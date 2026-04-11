import type { Page } from "puppeteer-core";
import type { BankScraper, BankMovement, CreditCardBalance, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, deduplicateMovements, normalizeDate, normalizeInstallments } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { fillRut, fillPassword, clickSubmit, detectLoginError } from "../actions/login.js";

// ─── Constants ───────────────────────────────────────────────────

const LOGIN_URL = "https://www.mitarjetacencosud.cl/login";
const BANK_ID = "cencosud";

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Detect whether an hCaptcha/reCAPTCHA challenge is currently blocking the page.
 */
async function detectCaptcha(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    if (document.querySelector('iframe[src*="hcaptcha"], iframe[src*="recaptcha"]')) return true;
    if (document.querySelector('.h-captcha, .g-recaptcha, [id*="hcaptcha"], [class*="hcaptcha"]')) return true;
    const text = (document.body?.innerText || "").toLowerCase();
    return text.includes("select all images") || text.includes("i am not a robot");
  });
}

/**
 * Wait up to `timeoutSec` seconds for the user to solve the CAPTCHA.
 * Returns true when the CAPTCHA disappears, false on timeout.
 */
async function waitForCaptcha(
  page: Page,
  debugLog: string[],
  timeoutSec = 180,
): Promise<boolean> {
  debugLog.push(`  CAPTCHA detectado — resuelve manualmente en el navegador (${timeoutSec}s máx)...`);
  const start = Date.now();
  while ((Date.now() - start) / 1000 < timeoutSec) {
    const still = await detectCaptcha(page);
    if (!still) {
      debugLog.push("  CAPTCHA resuelto, continuando...");
      return true;
    }
    await delay(2000);
  }
  debugLog.push(`  Timeout esperando CAPTCHA (${timeoutSec}s).`);
  return false;
}

/**
 * Click a link/button by its exact text, then wait for the SPA to settle.
 * Sets up waitForNavigation BEFORE the click to correctly catch SPA navigations.
 */
async function clickAndWait(
  page: Page,
  texts: string[],
  debugLog: string[],
  timeout = 15000,
): Promise<boolean> {
  for (const txt of texts) {
    // Register navigation listener before click so it catches the event
    const navPromise = page.waitForNavigation({ waitUntil: "networkidle2", timeout }).catch(() => {});
    const clicked = await page.evaluate((t: string) => {
      const els = Array.from(document.querySelectorAll("a, button, span, div, li"));
      for (const el of els) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
        if (text === t && text.length < 60) { (el as HTMLElement).click(); return true; }
      }
      return false;
    }, txt.toLowerCase());

    if (clicked) {
      await navPromise;
      debugLog.push(`  Clicked: "${txt}"`);
      await delay(2000);
      return true;
    } else {
      // Cancel the pending navPromise by navigating nowhere (it will resolve via catch)
      navPromise.catch(() => {});
    }
  }
  return false;
}

/**
 * Extract N/N pattern from raw installment text (e.g. "Cuota 01/01", "1/3") and
 * normalize to NN/NN format. Returns undefined for free-text like "3 Cuotas".
 */
function parseInstallments(raw?: string): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(/(\d{1,2})\/(\d{1,2})/);
  if (match) return normalizeInstallments(`${match[1]}/${match[2]}`);
  return normalizeInstallments(raw);
}

/**
 * Extract movements from the current page of the Cencosud movements table.
 * Detects the "Monto original" column dynamically from the thead so it works
 * for both the unbilled table (col 4) and the billed table (col 2).
 * Signs: positive page values = purchase (stored as negative), negative = credit/refund (positive).
 */
async function extractOnePage(
  page: Page,
  source: BankMovement["source"],
): Promise<BankMovement[]> {
  // Wait for any row-like structure to appear before extracting
  await Promise.race([
    page.waitForSelector("table tr, [role='row'], [role='grid']", { timeout: 6000 }).catch(() => {}),
    delay(6000),
  ]);
  await delay(500);

  const raw = await page.evaluate((src: string) => {
    const DATE_RE = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/;
    type RawMov = { date: string; description: string; amount: number; installments?: string; source: string };

    const findAmtIdx = (headers: string[]): number => {
      for (let i = headers.length - 1; i >= 0; i--) {
        if (headers[i].includes("monto original")) return i;
      }
      return headers.length > 0 ? headers.length - 1 : -1;
    };

    const parseAmt = (raw: string): { amount: number; isNeg: boolean } | null => {
      const isNeg = raw.includes("-");
      const clean = raw.replace(/\./g, "").replace(/[^\d]/g, "");
      const n = parseInt(clean, 10);
      return isNaN(n) || n === 0 ? null : { amount: isNeg ? n : -n, isNeg };
    };

    const movements: RawMov[] = [];

    // ── Strategy 1: real <table> (with or without <tbody>) ──────────
    for (const table of Array.from(document.querySelectorAll("table"))) {
      const headerEls = table.querySelectorAll("thead th, thead td");
      const headers = Array.from(headerEls).map((h) => (h as HTMLElement).innerText?.trim().toLowerCase() || "");
      const amtIdx = findAmtIdx(headers);
      const cuotasIdx = headers.findIndex((h) => h.includes("cuota"));

      const dataRows = Array.from(table.querySelectorAll("tbody tr, tr")).filter(
        (r) => r.querySelectorAll("td").length >= 3,
      );
      for (const row of dataRows) {
        const texts = Array.from(row.querySelectorAll("td")).map((c) => (c as HTMLElement).innerText?.trim() || "");
        const dateRaw = texts[0];
        const desc = texts[1] || "";
        if (!DATE_RE.test(dateRaw) || !desc.trim()) continue;
        const amtRaw = texts[amtIdx >= 0 && amtIdx < texts.length ? amtIdx : texts.length - 1] || "";
        const parsed = parseAmt(amtRaw);
        if (!parsed) continue;
        const installRaw = cuotasIdx >= 0 && cuotasIdx < texts.length ? texts[cuotasIdx] : "";
        const installments = /\d+\s*[Cc]uotas?|\d+\/\d+/.test(installRaw) ? installRaw : undefined;
        movements.push({ date: dateRaw, description: desc, amount: parsed.amount, installments, source: src });
      }
      if (movements.length > 0) return movements;
    }

    // ── Strategy 2: ARIA role="row" / role="gridcell" ───────────────
    const ariaRows = Array.from(document.querySelectorAll("[role='row']")).filter(
      (r) => r.querySelectorAll("[role='cell'], [role='gridcell']").length >= 3,
    );
    if (ariaRows.length > 0) {
      const headers = Array.from(document.querySelectorAll("[role='columnheader']")).map(
        (h) => (h as HTMLElement).innerText?.trim().toLowerCase() || "",
      );
      const amtIdx = findAmtIdx(headers);
      const cuotasIdx = headers.findIndex((h) => h.includes("cuota"));
      for (const row of ariaRows) {
        const texts = Array.from(row.querySelectorAll("[role='cell'], [role='gridcell']")).map(
          (c) => (c as HTMLElement).innerText?.trim() || "",
        );
        const dateRaw = texts[0];
        const desc = texts[1] || "";
        if (!DATE_RE.test(dateRaw) || !desc.trim()) continue;
        const amtRaw = texts[amtIdx >= 0 && amtIdx < texts.length ? amtIdx : texts.length - 1] || "";
        const parsed = parseAmt(amtRaw);
        if (!parsed) continue;
        const installRaw = cuotasIdx >= 0 && cuotasIdx < texts.length ? texts[cuotasIdx] : "";
        const installments = /\d+\s*[Cc]uotas?|\d+\/\d+/.test(installRaw) ? installRaw : undefined;
        movements.push({ date: dateRaw, description: desc, amount: parsed.amount, installments, source: src });
      }
      if (movements.length > 0) return movements;
    }

    // ── Strategy 3: div grid — deepest element with date + amount ───
    const NOISE = /(ver todos|movimientos no facturados|movimientos facturados|nacionales|internacionales|fecha|operaci)/i;
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const htmlEl = el as HTMLElement;
      if (htmlEl.offsetParent === null) continue;
      const text = htmlEl.innerText?.trim() || "";
      if (text.length < 8 || text.length > 250) continue;
      const dateMatch = text.match(DATE_RE);
      if (!dateMatch) continue;
      const amtMatch = text.match(/\$\s*([\d\.]{3,})/);
      if (!amtMatch) continue;
      if (NOISE.test(text)) continue;
      // Skip if any child also has both patterns (not the leaf)
      const childHasBoth = Array.from(htmlEl.children).some((c) => {
        const ct = (c as HTMLElement).innerText?.trim() || "";
        return DATE_RE.test(ct) && /\$\s*[\d\.]{3,}/.test(ct);
      });
      if (childHasBoth) continue;
      // "+$" before amount = credit/refund (store positive); otherwise = purchase (store negative)
      const isCredit = /\+\s*\$/.test(text);
      const absAmt = parseInt(amtMatch[1].replace(/\./g, ""), 10);
      if (isNaN(absAmt) || absAmt === 0) continue;
      // Clean description: strip date, all $amounts, interest-rate percentages, trailing sign
      let desc = text
        .replace(dateMatch[0], "")
        .replace(/\$[\d\.]+/g, "")
        .replace(/\b\d+[,.]\d+%/g, "")
        .replace(/\s+[+\-]\s*$/g, "")
        .replace(/\s+/g, " ")
        .trim();
      // Extract installments ("3 Cuotas", "Cuota 01/01") from description
      const installMatch = desc.match(/\b(\d+\s+[Cc]uotas?|[Cc]uota\s+\d+\/\d+)\b/);
      const installments = installMatch ? installMatch[0] : undefined;
      if (installments) desc = desc.replace(installments, "").replace(/\s+/g, " ").trim();
      movements.push({ date: dateMatch[1], description: desc, amount: isCredit ? absAmt : -absAmt, installments, source: src });
    }

    return movements;
  }, source);

  return raw.map((m) => {
    const inst = parseInstallments(m.installments);
    return {
      ...m,
      date: normalizeDate(m.date),
      balance: 0,
      source: source,
      ...(inst ? { installments: inst } : {}),
    };
  });
}

/**
 * Click the "next page" button in the Cencosud paginator.
 * Returns true if a next page exists and was clicked.
 */
async function clickNextPage(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // Look for a right-arrow / "siguiente" button that is enabled
    const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
    for (const el of candidates) {
      const text = (el as HTMLElement).innerText?.trim() || "";
      const label = (el as HTMLElement).getAttribute("aria-label")?.toLowerCase() || "";
      const isNext =
        text === "›" || text === ">" || text === "→" ||
        label.includes("siguiente") || label.includes("next") ||
        (el as HTMLElement).className?.toLowerCase().includes("next");
      if (!isNext) continue;
      if ((el as HTMLButtonElement).disabled || (el as HTMLElement).getAttribute("aria-disabled") === "true") return false;
      (el as HTMLElement).click();
      return true;
    }
    return false;
  });
}

/**
 * Extract ALL movements from a table section, paginating until no more pages.
 */
async function extractTableMovements(
  page: Page,
  source: BankMovement["source"],
  debugLog: string[],
): Promise<BankMovement[]> {
  // Diagnostics: log what table-like structures exist on the page
  const diag = await page.evaluate(() => ({
    tables: document.querySelectorAll("table").length,
    trs: document.querySelectorAll("tr").length,
    tds: document.querySelectorAll("td").length,
    ariaRows: document.querySelectorAll("[role='row']").length,
    ariaGridcells: document.querySelectorAll("[role='gridcell'], [role='cell']").length,
    ariaGrid: document.querySelectorAll("[role='grid'], [role='table']").length,
  }));
  debugLog.push(`    DOM: tables=${diag.tables} tr=${diag.trs} td=${diag.tds} role=row:${diag.ariaRows} gridcell:${diag.ariaGridcells} grid:${diag.ariaGrid}`);

  const all: BankMovement[] = [];
  for (let pageNum = 1; pageNum <= 30; pageNum++) {
    const batch = await extractOnePage(page, source);
    debugLog.push(`    page ${pageNum}: ${batch.length} rows`);
    all.push(...batch);
    const hasNext = await clickNextPage(page);
    if (!hasNext) break;
    await delay(2000);
  }
  return all;
}

/**
 * Extract the "Mis Productos" balance card from the post-login dashboard.
 * Returns { used, available, total } from "Línea de compras / Avances", or null if not found.
 */
async function extractDashboardBalance(
  page: Page,
): Promise<{ used: number; available: number; total: number } | null> {
  return page.evaluate(() => {
    // Find the smallest visible container that has all three labels
    const all = Array.from(document.querySelectorAll("*")) as HTMLElement[];
    const containers = all.filter((el) => {
      if (el.offsetParent === null) return false;
      const t = el.innerText?.toLowerCase() || "";
      return t.includes("utilizado") && t.includes("disponible") && t.includes("cupo total");
    });
    if (containers.length === 0) return null;

    // Prefer the most specific (fewest children)
    const container = containers.sort(
      (a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length,
    )[0];

    const text = container.innerText || "";
    const lower = text.toLowerCase();

    // For each label, grab the first $amount that appears after it in the text
    const getAmtAfter = (label: string): number => {
      const pos = lower.indexOf(label);
      if (pos < 0) return 0;
      const m = text.slice(pos).match(/\$([\d\.]+)/);
      return m ? parseInt(m[1].replace(/\./g, ""), 10) : 0;
    };

    const used = getAmtAfter("utilizado");
    const available = getAmtAfter("disponible");
    const total = getAmtAfter("cupo total");
    return used || available || total ? { used, available, total } : null;
  });
}

/**
 * Extract the card label from the movements page header.
 * The header shows: "Mastercard Black ●●●● 7779"
 */
async function extractCardLabel(page: Page): Promise<string> {
  return page.evaluate(() => {
    // Look for masked card number pattern next to a card brand name
    const all = Array.from(document.querySelectorAll("*"));
    for (const el of all) {
      const text = (el as HTMLElement).innerText?.trim() || "";
      // Pattern: "Mastercard Black ●●●● 7779" or "Visa ●●●● 1234"
      if (/[●•\*]{2,}\s*\d{4}/.test(text) && text.length < 50 && el.children.length <= 2) {
        return text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
      }
    }
    return "Tarjeta Cencosud";
  });
}

/**
 * Extract movements for a given tab (Nacionales / Internacionales).
 * Clicks the tab first, waits for content, then extracts all pages.
 */
async function extractTabMovements(
  page: Page,
  tabText: string,
  source: BankMovement["source"],
  debugLog: string[],
): Promise<BankMovement[]> {
  // Exact-match required: "nacionales" must not accidentally click a container
  // whose innerText *contains* "internacionales" (which includes "nacionales").
  const clicked = await page.evaluate((txt: string) => {
    for (const el of Array.from(document.querySelectorAll("[role='tab'], button, li, span, div"))) {
      if ((el as HTMLElement).innerText?.trim().toLowerCase() === txt) {
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, tabText.toLowerCase());

  if (clicked) {
    debugLog.push(`  Tab "${tabText}" selected`);
    await delay(2000);
  }

  return extractTableMovements(page, source, debugLog);
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeCencosud(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const { onProgress } = options;
  const progress = onProgress || (() => {});

  // 1. Navigate to login
  debugLog.push("1. Navigating to Tarjeta Cencosud...");
  progress("Abriendo sitio de Tarjeta Cencosud...");
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 40000 });
  await delay(2000);
  await closePopups(page);
  await doSave(page, "01-loaded");

  // 2. Fill RUT
  debugLog.push("2. Filling RUT...");
  progress("Ingresando RUT...");

  if (!await fillRut(page, rut, { rutFormat: "clean" })) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank: BANK_ID, accounts: [], error: "No se encontró campo de RUT", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(800);
  await doSave(page, "02-rut-filled");

  // 3. Fill password
  debugLog.push("3. Filling password...");
  progress("Ingresando clave...");

  if (!await fillPassword(page, password)) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank: BANK_ID, accounts: [], error: "No se encontró campo de clave", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(600);

  // 4. Submit — wait for navigation triggered by login
  debugLog.push("4. Submitting login...");
  progress("Iniciando sesión...");

  const loginNavPromise = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
  await clickSubmit(page, page, { submitTexts: ["ingresar", "entrar"] });

  // Give the page a moment to either navigate or show a CAPTCHA
  await delay(2500);

  // 4b. Handle CAPTCHA if it appeared instead of a navigation
  if (await detectCaptcha(page)) {
    if (!options.headful) {
      // Can't solve an image CAPTCHA in headless mode — tell the user to rerun headful
      const ss = await page.screenshot({ encoding: "base64" });
      return {
        success: false,
        bank: BANK_ID,
        accounts: [],
        error: "CAPTCHA detectado en modo headless. Ejecuta nuevamente con --headful para resolverlo manualmente.",
        screenshot: ss as string,
        debug: debugLog.join("\n"),
      };
    }
    progress("CAPTCHA detectado — resuélvelo en el navegador...");
    const captchaTimeoutSec = parseInt(process.env.CENCOSUD_CAPTCHA_TIMEOUT || "180", 10);
    const solved = await waitForCaptcha(page, debugLog, captchaTimeoutSec);
    if (!solved) {
      const ss = await page.screenshot({ encoding: "base64" });
      return { success: false, bank: BANK_ID, accounts: [], error: "Timeout esperando CAPTCHA — resuélvelo en el navegador y vuelve a intentarlo", screenshot: ss as string, debug: debugLog.join("\n") };
    }
    // After CAPTCHA is solved the form submits and the page navigates
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
    await delay(2000);
  } else {
    await loginNavPromise;
    await delay(2000);
  }

  await doSave(page, "03-after-login");

  // 5. Check for login error
  const loginError = await detectLoginError(page);
  if (loginError) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank: BANK_ID, accounts: [], error: `Error del banco: ${loginError}`, screenshot: ss as string, debug: debugLog.join("\n") };
  }

  debugLog.push("5. Login OK!");
  progress("Sesión iniciada");
  await closePopups(page);
  await delay(1000);

  // 5b. Extract balance from the "Mis Productos" dashboard card
  debugLog.push("5b. Extracting dashboard balance...");
  const dashBalance = await extractDashboardBalance(page);
  if (dashBalance) {
    debugLog.push(`  Utilizado: ${dashBalance.used} | Disponible: ${dashBalance.available} | Cupo Total: ${dashBalance.total}`);
  } else {
    debugLog.push("  Balance card not found");
  }

  // 6. Navigate to full movements page via "Ver todos"
  debugLog.push("6. Navigating to full movements page...");
  progress("Abriendo página de movimientos...");

  const navOk = await clickAndWait(page, ["Ver todos", "Ver todo", "Ver más movimientos"], debugLog, 20000);
  if (!navOk) {
    // Fallback: sidebar "Movimientos" link
    await clickAndWait(page, ["Movimientos", "Mis movimientos"], debugLog, 15000);
  }
  await doSave(page, "04-movements-page");

  // 7. Extract card label from movements page header
  debugLog.push("7. Extracting card label...");
  const cardLabel = await extractCardLabel(page);
  debugLog.push(`  Label: ${cardLabel}`);

  // 8. Extract UNBILLED movements — Nacionales tab
  debugLog.push("8. Extracting unbilled movements...");
  progress("Extrayendo movimientos no facturados...");

  const unbilledNac = await extractTabMovements(page, "nacionales", MOVEMENT_SOURCE.credit_card_unbilled, debugLog);
  debugLog.push(`  Unbilled nacionales: ${unbilledNac.length}`);

  const unbilledInt = await extractTabMovements(page, "internacionales", MOVEMENT_SOURCE.credit_card_unbilled, debugLog);
  debugLog.push(`  Unbilled internacionales: ${unbilledInt.length}`);

  // 9. Navigate to BILLED movements
  debugLog.push("9. Navigating to billed movements...");
  progress("Abriendo movimientos facturados...");

  const billedNavOk = await clickAndWait(
    page,
    ["Ir a Movimientos Facturados", "Movimientos Facturados", "Facturados", "Estado de cuenta"],
    debugLog,
    20000,
  );

  let billedMovements: BankMovement[] = [];

  if (billedNavOk) {
    await doSave(page, "05-billed-page");
    // Billed page has no nacionales/internacionales tabs — extract once
    billedMovements = await extractTableMovements(page, MOVEMENT_SOURCE.credit_card_billed, debugLog);
    debugLog.push(`  Billed: ${billedMovements.length}`);
  } else {
    debugLog.push("  Could not navigate to billed movements");
  }

  // 10. Combine and deduplicate
  const allMovements = deduplicateMovements([...unbilledNac, ...unbilledInt, ...billedMovements]);
  debugLog.push(`10. Total movements: ${allMovements.length}`);
  progress(`Listo — ${allMovements.length} movimientos`);

  await doSave(page, "06-final");
  const ss = doScreenshots ? ((await page.screenshot({ encoding: "base64", fullPage: true })) as string) : undefined;

  const creditCard: CreditCardBalance = {
    label: cardLabel,
    ...(dashBalance ? { national: dashBalance } : {}),
    movements: allMovements,
  };

  return {
    success: true,
    bank: BANK_ID,
    accounts: [],
    creditCards: [creditCard],
    screenshot: ss,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────────

const cencosud: BankScraper = {
  id: BANK_ID,
  name: "Tarjeta Cencosud",
  url: LOGIN_URL,
  scrape: (options) => runScraper(BANK_ID, options, {}, scrapeCencosud),
};

export default cencosud;
