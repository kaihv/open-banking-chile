import type { Page } from "puppeteer-core";
import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, parseChileanAmount, normalizeDate, deduplicateMovements } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { clickByText } from "../actions/navigation.js";

// ─── Bestado-specific constants ──────────────────────────────────

const LOGIN_URL = "https://www.bancoestado.cl/content/bancoestado-public/cl/es/home/home.html#/login";

// ─── Bestado-specific helpers ────────────────────────────────────

async function fillRut(page: Page, rut: string): Promise<boolean> {
  const rutInput = await page.$("#rut");
  if (!rutInput) return false;

  await rutInput.click();
  await delay(500);

  // Angular removes readonly on focus — force-remove if still present
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

  return true;
}

async function fillPassword(page: Page, password: string): Promise<boolean> {
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

  return true;
}

async function extractBalanceFromDashboard(page: Page, debugLog: string[]): Promise<number | undefined> {
  const balance = await page.evaluate(() => {
    const productCards = document.querySelectorAll('[class*="product"], [class*="card"], [class*="cuenta"]');
    for (const card of productCards) {
      const text = (card as HTMLElement).innerText || "";
      if (text.toLowerCase().includes("cuentarut") || text.toLowerCase().includes("cuenta rut")) {
        const amountMatch = text.match(/\$\s*([\d.,]+)/);
        if (amountMatch) return amountMatch[1];
      }
    }
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
  return undefined;
}

async function extractMovements(page: Page): Promise<BankMovement[]> {
  const raw = await page.evaluate(() => {
    const results: Array<{ date: string; description: string; amount: string; balance: string }> = [];

    // Strategy 1: Table with headers
    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll("tr"));
      if (rows.length < 2) continue;

      let dateIdx = -1, descIdx = -1, amountIdx = -1, saldoIdx = -1;
      let cargoIdx = -1, abonoIdx = -1;
      for (const row of rows) {
        const ths = row.querySelectorAll("th");
        if (ths.length >= 3) {
          const headers = Array.from(ths).map(h => (h as HTMLElement).innerText?.trim().toLowerCase());
          dateIdx = headers.findIndex(h => h.includes("fecha"));
          descIdx = headers.findIndex(h => h.includes("descripci") || h.includes("detalle") || h.includes("glosa"));
          saldoIdx = headers.findIndex(h => h.includes("saldo"));
          amountIdx = headers.findIndex(h => (h.includes("abono") && h.includes("cargo")) || h.includes("monto") || h.includes("importe"));
          if (amountIdx < 0) {
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
          amount = texts[amountIdx] || "";
        } else if (cargoIdx >= 0 || abonoIdx >= 0) {
          const cargo = cargoIdx >= 0 ? texts[cargoIdx] || "" : "";
          const abono = abonoIdx >= 0 ? texts[abonoIdx] || "" : "";
          if (cargo && cargo !== "$0" && cargo !== "0") amount = `-${cargo}`;
          else if (abono) amount = abono;
        }

        results.push({
          date: dateText,
          description: texts[descIdx >= 0 ? descIdx : 1] || "",
          amount,
          balance: saldoIdx >= 0 ? texts[saldoIdx] || "" : "",
        });
      }
    }

    // Strategy 2: Dashboard movement cards
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

  return raw
    .map(r => {
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

// ─── Main scrape function ────────────────────────────────────────

async function scrapeBestado(
  session: BrowserSession,
  options: ScraperOptions,
): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots } = options;
  const { onProgress } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const bank = "bestado";
  const progress = onProgress || (() => {});

  // 1. Navigate
  debugLog.push("1. Navigating to BancoEstado login...");
  progress("Abriendo sitio del banco...");
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(3000);
  await closePopups(page);
  await doSave(page, "01-homepage");

  // 2. Wait for login form
  debugLog.push("2. Waiting for login offcanvas...");
  try {
    await page.waitForSelector(".msd-custom-sidenav__container #rut", { visible: true, timeout: 15000 });
  } catch {
    await clickByText(page, ["ingresar", "banca en línea", "login"]);
    await delay(3000);
    await page.waitForSelector("#rut", { visible: true, timeout: 10000 });
  }
  await doSave(page, "02-login-form");

  // 3-4. Fill credentials
  debugLog.push("3. Filling RUT...");
  progress("Ingresando RUT...");
  if (!(await fillRut(page, rut))) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se pudo llenar el RUT", screenshot: ss as string, debug: debugLog.join("\n") };
  }

  debugLog.push("4. Filling password...");
  progress("Ingresando clave...");
  if (!(await fillPassword(page, password))) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se pudo llenar la clave", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await doSave(page, "03-credentials");

  // 5. Submit
  debugLog.push("5. Submitting login...");
  progress("Iniciando sesión...");
  const submitBtn = await page.$("#btnLogin");
  if (submitBtn) {
    await submitBtn.click();
  } else {
    await page.evaluate(() => {
      const form = document.querySelector("form");
      if (form) form.dispatchEvent(new Event("submit", { bubbles: true }));
    });
  }

  try { await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }); } catch { await delay(5000); }
  await delay(3000);
  await closePopups(page);
  await doSave(page, "04-post-login");

  // Check login errors
  const loginError = await page.evaluate(() => {
    const errorKeywords = ["contraseña", "clave incorrecta", "rut inválido", "credenciales", "bloqueado", "intente nuevamente", "reintente"];
    const errorEls = document.querySelectorAll('[class*="error"], [class*="alert"], .input-messages');
    for (const el of errorEls) {
      const text = (el as HTMLElement).innerText?.trim().toLowerCase();
      if (text && errorKeywords.some(kw => text.includes(kw))) return (el as HTMLElement).innerText?.trim();
    }
    return null;
  });
  if (loginError) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: `Login fallido: ${loginError}`, screenshot: ss as string, debug: debugLog.join("\n") };
  }

  // Dismiss promo modals
  await page.evaluate(() => {
    const btns = document.querySelectorAll("button, a");
    for (const btn of btns) {
      const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
      if (text === "no por ahora" || text === "cerrar" || text === "×") { (btn as HTMLElement).click(); break; }
    }
  });
  await delay(1000);

  const postLoginUrl = new URL(page.url());
  debugLog.push(`  Login OK! URL: ${postLoginUrl.origin}${postLoginUrl.pathname}`);
  progress("Sesión iniciada correctamente");

  // 6. Balance
  debugLog.push("6. Extracting CuentaRUT balance...");
  progress("Extrayendo saldo CuentaRUT...");
  const balance = await extractBalanceFromDashboard(page, debugLog);
  await doSave(page, "05-dashboard");

  // 7. Navigate to movements
  debugLog.push("7. Navigating to CuentaRUT movements...");
  progress("Navegando a movimientos CuentaRUT...");
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
    // Sidebar fallback
    const sidebarClicked = await clickByText(page, ["cuentas"]);
    if (sidebarClicked) {
      await delay(2000);
      await clickByText(page, ["cuentarut", "cuenta rut", "movimientos", "cartola"]);
      await delay(5000);
      await closePopups(page);
    }
  }

  await doSave(page, "06-movements-page");

  // 8. Extract movements with pagination
  debugLog.push("8. Extracting movements...");
  progress("Extrayendo movimientos...");
  let movements = await extractMovements(page);

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
    const more = await extractMovements(page);
    if (more.length === 0) break;
    movements.push(...more);
  }

  const deduplicated = deduplicateMovements(movements);
  debugLog.push(`  Total: ${deduplicated.length} unique movements`);
  progress(`Listo — ${deduplicated.length} movimientos totales`);

  await doSave(page, "07-final");
  const ss = doScreenshots ? await page.screenshot({ encoding: "base64" }) as string : undefined;

  return { success: true, bank, accounts: [{ balance, movements: deduplicated }], screenshot: ss, debug: debugLog.join("\n") };
}

// ─── Export ──────────────────────────────────────────────────────

const bestado: BankScraper = {
  id: "bestado",
  name: "Banco Estado",
  url: "https://www.bancoestado.cl",
  scrape: (options) => runScraper("bestado", options, { forceHeadful: true }, scrapeBestado),
};

export default bestado;
