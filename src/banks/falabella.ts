import puppeteer, { type Page } from "puppeteer-core";
import type { BankMovement, BankScraper, CardOwner, CreditCardBalance, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, findChrome, formatRut, saveScreenshot, logout, parseChileanAmount, deduplicateMovements, normalizeDate, normalizeOwner, normalizeInstallments } from "../utils.js";

const BANK_URL = "https://www.bancofalabella.cl";
const SHADOW_HOST = "credit-card-movements";

// ─── Login helpers ──────────────────────────────────────────────

async function fillRut(page: Page, rut: string): Promise<boolean> {
  const formattedRut = formatRut(rut);

  const selectors = [
    'input[name*="rut"]',
    'input[id*="rut"]',
    'input[placeholder*="RUT"]',
    'input[placeholder*="Rut"]',
    'input[type="text"][name*="user"]',
    'input[type="text"][name*="username"]',
    'input[id*="user"]',
    'input[aria-label*="RUT"]',
    'input[aria-label*="rut"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(formattedRut, { delay: 50 });
        return true;
      }
    } catch { /* try next */ }
  }

  try {
    const filled = await page.evaluate((rutVal: string) => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      for (const input of inputs) {
        const el = input as HTMLInputElement;
        if (el.offsetParent !== null && !el.disabled) {
          el.focus();
          el.value = rutVal;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      return false;
    }, formattedRut);
    if (filled) return true;
  } catch { /* continue */ }

  return false;
}

async function fillPassword(page: Page, password: string): Promise<boolean> {
  const selectors = [
    'input[type="password"]',
    'input[name*="pass"]',
    'input[name*="clave"]',
    'input[id*="pass"]',
    'input[id*="clave"]',
    'input[placeholder*="Clave"]',
    'input[placeholder*="clave"]',
    'input[placeholder*="Contraseña"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await el.type(password, { delay: 50 });
        return true;
      }
    } catch { /* try next */ }
  }

  return false;
}

async function clickSubmitButton(page: Page): Promise<boolean> {
  const selectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button[class*="login"]',
    'button[class*="submit"]',
    'button[id*="login"]',
    'button[id*="submit"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); return true; }
    } catch { /* try next */ }
  }

  const texts = ["Ingresar", "Iniciar sesión", "Entrar", "Login", "Continuar"];
  for (const text of texts) {
    try {
      const clicked = await page.evaluate((t: string) => {
        const buttons = Array.from(document.querySelectorAll("button, input[type='submit'], a"));
        for (const btn of buttons) {
          if ((btn as HTMLElement).innerText?.trim().toLowerCase() === t.toLowerCase()) {
            (btn as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, text);
      if (clicked) return true;
    } catch { /* try next */ }
  }

  await page.keyboard.press("Enter");
  return true;
}

// ─── Account helpers ────────────────────────────────────────────

async function tryExpandDateRange(page: Page, debugLog: string[]): Promise<void> {
  try {
    const selectInfo = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      return selects.map((sel, i) => ({
        index: i,
        name: sel.name || sel.id || `select-${i}`,
        options: Array.from(sel.querySelectorAll("option")).map((o) => ({
          text: o.text.trim(), value: o.value, selected: o.selected,
        })),
      }));
    });

    if (selectInfo.length > 0) {
      for (const sel of selectInfo) {
        for (const opt of sel.options) {
          const text = opt.text.toLowerCase();
          if (text.includes("todos") || text.includes("último mes") || text.includes("30 día") || text.includes("mes anterior")) {
            await page.evaluate((selIdx: number, optValue: string) => {
              const selects = document.querySelectorAll("select");
              const select = selects[selIdx] as HTMLSelectElement;
              if (select) {
                select.value = optValue;
                select.dispatchEvent(new Event("change", { bubbles: true }));
              }
            }, sel.index, opt.value);
            debugLog.push(`  Changed [${sel.name}] to "${opt.text}"`);
            await delay(3000);
            break;
          }
        }
      }
    }

    const clickedSearch = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, input[type='submit']"));
      for (const btn of buttons) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
        if (text === "buscar" || text === "consultar" || text === "filtrar") {
          (btn as HTMLElement).click();
          return text;
        }
      }
      return null;
    });

    if (clickedSearch) {
      debugLog.push(`  Clicked "${clickedSearch}" button`);
      await delay(3000);
    }
  } catch { /* ignore */ }
}

const NAV_TARGETS = [
  { text: "cartola", exact: false },
  { text: "últimos movimientos", exact: false },
  { text: "movimientos", exact: true },
  { text: "estado de cuenta", exact: false },
];

async function clickNavTarget(page: Page, debugLog: string[]): Promise<boolean> {
  for (const target of NAV_TARGETS) {
    const result = await page.evaluate((t: { text: string; exact: boolean }) => {
      const elements = Array.from(document.querySelectorAll("a, button, [role='tab'], [role='menuitem'], li, span"));
      for (const el of elements) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
        const href = (el as HTMLAnchorElement).href || "";
        if (href.includes("cc-nuevos") || href.includes("comenzar")) continue;
        if (text.includes("historial de transferencia")) continue;
        const match = t.exact ? text === t.text : text.includes(t.text);
        if (match && text.length < 50) {
          (el as HTMLElement).click();
          return `Clicked: "${text}"`;
        }
      }
      return null;
    }, target);

    if (result) {
      debugLog.push(`  ${result}`);
      await delay(4000);
      return true;
    }
  }
  return false;
}

async function extractAccountMovements(page: Page): Promise<BankMovement[]> {
  const rawMovements = await page.evaluate(() => {
    const movements: BankMovement[] = [];

    // Strategy 1: Table with headers (Fecha, Cargo, Abono, Saldo)
    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      let cargoIdx = -1, abonoIdx = -1, saldoIdx = -1, hasHeaders = false;

      const allRows = Array.from(table.querySelectorAll("tr"));
      for (const row of allRows) {
        const ths = row.querySelectorAll("th");
        if (ths.length >= 3) {
          const headerTexts = Array.from(ths).map((h) => (h as HTMLElement).innerText?.trim().toLowerCase());
          if (headerTexts.some((h) => h.includes("fecha"))) {
            cargoIdx = headerTexts.findIndex((h) => h.includes("cargo"));
            abonoIdx = headerTexts.findIndex((h) => h.includes("abono"));
            saldoIdx = headerTexts.findIndex((h) => h.includes("saldo"));
            hasHeaders = true;
            break;
          }
        }
      }

      if (!hasHeaders) continue;

      for (const row of allRows) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 3) continue;
        const texts = Array.from(cells).map((c) => (c as HTMLElement).innerText?.trim());
        if (!texts[0]?.match(/^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/)) continue;

        let amount = 0, balance = 0;
        if (cargoIdx >= 0 && texts[cargoIdx]) {
          const val = parseInt(texts[cargoIdx].replace(/[^0-9]/g, ""), 10) || 0;
          if (val > 0) amount = -val;
        }
        if (abonoIdx >= 0 && texts[abonoIdx]) {
          const val = parseInt(texts[abonoIdx].replace(/[^0-9]/g, ""), 10) || 0;
          if (val > 0) amount = val;
        }
        if (saldoIdx >= 0 && texts[saldoIdx]) {
          balance = parseInt(texts[saldoIdx].replace(/[^0-9]/g, ""), 10) || 0;
          if (texts[saldoIdx].includes("-")) balance = -balance;
        }
        if (amount !== 0) movements.push({ date: texts[0], description: texts[1] || "", amount, balance, source: "account" });
      }
    }

    // Strategy 2: SPA movement components
    if (movements.length === 0) {
      const movementEls = document.querySelectorAll('[class*="movement"], [class*="transaction"], [class*="movimiento"], [class*="Movement"], [class*="Transaction"]');
      for (const el of movementEls) {
        const text = (el as HTMLElement).innerText || "";
        const dateMatch = text.match(/(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})/);
        const amountMatch = text.match(/\$[\d.,]+/g);
        if (dateMatch && amountMatch) {
          const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
          const descLine = lines.find((l) => !l.match(/^\$/) && !l.match(/^\d{1,2}[/\-.]/) && l.length > 2);
          const isNegative = text.includes("Cargo") || text.includes("cargo") || text.includes("-$");
          const amt = parseInt(amountMatch[0].replace(/[^0-9]/g, ""), 10) || 0;
          movements.push({
            date: dateMatch[1],
            description: descLine || "",
            amount: isNegative ? -amt : amt,
            balance: amountMatch.length > 1 ? parseInt(amountMatch[amountMatch.length - 1].replace(/[^0-9]/g, ""), 10) : 0,
            source: "account",
          });
        }
      }
    }

    // Strategy 3: Generic pattern matching
    if (movements.length === 0) {
      const allElements = document.querySelectorAll("div, li, article, section");
      for (const el of allElements) {
        if (el.children.length >= 3) {
          const text = (el as HTMLElement).innerText || "";
          const lines = text.split("\n");
          if (lines.length >= 3 && lines.length <= 8) {
            const dateMatch = text.match(/(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})/);
            const amountMatch = text.match(/\$[\d.,]+/);
            if (dateMatch && amountMatch) {
              const trimmedLines = lines.map((l) => l.trim()).filter(Boolean);
              const descLine = trimmedLines.find((l) => !l.match(/^\$/) && !l.match(/^\d{1,2}[/\-.]/) && l.length > 3);
              const amt = parseInt(amountMatch[0].replace(/[^0-9]/g, ""), 10) || 0;
              movements.push({ date: dateMatch[1], description: descLine || "", amount: amt, balance: 0, source: "account" });
            }
          }
        }
      }
    }

    return movements;
  });

  // Normalize dates and amounts in Node context (page.evaluate runs in browser)
  return deduplicateMovements(
    rawMovements.map((m: BankMovement) => ({
      ...m,
      date: normalizeDate(m.date),
    }))
  );
}

async function paginateAccountMovements(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  const allMovements: BankMovement[] = [];

  for (let i = 0; i < 20; i++) {
    const movements = await extractAccountMovements(page);
    allMovements.push(...movements);

    const isDisabled = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
      for (const btn of candidates) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
        if (text === "siguiente" || text === "›" || text === ">") {
          return (btn as HTMLButtonElement).disabled || (btn as HTMLElement).classList.contains("disabled") || (btn as HTMLElement).getAttribute("aria-disabled") === "true";
        }
      }
      return true;
    });

    if (isDisabled) break;

    await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
      for (const btn of candidates) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
        if (text === "siguiente" || text === "›" || text === ">") {
          (btn as HTMLElement).click();
          return;
        }
      }
    });
    await delay(3000);
  }

  return allMovements;
}

// ─── CMR (TC) helpers ───────────────────────────────────────────

async function waitForCmrMovements(page: Page, timeoutMs = 30000): Promise<void> {
  try {
    await page.waitForFunction((host: string) => {
      const el = document.querySelector(host);
      if (!el?.shadowRoot) return false;
      return el.shadowRoot.querySelectorAll("table tbody tr td").length > 0;
    }, { timeout: timeoutMs }, SHADOW_HOST);
  } catch { /* timeout — continue */ }
  await delay(500);
}

async function extractCupos(page: Page, debugLog: string[]): Promise<CreditCardBalance | null> {
  try {
    const cupoData = await page.evaluate(() => {
      const text = document.body?.innerText || "";

      let label = "";
      const labelMatch = text.match(/(CMR\s+\w+(?:\s+\w+)?)\s*\n?\s*[•·*\s]+\s*(\d{4})/i);
      if (labelMatch) label = `${labelMatch[1]} ****${labelMatch[2]}`;

      const cupoMatch = text.match(/\$([\d.,]+)\s*\n?\s*Cupo de compras/i);
      const usadoMatch = text.match(/\$([\d.,]+)\s*\n?\s*Cupo utilizado/i);
      const disponibleMatch = text.match(/\$([\d.,]+)\s*\n?\s*Cupo disponible/i);

      return { label, cupo: cupoMatch?.[1], usado: usadoMatch?.[1], disponible: disponibleMatch?.[1] };
    });

    if (!cupoData.cupo && !cupoData.disponible) {
      debugLog.push("  CMR: No cupo data found on page");
      return null;
    }

    const total = cupoData.cupo ? parseChileanAmount(cupoData.cupo) : 0;
    const used = cupoData.usado ? parseChileanAmount(cupoData.usado) : 0;
    const available = cupoData.disponible ? parseChileanAmount(cupoData.disponible) : 0;

    debugLog.push(`  CMR cupos: total=$${total}, used=$${used}, available=$${available}`);
    return {
      label: cupoData.label || "CMR",
      national: { total, used, available },
    };
  } catch (err) {
    debugLog.push(`  CMR: Could not extract cupos: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const TAB_IDS: Record<string, string> = {
  "últimos movimientos": "last-movements",
  "movimientos facturados": "invoicedMovements",
};

async function clickCmrTab(page: Page, tabText: string, debugLog: string[]): Promise<boolean> {
  const tabId = TAB_IDS[tabText.toLowerCase()] || "";
  const clicked = await page.evaluate((text: string, host: string, radioId: string) => {
    const shadowEl = document.querySelector(host);
    const roots: Array<Document | ShadowRoot> = [];
    if (shadowEl?.shadowRoot) roots.push(shadowEl.shadowRoot);
    roots.push(document);
    for (const root of roots) {
      if (radioId) {
        const radio = root.querySelector(`#${radioId}`) as HTMLInputElement | null;
        if (radio) {
          radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
          radio.click();
          return true;
        }
      }
      const labels = Array.from(root.querySelectorAll("label"));
      for (const label of labels) {
        const t = label.innerText?.trim().toLowerCase() || "";
        if (t.includes(text.toLowerCase())) {
          label.click();
          return true;
        }
      }
    }
    return false;
  }, tabText, SHADOW_HOST, tabId);

  if (clicked) debugLog.push(`  CMR: Clicked tab "${tabText}"`);
  return clicked;
}

async function extractCmrMovementsFromTable(page: Page): Promise<BankMovement[]> {
  return await page.evaluate((host: string) => {
    const movements: BankMovement[] = [];

    const shadowEl = document.querySelector(host);
    const root = shadowEl?.shadowRoot || document;
    const tables = root.querySelectorAll("table");

    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll("tbody tr"));

      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 4) continue;

        const texts = Array.from(cells).map(c => (c as HTMLElement).innerText?.trim() || "");

        const dateMatch = texts[0]?.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
        const pendingImg = row.querySelector("td:first-child img[alt*='pendiente'], td:first-child .td-time-img");
        const isPending = !!pendingImg || texts[0] === "";

        if (!dateMatch && !isPending) continue;

        const date = dateMatch ? dateMatch[1].replace(/\//g, "-") : "pendiente";
        const description = texts[1] || "";
        const montoText = texts[3] || "";

        const isNegativeInSource = montoText.includes("-$");
        const amountMatch = montoText.match(/\$\s*([\d.,]+)/);
        let amount = 0;
        if (amountMatch) {
          const clean = amountMatch[1].replace(/\./g, "").replace(",", ".");
          const value = parseInt(clean, 10) || 0;
          amount = isNegativeInSource ? value : -value;
        }

        const persona = texts[2] || undefined;
        const installments = texts[4] || undefined;

        if (description && amount !== 0) {
          movements.push({ date, description, amount, balance: 0, source: "credit_card_unbilled", owner: persona as CardOwner | undefined, installments });
        }
      }
    }

    return movements;
  }, SHADOW_HOST);
}

async function paginateCmrMovements(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  const allMovements: BankMovement[] = [];

  for (let i = 0; i < 20; i++) {
    const movements = await extractCmrMovementsFromTable(page);
    allMovements.push(...movements);

    const hasNext = await page.evaluate((host: string) => {
      const shadowEl = document.querySelector(host);
      const root = shadowEl?.shadowRoot || document;
      const paginationBtns = Array.from(root.querySelectorAll(".btn-pagination"));
      for (const btn of paginationBtns) {
        const el = btn as HTMLButtonElement;
        const img = el.querySelector("img");
        if (!img) continue;
        const alt = (img.getAttribute("alt") || "").toLowerCase();
        const src = img.getAttribute("src") || "";
        const isNext = alt.includes("avanzar") || alt.includes("siguiente") || alt.includes("next") || src.includes("right-arrow");
        if (isNext && !el.disabled) {
          el.click();
          return true;
        }
      }
      return false;
    }, SHADOW_HOST);

    if (!hasNext) break;
    await waitForCmrMovements(page);
  }

  // Normalize in Node context (page.evaluate runs in browser)
  return deduplicateMovements(
    allMovements.map((m) => ({
      ...m,
      date: normalizeDate(m.date),
      owner: normalizeOwner(m.owner),
      installments: normalizeInstallments(m.installments),
    }))
  );
}

// ─── Main scraper ───────────────────────────────────────────────

async function scrape(options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, chromePath, saveScreenshots: doScreenshots, headful, owner = "B" } = options;
  const bank = "falabella";

  if (!rut || !password) {
    return { success: false, bank, movements: [], error: "Debes proveer RUT y clave." };
  }

  const executablePath = findChrome(chromePath);
  if (!executablePath) {
    return {
      success: false, bank, movements: [],
      error: "No se encontró Chrome/Chromium. Instala Google Chrome o pasa chromePath en las opciones.\n  Ubuntu/Debian: sudo apt install google-chrome-stable\n  macOS: brew install --cask google-chrome",
    };
  }

  let browser;
  const debugLog: string[] = [];
  const doSave = async (page: Page, name: string) => saveScreenshot(page, name, !!doScreenshots, debugLog);

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: !headful,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--window-size=1280,900", "--disable-blink-features=AutomationControlled", "--disable-notifications"],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // Step 1: Navigate
    debugLog.push("1. Navigating to bank homepage...");
    await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 30000 });
    await delay(2000);

    // Dismiss cookie banner
    try {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, a, span"));
        for (const btn of btns) {
          if ((btn as HTMLElement).innerText?.trim().toLowerCase() === "entendido") {
            (btn as HTMLElement).click(); return;
          }
        }
      });
      await delay(1000);
    } catch { /* no banner */ }

    await doSave(page, "01-homepage");

    // Step 2: Click "Mi cuenta"
    debugLog.push("2. Clicking 'Mi cuenta'...");
    const miCuentaClicked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a, button"));
      for (const link of links) {
        const text = (link as HTMLElement).innerText?.trim();
        if (text === "Mi cuenta") { (link as HTMLElement).click(); return true; }
      }
      return false;
    });

    if (!miCuentaClicked) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return { success: false, bank, movements: [], error: "No se encontró el botón 'Mi cuenta'", screenshot: screenshot as string, debug: debugLog.join("\n") };
    }

    await delay(4000);
    await doSave(page, "02-login-form");

    // Step 3: Fill RUT
    debugLog.push("3. Filling RUT...");
    const rutFilled = await fillRut(page, rut);
    if (!rutFilled) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return { success: false, bank, movements: [], error: `No se encontró campo de RUT en ${page.url()}`, screenshot: screenshot as string, debug: debugLog.join("\n") };
    }
    await delay(1500);

    // Step 4: Fill password
    debugLog.push("4. Filling password...");
    let passwordFilled = await fillPassword(page, password);
    if (!passwordFilled) {
      await page.keyboard.press("Enter");
      await delay(3000);
      passwordFilled = await fillPassword(page, password);
    }
    if (!passwordFilled) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return { success: false, bank, movements: [], error: `No se encontró campo de clave en ${page.url()}`, screenshot: screenshot as string, debug: debugLog.join("\n") };
    }
    await delay(1000);

    // Step 5: Submit login
    debugLog.push("5. Submitting login...");
    await clickSubmitButton(page);
    await delay(8000);
    await doSave(page, "03-after-login");

    // Check 2FA
    const pageContent = (await page.content()).toLowerCase();
    if (pageContent.includes("clave dinámica") || pageContent.includes("clave dinamica") || pageContent.includes("segundo factor") || pageContent.includes("código de verificación")) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return { success: false, bank, movements: [], error: "El banco pide clave dinámica (2FA). No se puede automatizar este paso.", screenshot: screenshot as string, debug: debugLog.join("\n") };
    }

    // Check login errors
    const errorCheck = await page.evaluate(() => {
      const errorEls = document.querySelectorAll('[class*="error"], [class*="alert"], [role="alert"], [class*="Error"]');
      for (const el of errorEls) {
        const text = (el as HTMLElement).innerText?.trim();
        if (text && text.length > 5 && text.length < 200) return text;
      }
      return null;
    });
    if (errorCheck) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return { success: false, bank, movements: [], error: `Error del banco: ${errorCheck}`, screenshot: screenshot as string, debug: debugLog.join("\n") };
    }

    debugLog.push(`6. Login OK!`);
    await closePopups(page);
    await doSave(page, "04-post-login");

    // Save dashboard URL for returning after account movements phase
    const dashboardUrl = page.url();

    // ── Phase 1: Account movements ──────────────────────────────

    debugLog.push("7. [Cuenta] Looking for Cartola/Movimientos...");
    let navigated = await clickNavTarget(page, debugLog);

    if (!navigated) {
      debugLog.push("  No Cartola link found. Looking for account to click...");
      const clickedAccount = await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll("a, div, button, tr, li"));
        for (const el of allElements) {
          const text = (el as HTMLElement).innerText?.trim() || "";
          const href = (el as HTMLAnchorElement).href || "";
          if (href.includes("cc-nuevos") || href.includes("comenzar")) continue;
          if ((text.toLowerCase().includes("cuenta corriente") || text.toLowerCase().includes("cuenta vista")) && text.length < 100) {
            if (el.tagName === "A") { (el as HTMLElement).click(); return `Clicked: "${text.substring(0, 60)}"`; }
            const childLink = el.querySelector("a:not([href*='cc-nuevos'])") as HTMLElement;
            if (childLink) { childLink.click(); return `Clicked child: "${childLink.innerText?.trim().substring(0, 60)}"`; }
            (el as HTMLElement).click();
            return `Clicked element: "${text.substring(0, 60)}"`;
          }
        }
        return null;
      });

      if (clickedAccount) {
        debugLog.push(`  ${clickedAccount}`);
        await delay(4000);
        if (page.url().includes("web2.bancofalabella") || page.url().includes("web-clientes")) {
          navigated = await clickNavTarget(page, debugLog);
        }
      }
    }

    await doSave(page, "05-account-movements");
    await tryExpandDateRange(page, debugLog);

    const accountMovements = await paginateAccountMovements(page, debugLog);
    debugLog.push(`8. [Cuenta] Extracted ${accountMovements.length} movements`);

    let balance: number | undefined;
    if (accountMovements.length > 0 && accountMovements[0].balance > 0) {
      balance = accountMovements[0].balance;
    } else {
      balance = await page.evaluate(() => {
        const bodyText = document.body?.innerText || "";
        const match = bodyText.match(/Saldo disponible[\s\S]{0,50}\$\s*([\d.]+)/i);
        if (match) return parseInt(match[1].replace(/[^0-9]/g, ""), 10);
        return undefined;
      });
    }

    // ── Phase 2: CMR credit card movements ──────────────────────

    debugLog.push("9. [CMR] Navigating back to authenticated dashboard...");
    await page.goto(dashboardUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await delay(2000);
    await closePopups(page);

    debugLog.push("10. [CMR] Extracting credit card cupos...");
    const cmrBalance = await extractCupos(page, debugLog);
    const creditCards: CreditCardBalance[] = cmrBalance ? [cmrBalance] : [];

    debugLog.push("11. [CMR] Looking for CMR card product...");
    const cardClicked = await page.evaluate(() => {
      const cardSelectors = [
        "#cardDetail0",
        "[id^='cardDetail']",
        "app-credit-cards .card",
        "[class*='credit-card'] .card",
        "[class*='creditCard']",
      ];
      for (const sel of cardSelectors) {
        const el = document.querySelector(sel);
        if (el) { (el as HTMLElement).click(); return `Clicked: ${sel}`; }
      }

      const elements = Array.from(document.querySelectorAll("a, button, div, li, [role='button']"));
      for (const el of elements) {
        const text = (el as HTMLElement).innerText?.trim() || "";
        if (text.toLowerCase().includes("cmr") && text.length < 100) {
          (el as HTMLElement).click();
          return `Clicked: "${text.substring(0, 60)}"`;
        }
      }
      return null;
    });

    if (cardClicked) {
      debugLog.push(`  ${cardClicked}`);
      await waitForCmrMovements(page);
    }

    await doSave(page, "06-cmr-card");

    // Filter by owner if specified
    if (owner !== "B") {
      const ownerLabel = owner === "T" ? "Titular" : "Adicional";
      debugLog.push(`  CMR: Filtering by ${ownerLabel}`);
      await page.evaluate((host: string, value: string) => {
        const shadowEl = document.querySelector(host);
        const root = shadowEl?.shadowRoot || document;
        const select = root.querySelector("select[name='searchownership']") as HTMLSelectElement | null;
        if (select) {
          select.value = value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, SHADOW_HOST, owner);
      await waitForCmrMovements(page);
    }

    debugLog.push("12. [CMR] Extracting TC por facturar...");
    const recentMovements = await paginateCmrMovements(page, debugLog);
    debugLog.push(`  TC por facturar: ${recentMovements.length}`);

    const taggedRecent = recentMovements.map(m => ({
      ...m,
      source: MOVEMENT_SOURCE.credit_card_unbilled,
    }));

    debugLog.push("13. [CMR] Extracting TC facturados...");
    const facturadosClicked = await clickCmrTab(page, "movimientos facturados", debugLog);

    let taggedFacturados: BankMovement[] = [];
    if (facturadosClicked) {
      try {
        await page.waitForFunction((host: string) => {
          const el = document.querySelector(host);
          if (!el?.shadowRoot) return false;
          return el.shadowRoot.querySelector("app-invoiced-movements table tbody tr td") !== null;
        }, { timeout: 30000 }, SHADOW_HOST);
      } catch { /* timeout */ }
      await delay(1000);
      await doSave(page, "07-cmr-facturados");

      const facturadosMovements = await paginateCmrMovements(page, debugLog);
      debugLog.push(`  TC facturados: ${facturadosMovements.length}`);

      taggedFacturados = facturadosMovements.map(m => ({
        ...m,
        source: MOVEMENT_SOURCE.credit_card_billed,
      }));
    }

    // Dedup TC movements across tabs
    const tcMovements = deduplicateMovements([...taggedRecent, ...taggedFacturados]);

    const allMovements = [...accountMovements, ...tcMovements];
    debugLog.push(`14. Total movements: ${allMovements.length} (account: ${accountMovements.length}, TC: ${tcMovements.length})`);

    await doSave(page, "08-final");
    const screenshot = doScreenshots ? ((await page.screenshot({ encoding: "base64", fullPage: true })) as string) : undefined;

    return {
      success: true,
      bank,
      movements: deduplicateMovements(allMovements),
      balance: balance || undefined,
      creditCards: creditCards.length > 0 ? creditCards : undefined,
      screenshot,
      debug: debugLog.join("\n"),
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

// ─── Export ─────────────────────────────────────────────────────

const falabella: BankScraper = {
  id: "falabella",
  name: "Banco Falabella",
  url: "https://www.bancofalabella.cl",
  scrape,
};

export default falabella;
