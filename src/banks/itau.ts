import type { Page } from "puppeteer-core";
import type { AccountBalance, BankMovement, BankScraper, CreditCardBalance, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, formatRut, parseChileanAmount, normalizeDate, deduplicateMovements, normalizeInstallments } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { detect2FA, waitFor2FA } from "../actions/two-factor.js";

// ─── Itaú-specific constants ─────────────────────────────────────

const LOGIN_URL = "https://banco.itau.cl/wps/portal/newolb/web/login";
const PORTAL_BASE = "https://banco.itau.cl/wps/myportal/newolb/web";

const TWO_FACTOR_CONFIG = {
  keywords: ["itaú key", "aprueba", "segundo factor", "autoriza"],
  timeoutEnvVar: "ITAU_2FA_TIMEOUT_SEC",
};

// ─── Itaú-specific helpers ───────────────────────────────────────

async function itauLogin(
  page: Page,
  rut: string,
  password: string,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>,
): Promise<{ success: boolean; error?: string; screenshot?: string }> {
  debugLog.push("1. Navigating to login page...");
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(2000);
  await doSave(page, "01-login");

  debugLog.push("2. Filling RUT...");
  const rutEl = await page.$("#loginNameID");
  if (!rutEl) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró campo de RUT (#loginNameID)", screenshot: ss as string };
  }
  await rutEl.click({ clickCount: 3 });
  await rutEl.type(formatRut(rut), { delay: 45 });

  debugLog.push("3. Filling password...");
  const passEl = await page.$("#pswdId");
  if (!passEl) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró campo de clave (#pswdId)", screenshot: ss as string };
  }
  await passEl.click();
  await passEl.type(password, { delay: 45 });

  debugLog.push("4. Submitting login...");
  await doSave(page, "02-pre-submit");
  await page.evaluate(() => { const btn = document.getElementById("btnLoginRecaptchaV3"); if (btn) btn.click(); });
  try { await page.waitForNavigation({ timeout: 20000 }); } catch { /* SPA */ }
  await delay(3000);
  await doSave(page, "03-after-submit");

  // Login error check
  const errorText = await page.evaluate(() => {
    const sels = ['[class*="error"]', '[class*="alert"]', '[role="alert"]', ".msg-error-input"];
    for (const sel of sels) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const t = (el as HTMLElement).innerText?.trim();
        if (t && t.length > 3 && t.length < 300 && (el as HTMLElement).offsetParent !== null) {
          const lower = t.toLowerCase();
          if (lower.includes("incorrecto") || lower.includes("bloqueada") || lower.includes("suspendida") || lower.includes("inválido")) return t;
        }
      }
    }
    return null;
  });
  if (errorText) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: `Error de login: ${errorText}`, screenshot: ss as string };
  }

  // 2FA
  if (await detect2FA(page, TWO_FACTOR_CONFIG)) {
    debugLog.push("5. 2FA detected...");
    await doSave(page, "04-2fa");
    const approved = await waitFor2FA(page, debugLog, TWO_FACTOR_CONFIG);
    if (!approved) {
      const ss = await page.screenshot({ encoding: "base64" });
      return { success: false, error: "2FA no fue aprobado a tiempo (Itaú Key)", screenshot: ss as string };
    }
    await delay(3000);
  }

  debugLog.push("5. Login OK!");
  return { success: true };
}

async function extractBalance(page: Page, debugLog: string[]): Promise<number | undefined> {
  debugLog.push("6. Extracting balance...");
  await page.goto(`${PORTAL_BASE}/cuentas/cuenta-corriente/saldos`, { waitUntil: "networkidle2", timeout: 20000 });
  await delay(2000);
  const balance = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const match = text.match(/Saldo disponible para uso\s*\$\s*([\d.,]+)/);
    if (match) return parseInt(match[1].replace(/[^0-9]/g, ""), 10);
    return undefined;
  });
  if (balance !== undefined) debugLog.push(`  Balance: $${balance.toLocaleString("es-CL")}`);
  return balance;
}

async function extractMovements(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  debugLog.push("7. Extracting movements...");
  await page.goto(`${PORTAL_BASE}/cuentas/cuenta-corriente/saldos-ultimo-movimiento`, { waitUntil: "networkidle2", timeout: 20000 });
  await delay(3000);

  const allMovements: BankMovement[] = [];

  for (let pageNum = 1; pageNum <= 10; pageNum++) {
    const pageMovements = await page.evaluate(() => {
      const results: Array<{ date: string; description: string; cargo: string; abono: string; saldo: string }> = [];
      const rows = document.querySelectorAll("table tbody tr");
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td"));
        if (cells.length !== 6) continue;
        const date = cells[0].innerText?.trim() || "";
        if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) continue;
        results.push({ date, description: cells[1].innerText?.trim() || "", cargo: cells[2].innerText?.trim() || "", abono: cells[3].innerText?.trim() || "", saldo: cells[4].innerText?.trim() || "" });
      }
      return results;
    });

    for (const m of pageMovements) {
      const cargoVal = parseChileanAmount(m.cargo);
      const abonoVal = parseChileanAmount(m.abono);
      const amount = abonoVal > 0 ? abonoVal : -cargoVal;
      if (amount === 0) continue;
      allMovements.push({ date: normalizeDate(m.date), description: m.description, amount, balance: parseChileanAmount(m.saldo), source: MOVEMENT_SOURCE.account });
    }
    debugLog.push(`  Page ${pageNum}: ${pageMovements.length} movements`);

    const hasNext = await page.evaluate(() => {
      const pageInfo = document.body?.innerText?.match(/Página (\d+) de (\d+)/);
      if (pageInfo && parseInt(pageInfo[1], 10) >= parseInt(pageInfo[2], 10)) return false;
      const nextBtn = document.querySelector('a[name="nextbtn"]') as HTMLElement | null;
      if (nextBtn) { nextBtn.click(); return true; }
      return false;
    });
    if (!hasNext) break;
    await delay(3000);
  }

  return allMovements;
}

async function extractCreditCardData(page: Page, debugLog: string[]): Promise<{ movements: BankMovement[]; creditCards: CreditCardBalance[] }> {
  debugLog.push("8. Extracting credit card data...");
  const movements: BankMovement[] = [];
  const creditCards: CreditCardBalance[] = [];

  await page.goto(`${PORTAL_BASE}/tarjeta-credito/resumen/deuda`, { waitUntil: "networkidle2", timeout: 20000 });
  await delay(3000);

  const tcInfo = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const cardMatch = text.match(/(Mastercard|Visa)\s+[\w\s]+\*{4}\s*\*{4}\s*\*{4}\s*(\d{4})/i);
    const label = cardMatch ? cardMatch[0].replace(/\*{4}\s*\*{4}\s*\*{4}\s*/, "****").replace(/\s+/g, " ").trim() : null;
    const nacSection = text.match(/Nacional[\s\S]*?(?=Internacional|Ofertas|Movimientos|$)/)?.[0] || "";
    const nacDisponible = nacSection.match(/Cupo disponible\s*\$\s*([\d.]+)/);
    const nacUtilizado = nacSection.match(/Cupo utilizado\s*(?:[\s\S]*?\$\s*([\d.]+))?/);
    const intSection = text.match(/Internacional[\s\S]*?(?=Ofertas|Movimientos|Emergencias|$)/)?.[0] || "";
    const intUsdValues = [...intSection.matchAll(/USD\$?\s*(-?[\d.,]+)/g)].map(m => m[1]);
    const proxFactMatch = text.match(/Próxima facturación\s*(\d{2}\/\d{2}\/\d{4})/);
    const noFacturados: Array<{ date: string; desc: string; amount: string }> = [];
    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      const prevText = (table.previousElementSibling as HTMLElement)?.innerText?.toLowerCase() || "";
      if (prevText.includes("no facturad")) {
        const rows = table.querySelectorAll("tbody tr");
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll("td"));
          if (cells.length >= 3) noFacturados.push({ date: cells[0].innerText?.trim() || "", desc: cells[1].innerText?.trim() || "", amount: cells[cells.length - 1].innerText?.trim() || "" });
        }
      }
    }
    return { label, nacDisponible: nacDisponible?.[1], nacUtilizado: nacUtilizado?.[1], intDisponible: intUsdValues[2] || null, intUtilizado: intUsdValues[1] || null, intTotal: intUsdValues[0] || null, proxFact: proxFactMatch?.[1], noFacturados };
  });

  if (tcInfo.label) {
    const nacUsed = parseChileanAmount(tcInfo.nacUtilizado || "0");
    const nacAvailable = parseChileanAmount(tcInfo.nacDisponible || "0");
    const card: CreditCardBalance = { label: tcInfo.label, national: { used: nacUsed, available: nacAvailable, total: nacUsed + nacAvailable }, movements: [] };
    if (tcInfo.intDisponible) {
      const parseUsd = (s: string) => parseFloat(s.replace(/\./g, "").replace(",", ".")) || 0;
      card.international = { used: Math.abs(parseUsd(tcInfo.intUtilizado || "0")), available: parseUsd(tcInfo.intDisponible || "0"), total: parseUsd(tcInfo.intTotal || "0"), currency: "USD" };
    }
    if (tcInfo.proxFact) card.nextBillingDate = normalizeDate(tcInfo.proxFact);
    creditCards.push(card);

    for (const m of tcInfo.noFacturados) {
      const amount = parseChileanAmount(m.amount);
      if (amount === 0) continue;
      movements.push({ date: normalizeDate(m.date), description: m.desc, amount: -amount, balance: 0, source: MOVEMENT_SOURCE.credit_card_unbilled });
    }
    debugLog.push(`  No-facturados: ${tcInfo.noFacturados.length}`);
  }

  // Facturados
  await page.goto(`${PORTAL_BASE}/tarjeta-credito/resumen/cuenta-nacional`, { waitUntil: "networkidle2", timeout: 20000 });
  await delay(3000);

  const facturados = await page.evaluate(() => {
    const results: Array<{ date: string; desc: string; amount: string; cuota: string }> = [];
    const rows = document.querySelectorAll("table tbody tr");
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 7) continue;
      const dateText = cells[1]?.innerText?.trim() || "";
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dateText)) continue;
      results.push({ date: dateText, desc: cells[3]?.innerText?.trim() || "", amount: cells[4]?.innerText?.trim() || "", cuota: cells[6]?.innerText?.trim() || "" });
    }
    return results;
  });

  for (const m of facturados) {
    const amount = parseChileanAmount(m.amount);
    if (amount === 0) continue;
    movements.push({ date: normalizeDate(m.date), description: m.desc, amount: amount > 0 ? -amount : Math.abs(amount), balance: 0, source: MOVEMENT_SOURCE.credit_card_billed, installments: normalizeInstallments(m.cuota) });
  }
  debugLog.push(`  Facturados: ${facturados.length}`);

  return { movements, creditCards };
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeItau(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots } = options;
  const { onProgress } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const bank = "itau";
  const progress = onProgress || (() => {});

  progress("Abriendo sitio del banco...");
  const loginResult = await itauLogin(page, rut, password, debugLog, doSave);
  if (!loginResult.success) {
    return { success: false, bank, accounts: [], error: loginResult.error, screenshot: loginResult.screenshot, debug: debugLog.join("\n") };
  }

  progress("Sesión iniciada correctamente");
  await closePopups(page);

  progress("Extrayendo saldo...");
  const balance = await extractBalance(page, debugLog);

  progress("Extrayendo movimientos de cuenta...");
  const accountMovements = await extractMovements(page, debugLog);
  progress(`Cuenta: ${accountMovements.length} movimientos`);

  progress("Extrayendo datos de tarjeta de crédito...");
  const tcResult = await extractCreditCardData(page, debugLog);

  const deduplicatedAccount = deduplicateMovements(accountMovements);

  debugLog.push(`9. Total: ${deduplicatedAccount.length} account movements`);
  progress(`Listo — ${deduplicatedAccount.length} movimientos totales`);
  await doSave(page, "05-final");
  const ss = doScreenshots ? (await page.screenshot({ encoding: "base64" })) as string : undefined;

  const accounts: AccountBalance[] = [{ balance, movements: deduplicatedAccount }];
  return { success: true, bank, accounts, creditCards: tcResult.creditCards.length > 0 ? tcResult.creditCards : undefined, screenshot: ss, debug: debugLog.join("\n") };
}

// ─── Export ──────────────────────────────────────────────────────

const itau: BankScraper = {
  id: "itau",
  name: "Itaú",
  url: "https://banco.itau.cl",
  scrape: (options) => runScraper("itau", options, {}, scrapeItau),
};

export default itau;
