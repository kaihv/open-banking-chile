import puppeteer, { type Page } from "puppeteer-core";
import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types";
import { closePopups, delay, findChrome, formatRut, saveScreenshot } from "../utils";

const BANK_URL = "https://banco.santander.cl/personas";

function parseChileanAmount(value: string): number {
  const clean = value.replace(/[^0-9-]/g, "");
  if (!clean) return 0;
  const isNegative = clean.startsWith("-") || value.includes("-$");
  const amount = parseInt(clean.replace(/-/g, ""), 10) || 0;
  return isNegative ? -amount : amount;
}

async function fillRut(page: Page, rut: string): Promise<boolean> {
  const formattedRut = formatRut(rut);
  const cleanRut = rut.replace(/[.\-]/g, "");

  const selectors = [
    'input[name*="rut"]',
    'input[id*="rut"]',
    'input[placeholder*="RUT"]',
    'input[placeholder*="Rut"]',
    'input[name*="user"]',
    'input[id*="user"]',
    'input[name*="document"]',
    'input[id*="document"]',
    'input[type="text"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(formattedRut, { delay: 45 });
        return true;
      }
    } catch {
      // Try next selector.
    }
  }

  try {
    const wasFilled = await page.evaluate((rutWithFormat: string, rutWithoutFormat: string) => {
      const candidates = Array.from(document.querySelectorAll("input"));
      for (const input of candidates) {
        const el = input as HTMLInputElement;
        if (el.offsetParent === null || el.disabled || el.type === "password") continue;
        el.focus();
        el.value = el.maxLength > 0 && el.maxLength <= 10 ? rutWithoutFormat : rutWithFormat;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    }, formattedRut, cleanRut);

    return wasFilled;
  } catch {
    return false;
  }
}

async function fillPassword(page: Page, password: string): Promise<boolean> {
  const selectors = [
    'input[type="password"]',
    'input[name*="pass"]',
    'input[id*="pass"]',
    'input[name*="clave"]',
    'input[id*="clave"]',
    'input[placeholder*="Clave"]',
    'input[placeholder*="contraseña"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await el.type(password, { delay: 45 });
        return true;
      }
    } catch {
      // Try next selector.
    }
  }

  return false;
}

async function clickByText(page: Page, texts: string[]): Promise<boolean> {
  for (const text of texts) {
    const clicked = await page.evaluate((targetText: string) => {
      const candidates = Array.from(document.querySelectorAll("button, a, span, div"));
      for (const candidate of candidates) {
        const innerText = (candidate as HTMLElement).innerText?.trim().toLowerCase();
        if (!innerText) continue;
        if (innerText === targetText || innerText.includes(targetText)) {
          (candidate as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, text.toLowerCase());

    if (clicked) return true;
  }

  return false;
}

async function extractBalance(page: Page): Promise<number | undefined> {
  return await page.evaluate(() => {
    const text = document.body?.innerText || "";

    const patterns = [
      /saldo disponible[^\d$-]*\$\s*([\d.]+)/i,
      /saldo actual[^\d$-]*\$\s*([\d.]+)/i,
      /saldo cuenta[^\d$-]*\$\s*([\d.]+)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const value = parseInt(match[1].replace(/[^0-9]/g, ""), 10);
        if (!Number.isNaN(value)) return value;
      }
    }

    return undefined;
  });
}

async function extractMovements(page: Page): Promise<BankMovement[]> {
  const rawMovements = await page.evaluate(() => {
    const results: Array<{ date: string; description: string; amount: string; balance: string }> = [];

    // Strategy 1: Traditional tables.
    const tables = Array.from(document.querySelectorAll("table"));
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll("tr"));
      if (rows.length < 2) continue;

      let dateIndex = 0;
      let descriptionIndex = 1;
      let cargoIndex = -1;
      let abonoIndex = -1;
      let amountIndex = -1;
      let balanceIndex = -1;
      let hasHeader = false;

      for (const row of rows) {
        const headers = row.querySelectorAll("th");
        if (headers.length < 2) continue;

        const headerTexts = Array.from(headers).map((h) => (h as HTMLElement).innerText?.trim().toLowerCase() || "");
        if (!headerTexts.some((h) => h.includes("fecha"))) continue;

        hasHeader = true;
        dateIndex = headerTexts.findIndex((h) => h.includes("fecha"));
        descriptionIndex = headerTexts.findIndex((h) => h.includes("descrip") || h.includes("detalle") || h.includes("glosa"));
        cargoIndex = headerTexts.findIndex((h) => h.includes("cargo") || h.includes("débito") || h.includes("debito"));
        abonoIndex = headerTexts.findIndex((h) => h.includes("abono") || h.includes("crédito") || h.includes("credito"));
        amountIndex = headerTexts.findIndex((h) => h === "monto" || h.includes("importe"));
        balanceIndex = headerTexts.findIndex((h) => h.includes("saldo"));
        break;
      }

      if (!hasHeader) continue;

      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 3) continue;

        const values = Array.from(cells).map((c) => (c as HTMLElement).innerText?.trim() || "");
        const date = values[dateIndex] || "";
        if (!date.match(/\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/)) continue;

        const description = descriptionIndex >= 0 ? (values[descriptionIndex] || "") : "";

        let amount = "";
        if (cargoIndex >= 0 && values[cargoIndex]) {
          amount = `-${values[cargoIndex]}`;
        } else if (abonoIndex >= 0 && values[abonoIndex]) {
          amount = values[abonoIndex];
        } else if (amountIndex >= 0) {
          amount = values[amountIndex] || "";
        }

        const balance = balanceIndex >= 0 ? (values[balanceIndex] || "") : "";
        if (!amount) continue;

        results.push({ date, description, amount, balance });
      }
    }

    // Strategy 2: Card/list components.
    if (results.length === 0) {
      const cards = document.querySelectorAll("[class*='mov'], [class*='tran'], li, article, section");
      for (const card of cards) {
        const text = (card as HTMLElement).innerText || "";
        const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
        if (lines.length < 3 || lines.length > 10) continue;

        const date = lines.find((line) => /\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/.test(line));
        const amount = lines.find((line) => /[$]\s*[\d.]+/.test(line));

        if (!date || !amount) continue;

        const description = lines.find((line) => line !== date && line !== amount && line.length > 3) || "";
        const balance = lines.find((line) => line.toLowerCase().includes("saldo") && /[$]\s*[\d.]+/.test(line)) || "";

        const normalizedAmount =
          text.toLowerCase().includes("cargo") ||
          text.toLowerCase().includes("débito") ||
          text.toLowerCase().includes("debito") ||
          amount.includes("-")
            ? `-${amount}`
            : amount;

        results.push({ date, description, amount: normalizedAmount, balance });
      }
    }

    return results;
  });

  const parsed = rawMovements.map((movement) => {
    const amount = parseChileanAmount(movement.amount);
    if (amount === 0) return null;

    const balance = movement.balance ? parseChileanAmount(movement.balance) : 0;

    return {
      date: movement.date,
      description: movement.description,
      amount,
      balance,
    } satisfies BankMovement;
  }).filter((movement): movement is BankMovement => movement !== null);

  const seen = new Set<string>();
  return parsed.filter((movement) => {
    const key = `${movement.date}|${movement.description}|${movement.amount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function paginateAndExtract(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  const allMovements: BankMovement[] = [];

  for (let pageIndex = 0; pageIndex < 25; pageIndex++) {
    const movements = await extractMovements(page);
    allMovements.push(...movements);

    const nextClicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("button, a"));
      for (const candidate of candidates) {
        const text = (candidate as HTMLElement).innerText?.trim().toLowerCase() || "";
        if (!text) continue;
        if (!text.includes("siguiente") && !text.includes("ver más") && !text.includes("mostrar más")) continue;

        const disabled =
          (candidate as HTMLButtonElement).disabled ||
          candidate.getAttribute("aria-disabled") === "true" ||
          candidate.classList.contains("disabled");
        if (disabled) return false;

        (candidate as HTMLElement).click();
        return true;
      }
      return false;
    });

    if (!nextClicked) break;

    debugLog.push(`  Pagination: loaded page ${pageIndex + 2}`);
    await delay(2500);
  }

  const seen = new Set<string>();
  return allMovements.filter((movement) => {
    const key = `${movement.date}|${movement.description}|${movement.amount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function scrape(options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, chromePath, saveScreenshots: doScreenshots, headful } = options;
  const bank = "santander";

  if (!rut || !password) {
    return {
      success: false,
      bank,
      movements: [],
      error: "Debes proveer RUT y clave.",
    };
  }

  const executablePath = findChrome(chromePath);
  if (!executablePath) {
    return {
      success: false,
      bank,
      movements: [],
      error:
        "No se encontró Chrome/Chromium. Instala Google Chrome o pasa chromePath en las opciones.\n" +
        "  Ubuntu/Debian: sudo apt install google-chrome-stable\n" +
        "  macOS: brew install --cask google-chrome",
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
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=1280,900",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    debugLog.push("1. Navigating to Santander...");
    await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 30000 });
    await delay(2000);

    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, a"));
      for (const button of buttons) {
        const text = (button as HTMLElement).innerText?.trim().toLowerCase();
        if (text === "aceptar" || text === "entendido" || text === "continuar") {
          (button as HTMLElement).click();
        }
      }
    });

    await doSave(page, "01-homepage");

    debugLog.push("2. Opening login form...");
    await clickByText(page, ["ingresar", "acceso clientes", "banco en linea", "iniciar sesión", "iniciar sesion"]);
    await delay(3500);
    await doSave(page, "02-login");

    debugLog.push("3. Filling RUT...");
    const rutFilled = await fillRut(page, rut);
    if (!rutFilled) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        success: false,
        bank,
        movements: [],
        error: `No se encontró campo de RUT en ${page.url()}`,
        screenshot: screenshot as string,
        debug: debugLog.join("\n"),
      };
    }

    await delay(1000);
    await clickByText(page, ["continuar", "siguiente"]);
    await delay(2500);

    debugLog.push("4. Filling password...");
    const passwordFilled = await fillPassword(page, password);
    if (!passwordFilled) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        success: false,
        bank,
        movements: [],
        error: `No se encontró campo de clave en ${page.url()}`,
        screenshot: screenshot as string,
        debug: debugLog.join("\n"),
      };
    }

    await delay(700);

    debugLog.push("5. Submitting login...");
    const submitted = await clickByText(page, ["ingresar", "entrar", "iniciar sesión", "iniciar sesion"]);
    if (!submitted) {
      await page.keyboard.press("Enter");
    }

    await delay(7000);
    await doSave(page, "03-post-login");

    const pageContent = (await page.content()).toLowerCase();
    if (
      pageContent.includes("clave dinámica") ||
      pageContent.includes("clave dinamica") ||
      pageContent.includes("superclave") ||
      pageContent.includes("segundo factor") ||
      pageContent.includes("token") ||
      pageContent.includes("código de verificación") ||
      pageContent.includes("codigo de verificacion")
    ) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        success: false,
        bank,
        movements: [],
        error: "El banco pidió segundo factor (2FA), por lo que no se puede completar automáticamente.",
        screenshot: screenshot as string,
        debug: debugLog.join("\n"),
      };
    }

    const loginError = await page.evaluate(() => {
      const selectors = [
        '[class*="error"]',
        '[class*="alert"]',
        '[role="alert"]',
        '[class*="warning"]',
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
          const text = (element as HTMLElement).innerText?.trim();
          if (text && text.length >= 4 && text.length <= 250) {
            return text;
          }
        }
      }

      return null;
    });

    if (loginError) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        success: false,
        bank,
        movements: [],
        error: `Error del banco: ${loginError}`,
        screenshot: screenshot as string,
        debug: debugLog.join("\n"),
      };
    }

    debugLog.push(`6. Login OK. URL: ${page.url()}`);

    await closePopups(page);

    debugLog.push("7. Navigating to movements...");
    await clickByText(page, ["cuentas", "movimientos", "cartola", "últimos movimientos", "ultimos movimientos"]);
    await delay(4000);
    await doSave(page, "04-movements");

    const movements = await paginateAndExtract(page, debugLog);
    const balance = await extractBalance(page);

    debugLog.push(`8. Extracted ${movements.length} movement(s)`);
    if (balance !== undefined) {
      debugLog.push(`9. Balance found: $${balance.toLocaleString("es-CL")}`);
    } else {
      debugLog.push("9. Balance not found");
    }

    await doSave(page, "05-final");
    const screenshot = await page.screenshot({ encoding: "base64", fullPage: true });

    return {
      success: true,
      bank,
      movements,
      balance,
      screenshot: screenshot as string,
      debug: debugLog.join("\n"),
    };
  } catch (error) {
    return {
      success: false,
      bank,
      movements: [],
      error: `Error del scraper: ${error instanceof Error ? error.message : String(error)}`,
      debug: debugLog.join("\n"),
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

const santander: BankScraper = {
  id: "santander",
  name: "Banco Santander",
  url: "https://banco.santander.cl/personas",
  scrape,
};

export default santander;
