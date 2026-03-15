import puppeteer, { type Page } from "puppeteer-core";
import type { BankMovement, BankScraper, CreditCardBalance, ScrapeResult, ScraperOptions } from "../types";
import { closePopups, delay, findChrome, formatRut, saveScreenshot } from "../utils";

const BANK_URL = "https://www.bancofalabella.cl";

// ─── Login helpers (shared with falabella) ──────────────────────

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

// ─── Loader helper ──────────────────────────────────────────────

const SHADOW_HOST = "credit-card-movements";

async function waitForMovements(page: Page, timeoutMs = 30000): Promise<void> {
  try {
    // Movements are inside shadow DOM of <credit-card-movements>
    await page.waitForFunction((host: string) => {
      const el = document.querySelector(host);
      if (!el?.shadowRoot) return false;
      return el.shadowRoot.querySelectorAll("table tbody tr td").length > 0;
    }, { timeout: timeoutMs }, SHADOW_HOST);
  } catch {
    // Timeout — content may not load, continue anyway
  }
  await delay(500);
}

// ─── TC extraction helpers ──────────────────────────────────────

function parseAmount(text: string): number {
  const clean = text.replace(/[^0-9.,]/g, "");
  // Chilean format: 1.234.567 or 1.234
  const normalized = clean.replace(/\./g, "").replace(",", ".");
  return parseInt(normalized, 10) || 0;
}

async function extractCupos(page: Page, debugLog: string[]): Promise<CreditCardBalance | null> {
  try {
    const cupoData = await page.evaluate(() => {
      const text = document.body?.innerText || "";

      // Extract card label: "CMR Mastercard Elite\n•••• 0750"
      let label = "";
      const labelMatch = text.match(/(CMR\s+\w+(?:\s+\w+)?)\s*\n?\s*[•·*\s]+\s*(\d{4})/i);
      if (labelMatch) label = `${labelMatch[1]} ****${labelMatch[2]}`;

      // Format on page: "$7.010.000\nCupo de compras" / "$6.374.752\nCupo utilizado" / "$635.248\nCupo disponible"
      const cupoMatch = text.match(/\$([\d.,]+)\s*\n?\s*Cupo de compras/i);
      const usadoMatch = text.match(/\$([\d.,]+)\s*\n?\s*Cupo utilizado/i);
      const disponibleMatch = text.match(/\$([\d.,]+)\s*\n?\s*Cupo disponible/i);

      return { label, cupo: cupoMatch?.[1], usado: usadoMatch?.[1], disponible: disponibleMatch?.[1] };
    });

    if (!cupoData.cupo && !cupoData.disponible) {
      debugLog.push("  No cupo data found in page text");
      return null;
    }

    const total = cupoData.cupo ? parseAmount(cupoData.cupo) : 0;
    const used = cupoData.usado ? parseAmount(cupoData.usado) : 0;
    const available = cupoData.disponible ? parseAmount(cupoData.disponible) : 0;

    const cc: CreditCardBalance = {
      label: cupoData.label || "CMR",
      national: { total, used, available },
    };

    debugLog.push(`  Cupos: total=$${total}, used=$${used}, available=$${available}`);
    return cc;
  } catch (err) {
    debugLog.push(`  Could not extract cupos: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const TAB_IDS: Record<string, string> = {
  "últimos movimientos": "last-movements",
  "movimientos facturados": "invoicedMovements",
  "estados de cuenta cmr": "account-status",
  "próximos vencimientos": "next-expiration",
};

async function clickTab(page: Page, tabText: string, debugLog: string[]): Promise<boolean> {
  const tabId = TAB_IDS[tabText.toLowerCase()] || "";
  const clicked = await page.evaluate((text: string, host: string, radioId: string) => {
    const shadowEl = document.querySelector(host);
    const roots: Array<Document | ShadowRoot> = [];
    if (shadowEl?.shadowRoot) roots.push(shadowEl.shadowRoot);
    roots.push(document);
    for (const root of roots) {
      // Try clicking the radio input directly by ID
      if (radioId) {
        const radio = root.querySelector(`#${radioId}`) as HTMLInputElement | null;
        if (radio) {
          radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
          radio.click();
          return true;
        }
      }
      // Fallback: click label by text
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

  if (clicked) {
    debugLog.push(`  Clicked tab: "${tabText}"`);
  }
  return clicked;
}

async function extractMovementsFromTable(page: Page): Promise<BankMovement[]> {
  return await page.evaluate((host: string) => {
    const movements: BankMovement[] = [];

    // Movements are inside shadow DOM of <credit-card-movements>
    const shadowEl = document.querySelector(host);
    const root = shadowEl?.shadowRoot || document;
    const tables = root.querySelectorAll("table");

    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll("tbody tr"));

      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 4) continue;

        const texts = Array.from(cells).map(c => (c as HTMLElement).innerText?.trim() || "");

        // First cell: date (dd/mm/yyyy) or pending (img with alt="pendiente")
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
          // -$ in source means payment/credit (positive for us), otherwise it's a charge (negative)
          amount = isNegativeInSource ? value : -value;
        }

        const persona = texts[2] || undefined;
        const installments = texts[4] || undefined;

        if (description && amount !== 0) {
          movements.push({ date, description, amount, balance: 0, owner: persona, installments });
        }
      }
    }

    return movements;
  }, SHADOW_HOST);
}

async function paginateAndExtract(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  const allMovements: BankMovement[] = [];

  for (let i = 0; i < 20; i++) {
    const movements = await extractMovementsFromTable(page);
    allMovements.push(...movements);

    // Check for next page button (btn-pagination with "boton avanzar" img)
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
    await waitForMovements(page);
  }

  // Deduplicate
  const seen = new Set<string>();
  return allMovements.filter(m => {
    const key = `${m.date}|${m.description}|${m.amount}|${m.owner || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Logout ──────────────────────────────────────────────────────

async function logout(page: Page, debugLog: string[]): Promise<void> {
  try {
    const clicked = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll("a, button, span, div, li"));
      for (const el of elements) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase();
        if (text === "cerrar sesión" || text === "salir" || text === "logout" || text === "sign out") {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    if (clicked) {
      debugLog.push("  Logged out successfully");
      await delay(2000);
    }
  } catch {
    // best effort
  }
}

// ─── Main scraper ───────────────────────────────────────────────

async function scrape(options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, chromePath, saveScreenshots: doScreenshots, headful, owner = "B" } = options;
  const bank = "cmr";

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

    // Step 1: Navigate to bank homepage
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

    debugLog.push(`6. Login OK! URL: ${page.url()}`);
    await closePopups(page);
    await doSave(page, "04-post-login");

    // Step 7: Extract cupos (visible on post-login page before clicking card)
    debugLog.push("7. Extracting credit card cupos...");
    const creditCardBalance = await extractCupos(page, debugLog);
    const creditCards: CreditCardBalance[] = creditCardBalance ? [creditCardBalance] : [];

    // Step 8: Navigate to credit card movements
    debugLog.push("8. Looking for credit card products...");

    // Click on the CMR card product to expand details
    const cardClicked = await page.evaluate(() => {
      // Try specific card detail selectors
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

      // Fallback: look for CMR text in clickable elements
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
      await waitForMovements(page);
    }

    await doSave(page, "05-card-selected");

    // Filter by owner (Titular/Adicional) if specified
    if (owner !== "B") {
      const ownerLabel = owner === "T" ? "Titular" : "Adicional";
      debugLog.push(`  Filtering by: ${ownerLabel}`);
      await page.evaluate((host: string, value: string) => {
        const shadowEl = document.querySelector(host);
        const root = shadowEl?.shadowRoot || document;
        const select = root.querySelector("select[name='searchownership']") as HTMLSelectElement | null;
        if (select) {
          select.value = value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, SHADOW_HOST, owner);
      await waitForMovements(page);
    }

    // Step 9: Extract movements from "Últimos movimientos" tab (default tab, already loaded)
    debugLog.push("9. Extracting últimos movimientos...");

    const recentMovements = await paginateAndExtract(page, debugLog);
    debugLog.push(`  Recent movements: ${recentMovements.length}`);

    // Tag recent movements
    const taggedRecent = recentMovements.map(m => ({
      ...m,
      description: `[TC Por Facturar] ${m.description}`,
    }));

    // Step 10: Extract movements from "Movimientos facturados" tab
    debugLog.push("10. Extracting movimientos facturados...");

    const facturadosClicked = await clickTab(page, "movimientos facturados", debugLog);

    let taggedFacturados: BankMovement[] = [];
    if (facturadosClicked) {
      // Wait for facturados content to load inside shadow DOM
      try {
        await page.waitForFunction((host: string) => {
          const el = document.querySelector(host);
          if (!el?.shadowRoot) return false;
          return el.shadowRoot.querySelector("app-invoiced-movements table tbody tr td") !== null;
        }, { timeout: 30000 }, SHADOW_HOST);
      } catch { /* timeout */ }
      await delay(1000);
      await doSave(page, "06-facturados");

      const facturadoMovements = await paginateAndExtract(page, debugLog);
      debugLog.push(`  Facturados movements: ${facturadoMovements.length}`);

      taggedFacturados = facturadoMovements.map(m => ({
        ...m,
        description: `[TC Facturados] ${m.description}`,
      }));
    }

    // Deduplicate across tabs (a movement could appear in both)
    const seen = new Set<string>();
    const allMovements = [...taggedRecent, ...taggedFacturados].filter(m => {
      const key = `${m.date}|${m.description}|${m.amount}|${m.owner || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    debugLog.push(`11. Total movements: ${allMovements.length}`);

    await doSave(page, "07-final");
    const screenshot = await page.screenshot({ encoding: "base64", fullPage: true });

    return {
      success: true,
      bank,
      movements: allMovements,
      creditCards: creditCards.length > 0 ? creditCards : undefined,
      screenshot: screenshot as string,
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

const cmr: BankScraper = {
  id: "cmr",
  name: "CMR Falabella",
  url: "https://www.bancofalabella.cl",
  scrape,
};

export default cmr;
