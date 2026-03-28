import type { Page, Frame } from "puppeteer-core";
import type { BankMovement, BankScraper, CreditCardBalance, MovementSource, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, formatRut, parseChileanAmount, normalizeDate, deduplicateMovements } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { detect2FA, waitFor2FA } from "../actions/two-factor.js";
import { detectLoginError } from "../actions/login.js";

// ─── BCI-specific constants ──────────────────────────────────────

const LOGIN_URL = "https://www.bci.cl/corporativo/banco-en-linea/personas";

const IFRAME_PATTERNS = {
  content: ["miBanco.jsf", "vistaSupercartola"],
  movements: "fe-saldosultimosmov",
  tcMovements: "fe-mismovimientos",
  tcCupo: "vistaSaldosTDC.jsf",
} as const;

const TWO_FACTOR_CONFIG = {
  keywords: ["bci pass", "segundo factor", "aprobación en tu app", "autorizar en tu app", "confirmar en tu app"],
  timeoutEnvVar: "BCI_2FA_TIMEOUT_SEC",
};

const TC_COMBINATIONS = [
  { tab: "Nacional $", billingType: "No facturados", source: MOVEMENT_SOURCE.credit_card_unbilled },
  { tab: "Nacional $", billingType: "Facturados", source: MOVEMENT_SOURCE.credit_card_billed },
  { tab: "Internacional USD", billingType: "No facturados", source: MOVEMENT_SOURCE.credit_card_unbilled },
  { tab: "Internacional USD", billingType: "Facturados", source: MOVEMENT_SOURCE.credit_card_billed },
];

const NEXT_PAGE_TEXTS = ["navigate_next", "siguiente"];
const ACCOUNT_SELECT = "bci-wk-select#cuenta select, select";

// ─── BCI-specific helpers ────────────────────────────────────────

async function clickByTitle(page: Page, title: string): Promise<boolean> {
  return page.evaluate((t: string) => {
    const link = document.querySelector(`a[title="${t}"]`) as HTMLElement | null;
    if (link) { link.click(); return true; }
    return false;
  }, title);
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

async function bciLogin(
  page: Page, rut: string, password: string, debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>,
): Promise<{ success: boolean; error?: string; screenshot?: string }> {
  debugLog.push("1. Navigating to BCI login...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await delay(3000);
  await doSave(page, "01-login-form");

  debugLog.push("2. Filling RUT...");
  const cleanRut = rut.replace(/[.\-\s]/g, "");
  const rutBody = cleanRut.slice(0, -1);
  const rutDv = cleanRut.slice(-1);
  const filled = await page.evaluate((formatted: string, body: string, dv: string) => {
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
  }, formatRut(rut), rutBody, rutDv);
  if (!filled) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "Campo de RUT no encontrado.", screenshot: ss as string };
  }

  debugLog.push("  Filling password...");
  const passFilled = await page.evaluate((pass: string) => {
    const clave = document.getElementById("clave") as HTMLInputElement | null;
    if (!clave) return false;
    clave.value = pass;
    clave.dispatchEvent(new Event("input", { bubbles: true }));
    clave.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, password);
  if (!passFilled) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "Campo de clave no encontrado.", screenshot: ss as string };
  }

  await delay(500);
  debugLog.push("3. Submitting login...");
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    if (btn) btn.disabled = false;
    const form = document.getElementById("frm") as HTMLFormElement | null;
    if (form) form.submit();
    else if (btn) btn.click();
  });
  try { await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }); } catch { /* SPA */ }
  await delay(3000);
  await doSave(page, "03-post-login");

  // 2FA
  if (await detect2FA(page, TWO_FACTOR_CONFIG)) {
    await doSave(page, "03b-2fa-challenge");
    const approved = await waitFor2FA(page, debugLog, TWO_FACTOR_CONFIG);
    if (!approved) {
      const ss = await page.screenshot({ encoding: "base64" });
      return { success: false, error: "Timeout esperando BCI Pass.", screenshot: ss as string };
    }
    await delay(3000);
  }

  const loginError = await detectLoginError(page);
  if (loginError) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: `Error del banco: ${loginError}`, screenshot: ss as string };
  }

  if (page.url().includes("banco-en-linea/personas")) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "Login no navegó fuera de la página.", screenshot: ss as string };
  }

  debugLog.push("4. Login OK!");
  return { success: true };
}

async function extractMovementsFromFrame(frame: Frame, debugLog: string[]): Promise<BankMovement[]> {
  await frame.evaluate(() => {
    for (const opt of document.querySelectorAll("a, button, span, option")) {
      if ((opt as HTMLElement).innerText?.trim() === "50") { (opt as HTMLElement).click(); return; }
    }
  });
  await delay(3000);

  const all: BankMovement[] = [];
  for (let pageIndex = 0; pageIndex < 25; pageIndex++) {
    const raw = await frame.evaluate(() => {
      const results: Array<{ date: string; description: string; cargo: string; abono: string }> = [];
      for (const row of Array.from(document.querySelectorAll("table tbody tr"))) {
        const cells = Array.from(row.querySelectorAll("td"));
        if (cells.length < 4) continue;
        const date = cells[0].textContent?.trim() || "";
        if (!/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(date)) continue;
        results.push({ date, description: cells[1].textContent?.trim() || "", cargo: cells[2].textContent?.trim() || "", abono: cells[3].textContent?.trim() || "" });
      }
      return results;
    });
    for (const r of raw) {
      const cargoAmount = r.cargo ? parseChileanAmount(r.cargo) : 0;
      const abonoAmount = r.abono ? parseChileanAmount(r.abono) : 0;
      const amount = cargoAmount > 0 ? -cargoAmount : abonoAmount;
      if (amount === 0) continue;
      all.push({ date: normalizeDate(r.date), description: r.description, amount, balance: 0, source: MOVEMENT_SOURCE.account });
    }
    debugLog.push(`  Page ${pageIndex + 1}: ${raw.length} raw movements`);

    const hasNext = await frame.evaluate((nextTexts: string[]) => {
      for (const btn of document.querySelectorAll("button, a")) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || "";
        if (nextTexts.some((t) => text === t || text.includes(t))) {
          if ((btn as HTMLButtonElement).disabled || btn.getAttribute("aria-disabled") === "true") return false;
          (btn as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, [...NEXT_PAGE_TEXTS]);
    if (!hasNext) break;
    await delay(3000);
  }
  return all;
}

async function extractTCMovements(frame: Frame, tab: string, billingType: string, source: MovementSource, debugLog: string[]): Promise<BankMovement[]> {
  await frame.evaluate((tabName: string) => {
    for (const span of document.querySelectorAll("bci-wk-tabs span, .listTab span, .listTab a span")) {
      if (span.textContent?.trim() === tabName) { (span.closest("a") || span as HTMLElement).click(); return; }
    }
  }, tab);
  await delay(2000);

  await frame.evaluate((btnText: string) => {
    for (const btn of document.querySelectorAll("button")) {
      if (btn.textContent?.trim() === btnText) { btn.click(); return; }
    }
  }, billingType);
  await delay(2000);

  const hasNoMovements = await frame.evaluate(() => {
    const text = document.body?.innerText?.toLowerCase() || "";
    return text.includes("no tienes movimientos") || text.includes("sin movimientos");
  });
  if (hasNoMovements) { debugLog.push(`    ${tab} / ${billingType}: sin movimientos`); return []; }

  const raw = await frame.evaluate(() => {
    const results: Array<{ date: string; description: string; amount: string }> = [];
    for (const row of document.querySelectorAll("table tbody tr, .wrapper-table tr")) {
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
  for (const r of raw) {
    const numStr = r.amount.replace(/[^0-9.\-,]/g, "");
    const amount = parseFloat(numStr.replace(/\./g, "").replace(",", ".")) || 0;
    if (amount === 0) continue;
    movements.push({ date: normalizeDate(r.date), description: r.description, amount: -Math.abs(amount), balance: 0, source });
  }
  debugLog.push(`    ${tab} / ${billingType}: ${movements.length} movimientos`);
  return movements;
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeBci(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const { onProgress } = options;
  const bank = "bci";
  const progress = onProgress || (() => {});

  progress("Abriendo sitio del banco...");
  const loginResult = await bciLogin(page, rut, password, debugLog, doSave);
  if (!loginResult.success) {
    return { success: false, bank, movements: [], error: loginResult.error, screenshot: loginResult.screenshot, debug: debugLog.join("\n") };
  }

  progress("Sesión iniciada correctamente");
  await closePopups(page);
  await delay(2000);

  // Account movements
  progress("Extrayendo movimientos de cuenta...");
  debugLog.push("5. Fetching account movements...");
  const allMovements: BankMovement[] = [];
  let balance: number | undefined;

  if (await clickByTitle(page, "Últimos Movimientos")) {
    const movFrame = await waitForFrame(page, IFRAME_PATTERNS.movements, 15000);
    if (movFrame) {
      await delay(3000);
      const accounts = await movFrame.evaluate((sel: string) => {
        const select = document.querySelector(sel) as HTMLSelectElement | null;
        if (!select) return [];
        return Array.from(select.options).map((o) => ({ value: o.value, label: o.textContent?.trim() || "" }));
      }, ACCOUNT_SELECT);
      debugLog.push(`  Found ${accounts.length} account(s)`);

      for (let i = 0; i < accounts.length; i++) {
        if (i > 0) {
          await movFrame.evaluate((value: string, sel: string) => {
            const select = document.querySelector(sel) as HTMLSelectElement | null;
            if (!select) return;
            select.value = value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }, accounts[i].value, ACCOUNT_SELECT);
          await delay(3000);
        }
        if (balance === undefined) {
          balance = await movFrame.evaluate(() => {
            const el = document.querySelector("#saldoDis + div, .bci-h2-w800");
            if (!el) return undefined;
            const match = (el as HTMLElement).textContent?.trim().match(/\$\s*([\d.]+)/);
            if (match) return parseInt(match[1].replace(/\./g, ""), 10);
            return undefined;
          });
        }
        const movements = await extractMovementsFromFrame(movFrame, debugLog);
        const prefixed = accounts.length > 1 ? movements.map(m => ({ ...m, description: `[${accounts[i].label}] ${m.description}`.trim() })) : movements;
        allMovements.push(...prefixed);
      }
    }
  }

  // Credit cards
  progress("Extrayendo datos de tarjeta de crédito...");
  debugLog.push("6. Navigating to credit cards...");
  const creditCards: CreditCardBalance[] = [];
  if (await clickByTitle(page, "Tarjetas")) {
    await delay(3000);
    const cardLabels = await page.evaluate(() => {
      const selects = document.querySelectorAll("select.tdc");
      if (selects.length === 0) return [];
      return Array.from((selects[0] as HTMLSelectElement).options).map((o) => o.textContent?.trim() || "");
    });

    if (cardLabels.length > 0 && await clickByTitle(page, "Mis movimientos")) {
      const tcFrame = await waitForFrame(page, IFRAME_PATTERNS.tcMovements, 15000);
      if (tcFrame) {
        await delay(3000);
        for (const { tab, billingType, source } of TC_COMBINATIONS) {
          const movements = await extractTCMovements(tcFrame, tab, billingType, source, debugLog);
          allMovements.push(...movements);
        }
      }

      if (await clickByTitle(page, "Cupo disponible")) {
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
            return { nationalUsed: natUsed ? parseAmt(natUsed[1]) : 0, nationalAvailable: natAvail ? parseAmt(natAvail[1]) : 0, nationalTotal: natTotal ? parseAmt(natTotal[1]) : 0, internationalUsed: intUsed ? parseAmt(intUsed[1]) : 0, internationalAvailable: intAvail ? parseAmt(intAvail[1]) : 0, internationalTotal: intTotal ? parseAmt(intTotal[1]) : 0 };
          });
          for (const label of cardLabels) {
            const card: CreditCardBalance = { label, national: { used: cupoData.nationalUsed, available: cupoData.nationalAvailable, total: cupoData.nationalTotal } };
            if (cupoData.internationalTotal > 0) card.international = { used: cupoData.internationalUsed, available: cupoData.internationalAvailable, total: cupoData.internationalTotal, currency: "USD" };
            creditCards.push(card);
          }
        }
      }
    }
  }

  const deduplicated = deduplicateMovements(allMovements);
  debugLog.push(`  Total: ${deduplicated.length} unique movements`);
  progress(`Listo — ${deduplicated.length} movimientos totales`);
  await doSave(page, "06-final");
  const ss = doScreenshots ? (await page.screenshot({ encoding: "base64" })) as string : undefined;

  return { success: true, bank, movements: deduplicated, balance, creditCards: creditCards.length > 0 ? creditCards : undefined, screenshot: ss, debug: debugLog.join("\n") };
}

// ─── Export ──────────────────────────────────────────────────────

const bci: BankScraper = {
  id: "bci",
  name: "BCI",
  url: "https://www.bci.cl/personas",
  scrape: (options) => runScraper("bci", options, {}, scrapeBci),
};

export default bci;
