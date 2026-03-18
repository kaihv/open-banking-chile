import puppeteer, { type Page, type Frame } from "puppeteer-core";
import type { BankMovement, BankScraper, CreditCardBalance, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, findChrome, formatRut, saveScreenshot, normalizeDate, parseChileanAmount, deduplicateMovements, logout } from "../utils.js";

const LOGIN_URL = "https://www.bci.cl/corporativo/banco-en-linea/personas";

const IFRAME_PATTERNS = {
  content: ["miBanco.jsf", "vistaSupercartola"],
  movements: "fe-saldosultimosmov",
  tcMovements: "fe-mismovimientos",
  tcCupo: "vistaSaldosTDC.jsf",
} as const;

const TWO_FA_KEYWORDS = ["bci pass", "segundo factor", "aprobación en tu app", "autorizar en tu app", "confirmar en tu app"];
const TWO_FA_TIMEOUT_SEC = Math.min(600, Math.max(30, parseInt(process.env.BCI_2FA_TIMEOUT_SEC || "180", 10) || 180));

const TC_COMBINATIONS = [
  { tab: "Nacional $", billingType: "No facturados", source: MOVEMENT_SOURCE.credit_card_unbilled },
  { tab: "Nacional $", billingType: "Facturados", source: MOVEMENT_SOURCE.credit_card_billed },
  { tab: "Internacional USD", billingType: "No facturados", source: MOVEMENT_SOURCE.credit_card_unbilled },
  { tab: "Internacional USD", billingType: "Facturados", source: MOVEMENT_SOURCE.credit_card_billed },
];

const NEXT_PAGE_TEXTS = ["navigate_next", "siguiente"];
const ACCOUNT_SELECT = "bci-wk-select#cuenta select, select";

// ─── Helpers ────────────────────────────────────────────────────

async function clickByTitle(page: Page, title: string): Promise<boolean> {
  return page.evaluate((t: string) => {
    const link = document.querySelector(`a[title="${t}"]`) as HTMLElement | null;
    if (link) { link.click(); return true; }
    return false;
  }, title);
}

async function failWithScreenshot(page: Page, error: string): Promise<{ success: false; error: string; screenshot: string }> {
  const screenshot = (await page.screenshot({ encoding: "base64" })) as string;
  return { success: false, error, screenshot };
}

function getContentFrame(page: Page): Frame | null {
  return page.frames().find((f) => IFRAME_PATTERNS.content.some((p) => f.url().includes(p))) || null;
}

async function waitForFrame(page: Page, urlPattern: string, timeoutMs = 10000): Promise<Frame | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = page.frames().find((f) => f.url().includes(urlPattern));
    if (frame) return frame;
    await delay(500);
  }
  return null;
}

// ─── Login helpers ───────────────────────────────────────────────

async function fillRut(page: Page, rut: string, debugLog: string[]): Promise<boolean> {
  debugLog.push("2. Filling RUT...");
  const cleanRut = rut.replace(/[.\-\s]/g, "");
  const rutBody = cleanRut.slice(0, -1);
  const rutDv = cleanRut.slice(-1);
  const formattedRut = formatRut(rut);

  return page.evaluate(
    (formatted: string, body: string, dv: string) => {
      const rutAux = document.getElementById("rut_aux") as HTMLInputElement | null;
      const rutHidden = document.getElementById("rut") as HTMLInputElement | null;
      const digHidden = document.getElementById("dig") as HTMLInputElement | null;

      if (!rutAux) return false;

      rutAux.value = formatted;
      rutAux.dispatchEvent(new Event("input", { bubbles: true }));
      rutAux.dispatchEvent(new Event("change", { bubbles: true }));
      rutAux.dispatchEvent(new Event("blur", { bubbles: true }));
      if (rutHidden) rutHidden.value = body;
      if (digHidden) digHidden.value = dv;
      return true;
    },
    formattedRut, rutBody, rutDv
  );
}

async function fillPassword(page: Page, password: string, debugLog: string[]): Promise<boolean> {
  debugLog.push("  Filling password...");
  return page.evaluate((pass: string) => {
    const clave = document.getElementById("clave") as HTMLInputElement | null;
    if (!clave) return false;
    clave.value = pass;
    clave.dispatchEvent(new Event("input", { bubbles: true }));
    clave.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, password);
}

async function submitLogin(page: Page, debugLog: string[]): Promise<void> {
  debugLog.push("3. Submitting login...");
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    if (btn) btn.disabled = false;
    const form = document.getElementById("frm") as HTMLFormElement | null;
    if (form) form.submit();
    else if (btn) btn.click();
  });

  try {
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
  } catch { /* SPA */ }
  await delay(3000);
}

async function detectLoginError(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const pattern = /(error|incorrect|inv[aá]lid|rechazad|bloquead|fall[oó]|intenta nuevamente|clave.*(err[oó]nea|incorrecta))/i;
    for (const sel of ['[class*="error"]', '[class*="alert"]', '[role="alert"]']) {
      for (const el of document.querySelectorAll(sel)) {
        const text = (el as HTMLElement).innerText?.trim();
        if (text && text.length > 3 && text.length < 250 && pattern.test(text)) return text;
      }
    }
    return null;
  });
}

async function has2FAChallenge(page: Page): Promise<boolean> {
  return page.evaluate((keywords: string[]) => {
    const text = (document.body?.innerText || "").toLowerCase();
    return keywords.some((kw) => text.includes(kw));
  }, TWO_FA_KEYWORDS);
}

async function waitFor2FA(page: Page, debugLog: string[]): Promise<boolean> {
  debugLog.push(`  2FA detectado (BCI Pass). Esperando aprobación manual (${TWO_FA_TIMEOUT_SEC}s)...`);
  const deadline = Date.now() + TWO_FA_TIMEOUT_SEC * 1000;
  let pollCount = 0;

  while (Date.now() < deadline) {
    const still2FA = await has2FAChallenge(page);
    if (!still2FA) {
      debugLog.push("  2FA completado.");
      return true;
    }
    pollCount++;
    if (pollCount % 10 === 0) {
      const remaining = Math.round((deadline - Date.now()) / 1000);
      debugLog.push(`  Esperando aprobación... (${remaining}s restantes)`);
    }
    await delay(3000);
  }

  return false;
}

// ─── Login ──────────────────────────────────────────────────────

async function login(
  page: Page,
  rut: string,
  password: string,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>
): Promise<{ success: boolean; error?: string; screenshot?: string }> {
  debugLog.push("1. Navigating to BCI login...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await delay(3000);
  await doSave(page, "01-login-form");

  const rutFilled = await fillRut(page, rut, debugLog);
  if (!rutFilled) {
    return failWithScreenshot(page, "Campo de RUT no encontrado.");
  }

  const passFilled = await fillPassword(page, password, debugLog);
  if (!passFilled) {
    return failWithScreenshot(page, "Campo de clave no encontrado.");
  }

  await delay(500);
  await doSave(page, "02-pre-submit");

  await submitLogin(page, debugLog);
  await doSave(page, "03-post-login");

  // Check for 2FA
  if (await has2FAChallenge(page)) {
    await doSave(page, "03b-2fa-challenge");
    const approved = await waitFor2FA(page, debugLog);
    if (!approved) {
      return failWithScreenshot(page, `Timeout esperando BCI Pass (${TWO_FA_TIMEOUT_SEC}s).`);
    }
    await delay(3000);
  }

  // Check for login errors
  const loginError = await detectLoginError(page);
  if (loginError) {
    return failWithScreenshot(page, `Error del banco: ${loginError}`);
  }

  // Verify navigation away from login page
  const currentUrl = page.url();
  if (currentUrl.includes("banco-en-linea/personas")) {
    return failWithScreenshot(page, "Login no navegó fuera de la página.");
  }

  // Verify dashboard loaded (positive check)
  const dashboardLoaded = getContentFrame(page) !== null ||
    currentUrl.includes("mibanco") ||
    currentUrl.includes("home");
  if (!dashboardLoaded) {
    debugLog.push(`  Warning: URL post-login no reconocida: ${currentUrl}`);
  }

  debugLog.push(`4. Login OK!`);
  return { success: true };
}

// ─── Navigate to movements ──────────────────────────────────────

async function fetchAccountMovements(
  page: Page,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>
): Promise<{ movements: BankMovement[]; balance?: number }> {
  debugLog.push("5. Fetching account movements...");

  const clicked = await clickByTitle(page, "Últimos Movimientos");

  if (!clicked) {
    debugLog.push("  'Últimos Movimientos' link not found");
    return { movements: [] };
  }

  const movFrame = await waitForFrame(page, IFRAME_PATTERNS.movements, 15000);
  if (!movFrame) {
    debugLog.push("  Movements iframe did not load");
    return { movements: [] };
  }

  await delay(3000);
  await doSave(page, "04-movements");

  // Read accounts from the iframe's own selector (bci-wk-select#cuenta > select)
  const accounts = await movFrame.evaluate((sel: string) => {
    const select = document.querySelector(sel) as HTMLSelectElement | null;
    if (!select) return [];
    return Array.from(select.options).map((o) => ({ value: o.value, label: o.textContent?.trim() || "" }));
  }, ACCOUNT_SELECT);

  debugLog.push(`  Found ${accounts.length} account(s): ${accounts.map((a) => a.label).join(", ")}`);

  const allMovements: BankMovement[] = [];
  let balance: number | undefined;

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    debugLog.push(`  Processing account: ${account.label}`);

    // Select account in iframe dropdown if multiple
    if (i > 0) {
      await movFrame.evaluate((value: string, sel: string) => {
        const select = document.querySelector(sel) as HTMLSelectElement | null;
        if (!select) return;
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }, account.value, ACCOUNT_SELECT);
      await delay(3000);
    }

    // Extract balance from iframe (first account only, or CLP account)
    if (balance === undefined) {
      balance = await movFrame.evaluate(() => {
        const el = document.querySelector("#saldoDis + div, .bci-h2-w800");
        if (!el) return undefined;
        const text = (el as HTMLElement).textContent?.trim() || "";
        const match = text.match(/\$\s*([\d.]+)/);
        if (match) return parseInt(match[1].replace(/\./g, ""), 10);
        return undefined;
      });
      if (balance !== undefined) debugLog.push(`  Balance: $${balance.toLocaleString("es-CL")}`);
    }

    const movements = await extractMovementsFromFrame(movFrame, debugLog);
    const prefixed = accounts.length > 1
      ? movements.map(m => ({ ...m, description: `[${account.label}] ${m.description}`.trim() }))
      : movements;
    allMovements.push(...prefixed);
    debugLog.push(`    ${movements.length} movements from ${account.label}`);
  }

  return { movements: allMovements, balance };
}

// ─── Extract movements from iframe ──────────────────────────────

async function extractMovementsFromFrame(frame: Frame, debugLog: string[]): Promise<BankMovement[]> {
  // Try to show 50 per page to minimize pagination
  await frame.evaluate(() => {
    for (const opt of document.querySelectorAll("a, button, span, option")) {
      if ((opt as HTMLElement).innerText?.trim() === "50") {
        (opt as HTMLElement).click();
        return;
      }
    }
  });
  await delay(3000);

  const allMovements: BankMovement[] = [];

  // BCI typically shows ~50 per page, 25 pages covers ~1250 movements
  for (let pageIndex = 0; pageIndex < 25; pageIndex++) {
    const rawMovements = await frame.evaluate(() => {
      const results: Array<{ date: string; description: string; cargo: string; abono: string }> = [];

      // BCI table: Fecha(0) | Descripción(1) | Cargo(2) | Abono(3) | Detalle(4)
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td"));
        if (cells.length < 4) continue;

        const date = cells[0].textContent?.trim() || "";
        if (!/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(date)) continue;

        const description = cells[1].textContent?.trim() || "";
        const cargo = cells[2].textContent?.trim() || "";
        const abono = cells[3].textContent?.trim() || "";

        if (!description || (!cargo && !abono)) continue;
        results.push({ date, description, cargo, abono });
      }

      return results;
    });

    debugLog.push(`  Page ${pageIndex + 1}: ${rawMovements.length} raw movements`);

    for (const r of rawMovements) {
      const cargoAmount = r.cargo ? parseChileanAmount(r.cargo) : 0;
      const abonoAmount = r.abono ? parseChileanAmount(r.abono) : 0;
      const amount = cargoAmount > 0 ? -cargoAmount : abonoAmount;
      if (amount === 0) continue;

      allMovements.push({
        date: normalizeDate(r.date),
        description: r.description,
        amount,
        balance: 0,
        source: MOVEMENT_SOURCE.account,
      });
    }

    // Try next page
    const hasNext = await frame.evaluate((nextTexts: string[]) => {
      for (const btn of document.querySelectorAll("button, a")) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || "";
        const ariaLabel = btn.getAttribute("aria-label")?.toLowerCase() || "";
        if (nextTexts.some((t) => text === t || text.includes(t)) || ariaLabel.includes("next")) {
          const disabled = (btn as HTMLButtonElement).disabled ||
            btn.getAttribute("aria-disabled") === "true" ||
            btn.classList.contains("disabled");
          if (disabled) return false;
          (btn as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, [...NEXT_PAGE_TEXTS]);

    if (!hasNext) break;
    await delay(3000);
  }

  return allMovements;
}

// ─── Credit card extraction helpers ──────────────────────────────

async function extractTCMovementsFromAngularFrame(
  frame: Frame,
  tab: string,
  billingType: string,
  debugLog: string[]
): Promise<BankMovement[]> {
  // Click the tab (Nacional $ / Internacional USD)
  await frame.evaluate((tabName: string) => {
    for (const span of document.querySelectorAll("bci-wk-tabs span, .listTab span, .listTab a span")) {
      if (span.textContent?.trim() === tabName) {
        (span.closest("a") || span as HTMLElement).click();
        return;
      }
    }
  }, tab);
  await delay(2000);

  // Click the billing type button (No facturados / Facturados)
  await frame.evaluate((btnText: string) => {
    for (const btn of document.querySelectorAll("button")) {
      if (btn.textContent?.trim() === btnText) {
        btn.click();
        return;
      }
    }
  }, billingType);
  await delay(2000);

  // Check if "no tienes movimientos" message is shown
  const hasNoMovements = await frame.evaluate(() => {
    const text = document.body?.innerText?.toLowerCase() || "";
    return text.includes("no tienes movimientos") || text.includes("sin movimientos");
  });

  if (hasNoMovements) {
    debugLog.push(`    ${tab} / ${billingType}: sin movimientos`);
    return [];
  }

  // Extract movements from the Angular table
  const rawMovements = await frame.evaluate(() => {
    const results: Array<{ date: string; description: string; amount: string }> = [];

    // Try standard table rows
    const rows = document.querySelectorAll("table tbody tr, .wrapper-table tr");
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 2) continue;

      const date = cells[0]?.textContent?.trim() || "";
      if (!date || !/\d{1,2}[\/.\-\s]/.test(date)) continue;

      const description = cells[1]?.textContent?.trim() || "";
      const amount = cells[cells.length - 1]?.textContent?.trim() || cells[2]?.textContent?.trim() || "";

      if (description && amount) results.push({ date, description, amount });
    }

    return results;
  });

  const movements: BankMovement[] = [];
  for (const r of rawMovements) {
    const numStr = r.amount.replace(/[^0-9.\-,]/g, "");
    const amount = parseFloat(numStr.replace(/\./g, "").replace(",", ".")) || 0;
    if (amount === 0) continue;

    movements.push({
      date: normalizeDate(r.date),
      description: r.description,
      amount: -Math.abs(amount),
      balance: 0,
      source: MOVEMENT_SOURCE.credit_card_unbilled, // overridden by caller with correct source
    });
  }

  debugLog.push(`    ${tab} / ${billingType}: ${movements.length} movimientos`);
  return movements;
}

// ─── Credit card data (via Tarjetas menu) ────────────────────────

async function extractCreditCardInfo(
  page: Page,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>
): Promise<{ movements: BankMovement[]; creditCards: CreditCardBalance[] }> {
  debugLog.push("6. Navigating to credit cards...");

  const tarjetasClicked = await clickByTitle(page, "Tarjetas");

  if (!tarjetasClicked) {
    debugLog.push("  'Tarjetas' menu not found");
    return { movements: [], creditCards: [] };
  }
  await delay(3000);

  // Get card labels from the dropdown selector
  const cardLabels = await page.evaluate(() => {
    const selects = document.querySelectorAll("select.tdc");
    if (selects.length === 0) return [];
    const options = Array.from((selects[0] as HTMLSelectElement).options);
    return options.map((o) => o.textContent?.trim() || "");
  });

  if (cardLabels.length === 0) {
    debugLog.push("  No credit cards found in selector");
    return { movements: [], creditCards: [] };
  }

  debugLog.push(`  Found ${cardLabels.length} card(s): ${cardLabels.join(", ")}`);

  const movClicked = await clickByTitle(page, "Mis movimientos");
  if (!movClicked) {
    debugLog.push("  'Mis movimientos' link not found");
    return { movements: [], creditCards: [] };
  }

  const tcFrame = await waitForFrame(page, IFRAME_PATTERNS.tcMovements, 15000);
  if (!tcFrame) {
    debugLog.push("  TC movements iframe not loaded");
    return { movements: [], creditCards: [] };
  }

  debugLog.push("  TC movements iframe loaded");
  await delay(3000);
  await doSave(page, "05-tc-movements");

  // Extract movements from all tab/billing type combinations
  const allTCMovements: BankMovement[] = [];

  for (const { tab, billingType, source } of TC_COMBINATIONS) {
    const movements = await extractTCMovementsFromAngularFrame(tcFrame, tab, billingType, debugLog);
    allTCMovements.push(...movements.map((m) => ({ ...m, source })));
  }

  // Get credit card balance from "Cupo disponible" page
  const creditCards: CreditCardBalance[] = [];

  const cupoClicked = await clickByTitle(page, "Cupo disponible");
  if (cupoClicked) {
    const cupoFrame = await waitForFrame(page, IFRAME_PATTERNS.tcCupo, 15000);
    if (cupoFrame) {
      await delay(3000);
      const cupoData = await cupoFrame.evaluate(() => {
        const bodyText = document.body?.innerText || "";
        const parseAmt = (t: string) => parseInt(t.replace(/[^0-9]/g, ""), 10) || 0;

        const natUsed = bodyText.match(/utilizado\s*(?:nacional)?\s*\$?\s*([\d.]+)/i);
        const natAvail = bodyText.match(/disponible\s*(?:nacional)?\s*\$?\s*([\d.]+)/i);
        const natTotal = bodyText.match(/total\s*(?:nacional)?\s*\$?\s*([\d.]+)/i);
        const intUsed = bodyText.match(/utilizado\s*(?:internacional)?\s*USD?\s*\$?\s*([\d.,]+)/i);
        const intAvail = bodyText.match(/disponible\s*(?:internacional)?\s*USD?\s*\$?\s*([\d.,]+)/i);
        const intTotal = bodyText.match(/total\s*(?:internacional)?\s*USD?\s*\$?\s*([\d.,]+)/i);

        return {
          nationalUsed: natUsed ? parseAmt(natUsed[1]) : 0,
          nationalAvailable: natAvail ? parseAmt(natAvail[1]) : 0,
          nationalTotal: natTotal ? parseAmt(natTotal[1]) : 0,
          internationalUsed: intUsed ? parseAmt(intUsed[1]) : 0,
          internationalAvailable: intAvail ? parseAmt(intAvail[1]) : 0,
          internationalTotal: intTotal ? parseAmt(intTotal[1]) : 0,
        };
      });

      for (const label of cardLabels) {
        const card: CreditCardBalance = {
          label,
          national: { used: cupoData.nationalUsed, available: cupoData.nationalAvailable, total: cupoData.nationalTotal },
        };
        if (cupoData.internationalTotal > 0) {
          card.international = {
            used: cupoData.internationalUsed,
            available: cupoData.internationalAvailable,
            total: cupoData.internationalTotal,
            currency: "USD",
          };
        }
        creditCards.push(card);
      }
      debugLog.push(`  Cupo: NAC used=$${cupoData.nationalUsed}, INT used=$${cupoData.internationalUsed}`);
    } else {
      debugLog.push("  Cupo disponible iframe not loaded");
    }
  }

  return { movements: allTCMovements, creditCards };
}

// ─── Main scraper ───────────────────────────────────────────────

async function scrape(options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, chromePath, saveScreenshots: doScreenshots, headful } = options;
  const bank = "bci";

  if (!rut || !password) {
    return { success: false, bank, movements: [], error: "Debes proveer RUT y clave." };
  }

  const executablePath = findChrome(chromePath);
  if (!executablePath) {
    return {
      success: false, bank, movements: [],
      error: "No se encontró Chrome/Chromium. Instala Google Chrome o pasa chromePath.\n  Ubuntu/Debian: sudo apt install google-chrome-stable\n  macOS: brew install --cask google-chrome",
    };
  }

  let browser;
  const debugLog: string[] = [];
  const doSave = async (page: Page, name: string) => saveScreenshot(page, name, !!doScreenshots, debugLog);

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: !headful,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
        "--disable-gpu", "--window-size=1280,900", "--disable-blink-features=AutomationControlled",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, "webdriver", { get: () => false }); });

    // Login
    const loginResult = await login(page, rut, password, debugLog, doSave);
    if (!loginResult.success) {
      return { success: false, bank, movements: [], error: loginResult.error, screenshot: loginResult.screenshot, debug: debugLog.join("\n") };
    }

    await closePopups(page);
    await delay(2000);

    // Fetch account movements and balance from iframe
    const acctResult = await fetchAccountMovements(page, debugLog, doSave);
    const accountMovements = acctResult.movements;
    let balance = acctResult.balance;

    // Credit card data
    const tcResult = await extractCreditCardInfo(page, debugLog, doSave);
    debugLog.push(`  TC movements: ${tcResult.movements.length}, cards: ${tcResult.creditCards.length}`);

    const allMovements = [...accountMovements, ...tcResult.movements];

    // Deduplicate
    const deduplicated = deduplicateMovements(allMovements);

    debugLog.push(`  Total: ${deduplicated.length} unique movements`);
    await doSave(page, "06-final");

    const screenshot = doScreenshots ? ((await page.screenshot({ encoding: "base64" })) as string) : undefined;
    return {
      success: true, bank, movements: deduplicated, balance,
      creditCards: tcResult.creditCards.length > 0 ? tcResult.creditCards : undefined,
      screenshot, debug: debugLog.join("\n"),
    };
  } catch (error) {
    return { success: false, bank, movements: [], error: `Error del scraper: ${error instanceof Error ? error.message : String(error)}`, debug: debugLog.join("\n") };
  } finally {
    if (browser) {
      try {
        const pages = await browser.pages();
        if (pages.length > 0) await logout(pages[pages.length - 1], debugLog);
      } catch { /* best effort */ }
      await browser.close().catch(() => {});
    }
  }
}

// ─── Export ──────────────────────────────────────────────────────

const bci: BankScraper = {
  id: "bci",
  name: "BCI",
  url: "https://www.bci.cl/personas",
  scrape,
};

export default bci;
