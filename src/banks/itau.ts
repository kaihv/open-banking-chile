import puppeteer, { type Page } from "puppeteer-core";
import type { BankMovement, BankScraper, CreditCardBalance, ScrapeResult, ScraperOptions } from "../types";
import { closePopups, delay, findChrome, formatRut, saveScreenshot } from "../utils";

const LOGIN_URL = "https://banco.itau.cl/wps/portal/newolb/web/login";
const PORTAL_BASE = "https://banco.itau.cl/wps/myportal/newolb/web";

// ─── Helpers ─────────────────────────────────────────────────────

function parseAmount(text: string): number {
  // Chilean format: dots are thousand separators, no decimal for CLP
  const clean = text.replace(/[^0-9-]/g, "");
  return parseInt(clean, 10) || 0;
}

function normalizeDate(raw: string): string {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[1].padStart(2, "0")}-${m[2]}-${m[3]}`;
  return raw.trim();
}

// ─── Login helpers ───────────────────────────────────────────────

async function fillRut(page: Page, rut: string, debugLog: string[]): Promise<boolean> {
  const formattedRut = formatRut(rut);
  const rutEl = await page.$("#loginNameID");
  if (!rutEl) {
    debugLog.push("  RUT field not found (#loginNameID)");
    return false;
  }
  await rutEl.click({ clickCount: 3 });
  await rutEl.type(formattedRut, { delay: 45 });
  debugLog.push(`  RUT filled: ${formattedRut}`);
  return true;
}

async function fillPassword(page: Page, password: string, debugLog: string[]): Promise<boolean> {
  const passEl = await page.$("#pswdId");
  if (!passEl) {
    debugLog.push("  Password field not found (#pswdId)");
    return false;
  }
  await passEl.click();
  await passEl.type(password, { delay: 45 });
  debugLog.push("  Password filled");
  return true;
}

async function submitLogin(page: Page, debugLog: string[]): Promise<void> {
  await page.evaluate(() => {
    const btn = document.getElementById("btnLoginRecaptchaV3");
    if (btn) btn.click();
  });
  try {
    await page.waitForNavigation({ timeout: 20000 });
  } catch {
    // SPA may not trigger traditional navigation
  }
  await delay(3000);
}

async function detectLoginError(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const sels = ['[class*="error"]', '[class*="alert"]', '[role="alert"]', ".msg-error-input"];
    for (const sel of sels) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const t = (el as HTMLElement).innerText?.trim();
        if (t && t.length > 3 && t.length < 300 && (el as HTMLElement).offsetParent !== null) {
          const lower = t.toLowerCase();
          if (lower.includes("incorrecto") || lower.includes("bloqueada") || lower.includes("suspendida") || lower.includes("inválido")) {
            return t;
          }
        }
      }
    }
    return null;
  });
}

async function has2FAChallenge(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const text = document.body?.innerText?.toLowerCase() || "";
    return text.includes("itaú key") || text.includes("aprueba") || text.includes("segundo factor") || text.includes("autoriza");
  });
}

async function waitFor2FA(page: Page, debugLog: string[]): Promise<boolean> {
  const timeoutSec = Math.max(30, parseInt(process.env.ITAU_2FA_TIMEOUT_SEC || "180", 10) || 180);
  const deadline = Date.now() + timeoutSec * 1000;
  let pollCount = 0;

  while (Date.now() < deadline) {
    await delay(3000);
    if (pollCount % 10 === 0) {
      const remaining = Math.round((deadline - Date.now()) / 1000);
      debugLog.push(`  Esperando aprobación Itaú Key... (${remaining}s restantes)`);
    }
    pollCount++;

    const still2FA = await has2FAChallenge(page).catch(() => true);
    if (!still2FA) {
      debugLog.push("  2FA approved!");
      return true;
    }
  }

  debugLog.push("  2FA timeout — user did not approve in time");
  return false;
}

// ─── Login ───────────────────────────────────────────────────────

async function login(
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
  if (!await fillRut(page, rut, debugLog)) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró el campo de RUT (#loginNameID)", screenshot: screenshot as string };
  }

  debugLog.push("3. Filling password...");
  if (!await fillPassword(page, password, debugLog)) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró el campo de clave (#pswdId)", screenshot: screenshot as string };
  }

  debugLog.push("4. Submitting login...");
  await doSave(page, "02-pre-submit");
  await submitLogin(page, debugLog);
  await doSave(page, "03-after-submit");

  const errorText = await detectLoginError(page);
  if (errorText) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: `Error de login: ${errorText}`, screenshot: screenshot as string };
  }

  if (await has2FAChallenge(page)) {
    debugLog.push("5. 2FA detected — waiting for manual approval...");
    await doSave(page, "04-2fa");
    const approved = await waitFor2FA(page, debugLog);
    if (!approved) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return { success: false, error: "2FA no fue aprobado a tiempo (Itaú Key)", screenshot: screenshot as string };
    }
    await delay(3000);
  }

  const currentUrl = page.url();
  debugLog.push(`5. Login OK! URL: ${currentUrl}`);
  return { success: true };
}

// ─── Data extraction ─────────────────────────────────────────────

async function extractBalance(page: Page, debugLog: string[]): Promise<number | undefined> {
  debugLog.push("6. Extracting balance...");
  await page.goto(`${PORTAL_BASE}/cuentas/cuenta-corriente/saldos`, { waitUntil: "networkidle2", timeout: 20000 });
  await delay(2000);

  const balance = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const match = text.match(/Saldo disponible para uso\s*\$\s*([\d.,]+)/);
    if (match) {
      return parseInt(match[1].replace(/[^0-9]/g, ""), 10);
    }
    return undefined;
  });

  if (balance !== undefined) {
    debugLog.push(`  Balance: $${balance.toLocaleString("es-CL")}`);
  } else {
    debugLog.push("  Balance not found");
  }

  return balance;
}

async function extractMovements(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  debugLog.push("7. Extracting movements (últimos 30)...");
  await page.goto(`${PORTAL_BASE}/cuentas/cuenta-corriente/saldos-ultimo-movimiento`, { waitUntil: "networkidle2", timeout: 20000 });
  await delay(3000);

  const allMovements: BankMovement[] = [];

  for (let pageNum = 1; pageNum <= 10; pageNum++) {
    const pageMovements = await page.evaluate(() => {
      const results: Array<{ date: string; description: string; cargo: string; abono: string; saldo: string }> = [];
      const rows = document.querySelectorAll("table tbody tr");
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td"));
        // Valid movement rows have 6 cells: date, desc, cargo, abono, saldo, docs
        if (cells.length !== 6) continue;
        const date = cells[0].innerText?.trim() || "";
        // Skip non-date rows (pagination, headers)
        if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) continue;
        results.push({
          date,
          description: cells[1].innerText?.trim() || "",
          cargo: cells[2].innerText?.trim() || "",
          abono: cells[3].innerText?.trim() || "",
          saldo: cells[4].innerText?.trim() || "",
        });
      }
      return results;
    });

    for (const m of pageMovements) {
      const cargoVal = parseAmount(m.cargo);
      const abonoVal = parseAmount(m.abono);
      const amount = abonoVal > 0 ? abonoVal : -cargoVal;
      if (amount === 0) continue;

      allMovements.push({
        date: normalizeDate(m.date),
        description: m.description,
        amount,
        balance: parseAmount(m.saldo),
      });
    }

    debugLog.push(`  Page ${pageNum}: ${pageMovements.length} movements`);

    // Check for next page — Itaú uses image-based pagination with name="nextbtn"
    const hasNext = await page.evaluate(() => {
      // Check if there are more pages
      const pageInfo = document.body?.innerText?.match(/Página (\d+) de (\d+)/);
      if (pageInfo) {
        const current = parseInt(pageInfo[1], 10);
        const total = parseInt(pageInfo[2], 10);
        if (current >= total) return false;
      }
      // Click the "next" pagination link
      const nextBtn = document.querySelector('a[name="nextbtn"]') as HTMLElement | null;
      if (nextBtn) {
        nextBtn.click();
        return true;
      }
      return false;
    });

    if (!hasNext) break;
    await delay(3000);
  }

  debugLog.push(`  Total account movements: ${allMovements.length}`);
  return allMovements;
}

async function extractCreditCardData(
  page: Page,
  debugLog: string[],
): Promise<{ movements: BankMovement[]; creditCards: CreditCardBalance[] }> {
  debugLog.push("8. Extracting credit card data...");
  const movements: BankMovement[] = [];
  const creditCards: CreditCardBalance[] = [];

  // Navigate to TC resumen
  await page.goto(`${PORTAL_BASE}/tarjeta-credito/resumen/deuda`, { waitUntil: "networkidle2", timeout: 20000 });
  await delay(3000);

  const tcInfo = await page.evaluate(() => {
    const text = document.body?.innerText || "";

    // Extract card label (e.g. "Mastercard Black Pb **** **** **** 1234" → "Mastercard Black Pb ****1234")
    const cardMatch = text.match(/(Mastercard|Visa)\s+[\w\s]+\*{4}\s*\*{4}\s*\*{4}\s*(\d{4})/i);
    const label = cardMatch
      ? cardMatch[0].replace(/\*{4}\s*\*{4}\s*\*{4}\s*/, "****").replace(/\s+/g, " ").trim()
      : null;

    // Nacional cupos — extract the Nacional section first
    const nacSection = text.match(/Nacional[\s\S]*?(?=Internacional|Ofertas|Movimientos|$)/)?.[0] || "";
    const nacDisponible = nacSection.match(/Cupo disponible\s*\$\s*([\d.]+)/);
    const nacUtilizado = nacSection.match(/Cupo utilizado\s*(?:[\s\S]*?\$\s*([\d.]+))?/);
    const nacTotal = nacSection.match(/Cupo total\s*(?:[\s\S]*?\$\s*([\d.]+))?/);

    // Internacional cupos — extract all USD values in order: total, utilizado, disponible
    const intSection = text.match(/Internacional[\s\S]*?(?=Ofertas|Movimientos|Emergencias|$)/)?.[0] || "";
    const intUsdValues = [...intSection.matchAll(/USD\$?\s*(-?[\d.,]+)/g)].map(m => m[1]);
    const intTotal = intUsdValues[0] || null;
    const intUtilizado = intUsdValues[1] || null;
    const intDisponible = intUsdValues[2] || null;

    // Próxima facturación
    const proxFactMatch = text.match(/Próxima facturación\s*(\d{2}\/\d{2}\/\d{4})/);

    // Non-facturados movements (they may be in a table on this page)
    const noFacturados: Array<{ date: string; desc: string; amount: string }> = [];
    // Check for "Movimientos no facturados" section
    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      const prevText = (table.previousElementSibling as HTMLElement)?.innerText?.toLowerCase() || "";
      if (prevText.includes("no facturad")) {
        const rows = table.querySelectorAll("tbody tr");
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll("td"));
          if (cells.length >= 3) {
            noFacturados.push({
              date: cells[0].innerText?.trim() || "",
              desc: cells[1].innerText?.trim() || "",
              amount: cells[cells.length - 1].innerText?.trim() || "",
            });
          }
        }
      }
    }

    return {
      label,
      nacDisponible: nacDisponible?.[1],
      nacUtilizado: nacUtilizado?.[1],
      nacTotal: nacTotal?.[1],
      intDisponible: intDisponible,
      intUtilizado: intUtilizado,
      intTotal: intTotal,
      proxFact: proxFactMatch?.[1],
      noFacturados,
    };
  });

  if (tcInfo.label) {
    const nacUsed = parseAmount(tcInfo.nacUtilizado || "0");
    const nacAvailable = parseAmount(tcInfo.nacDisponible || "0");
    const card: CreditCardBalance = {
      label: tcInfo.label,
      national: {
        used: nacUsed,
        available: nacAvailable,
        total: nacUsed + nacAvailable,
      },
    };

    if (tcInfo.intDisponible) {
      // Chilean format for USD: dots=thousands, comma=decimal (e.g. "6.829,26")
      const parseUsd = (s: string) => parseFloat(s.replace(/\./g, "").replace(",", ".")) || 0;
      const intUsed = Math.abs(parseUsd(tcInfo.intUtilizado || "0"));
      const intAvailable = parseUsd(tcInfo.intDisponible || "0");
      const intTotal = parseUsd(tcInfo.intTotal || "0");
      card.international = {
        used: intUsed,
        available: intAvailable,
        total: intTotal,
        currency: "USD",
      };
    }

    if (tcInfo.proxFact) {
      card.nextBillingDate = normalizeDate(tcInfo.proxFact);
    }

    creditCards.push(card);
    debugLog.push(`  Card: ${card.label}`);
    debugLog.push(`    NAC: used=$${card.national.used}, available=$${card.national.available}`);
    if (card.international) {
      debugLog.push(`    INT: used=USD${card.international.used}, available=USD${card.international.available}`);
    }

    // Add non-facturados movements
    for (const m of tcInfo.noFacturados) {
      const amount = parseAmount(m.amount);
      if (amount === 0) continue;
      movements.push({
        date: normalizeDate(m.date),
        description: `[TC Por Facturar] ${m.desc}`,
        amount: -amount,
        balance: 0,
      });
    }
    debugLog.push(`  No-facturados: ${tcInfo.noFacturados.length} movements`);
  } else {
    debugLog.push("  No credit card found");
  }

  // Navigate to TC estado de cuenta nacional for facturados
  await page.goto(`${PORTAL_BASE}/tarjeta-credito/resumen/cuenta-nacional`, { waitUntil: "networkidle2", timeout: 20000 });
  await delay(3000);

  const facturados = await page.evaluate(() => {
    const results: Array<{ date: string; desc: string; amount: string; cuota: string }> = [];
    const rows = document.querySelectorAll("table tbody tr");
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      // Look for rows with operation data: lugar, fecha, código, descripción, monto, total, cuota, valor
      if (cells.length < 7) continue;
      const dateText = cells[1]?.innerText?.trim() || "";
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dateText)) continue;
      results.push({
        date: dateText,
        desc: cells[3]?.innerText?.trim() || "",
        amount: cells[4]?.innerText?.trim() || "",
        cuota: cells[6]?.innerText?.trim() || "",
      });
    }
    return results;
  });

  for (const m of facturados) {
    const amount = parseAmount(m.amount);
    if (amount === 0) continue;
    const cuotaInfo = m.cuota ? ` ${m.cuota}` : "";
    movements.push({
      date: normalizeDate(m.date),
      description: `[TC Facturados] ${m.desc}${cuotaInfo}`,
      amount: amount > 0 ? -amount : Math.abs(amount), // Positive = charge (negative), negative = payment/credit (positive)
      balance: 0,
    });
  }
  debugLog.push(`  Facturados: ${facturados.length} movements`);

  return { movements, creditCards };
}

// ─── Logout ──────────────────────────────────────────────────────

async function logout(page: Page, debugLog: string[]): Promise<void> {
  try {
    const logoutClicked = await page.evaluate(() => {
      const links = document.querySelectorAll("a");
      for (const link of links) {
        const text = (link as HTMLElement).innerText?.trim().toLowerCase() || "";
        if (text === "cerrar sesión") {
          link.click();
          return true;
        }
      }
      return false;
    });
    if (logoutClicked) {
      debugLog.push("  Logged out successfully");
      await delay(2000);
    }
  } catch {
    // best effort
  }
}

// ─── Main scraper ────────────────────────────────────────────────

async function scrape(options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, chromePath, saveScreenshots: doScreenshots, headful } = options;
  const bank = "itau";

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
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--window-size=1280,900", "--disable-blink-features=AutomationControlled"],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // Login
    const loginResult = await login(page, rut, password, debugLog, doSave);
    if (!loginResult.success) {
      return { success: false, bank, movements: [], error: loginResult.error, screenshot: loginResult.screenshot, debug: debugLog.join("\n") };
    }

    await closePopups(page);

    // Extract balance
    const balance = await extractBalance(page, debugLog);

    // Extract account movements
    const accountMovements = await extractMovements(page, debugLog);

    // Extract credit card data
    const tcResult = await extractCreditCardData(page, debugLog);

    // Prefix account movements when there are also TC movements
    const prefixedAccountMovements = tcResult.movements.length > 0
      ? accountMovements.map((m) => ({ ...m, description: `[Cuenta Corriente] ${m.description}` }))
      : accountMovements;

    // Combine and deduplicate
    const allMovements = [...prefixedAccountMovements, ...tcResult.movements];
    const seen = new Set<string>();
    const deduplicated = allMovements.filter((m) => {
      const key = `${m.date}|${m.description}|${m.amount}|${m.balance}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    debugLog.push(`9. Total: ${deduplicated.length} unique movements`);
    await doSave(page, "05-final");
    const screenshot = doScreenshots ? (await page.screenshot({ encoding: "base64" })) as string : undefined;

    return {
      success: true,
      bank,
      movements: deduplicated,
      balance,
      creditCards: tcResult.creditCards.length > 0 ? tcResult.creditCards : undefined,
      screenshot,
      debug: debugLog.join("\n"),
    };
  } catch (error) {
    return {
      success: false, bank, movements: [],
      error: `Error del scraper: ${error instanceof Error ? error.message : String(error)}`,
      debug: debugLog.join("\n"),
    };
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

// ─── Export ───────────────────────────────────────────────────────

const itau: BankScraper = {
  id: "itau",
  name: "Itaú",
  url: "https://banco.itau.cl",
  scrape,
};

export default itau;
