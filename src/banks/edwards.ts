import type { Frame, Page } from "puppeteer-core";
import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { closePopups, delay, deduplicateMovements } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { fillRut, fillPassword, clickSubmit, detectLoginError } from "../actions/login.js";
import { dismissBanners } from "../actions/navigation.js";
import { extractAccountMovements } from "../actions/extraction.js";
import { paginateAndExtract } from "../actions/pagination.js";
import { extractBalance } from "../actions/balance.js";
import { clickTcTab, extractCreditCardMovements } from "../actions/credit-card.js";

// ─── Edwards-specific constants ──────────────────────────────────

const BANK_URL = "https://portalpersonas.bancochile.cl/persona/";

// ─── Edwards-specific helpers ────────────────────────────────────

const NAV_TARGETS = [
  { text: "saldos y mov. cuentas", exact: false },
  { text: "saldos y mov. tarjetas", exact: false },
  { text: "cartola", exact: false },
  { text: "últimos movimientos", exact: false },
  { text: "movimientos", exact: true },
  { text: "estado de cuenta", exact: false },
  { text: "historial", exact: false },
];

async function clickNavTarget(page: Page, debugLog: string[]): Promise<boolean> {
  for (const target of NAV_TARGETS) {
    const result = await page.evaluate((t: { text: string; exact: boolean }) => {
      const elements = Array.from(document.querySelectorAll("a, button, [role='tab'], [role='menuitem'], li, span"));
      for (const el of elements) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
        const match = t.exact ? text === t.text : text.includes(t.text);
        if (match && text.length < 50) { (el as HTMLElement).click(); return `Clicked: "${text}"`; }
      }
      return null;
    }, target);
    if (result) { debugLog.push(`  ${result}`); await delay(4000); return true; }
  }
  return false;
}

async function tryExpandDateRange(page: Page, debugLog: string[]): Promise<void> {
  try {
    const selectInfo = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      return selects.map((sel, i) => ({
        index: i, name: sel.name || sel.id || `select-${i}`,
        options: Array.from(sel.querySelectorAll("option")).map((o) => ({ text: o.text.trim(), value: o.value })),
      }));
    });
    for (const sel of selectInfo) {
      for (const opt of sel.options) {
        const text = opt.text.toLowerCase();
        if (text.includes("todos") || text.includes("último mes") || text.includes("30 día") || text.includes("60 día") || text.includes("90 día") || text.includes("6 mes") || text.includes("3 mes") || text.includes("mes anterior")) {
          await page.evaluate((selIdx: number, optValue: string) => {
            const selects = document.querySelectorAll("select");
            const select = selects[selIdx] as HTMLSelectElement;
            if (select) { select.value = optValue; select.dispatchEvent(new Event("change", { bubbles: true })); }
          }, sel.index, opt.value);
          debugLog.push(`  Changed [${sel.name}] to "${opt.text}"`);
          await delay(3000);
          break;
        }
      }
    }
  } catch { /* ignore */ }
}

async function edwardsPaginate(page: Page, extractFn: (page: Page) => Promise<BankMovement[]>, debugLog: string[]): Promise<BankMovement[]> {
  const all: BankMovement[] = [];
  for (let i = 0; i < 50; i++) {
    all.push(...await extractFn(page));
    // Edwards uses Angular Material / bch-paginator next buttons
    const clicked = await page.evaluate(() => {
      const matNext = document.querySelector(".mat-paginator-navigation-next:not([disabled])");
      if (matNext) { (matNext as HTMLElement).click(); return true; }
      const bchNext = document.querySelector("bch-paginator button[aria-label*='siguiente'], bch-paginator button[aria-label*='next']");
      if (bchNext && !(bchNext as HTMLButtonElement).disabled) { (bchNext as HTMLElement).click(); return true; }
      const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
      for (const btn of candidates) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
        if (text === "siguiente" || text === "›" || text === ">" || text?.includes("ver más")) {
          if ((btn as HTMLButtonElement).disabled || (btn as HTMLElement).classList.contains("disabled")) return false;
          (btn as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    if (!clicked) break;
    await delay(3000);
  }
  return deduplicateMovements(all);
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeEdwards(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const { onProgress } = options;
  const bank = "edwards";
  const progress = onProgress || (() => {});

  // 1. Navigate
  debugLog.push("1. Navigating to Banco Edwards...");
  progress("Abriendo sitio del banco...");
  await page.goto(BANK_URL, { waitUntil: "load", timeout: 30000 });
  await delay(5000);
  await dismissBanners(page);
  await doSave(page, "01-loaded");

  // Check for iframe login
  const frames = page.frames();
  const bodyLen = await page.evaluate(() => document.body?.innerText?.length ?? 0);
  let loginCtx: Page | Frame = page;
  if (bodyLen === 0 && frames.length > 1) {
    const f = frames.find((fr) => fr !== page.mainFrame() && fr.url() && !fr.url().startsWith("about:"));
    if (f) { loginCtx = f; debugLog.push("  Formulario en iframe"); }
  }

  // 2-4. Login
  debugLog.push("2. Filling RUT...");
  progress("Ingresando RUT...");
  if (!(await fillRut(loginCtx as unknown as Page, rut))) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró campo de RUT", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(1500);

  debugLog.push("3. Filling password...");
  let passOk = await fillPassword(page, password);
  if (!passOk) { await page.keyboard.press("Enter"); await delay(3000); passOk = await fillPassword(page, password); }
  if (!passOk) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró campo de clave", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(1000);

  debugLog.push("4. Submitting login...");
  progress("Iniciando sesión...");
  await clickSubmit(page, page);
  await delay(8000);
  await doSave(page, "02-after-login");

  // Error check
  const loginError = await detectLoginError(page);
  if (loginError) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: `Error del banco: ${loginError}`, screenshot: ss as string, debug: debugLog.join("\n") };
  }

  debugLog.push("5. Login OK!");
  progress("Sesión iniciada correctamente");
  await closePopups(page);

  // 6. Navigate to movements
  debugLog.push("6. Looking for Cartola/Movimientos...");
  progress("Buscando cartola de cuenta...");
  let navigated = await clickNavTarget(page, debugLog);
  if (!navigated) {
    const clickedAccount = await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll("a, div, button, tr, li"))) {
        const text = (el as HTMLElement).innerText?.trim() || "";
        if ((text.toLowerCase().includes("cuenta corriente") || text.toLowerCase().includes("cuenta vista") || text.toLowerCase().includes("cuenta")) && text.length < 100) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    if (clickedAccount) { await delay(4000); navigated = await clickNavTarget(page, debugLog); }
  }

  await tryExpandDateRange(page, debugLog);

  let movements = await edwardsPaginate(page, extractAccountMovements, debugLog);
  movements = deduplicateMovements(movements);

  // 7b. Credit card movements
  debugLog.push("7b. Navigating to Tarjetas de Crédito...");
  progress("Navegando a tarjeta de crédito...");
  const baseUrl = page.url().split("#")[0];
  await page.goto(`${baseUrl}#/home`, { waitUntil: "load", timeout: 15000 });
  await delay(3000);

  // Try TC navigation targets
  const TC_TARGETS = ["saldos y mov. tarjetas", "tarjetas crédito"];
  let tcClicked = false;
  for (const t of TC_TARGETS) {
    const result = await page.evaluate((text: string) => {
      for (const el of Array.from(document.querySelectorAll("a, button, [role='tab'], [role='menuitem'], li, span"))) {
        const t = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
        if (t.includes(text) && t.length < 50) { (el as HTMLElement).click(); return true; }
      }
      return false;
    }, t);
    if (result) { tcClicked = true; await delay(4000); break; }
  }

  if (tcClicked) {
    if (await clickTcTab(page, "movimientos por facturar")) {
      const tcPorFact = await edwardsPaginate(page, (p) => extractCreditCardMovements(p, "unbilled"), debugLog);
      movements.push(...tcPorFact);
      debugLog.push(`  TC por facturar: ${tcPorFact.length}`);
    }
    if (await clickTcTab(page, "movimientos facturados")) {
      const tcFact = await edwardsPaginate(page, (p) => extractCreditCardMovements(p, "billed"), debugLog);
      movements.push(...tcFact);
      debugLog.push(`  TC facturados: ${tcFact.length}`);
    }
    movements = deduplicateMovements(movements);
  }

  debugLog.push(`8. Extracted ${movements.length} movements`);
  progress(`Listo — ${movements.length} movimientos totales`);

  let balance: number | undefined;
  const withBalance = movements.find((m) => m.balance > 0);
  if (withBalance) balance = withBalance.balance;
  if (balance === undefined || balance === 0) balance = await extractBalance(page);

  await doSave(page, "04-final");
  const ss = doScreenshots ? (await page.screenshot({ encoding: "base64", fullPage: true })) as string : undefined;

  return { success: true, bank, accounts: [{ balance: balance || undefined, movements }], screenshot: ss, debug: debugLog.join("\n") };
}

// ─── Export ──────────────────────────────────────────────────────

const edwards: BankScraper = {
  id: "edwards",
  name: "Banco Edwards",
  url: BANK_URL,
  scrape: (options) => runScraper("edwards", options, {}, scrapeEdwards),
};

export default edwards;
