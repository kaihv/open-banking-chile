import type { Page } from "puppeteer-core";
import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions, CreditCardBalance, MovementSource } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, parseChileanAmount, normalizeDate, deduplicateMovements } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";

// ─── BICE-specific constants ─────────────────────────────────────

const BANK_URL = "https://banco.bice.cl/personas";

// ─── BICE-specific helpers ───────────────────────────────────────

async function login(
  page: Page,
  rut: string,
  password: string,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>,
): Promise<{ success: boolean; error?: string; screenshot?: string; activePage?: Page }> {
  debugLog.push("1. Navigating to bank homepage...");
  await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(2000);
  await doSave(page, "01-homepage");

  debugLog.push("2. Opening login dropdown...");
  const loginDropdown = await page.$("#login-dropdown");
  if (!loginDropdown) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró el botón de login (#login-dropdown)", screenshot: ss as string };
  }
  await loginDropdown.click();
  await delay(1500);

  try { await page.waitForSelector(".dropdown-menu.show", { timeout: 5000 }); } catch { await loginDropdown.click(); await delay(2000); }

  debugLog.push("3. Clicking 'Personas'...");
  const personasLink = await page.$('a[data-click="Personas"]');
  if (!personasLink) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró el link 'Personas'", screenshot: ss as string };
  }
  await personasLink.click();

  // Multi-redirect: banco.bice.cl → portalpersonas → auth.bice.cl
  debugLog.push("4. Waiting for login form...");
  const browser = page.browser();
  let loginPage = page;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 25000);
      const interval = setInterval(async () => {
        const allPages = await browser.pages();
        for (const p of allPages) {
          if (p.url().includes("auth.bice.cl")) {
            loginPage = p;
            clearInterval(interval);
            clearTimeout(timeout);
            resolve();
            return;
          }
        }
      }, 1000);
    });
    await loginPage.waitForSelector("#username", { timeout: 15000 });
  } catch {
    const ss = await loginPage.screenshot({ encoding: "base64" });
    return { success: false, error: "No se cargó la página de login (timeout)", screenshot: ss as string };
  }
  await doSave(loginPage, "02-login-form");

  debugLog.push("5. Filling RUT...");
  const rutField = await loginPage.$("#username");
  if (!rutField) {
    const ss = await loginPage.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró campo de RUT (#username)", screenshot: ss as string };
  }
  await rutField.click();
  await rutField.type(rut.replace(/[.\-]/g, ""), { delay: 50 });

  debugLog.push("6. Filling password...");
  const passField = await loginPage.$("#password");
  if (!passField) {
    const ss = await loginPage.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró campo de clave (#password)", screenshot: ss as string };
  }
  await passField.click();
  await passField.type(password, { delay: 50 });
  await delay(500);

  debugLog.push("7. Submitting login...");
  await doSave(loginPage, "03-pre-submit");
  const submitBtn = await loginPage.$("#kc-login");
  if (submitBtn) await submitBtn.click();
  else await loginPage.keyboard.press("Enter");

  try { await loginPage.waitForNavigation({ timeout: 20000 }); } catch { /* SPA */ }
  await delay(3000);
  await doSave(loginPage, "04-after-login");

  if (loginPage.url().includes("auth.bice.cl")) {
    const errorText = await loginPage.evaluate(() => {
      const el = document.querySelector('[class*="error"], [class*="alert"], [role="alert"]');
      return el ? (el as HTMLElement).innerText?.trim() : null;
    });
    const ss = await loginPage.screenshot({ encoding: "base64" });
    return { success: false, error: `Error de login: ${errorText || "Credenciales inválidas"}`, screenshot: ss as string };
  }

  debugLog.push("8. Login OK!");
  return { success: true, activePage: loginPage };
}

async function dismissAdPopup(page: Page, debugLog: string[]): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const btn = await page.$("button.evg-btn-dismissal");
    if (btn) { await btn.click(); debugLog.push("  Ad popup dismissed"); await delay(1000); return; }
    await delay(2000);
  }
}

async function extractCurrentMonthMovements(page: Page): Promise<BankMovement[]> {
  const raw = await page.evaluate(() => {
    const rows = document.querySelectorAll("div.transaction-table__container table tbody tr");
    const results: Array<{ date: string; category: string; description: string; amount: string }> = [];
    for (const row of rows) {
      const cells = row.querySelectorAll("td");
      if (cells.length < 4) continue;
      results.push({
        date: (cells[0] as HTMLElement).innerText?.trim() || "",
        category: (cells[1] as HTMLElement).innerText?.trim().toLowerCase() || "",
        description: (cells[2] as HTMLElement).innerText?.trim() || "",
        amount: (cells[3] as HTMLElement).innerText?.trim() || "",
      });
    }
    return results;
  });

  return raw.map(r => {
    const amountVal = parseChileanAmount(r.amount);
    if (amountVal === 0) return null;
    const amount = r.category.includes("cargo") ? -amountVal : amountVal;
    return { date: normalizeDate(r.date), description: r.description, amount, balance: 0, source: MOVEMENT_SOURCE.account };
  }).filter(Boolean) as BankMovement[];
}

async function extractHistoricalMovements(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  const raw = await page.evaluate(() => {
    const table = document.querySelector('table[aria-describedby="Tabla resumen de cartolas"]')
      || document.querySelector("lib-credits-and-charges table")
      || document.querySelector("ds-table table");
    if (!table) return { rows: [] as Array<{ date: string; category: string; description: string; amount: string }>, found: false };

    const rows = table.querySelectorAll("tbody tr");
    const results: Array<{ date: string; category: string; description: string; amount: string }> = [];
    for (const row of rows) {
      const cells = row.querySelectorAll("td");
      if (cells.length < 5) continue;
      results.push({
        date: (cells[0] as HTMLElement).innerText?.trim() || "",
        category: (cells[1] as HTMLElement).innerText?.trim().toLowerCase() || "",
        description: (cells[3] as HTMLElement).innerText?.trim() || "",
        amount: (cells[4] as HTMLElement).innerText?.trim() || "",
      });
    }
    return { rows: results, found: true };
  });

  if (!raw.found) { debugLog.push("  Historical table not found"); return []; }

  return raw.rows.map(r => {
    const amountVal = parseChileanAmount(r.amount);
    if (amountVal === 0) return null;
    const amount = r.category.includes("cargo") ? -amountVal : amountVal;
    return { date: normalizeDate(r.date), description: r.description, amount, balance: 0, source: MOVEMENT_SOURCE.account };
  }).filter(Boolean) as BankMovement[];
}

async function bicePaginate(page: Page, extractFn: (page: Page) => Promise<BankMovement[]>): Promise<BankMovement[]> {
  const all: BankMovement[] = [];
  for (let i = 0; i < 50; i++) {
    all.push(...await extractFn(page));
    const isDisabled = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const span = btn.querySelector("span");
        if (span?.textContent?.trim() === "Siguiente") return btn.classList.contains("is-disabled");
      }
      return true;
    });
    if (isDisabled) break;
    await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const span = btn.querySelector("span");
        if (span?.textContent?.trim() === "Siguiente") { btn.click(); return; }
      }
    });
    await delay(3000);
  }
  return all;
}

async function selectPeriod(page: Page, periodIndex: number, debugLog: string[]): Promise<boolean> {
  await page.evaluate(() => {
    const selector = document.querySelector("ds-dropdown div.ds-selector");
    if (selector) (selector as HTMLElement).click();
  });
  await delay(1000);

  const periodLabel = await page.evaluate((idx: number) => {
    const items = document.querySelectorAll("ul.options.single li.li-single");
    if (idx >= items.length) return null;
    const span = items[idx].querySelector("span.label.header-ellipsis");
    const label = span?.textContent?.trim() || "";
    (items[idx] as HTMLElement).click();
    return label;
  }, periodIndex);

  if (!periodLabel) { debugLog.push(`  Period index ${periodIndex} not available`); return false; }
  debugLog.push(`  Selected period: ${periodLabel}`);

  await page.evaluate(() => {
    const container = document.querySelector("div.button-search");
    const btn = container?.querySelector("button");
    if (btn) btn.click();
  });
  await delay(7000);
  return true;
}

// ─── Credit card helpers ──────────────────────────────────────────

async function navigateToTcMovements(page: Page, debugLog: string[]): Promise<boolean> {
  debugLog.push("TC: Navigating to credit card movements...");

  // Try direct URL navigation first (fastest, least fragile)
  try {
    await page.goto("https://portalpersonas.bice.cl/movimientos-tc", {
      waitUntil: "networkidle2",
      timeout: 15000,
    });
    await delay(3000);
    const heading = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      return h1?.textContent?.trim() || "";
    });
    if (heading.includes("Tarjeta de Crédito")) {
      debugLog.push("TC: Direct URL navigation OK");
      return true;
    }
  } catch { /* fallback to menu navigation */ }

  // Fallback: click through sidebar menus
  const clickByText = async (text: string, exact = true): Promise<boolean> => {
    return await page.evaluate(
      ([searchText, isExact]) => {
        const items = document.querySelectorAll("div, span, a, li, button");
        for (const item of items) {
          const el = item as HTMLElement;
          // Only match direct text, not parent containers
          const directText = Array.from(el.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => n.textContent?.trim())
            .join("")
            .trim();
          const fullText = el.innerText?.trim() || "";
          const text = isExact ? directText : fullText;
          if (isExact ? text === searchText : text.includes(searchText)) {
            el.click();
            return true;
          }
        }
        return false;
      },
      [text, exact] as [string, boolean],
    );
  };

  // Click "Tarjetas de Crédito" sidebar item
  if (!(await clickByText("Tarjetas de Crédito"))) {
    debugLog.push("TC: 'Tarjetas de Crédito' not found in sidebar");
    return false;
  }
  await delay(1500);

  // Click "Consultas" submenu
  if (!(await clickByText("Consultas"))) {
    debugLog.push("TC: 'Consultas' not found in submenu");
    return false;
  }
  await delay(1000);

  // Click "Saldos y movimientos de Tarjeta de Crédito"
  if (!(await clickByText("Saldos y movimientos", false))) {
    debugLog.push("TC: 'Saldos y movimientos' link not found");
    return false;
  }
  await delay(3000);

  debugLog.push("TC: Menu navigation OK");
  return true;
}

async function extractCreditCardInfo(page: Page, debugLog: string[]): Promise<{ balance?: CreditCardBalance; movements: BankMovement[] }> {
  const data = await page.evaluate(() => {
    const result: {
      label?: string;
      nationalUsed?: number;
      nationalAvailable?: number;
      nationalTotal?: number;
      internationalUsed?: number;
      internationalAvailable?: number;
      internationalTotal?: number;
      billingPeriod?: string;
      nextBillingDate?: string;
    } = {};

    // Card label (e.g. "Visa Signature ···· 7620")
    const cardTexts: string[] = [];
    document.querySelectorAll("p, span, div").forEach((el) => {
      const t = (el as HTMLElement).innerText?.trim() || "";
      if (/Visa|Mastercard|Amex/i.test(t) && /\d{4}/.test(t)) {
        cardTexts.push(t.replace(/\n/g, " "));
      }
    });
    if (cardTexts.length > 0) result.label = cardTexts[0];

    // Cupo info — look for "Cupo utilizado", "Cupo disponible", "Cupo Total"
    const allText = document.body.innerText || "";
    const sections = allText.split(/Nacional|Internacional/);

    const parseAmount = (text: string): number | undefined => {
      const clean = text.replace(/[^0-9,.-]/g, "").replace(/\./g, "").replace(",", ".");
      const num = parseFloat(clean);
      return isNaN(num) ? undefined : Math.round(num);
    };

    // National section (first occurrence)
    if (sections.length > 1) {
      const nat = sections[1];
      const usedMatch = nat.match(/([\d.$\s.]+)\s*Cupo utilizado/i)
        || nat.match(/Cupo utilizado[\s\S]*?([\d$.\s]+)/i);
      const availMatch = nat.match(/([\d.$\s.]+)\s*Cupo disponible/i)
        || nat.match(/Cupo disponible[\s\S]*?([\d$.\s]+)/i);
      const totalMatch = nat.match(/Cupo Total:\s*([\d$.\s]+)/i);

      if (usedMatch) result.nationalUsed = parseAmount(usedMatch[1]);
      if (availMatch) result.nationalAvailable = parseAmount(availMatch[1]);
      if (totalMatch) result.nationalTotal = parseAmount(totalMatch[1]);
    }

    // International section
    if (sections.length > 2) {
      const intl = sections[2];
      const usedMatch = intl.match(/([\d$,\s.]+)\s*Cupo utilizado/i)
        || intl.match(/Cupo utilizado[\s\S]*?([\d$,\s]+)/i);
      const availMatch = intl.match(/([\d$,\s.]+)\s*Cupo disponible/i)
        || intl.match(/Cupo disponible[\s\S]*?([\d$,\s]+)/i);
      const totalMatch = intl.match(/Cupo Total:\s*(US\$[\d$,\s.]+)/i);

      if (usedMatch) result.internationalUsed = parseAmount(usedMatch[1]);
      if (availMatch) result.internationalAvailable = parseAmount(availMatch[1]);
      if (totalMatch) result.internationalTotal = parseAmount(totalMatch[1]);
    }

    // Billing dates
    const billingMatch = allText.match(/Facturación:\s*(\d{1,2}\s+\w+\s+\d{4})/i);
    const dueMatch = allText.match(/Vencimiento:\s*(\d{1,2}\s+\w+\s+\d{4})/i);
    if (billingMatch) result.billingPeriod = billingMatch[1];
    if (dueMatch) result.nextBillingDate = dueMatch[1];

    return result;
  });

  const ccBalance: CreditCardBalance = {
    label: data.label || "Tarjeta de Crédito BICE",
  };

  if (data.nationalUsed !== undefined || data.nationalAvailable !== undefined || data.nationalTotal !== undefined) {
    ccBalance.national = {
      used: data.nationalUsed || 0,
      available: data.nationalAvailable || 0,
      total: data.nationalTotal || 0,
    };
  }

  if (data.internationalUsed !== undefined || data.internationalAvailable !== undefined || data.internationalTotal !== undefined) {
    ccBalance.international = {
      used: data.internationalUsed || 0,
      available: data.internationalAvailable || 0,
      total: data.internationalTotal || 0,
      currency: "USD",
    };
  }

  if (data.billingPeriod) ccBalance.billingPeriod = data.billingPeriod;
  if (data.nextBillingDate) ccBalance.nextBillingDate = data.nextBillingDate;

  debugLog.push(`TC: Card=${ccBalance.label}, Nacional used=${ccBalance.national?.used}, Intl used=${ccBalance.international?.used}`);

  return { balance: ccBalance, movements: [] };
}

async function extractTcMovementsFromPage(page: Page, source: MovementSource): Promise<BankMovement[]> {
  const raw = await page.evaluate(() => {
    const results: Array<{ date: string; description: string; amount: string; installments: string }> = [];

    // Find the table container — its first child is the header row containing "Fecha" and "Monto"
    const allDivs = document.querySelectorAll("div");
    let tableContainer: Element | null = null;

    for (const div of allDivs) {
      const firstChild = div.children[0] as HTMLElement | undefined;
      if (!firstChild) continue;
      const firstText = firstChild.innerText?.trim() || "";
      if (firstText.includes("Fecha") && firstText.includes("Monto")) {
        tableContainer = div;
        break;
      }
    }

    if (!tableContainer) return results;

    // Movement rows are all children except the first (header)
    const rows = Array.from(tableContainer.children).slice(1);

    for (const row of rows) {
      const cells = Array.from(row.children);
      if (cells.length < 3) continue;

      // Cell 0: date (e.g. "03 abr 2026")
      const date = (cells[0] as HTMLElement).innerText?.trim() || "";
      if (!/^\d{1,2}\s/.test(date)) continue;

      // Cell 2: description
      const description = (cells[2] as HTMLElement).innerText?.trim() || "";

      // Last cell: installments + amount combined
      const lastCell = cells[cells.length - 1];
      const lastChildren = Array.from(lastCell.children);

      let installments = "";
      let amount = "";

      if (lastChildren.length >= 2) {
        installments = (lastChildren[0] as HTMLElement).innerText?.trim() || "";
        amount = (lastChildren[1] as HTMLElement).innerText?.trim() || "";
      } else {
        // Fallback: parse from combined text
        const fullText = (lastCell as HTMLElement).innerText || "";
        const instMatch = fullText.match(/(\d+\s+de\s+\d+)/);
        installments = instMatch?.[1] || "";
        const amtMatch = fullText.match(/[\d.]+(,\d+)?\s*(CLP|US\$)/);
        amount = amtMatch?.[0] || "";
      }

      if (date && description && amount) {
        results.push({ date, description, amount, installments });
      }
    }

    return results;
  });

  return raw
    .map((r) => {
      const amountVal = parseChileanAmount(r.amount);
      if (amountVal === 0) return null;
      // TC movements are always expenses (negative)
      // Exception: abonos/payments which are credits
      const descLower = r.description.toLowerCase();
      const isCredit =
        descLower.includes("abono") ||
        descLower.includes("pago") ||
        descLower.includes("nota de credito") ||
        descLower.includes("nota de crédito") ||
        descLower.includes("reverso") ||
        descLower.includes("anulacion") ||
        descLower.includes("anulación");
      const amount = isCredit ? amountVal : -amountVal;

      return {
        date: normalizeDate(r.date),
        description: r.description,
        amount,
        balance: 0,
        source,
        installments: r.installments && r.installments !== "1 de 1" ? r.installments : undefined,
      } as BankMovement;
    })
    .filter(Boolean) as BankMovement[];
}

async function clickTcTab(page: Page, tabText: string): Promise<boolean> {
  const clicked = await page.evaluate((text) => {
    const items = document.querySelectorAll("div, button, span");
    for (const item of items) {
      const el = item as HTMLElement;
      const directText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE || (n as HTMLElement).children?.length === 0)
        .map((n) => n.textContent?.trim())
        .filter(Boolean)
        .join(" ")
        .trim();
      if (directText.includes(text)) {
        el.click();
        return true;
      }
    }
    return false;
  }, tabText);

  if (clicked) await delay(3000);
  return clicked;
}

async function clickBilledPeriod(page: Page, periodIndex: number): Promise<boolean> {
  const clicked = await page.evaluate((idx) => {
    const buttons = document.querySelectorAll('button[role="tab"], button');
    const periodButtons = Array.from(buttons).filter((btn) => {
      const text = (btn as HTMLElement).innerText?.trim() || "";
      return text.includes("Periodo de facturación");
    });
    if (idx >= periodButtons.length) return false;
    (periodButtons[idx] as HTMLElement).click();
    return true;
  }, periodIndex);

  if (clicked) await delay(3000);
  return clicked;
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeBice(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots } = options;
  const { onProgress } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const bank = "bice";
  const progress = onProgress || (() => {});

  progress("Abriendo sitio del banco...");
  const loginResult = await login(page, rut, password, debugLog, doSave);
  if (!loginResult.success) {
    return { success: false, bank, movements: [], error: loginResult.error, screenshot: loginResult.screenshot, debug: debugLog.join("\n") };
  }

  progress("Sesión iniciada correctamente");
  const activePage = loginResult.activePage || page;
  await dismissAdPopup(activePage, debugLog);
  await closePopups(activePage);

  // Balance
  const balance = await activePage.evaluate(() => {
    const el = document.querySelector("h2.cabeceraCard2");
    if (!el) return undefined;
    const text = (el as HTMLElement).innerText?.trim();
    if (!text) return undefined;
    const val = parseInt(text.replace(/[^0-9]/g, ""), 10);
    return isNaN(val) ? undefined : val;
  });
  debugLog.push(`  Balance: ${balance !== undefined ? `$${balance.toLocaleString("es-CL")}` : "not found"}`);

  // Navigate to movements
  progress("Navegando a movimientos...");
  debugLog.push("9. Navigating to movements...");
  const link = await activePage.$("a.ultimosMov");
  if (!link) {
    const ss = await activePage.screenshot({ encoding: "base64" });
    return { success: false, bank, movements: [], balance, error: "No se pudo navegar a movimientos", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await link.click();
  try { await activePage.waitForSelector("div.transaction-table__container", { timeout: 15000 }); } catch { /* timeout */ }
  await delay(2000);
  await doSave(activePage, "05-movements-page");

  // Current month
  progress("Extrayendo movimientos del mes actual...");
  const movements = await bicePaginate(activePage, extractCurrentMonthMovements);
  debugLog.push(`10. Current month: ${movements.length} movements`);
  progress(`Mes actual: ${movements.length} movimientos`);

  // Historical periods
  const months = Math.min(Math.max(parseInt(process.env.BICE_MONTHS || "0", 10) || 0, 0), 16);
  if (months > 0) {
    debugLog.push(`11. Fetching ${months} historical period(s)...`);
    progress(`Extrayendo ${months} periodo(s) histórico(s)...`);
    const clicked = await activePage.evaluate(() => {
      const links = document.querySelectorAll("div.transactions-summary__link");
      for (const link of links) {
        if ((link as HTMLElement).innerText?.includes("Revisar periodos anteriores")) { (link as HTMLElement).click(); return true; }
      }
      return false;
    });

    if (clicked) {
      try { await activePage.waitForSelector('ds-dropdown[toplabel="Elige un periodo"]', { timeout: 10000 }); } catch { /* timeout */ }
      await delay(2000);

      const firstMovements = await bicePaginate(activePage, (p) => extractHistoricalMovements(p, debugLog));
      debugLog.push(`  Period 1: ${firstMovements.length} movements`);
      movements.push(...firstMovements);

      for (let i = 1; i < months; i++) {
        if (!(await selectPeriod(activePage, i, debugLog))) break;
        const hist = await bicePaginate(activePage, (p) => extractHistoricalMovements(p, debugLog));
        debugLog.push(`  Period ${i + 1}: ${hist.length} movements`);
        movements.push(...hist);
      }
    }
  }

  const deduplicated = deduplicateMovements(movements);
  debugLog.push(`  Total: ${deduplicated.length} unique movements`);
  progress(`Listo — ${deduplicated.length} movimientos totales`);

  // ── Credit card movements ─────────────────────────────────────
  let creditCards: CreditCardBalance[] | undefined;
  debugLog.push("TC: Starting credit card extraction...");
  progress("Extrayendo movimientos de tarjeta de crédito...");

  const tcNav = await navigateToTcMovements(activePage, debugLog);
  if (tcNav) {
    await doSave(activePage, "06-tc-page");

    // Extract credit card balance info
    const ccInfo = await extractCreditCardInfo(activePage, debugLog);
    if (ccInfo.balance) {
      creditCards = [ccInfo.balance];
    }

    // Extract unbilled movements (default tab: "Movimientos no facturados")
    const unbilled = await extractTcMovementsFromPage(activePage, MOVEMENT_SOURCE.credit_card_unbilled);
    debugLog.push(`TC: Unbilled movements: ${unbilled.length}`);
    movements.push(...unbilled);

    // Extract billed movements if BICE_MONTHS is set
    const tcMonths = Math.min(Math.max(parseInt(process.env.BICE_MONTHS || "0", 10) || 0, 0), 11);
    if (tcMonths > 0) {
      debugLog.push(`TC: Fetching ${tcMonths} billed period(s)...`);
      progress(`Extrayendo ${tcMonths} periodo(s) facturado(s) de TC...`);

      // Switch to billed tab
      if (await clickTcTab(activePage, "Movimientos facturados")) {
        await doSave(activePage, "06b-tc-billed");
        await delay(2000);

        for (let i = 0; i < tcMonths; i++) {
          if (!(await clickBilledPeriod(activePage, i))) {
            debugLog.push(`TC: Period ${i + 1} not available`);
            break;
          }
          await delay(2000);
          const billed = await extractTcMovementsFromPage(activePage, MOVEMENT_SOURCE.credit_card_billed);
          debugLog.push(`TC: Billed period ${i + 1}: ${billed.length} movements`);
          movements.push(...billed);
        }
      }
    }
  } else {
    debugLog.push("TC: Could not navigate to credit card section");
  }

  const finalMovements = deduplicateMovements(movements);
  debugLog.push(`  Final total: ${finalMovements.length} movements (${deduplicated.length} account + ${finalMovements.length - deduplicated.length} TC)`);
  progress(`Listo — ${finalMovements.length} movimientos totales`);

  await doSave(activePage, "07-final");
  const ss = doScreenshots ? (await activePage.screenshot({ encoding: "base64", fullPage: true })) as string : undefined;

  return { success: true, bank, movements: finalMovements, balance: balance || undefined, creditCards: creditCards, screenshot: ss, debug: debugLog.join("\n") };
}

// ─── Export ──────────────────────────────────────────────────────

const bice: BankScraper = {
  id: "bice",
  name: "Banco BICE",
  url: BANK_URL,
  scrape: (options) => runScraper("bice", options, {}, scrapeBice),
};

export default bice;
