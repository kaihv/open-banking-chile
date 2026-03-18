import puppeteer, { type Page } from "puppeteer-core";
import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, findChrome, saveScreenshot, normalizeDate, parseChileanAmount, deduplicateMovements, logout } from "../utils.js";

const BANK_URL = "https://banco.bice.cl/personas";

// ─── Login ──────────────────────────────────────────────────────

async function login(
  page: Page,
  rut: string,
  password: string,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>
): Promise<{ success: boolean; error?: string; screenshot?: string; activePage?: Page }> {
  debugLog.push("1. Navigating to bank homepage...");
  await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(2000);
  await doSave(page, "01-homepage");

  debugLog.push("2. Opening login dropdown...");
  const loginDropdown = await page.$("#login-dropdown");
  if (!loginDropdown) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró el botón de login (#login-dropdown)", screenshot: screenshot as string };
  }
  await loginDropdown.click();
  await delay(1500);

  try {
    await page.waitForSelector(".dropdown-menu.show", { timeout: 5000 });
  } catch {
    await loginDropdown.click();
    await delay(2000);
  }

  debugLog.push("3. Clicking 'Personas'...");
  const personasLink = await page.$('a[data-click="Personas"]');
  if (!personasLink) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró el link 'Personas' en el dropdown de login", screenshot: screenshot as string };
  }

  await personasLink.click();

  // Double redirect: banco.bice.cl -> portalpersonas.bice.cl (~5s blank) -> auth.bice.cl
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
    const screenshot = await loginPage.screenshot({ encoding: "base64" });
    return { success: false, error: "No se cargó la página de login (timeout esperando #username)", screenshot: screenshot as string };
  }
  await doSave(loginPage, "02-login-form");

  debugLog.push("5. Filling RUT...");
  const rutField = await loginPage.$("#username");
  if (!rutField) {
    const screenshot = await loginPage.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró el campo de RUT (#username)", screenshot: screenshot as string };
  }
  const cleanRut = rut.replace(/[.\-]/g, "");
  await rutField.click();
  await rutField.type(cleanRut, { delay: 50 });

  debugLog.push("6. Filling password...");
  const passField = await loginPage.$("#password");
  if (!passField) {
    const screenshot = await loginPage.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró el campo de clave (#password)", screenshot: screenshot as string };
  }
  await passField.click();
  await passField.type(password, { delay: 50 });
  await delay(500);

  debugLog.push("7. Submitting login...");
  await doSave(loginPage, "03-pre-submit");
  const submitBtn = await loginPage.$("#kc-login");
  if (submitBtn) {
    await submitBtn.click();
  } else {
    await loginPage.keyboard.press("Enter");
  }

  try {
    await loginPage.waitForNavigation({ timeout: 20000 });
  } catch {
    // SPA may not trigger navigation event
  }
  await delay(3000);
  await doSave(loginPage, "04-after-login");

  const currentUrl = loginPage.url();
  if (currentUrl.includes("auth.bice.cl")) {
    const errorText = await loginPage.evaluate(() => {
      const errorEl = document.querySelector('[class*="error"], [class*="alert"], [role="alert"]');
      return errorEl ? (errorEl as HTMLElement).innerText?.trim() : null;
    });
    const screenshot = await loginPage.screenshot({ encoding: "base64" });
    return { success: false, error: `Error de login: ${errorText || "Credenciales inválidas"}`, screenshot: screenshot as string };
  }

  debugLog.push(`8. Login OK!`);
  return { success: true, activePage: loginPage };
}

// ─── Post-login helpers ─────────────────────────────────────────

async function dismissAdPopup(page: Page, debugLog: string[]): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const btn = await page.$("button.evg-btn-dismissal");
    if (btn) {
      await btn.click();
      debugLog.push("  Ad popup dismissed");
      await delay(1000);
      return;
    }
    await delay(2000);
  }
}

async function extractBalance(page: Page): Promise<number | undefined> {
  return await page.evaluate(() => {
    const el = document.querySelector("h2.cabeceraCard2");
    if (!el) return undefined;
    const text = (el as HTMLElement).innerText?.trim();
    if (!text) return undefined;
    const val = parseInt(text.replace(/[^0-9]/g, ""), 10);
    return isNaN(val) ? undefined : val;
  });
}

async function navigateToMovements(
  page: Page,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>
): Promise<boolean> {
  debugLog.push("9. Navigating to movements...");
  const link = await page.$("a.ultimosMov");
  if (!link) {
    debugLog.push("  'Ir a Saldos y movimientos' link not found");
    return false;
  }
  await link.click();

  try {
    await page.waitForSelector("div.transaction-table__container", { timeout: 15000 });
  } catch {
    debugLog.push("  Movements table did not load (timeout)");
    return false;
  }
  await delay(2000);
  await doSave(page, "05-movements-page");
  debugLog.push("  Movements page loaded");
  return true;
}

// ─── Extraction ─────────────────────────────────────────────────

async function extractCurrentMonthMovements(page: Page): Promise<BankMovement[]> {
  const raw = await page.evaluate(() => {
    const rows = document.querySelectorAll("div.transaction-table__container table tbody tr");
    const results: Array<{ date: string; category: string; description: string; amount: string; balance: string }> = [];

    for (const row of rows) {
      const cells = row.querySelectorAll("td");
      if (cells.length < 5) continue;
      results.push({
        date: (cells[0] as HTMLElement).innerText?.trim() || "",
        category: (cells[1] as HTMLElement).innerText?.trim().toLowerCase() || "",
        description: (cells[2] as HTMLElement).innerText?.trim() || "",
        amount: (cells[3] as HTMLElement).innerText?.trim() || "",
        balance: (cells[4] as HTMLElement).innerText?.trim() || "",
      });
    }

    return results;
  });

  return raw.map((r) => {
    const amountVal = parseChileanAmount(r.amount);
    if (amountVal === 0) return null;
    const amount = r.category.includes("cargo") ? -amountVal : amountVal;
    return { date: normalizeDate(r.date), description: r.description, amount, balance: parseChileanAmount(r.balance), source: MOVEMENT_SOURCE.account };
  }).filter(Boolean) as BankMovement[];
}

async function extractHistoricalMovements(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  const raw = await page.evaluate(() => {
    const table = document.querySelector('table[aria-describedby="Tabla resumen de cartolas"]')
      || document.querySelector("lib-credits-and-charges table")
      || document.querySelector("ds-table table");
    if (!table) return { rows: [] as Array<{ date: string; category: string; description: string; amount: string }>, selector: "none" };

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

    return { rows: results, selector: table.getAttribute("aria-describedby") || table.tagName };
  });

  if (raw.selector === "none") {
    debugLog.push("  Historical table not found");
    return [];
  }

  return raw.rows.map((r) => {
    const amountVal = parseChileanAmount(r.amount);
    if (amountVal === 0) return null;
    const amount = r.category.includes("cargo") ? -amountVal : amountVal;
    return { date: normalizeDate(r.date), description: r.description, amount, balance: 0, source: MOVEMENT_SOURCE.account };
  }).filter(Boolean) as BankMovement[];
}

// ─── Pagination ─────────────────────────────────────────────────

async function paginateAndExtract(
  page: Page,
  extractFn: (page: Page) => Promise<BankMovement[]>
): Promise<BankMovement[]> {
  const allMovements: BankMovement[] = [];

  for (let i = 0; i < 50; i++) {
    const movements = await extractFn(page);
    allMovements.push(...movements);

    const isDisabled = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const span = btn.querySelector("span");
        if (span?.textContent?.trim() === "Siguiente") {
          return btn.classList.contains("is-disabled");
        }
      }
      return true;
    });

    if (isDisabled) break;

    await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const span = btn.querySelector("span");
        if (span?.textContent?.trim() === "Siguiente") {
          btn.click();
          return;
        }
      }
    });
    await delay(3000);
  }

  return allMovements;
}

// ─── Historical periods ────────────────────────────────────────

async function navigateToHistorical(
  page: Page,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>
): Promise<boolean> {
  debugLog.push("  Navigating to historical periods...");

  const clicked = await page.evaluate(() => {
    const links = document.querySelectorAll("div.transactions-summary__link");
    for (const link of links) {
      if ((link as HTMLElement).innerText?.includes("Revisar periodos anteriores")) {
        (link as HTMLElement).click();
        return true;
      }
    }
    return false;
  });

  if (!clicked) {
    debugLog.push("  'Revisar periodos anteriores' link not found");
    return false;
  }

  try {
    await page.waitForSelector('ds-dropdown[toplabel="Elige un periodo"]', { timeout: 10000 });
  } catch {
    debugLog.push("  Historical period selector did not load (timeout)");
    return false;
  }

  await delay(2000);
  await doSave(page, "06-historical-page");
  debugLog.push("  Historical page loaded");
  return true;
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

  if (!periodLabel) {
    debugLog.push(`  Period index ${periodIndex} not available`);
    return false;
  }

  debugLog.push(`  Selected period: ${periodLabel}`);

  await page.evaluate(() => {
    const container = document.querySelector("div.button-search");
    const btn = container?.querySelector("button");
    if (btn) btn.click();
  });
  await delay(7000);

  return true;
}

// ─── Main scraper ───────────────────────────────────────────────

async function scrape(options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, chromePath, saveScreenshots: doScreenshots, headful } = options;
  const bank = "bice";

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

    const activePage = loginResult.activePage || page;

    // Dismiss popups
    await dismissAdPopup(activePage, debugLog);
    await closePopups(activePage);

    // Extract balance from summary page
    const balance = await extractBalance(activePage);
    debugLog.push(`  Balance: ${balance !== undefined ? `$${balance.toLocaleString("es-CL")}` : "not found"}`);

    // Navigate to movements
    const navOk = await navigateToMovements(activePage, debugLog, doSave);
    if (!navOk) {
      const screenshot = await activePage.screenshot({ encoding: "base64" });
      return { success: false, bank, movements: [], balance, error: "No se pudo navegar a la página de movimientos", screenshot: screenshot as string, debug: debugLog.join("\n") };
    }

    // Extract current month movements (with pagination)
    const movements = await paginateAndExtract(activePage, extractCurrentMonthMovements);
    debugLog.push(`10. Extracted ${movements.length} current month movements`);

    // Historical periods
    const monthsStr = process.env.BICE_MONTHS || "0";
    const months = Math.min(Math.max(parseInt(monthsStr, 10) || 0, 0), 16);

    if (months > 0) {
      debugLog.push(`11. Fetching ${months} historical period(s)...`);
      const histNavOk = await navigateToHistorical(activePage, debugLog, doSave);

      if (!histNavOk) {
        debugLog.push("  Skipping historical periods (navigation failed)");
      } else {
        // First period is already loaded when we navigate to historical page
        const firstMovements = await paginateAndExtract(activePage, (p) => extractHistoricalMovements(p, debugLog));
        debugLog.push(`  Period 1: ${firstMovements.length} movements`);
        movements.push(...firstMovements);

        for (let i = 1; i < months; i++) {
          const periodOk = await selectPeriod(activePage, i, debugLog);
          if (!periodOk) break;

          const histMovements = await paginateAndExtract(activePage, (p) => extractHistoricalMovements(p, debugLog));
          debugLog.push(`  Period ${i + 1}: ${histMovements.length} movements`);
          movements.push(...histMovements);
        }
      }
    }

    // Deduplicate
    const deduplicated = deduplicateMovements(movements);

    debugLog.push(`  Total: ${deduplicated.length} unique movements`);

    await doSave(activePage, "07-final");
    const screenshot = doScreenshots ? ((await activePage.screenshot({ encoding: "base64", fullPage: true })) as string) : undefined;

    return { success: true, bank, movements: deduplicated, balance: balance || undefined, screenshot, debug: debugLog.join("\n") };
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

const bice: BankScraper = {
  id: "bice",
  name: "Banco BICE",
  url: "https://banco.bice.cl/personas",
  scrape,
};

export default bice;
