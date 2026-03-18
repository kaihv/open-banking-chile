import puppeteer, { type Page } from "puppeteer-core";
import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, findChrome, saveScreenshot, normalizeDate, parseChileanAmount, deduplicateMovements, logout } from "../utils.js";

const LOGIN_URL = "https://www.bancoestado.cl/content/bancoestado-public/cl/es/home/home.html#/login";

// ─── Login helpers ──────────────────────────────────────────────

async function fillRut(page: Page, rut: string, debugLog: string[]): Promise<boolean> {
  const rutInput = await page.$("#rut");
  if (!rutInput) return false;

  // Click to focus — Angular removes readonly on focus
  await rutInput.click();
  await delay(500);

  // If still readonly, remove it and re-focus
  const isReadonly = await page.evaluate(() => {
    const input = document.querySelector("#rut") as HTMLInputElement;
    if (input?.hasAttribute("readonly")) {
      input.removeAttribute("readonly");
      input.focus();
      return true;
    }
    return false;
  });
  if (isReadonly) await delay(300);

  // BancoEstado expects raw RUT without dots/dash (not formatted like "12.345.678-9")
  await rutInput.click({ clickCount: 3 });
  const cleanRut = rut.replace(/[.\-]/g, "");
  await rutInput.type(cleanRut, { delay: 80 });

  // Trigger Angular change detection
  await page.evaluate(() => {
    const input = document.querySelector("#rut") as HTMLInputElement;
    if (input) {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  debugLog.push("  RUT filled");
  return true;
}

async function fillPassword(page: Page, password: string, debugLog: string[]): Promise<boolean> {
  const passInput = await page.$("#pass");
  if (!passInput) return false;

  await passInput.click({ clickCount: 3 });
  await passInput.type(password, { delay: 80 });

  await page.evaluate(() => {
    const input = document.querySelector("#pass") as HTMLInputElement;
    if (input) {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  debugLog.push("  Password filled");
  return true;
}

// ─── Dashboard extraction ───────────────────────────────────────

async function extractBalanceFromDashboard(page: Page, debugLog: string[]): Promise<number | undefined> {
  const balance = await page.evaluate(() => {
    // Look for CuentaRUT product card on dashboard — it shows the balance as a large number
    const productCards = document.querySelectorAll('[class*="product"], [class*="card"], [class*="cuenta"]');
    for (const card of productCards) {
      const text = (card as HTMLElement).innerText || "";
      if (text.toLowerCase().includes("cuentarut") || text.toLowerCase().includes("cuenta rut")) {
        const amountMatch = text.match(/\$\s*([\d.,]+)/);
        if (amountMatch) return amountMatch[1];
      }
    }

    // Fallback: look for saldo pattern anywhere
    const bodyText = document.body?.innerText || "";
    const patterns = [
      /cuentarut[^$]*\$\s*([\d.,]+)/i,
      /cuenta\s*rut[^$]*\$\s*([\d.,]+)/i,
      /saldo\s*disponible[:\s]*\$?\s*([\d.,]+)/i,
    ];
    for (const pattern of patterns) {
      const match = bodyText.match(pattern);
      if (match) return match[1];
    }
    return null;
  });

  if (balance) {
    const parsed = parseChileanAmount(balance);
    debugLog.push(`  CuentaRUT balance: $${parsed.toLocaleString("es-CL")}`);
    return parsed;
  }

  debugLog.push("  CuentaRUT balance not found on dashboard");
  return undefined;
}

// ─── Movement extraction ────────────────────────────────────────

async function extractMovements(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  const raw = await page.evaluate(() => {
    const results: Array<{ date: string; description: string; amount: string; balance: string }> = [];

    // Strategy 1: Table with headers
    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll("tr"));
      if (rows.length < 2) continue;

      // Find header indices
      let dateIdx = -1, descIdx = -1, amountIdx = -1, saldoIdx = -1;
      let cargoIdx = -1, abonoIdx = -1;
      for (const row of rows) {
        const ths = row.querySelectorAll("th");
        if (ths.length >= 3) {
          const headers = Array.from(ths).map(h => (h as HTMLElement).innerText?.trim().toLowerCase());
          dateIdx = headers.findIndex(h => h.includes("fecha"));
          descIdx = headers.findIndex(h => h.includes("descripci") || h.includes("detalle") || h.includes("glosa"));
          saldoIdx = headers.findIndex(h => h.includes("saldo"));
          // Combined "Abonos/Cargos" column — sign embedded in value (+$xxx / -$xxx)
          amountIdx = headers.findIndex(h => (h.includes("abono") && h.includes("cargo")) || h.includes("monto") || h.includes("importe"));
          if (amountIdx < 0) {
            // Separate Cargo/Abono columns
            cargoIdx = headers.findIndex(h => h === "cargo" || h === "cargos" || h.includes("débito"));
            abonoIdx = headers.findIndex(h => h === "abono" || h === "abonos" || h.includes("crédito") || h.includes("depósito"));
          }
          if (dateIdx >= 0) break;
        }
      }

      if (dateIdx < 0) continue;

      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 3) continue;
        const texts = Array.from(cells).map(c => (c as HTMLElement).innerText?.trim());
        const dateText = texts[dateIdx] || "";
        if (!/\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/.test(dateText)) continue;

        let amount = "";
        if (amountIdx >= 0) {
          // Single column with sign embedded (e.g. "+$7", "-$436")
          amount = texts[amountIdx] || "";
        } else if (cargoIdx >= 0 || abonoIdx >= 0) {
          // Separate cargo/abono columns
          const cargo = cargoIdx >= 0 ? texts[cargoIdx] || "" : "";
          const abono = abonoIdx >= 0 ? texts[abonoIdx] || "" : "";
          if (cargo && cargo !== "$0" && cargo !== "0") {
            amount = `-${cargo}`;
          } else if (abono) {
            amount = abono;
          }
        }

        results.push({
          date: dateText,
          description: texts[descIdx >= 0 ? descIdx : 1] || "",
          amount,
          balance: saldoIdx >= 0 ? texts[saldoIdx] || "" : "",
        });
      }
    }

    // Strategy 2: Dashboard "Últimos movimientos" cards
    if (results.length === 0) {
      const movRows = document.querySelectorAll('[class*="movimiento"], [class*="movement"], [class*="transaction"]');
      for (const el of movRows) {
        const text = (el as HTMLElement).innerText || "";
        const dateMatch = text.match(/(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/);
        const amountMatch = text.match(/[+\-]?\$[\d.,]+/g);
        if (dateMatch && amountMatch) {
          const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
          const descLine = lines.find(l => !l.match(/^[+\-]?\$/) && !l.match(/^\d{1,2}[\/.\-]/) && l.length > 2);
          results.push({
            date: dateMatch[1],
            description: descLine || "",
            amount: amountMatch[0],
            balance: amountMatch.length > 1 ? amountMatch[amountMatch.length - 1] : "",
          });
        }
      }
    }

    return results;
  });

  debugLog.push(`  Raw movements extracted: ${raw.length}`);

  return raw
    .map(r => {
      // parseChileanAmount handles sign: "+$7" → 7, "- $436" → -436
      const amount = parseChileanAmount(r.amount);
      if (amount === 0) return null;

      return {
        date: normalizeDate(r.date),
        description: r.description,
        amount,
        balance: r.balance ? parseChileanAmount(r.balance) : 0,
        source: MOVEMENT_SOURCE.account,
      } as BankMovement;
    })
    .filter(Boolean) as BankMovement[];
}

// ─── Main scraper ───────────────────────────────────────────────

async function scrape(options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, chromePath, saveScreenshots: doScreenshots, headful } = options;
  const bank = "bestado";

  if (!rut || !password) {
    return { success: false, bank, movements: [], error: "Debes proveer RUT y clave." };
  }

  const executablePath = findChrome(chromePath);
  if (!executablePath) {
    return {
      success: false, bank, movements: [],
      error: "No se encontró Chrome/Chromium. Instala Google Chrome o usa CHROME_PATH.",
    };
  }

  let browser;
  const debugLog: string[] = [];
  const doSave = async (page: Page, name: string) => saveScreenshot(page, name, !!doScreenshots, debugLog);

  // BancoEstado blocks headless browsers (TLS fingerprinting) — requires visible Chrome
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return {
      success: false, bank, movements: [],
      error: "BancoEstado requiere modo headful (Chrome visible). No se detectó display ($DISPLAY/$WAYLAND_DISPLAY). Usa un entorno con GUI o configura Xvfb.",
      debug: debugLog.join("\n"),
    };
  }

  try {
    if (headful === false) {
      debugLog.push("  WARNING: BancoEstado bloquea headless. Se abrirá Chrome visible de todas formas.");
    }
    browser = await puppeteer.launch({
      headless: false,
      executablePath,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-blink-features=AutomationControlled", "--window-size=1280,900"],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

    // Hide webdriver detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // Step 1: Navigate to login
    debugLog.push("1. Navigating to BancoEstado login...");
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 30000 });
    await delay(3000);
    await closePopups(page);
    await doSave(page, "01-homepage");

    // Step 2: Wait for offcanvas login form
    debugLog.push("2. Waiting for login offcanvas...");
    try {
      await page.waitForSelector(".msd-custom-sidenav__container #rut", { visible: true, timeout: 15000 });
    } catch {
      const loginBtn = await page.evaluate(() => {
        const btns = document.querySelectorAll("a, button");
        for (const btn of btns) {
          const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
          if (text.includes("ingresar") || text.includes("banca en línea") || text.includes("login")) {
            (btn as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (loginBtn) {
        debugLog.push("  Clicked login button to open offcanvas");
        await delay(3000);
      }
      await page.waitForSelector("#rut", { visible: true, timeout: 10000 });
    }
    debugLog.push("  Login form visible");
    await doSave(page, "02-login-form");

    // Step 3: Fill RUT
    debugLog.push("3. Filling RUT...");
    const rutFilled = await fillRut(page, rut, debugLog);
    if (!rutFilled) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return { success: false, bank, movements: [], error: "No se pudo llenar el RUT", screenshot: screenshot as string, debug: debugLog.join("\n") };
    }

    // Step 4: Fill password
    debugLog.push("4. Filling password...");
    const passFilled = await fillPassword(page, password, debugLog);
    if (!passFilled) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return { success: false, bank, movements: [], error: "No se pudo llenar la clave", screenshot: screenshot as string, debug: debugLog.join("\n") };
    }
    await doSave(page, "03-credentials");

    // Step 5: Submit login
    debugLog.push("5. Submitting login...");
    const submitBtn = await page.$("#btnLogin");
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.evaluate(() => {
        const form = document.querySelector("form");
        if (form) form.dispatchEvent(new Event("submit", { bubbles: true }));
      });
    }

    try {
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
    } catch {
      await delay(5000);
    }
    await delay(3000);
    await closePopups(page);
    await doSave(page, "04-post-login");

    // Check for login errors
    const loginError = await page.evaluate(() => {
      const errorKeywords = ["contraseña", "clave incorrecta", "rut inválido", "credenciales", "bloqueado", "intente nuevamente", "reintente"];
      const errorEls = document.querySelectorAll('[class*="error"], [class*="alert"], .input-messages');
      for (const el of errorEls) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase();
        if (text && errorKeywords.some(kw => text.includes(kw))) {
          return (el as HTMLElement).innerText?.trim();
        }
      }
      return null;
    });

    if (loginError) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return { success: false, bank, movements: [], error: `Login fallido: ${loginError}`, screenshot: screenshot as string, debug: debugLog.join("\n") };
    }

    // Close promotional modals ("No por ahora", "Cerrar", etc.)
    await page.evaluate(() => {
      const btns = document.querySelectorAll("button, a");
      for (const btn of btns) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
        if (text === "no por ahora" || text === "cerrar" || text === "×") {
          (btn as HTMLElement).click();
          break;
        }
      }
    });
    await delay(1000);

    // Log URL without query params (may contain session tokens)
    const postLoginUrl = new URL(page.url());
    debugLog.push(`  Login OK! URL: ${postLoginUrl.origin}${postLoginUrl.pathname}`);

    // Step 6: Extract balance from dashboard (CuentaRUT)
    debugLog.push("6. Extracting CuentaRUT balance from dashboard...");
    const balance = await extractBalanceFromDashboard(page, debugLog);
    await doSave(page, "05-dashboard");

    // Step 7: Navigate to CuentaRUT movements
    debugLog.push("7. Navigating to CuentaRUT movements...");

    // First try: click "ir a movimientos" link on dashboard
    let navigated = await page.evaluate(() => {
      const links = document.querySelectorAll("a, button");
      for (const el of links) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase();
        if (text === "ir a movimientos" || text === "ver movimientos" || text === "ver más movimientos") {
          (el as HTMLElement).click();
          return text;
        }
      }
      return null;
    });

    if (navigated) {
      debugLog.push(`  Clicked: "${navigated}"`);
      await delay(5000);
      await closePopups(page);
    } else {
      // Second try: sidebar Cuentas > CuentaRUT / Movimientos
      debugLog.push("  No 'ir a movimientos' link, trying sidebar...");
      const sidebarClicked = await page.evaluate(() => {
        const items = document.querySelectorAll("nav a, a, button");
        // Look for "Cuentas" in sidebar
        for (const el of items) {
          const text = (el as HTMLElement).innerText?.trim().toLowerCase();
          if (text === "cuentas") {
            (el as HTMLElement).click();
            return "cuentas";
          }
        }
        return null;
      });

      if (sidebarClicked) {
        debugLog.push(`  Expanded: "${sidebarClicked}"`);
        await delay(2000);

        // Now click CuentaRUT or Movimientos submenu
        const subClicked = await page.evaluate(() => {
          const items = document.querySelectorAll("a, button");
          // Prefer CuentaRUT specific
          for (const el of items) {
            const text = (el as HTMLElement).innerText?.trim().toLowerCase();
            if (text.includes("cuentarut") || text.includes("cuenta rut")) {
              (el as HTMLElement).click();
              return text;
            }
          }
          // Fallback to movimientos
          for (const el of items) {
            const text = (el as HTMLElement).innerText?.trim().toLowerCase();
            if (text === "movimientos" || text === "cartola") {
              (el as HTMLElement).click();
              return text;
            }
          }
          return null;
        });

        if (subClicked) {
          debugLog.push(`  Clicked: "${subClicked}"`);
          await delay(5000);
          await closePopups(page);
        }
      }
    }

    await doSave(page, "06-movements-page");

    // Step 8: Extract movements
    debugLog.push("8. Extracting movements...");
    let movements = await extractMovements(page, debugLog);

    // Try pagination
    for (let i = 0; i < 10; i++) {
      const hasMore = await page.evaluate(() => {
        const btns = document.querySelectorAll("button, a");
        for (const btn of btns) {
          const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
          const el = btn as HTMLButtonElement;
          if ((text === "siguiente" || text === "ver más" || text === "cargar más" || text.includes("›")) && !el.disabled) {
            el.click();
            return true;
          }
        }
        return false;
      });

      if (!hasMore) break;
      debugLog.push(`  Pagination: page ${i + 2}`);
      await delay(3000);

      const moreMovements = await extractMovements(page, debugLog);
      if (moreMovements.length === 0) break;
      movements.push(...moreMovements);
    }

    const deduplicated = deduplicateMovements(movements);
    debugLog.push(`  Total: ${deduplicated.length} unique movements`);

    await doSave(page, "07-final");
    const screenshot = doScreenshots ? await page.screenshot({ encoding: "base64" }) as string : undefined;

    return {
      success: true,
      bank,
      movements: deduplicated,
      balance,
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

const bestado: BankScraper = {
  id: "bestado",
  name: "Banco Estado",
  url: "https://www.bancoestado.cl",
  scrape,
};

export default bestado;
