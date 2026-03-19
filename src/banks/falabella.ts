import type { Page } from "puppeteer-core";
import type { BankMovement, BankScraper, CardOwner, CreditCardBalance, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, deduplicateMovements, normalizeDate, normalizeOwner, normalizeInstallments, parseChileanAmount } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { fillRut, fillPassword, clickSubmit } from "../actions/login.js";
import { clickByText, dismissBanners } from "../actions/navigation.js";
import { extractAccountMovements } from "../actions/extraction.js";
import { paginateAndExtract } from "../actions/pagination.js";

// ─── Falabella-specific constants ────────────────────────────────

const BANK_URL = "https://www.bancofalabella.cl";
const SHADOW_HOST = "credit-card-movements";

// ─── Falabella-specific helpers ──────────────────────────────────

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
        if (text.includes("todos") || text.includes("último mes") || text.includes("30 día") || text.includes("mes anterior")) {
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
    const clickedSearch = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, input[type='submit']"));
      for (const btn of buttons) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
        if (text === "buscar" || text === "consultar" || text === "filtrar") { (btn as HTMLElement).click(); return text; }
      }
      return null;
    });
    if (clickedSearch) { debugLog.push(`  Clicked "${clickedSearch}"`); await delay(3000); }
  } catch { /* ignore */ }
}

async function clickNavTarget(page: Page, debugLog: string[]): Promise<boolean> {
  const targets = [
    { text: "cartola", exact: false },
    { text: "últimos movimientos", exact: false },
    { text: "movimientos", exact: true },
    { text: "estado de cuenta", exact: false },
  ];
  for (const target of targets) {
    const result = await page.evaluate((t: { text: string; exact: boolean }) => {
      const elements = Array.from(document.querySelectorAll("a, button, [role='tab'], [role='menuitem'], li, span"));
      for (const el of elements) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
        const href = (el as HTMLAnchorElement).href || "";
        if (href.includes("cc-nuevos") || href.includes("comenzar")) continue;
        if (text.includes("historial de transferencia")) continue;
        const match = t.exact ? text === t.text : text.includes(t.text);
        if (match && text.length < 50) { (el as HTMLElement).click(); return `Clicked: "${text}"`; }
      }
      return null;
    }, target);
    if (result) { debugLog.push(`  ${result}`); await delay(4000); return true; }
  }
  return false;
}

// ─── CMR Shadow DOM helpers ──────────────────────────────────────

async function waitForCmrMovements(page: Page, timeoutMs = 30000): Promise<void> {
  try {
    await page.waitForFunction((host: string) => {
      const el = document.querySelector(host);
      if (!el?.shadowRoot) return false;
      return el.shadowRoot.querySelectorAll("table tbody tr td").length > 0;
    }, { timeout: timeoutMs }, SHADOW_HOST);
  } catch { /* timeout */ }
  await delay(500);
}

async function extractCupos(page: Page, debugLog: string[]): Promise<CreditCardBalance | null> {
  try {
    const cupoData = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const labelMatch = text.match(/(CMR\s+\w+(?:\s+\w+)?)\s*\n?\s*[•·*\s]+\s*(\d{4})/i);
      const label = labelMatch ? `${labelMatch[1]} ****${labelMatch[2]}` : "";
      const cupoMatch = text.match(/\$([\d.,]+)\s*\n?\s*Cupo de compras/i);
      const usadoMatch = text.match(/\$([\d.,]+)\s*\n?\s*Cupo utilizado/i);
      const disponibleMatch = text.match(/\$([\d.,]+)\s*\n?\s*Cupo disponible/i);
      return { label, cupo: cupoMatch?.[1], usado: usadoMatch?.[1], disponible: disponibleMatch?.[1] };
    });
    if (!cupoData.cupo && !cupoData.disponible) return null;
    const total = cupoData.cupo ? parseChileanAmount(cupoData.cupo) : 0;
    const used = cupoData.usado ? parseChileanAmount(cupoData.usado) : 0;
    const available = cupoData.disponible ? parseChileanAmount(cupoData.disponible) : 0;
    debugLog.push(`  CMR cupos: total=$${total}, used=$${used}, available=$${available}`);
    return { label: cupoData.label || "CMR", national: { total, used, available } };
  } catch { return null; }
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
        if (radio) { radio.checked = true; radio.dispatchEvent(new Event("change", { bubbles: true })); radio.click(); return true; }
      }
      const labels = Array.from(root.querySelectorAll("label"));
      for (const label of labels) {
        if (label.innerText?.trim().toLowerCase().includes(text.toLowerCase())) { label.click(); return true; }
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
    for (const table of root.querySelectorAll("table")) {
      for (const row of Array.from(table.querySelectorAll("tbody tr"))) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 4) continue;
        const texts = Array.from(cells).map(c => (c as HTMLElement).innerText?.trim() || "");
        const dateMatch = texts[0]?.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
        const pendingImg = row.querySelector("td:first-child img[alt*='pendiente'], td:first-child .td-time-img");
        if (!dateMatch && !pendingImg && texts[0] !== "") continue;
        const date = dateMatch ? dateMatch[1].replace(/\//g, "-") : "pendiente";
        const description = texts[1] || "";
        const montoText = texts[3] || "";
        const isNeg = montoText.includes("-$");
        const amountMatch = montoText.match(/\$\s*([\d.,]+)/);
        let amount = 0;
        if (amountMatch) {
          const value = parseInt(amountMatch[1].replace(/\./g, "").replace(",", "."), 10) || 0;
          amount = isNeg ? value : -value;
        }
        if (description && amount !== 0)
          movements.push({ date, description, amount, balance: 0, source: "credit_card_unbilled", owner: (texts[2] || undefined) as CardOwner | undefined, installments: texts[4] || undefined });
      }
    }
    return movements;
  }, SHADOW_HOST);
}

async function paginateCmrMovements(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  const all: BankMovement[] = [];
  for (let i = 0; i < 20; i++) {
    all.push(...await extractCmrMovementsFromTable(page));
    const hasNext = await page.evaluate((host: string) => {
      const root = (document.querySelector(host) as Element & { shadowRoot?: ShadowRoot })?.shadowRoot || document;
      for (const btn of Array.from(root.querySelectorAll(".btn-pagination"))) {
        const el = btn as HTMLButtonElement;
        const img = el.querySelector("img");
        if (!img) continue;
        const alt = (img.getAttribute("alt") || "").toLowerCase();
        const src = img.getAttribute("src") || "";
        if ((alt.includes("avanzar") || alt.includes("siguiente") || alt.includes("next") || src.includes("right-arrow")) && !el.disabled) { el.click(); return true; }
      }
      return false;
    }, SHADOW_HOST);
    if (!hasNext) break;
    await waitForCmrMovements(page);
  }
  return deduplicateMovements(all.map(m => ({ ...m, date: normalizeDate(m.date), owner: normalizeOwner(m.owner), installments: normalizeInstallments(m.installments) })));
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeFalabella(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots, owner = "B" } = options;
  const { onProgress } = options;
  const progress = onProgress || (() => {});
  const { page, debugLog, screenshot: doSave } = session;
  const bank = "falabella";

  // 1. Navigate
  debugLog.push("1. Navigating to bank homepage...");
  progress("Abriendo sitio del banco...");
  await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(2000);
  await dismissBanners(page);
  await doSave(page, "01-homepage");

  // 2. Click "Mi cuenta"
  debugLog.push("2. Clicking 'Mi cuenta'...");
  progress("Ingresando a Mi cuenta...");
  if (!(await clickByText(page, ["Mi cuenta"], "a, button"))) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, movements: [], error: "No se encontró 'Mi cuenta'", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(4000);
  await doSave(page, "02-login-form");

  // 3-5. Login
  debugLog.push("3. Filling RUT...");
  progress("Ingresando RUT...");
  if (!(await fillRut(page, rut))) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, movements: [], error: "No se encontró campo de RUT", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(1500);

  debugLog.push("4. Filling password...");
  progress("Ingresando clave...");
  let passOk = await fillPassword(page, password);
  if (!passOk) { await page.keyboard.press("Enter"); await delay(3000); passOk = await fillPassword(page, password); }
  if (!passOk) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, movements: [], error: "No se encontró campo de clave", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(1000);

  debugLog.push("5. Submitting login...");
  progress("Iniciando sesión...");
  await clickSubmit(page, page);
  await delay(8000);
  await doSave(page, "03-after-login");

  // 2FA check
  const pageContent = (await page.content()).toLowerCase();
  if (pageContent.includes("clave dinámica") || pageContent.includes("segundo factor")) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, movements: [], error: "El banco pide clave dinámica (2FA).", screenshot: ss as string, debug: debugLog.join("\n") };
  }

  // Login error check
  const errorCheck = await page.evaluate(() => {
    const els = document.querySelectorAll('[class*="error"], [class*="alert"], [role="alert"]');
    for (const el of els) { const t = (el as HTMLElement).innerText?.trim(); if (t && t.length > 5 && t.length < 200) return t; }
    return null;
  });
  if (errorCheck) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, movements: [], error: `Error del banco: ${errorCheck}`, screenshot: ss as string, debug: debugLog.join("\n") };
  }

  debugLog.push("6. Login OK!");
  progress("Sesión iniciada correctamente");
  await closePopups(page);
  const dashboardUrl = page.url();

  // ── Phase 1: Account movements ──
  debugLog.push("7. [Cuenta] Looking for Cartola/Movimientos...");
  progress("Buscando cartola de cuenta...");
  let navigated = await clickNavTarget(page, debugLog);
  if (!navigated) {
    const clickedAccount = await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll("a, div, button, tr, li"))) {
        const text = (el as HTMLElement).innerText?.trim() || "";
        const href = (el as HTMLAnchorElement).href || "";
        if (href.includes("cc-nuevos") || href.includes("comenzar")) continue;
        if ((text.toLowerCase().includes("cuenta corriente") || text.toLowerCase().includes("cuenta vista")) && text.length < 100) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    if (clickedAccount) { await delay(4000); navigated = await clickNavTarget(page, debugLog); }
  }

  await tryExpandDateRange(page, debugLog);
  progress("Extrayendo movimientos de cuenta...");
  const accountMovements = await paginateAndExtract(page, extractAccountMovements, debugLog);
  debugLog.push(`8. [Cuenta] ${accountMovements.length} movements`);
  progress(`Cuenta: ${accountMovements.length} movimientos encontrados`);

  let balance: number | undefined;
  if (accountMovements.length > 0 && accountMovements[0].balance > 0) balance = accountMovements[0].balance;
  if (balance === undefined) {
    balance = await page.evaluate(() => {
      const match = (document.body?.innerText || "").match(/Saldo disponible[\s\S]{0,50}\$\s*([\d.]+)/i);
      if (match) return parseInt(match[1].replace(/[^0-9]/g, ""), 10);
      return undefined;
    });
  }

  // ── Phase 2: CMR credit card movements ──
  debugLog.push("9. [CMR] Navigating back to dashboard...");
  progress("Navegando a tarjeta de crédito...");
  await page.goto(dashboardUrl, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(2000);
  await closePopups(page);

  const cmrBalance = await extractCupos(page, debugLog);
  const creditCards: CreditCardBalance[] = cmrBalance ? [cmrBalance] : [];

  debugLog.push("11. [CMR] Looking for CMR card...");
  const cardClicked = await page.evaluate(() => {
    for (const sel of ["#cardDetail0", "[id^='cardDetail']", "app-credit-cards .card", "[class*='credit-card'] .card", "[class*='creditCard']"]) {
      const el = document.querySelector(sel);
      if (el) { (el as HTMLElement).click(); return true; }
    }
    for (const el of Array.from(document.querySelectorAll("a, button, div, li, [role='button']"))) {
      if ((el as HTMLElement).innerText?.trim().toLowerCase().includes("cmr") && (el as HTMLElement).innerText!.length < 100) { (el as HTMLElement).click(); return true; }
    }
    return false;
  });
  if (cardClicked) await waitForCmrMovements(page);

  // Owner filter
  if (owner !== "B") {
    await page.evaluate((host: string, value: string) => {
      const root = (document.querySelector(host) as Element & { shadowRoot?: ShadowRoot })?.shadowRoot || document;
      const select = root.querySelector("select[name='searchownership']") as HTMLSelectElement | null;
      if (select) { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }
    }, SHADOW_HOST, owner);
    await waitForCmrMovements(page);
  }

  debugLog.push("12. [CMR] Extracting TC por facturar...");
  progress("Extrayendo movimientos TC por facturar...");
  const recentMovements = await paginateCmrMovements(page, debugLog);
  const taggedRecent = recentMovements.map(m => ({ ...m, source: MOVEMENT_SOURCE.credit_card_unbilled }));

  debugLog.push("13. [CMR] Extracting TC facturados...");
  progress("Extrayendo movimientos TC facturados...");
  let taggedFacturados: BankMovement[] = [];
  if (await clickCmrTab(page, "movimientos facturados", debugLog)) {
    try { await page.waitForFunction((host: string) => {
      const el = document.querySelector(host);
      return el?.shadowRoot?.querySelector("app-invoiced-movements table tbody tr td") !== null;
    }, { timeout: 30000 }, SHADOW_HOST); } catch { /* timeout */ }
    await delay(1000);
    taggedFacturados = (await paginateCmrMovements(page, debugLog)).map(m => ({ ...m, source: MOVEMENT_SOURCE.credit_card_billed }));
  }

  const tcMovements = deduplicateMovements([...taggedRecent, ...taggedFacturados]);
  const allMovements = deduplicateMovements([...accountMovements, ...tcMovements]);
  debugLog.push(`14. Total: ${allMovements.length} (account: ${accountMovements.length}, TC: ${tcMovements.length})`);
  progress(`Listo — ${allMovements.length} movimientos totales`);

  await doSave(page, "08-final");
  const ss = doScreenshots ? (await page.screenshot({ encoding: "base64", fullPage: true })) as string : undefined;

  return { success: true, bank, movements: allMovements, balance: balance || undefined, creditCards: creditCards.length > 0 ? creditCards : undefined, screenshot: ss, debug: debugLog.join("\n") };
}

// ─── Export ──────────────────────────────────────────────────────

const falabella: BankScraper = {
  id: "falabella",
  name: "Banco Falabella",
  url: BANK_URL,
  scrape: (options) => runScraper("falabella", options, { extraArgs: ["--disable-notifications"] }, scrapeFalabella),
};

export default falabella;
