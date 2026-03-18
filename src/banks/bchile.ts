import puppeteer, { type Page } from "puppeteer-core";
import type { BankMovement, BankScraper, CreditCardBalance, MovementSource, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, findChrome, formatRut, saveScreenshot, normalizeDate, deduplicateMovements, logout, normalizeInstallments } from "../utils.js";

const BANK_URL = "https://portalpersonas.bancochile.cl/persona/";
const API_BASE = "https://portalpersonas.bancochile.cl/mibancochile/rest/persona";

// ─── Helpers ──────────────────────────────────────────────────────

// ─── Login helpers ────────────────────────────────────────────────

async function fillRut(page: Page, rut: string, debugLog: string[]): Promise<boolean> {
  const formattedRut = formatRut(rut);
  const cleanRut = rut.replace(/[.\-]/g, "");

  const selectors = [
    "#ppriv_per-login-click-input-rut",
    'input[name="userRut"]',
    "#rut",
    'input[name="rut"]',
    'input[placeholder*="RUT"]',
    'input[placeholder*="Rut"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        // Use clean RUT for fields with short maxlength, formatted otherwise
        const maxLen = await page.evaluate((s: string) => {
          const input = document.querySelector(s) as HTMLInputElement | null;
          return input?.maxLength ?? -1;
        }, sel);
        const rutValue = (maxLen > 0 && maxLen <= 10) ? cleanRut : formattedRut;
        await el.click({ clickCount: 3 });
        await el.type(rutValue, { delay: 45 });
        debugLog.push(`  RUT filled using selector: ${sel}`);
        return true;
      }
    } catch {
      // Try next selector.
    }
  }

  // Last resort: find any visible text input
  try {
    const wasFilled = await page.evaluate((rutFormatted: string, rutClean: string) => {
      const candidates = Array.from(document.querySelectorAll("input"));
      for (const input of candidates) {
        const el = input as HTMLInputElement;
        if (el.offsetParent === null || el.disabled || el.type === "password") continue;
        el.focus();
        el.value = el.maxLength > 0 && el.maxLength <= 10 ? rutClean : rutFormatted;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    }, formattedRut, cleanRut);

    if (wasFilled) {
      debugLog.push("  RUT filled using generic input fallback");
      return true;
    }
  } catch {
    // ignore
  }

  debugLog.push("  RUT field not found");
  return false;
}

async function fillPassword(page: Page, password: string, debugLog: string[]): Promise<boolean> {
  const selectors = [
    "#ppriv_per-login-click-input-password",
    'input[name="userPassword"]',
    "#pass",
    "#password",
    'input[type="password"]',
    'input[name="password"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;

      // Check if input is readonly or disabled
      const isReadonly = await page.evaluate((selector: string) => {
        const input = document.querySelector(selector) as HTMLInputElement | null;
        if (!input) return false;
        return input.readOnly || input.disabled;
      }, sel);

      if (!isReadonly) {
        await el.click();
        await el.type(password, { delay: 45 });
        debugLog.push(`  Password filled using selector: ${sel}`);
        return true;
      }

      // Input is readonly/disabled — try virtual keyboard
      debugLog.push(`  Password field ${sel} is readonly/disabled, trying virtual keyboard...`);
      const keyboardSelectors = [
        '[class*="keyboard"]',
        '[class*="teclado"]',
        '[class*="virtual"]',
      ];

      let keyboardFound = false;
      for (const kbSel of keyboardSelectors) {
        const keyboard = await page.$(kbSel);
        if (keyboard) {
          keyboardFound = true;
          debugLog.push(`  Virtual keyboard found: ${kbSel}`);

          for (const char of password) {
            const clicked = await page.evaluate((ch: string, kbSelector: string) => {
              const kb = document.querySelector(kbSelector);
              if (!kb) return false;
              const buttons = Array.from(kb.querySelectorAll("button, span, div, a"));
              for (const btn of buttons) {
                const text = (btn as HTMLElement).innerText?.trim();
                if (text === ch) {
                  (btn as HTMLElement).click();
                  return true;
                }
              }
              return false;
            }, char, kbSel);

            if (!clicked) {
              debugLog.push("  Virtual keyboard: character not found");
              return false;
            }
          }

          debugLog.push("  Password filled using virtual keyboard");
          return true;
        }
      }

      if (!keyboardFound) {
        debugLog.push("  Virtual keyboard not found");
      }
    } catch {
      // Try next selector.
    }
  }

  debugLog.push("  Password field not found");
  return false;
}

async function clickSubmitButton(page: Page, debugLog: string[]): Promise<boolean> {
  const selectors = [
    "#ppriv_per-login-click-ingresar-login",
    'button[type="submit"]',
    "#btn-login",
    "#btn_login",
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        debugLog.push(`  Submit clicked: ${sel}`);
        return true;
      }
    } catch {
      // Try next selector.
    }
  }

  // Fallback: find button by text
  const clicked = await page.evaluate(() => {
    const texts = ["ingresar", "continuar", "iniciar sesión"];
    const buttons = Array.from(document.querySelectorAll("button, a, input[type='submit']"));
    for (const btn of buttons) {
      const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (texts.some((t) => text.includes(t))) {
        (btn as HTMLElement).click();
        return true;
      }
    }
    return false;
  });

  if (clicked) {
    debugLog.push("  Submit clicked via text fallback");
    return true;
  }

  debugLog.push("  Submit button not found");
  return false;
}

async function detectLoginError(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const selectors = ['[class*="error"]', '[class*="alert"]', '[role="alert"]'];
    const errorTexts: string[] = [];

    for (const sel of selectors) {
      const elements = document.querySelectorAll(sel);
      for (const el of elements) {
        const text = (el as HTMLElement).innerText?.trim();
        if (text) errorTexts.push(text);
      }
    }

    const keywords = [
      "clave incorrecta",
      "rut inválido",
      "bloqueada",
      "bloqueado",
      "suspendida",
      "sesión activa",
      "ya tiene una sesión",
    ];

    for (const text of errorTexts) {
      const lower = text.toLowerCase();
      for (const kw of keywords) {
        if (lower.includes(kw)) return text;
      }
    }

    return null;
  });
}

async function has2FAChallenge(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const text = (document.body?.innerText || "").toLowerCase();
    return (
      text.includes("clave dinámica") ||
      text.includes("clave dinamica") ||
      text.includes("superclave") ||
      text.includes("segundo factor") ||
      text.includes("código de verificación") ||
      text.includes("codigo de verificacion") ||
      text.includes("ingresa tu token")
    );
  });
}

// ─── Login ────────────────────────────────────────────────────────

async function login(
  page: Page,
  rut: string,
  password: string,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>
): Promise<{ success: boolean; error?: string; screenshot?: string }> {
  debugLog.push("1. Navigating to bank homepage...");
  await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 45000 });
  await delay(3000);
  await doSave(page, "01-homepage");

  // Wait for login form to appear (may redirect via OAuth)
  try {
    await page.waitForSelector('input[name="userRut"], input[name="rut"], #rut, input[placeholder*="RUT"]', { timeout: 15000 });
  } catch {
    debugLog.push("  Login form not found after waiting");
  }
  await delay(1000);
  await doSave(page, "01b-login-form");

  debugLog.push("2. Filling RUT...");
  const rutFilled = await fillRut(page, rut, debugLog);
  if (!rutFilled) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró el campo de RUT", screenshot: screenshot as string };
  }
  await delay(500);

  debugLog.push("3. Filling password...");
  const passFilled = await fillPassword(page, password, debugLog);
  if (!passFilled) {
    // May be two-step: submit RUT first, then wait for password
    const submitted1 = await clickSubmitButton(page, debugLog);
    if (!submitted1) await page.keyboard.press("Enter");
    await delay(3000);
    await doSave(page, "02-after-rut-submit");

    const passFilled2 = await fillPassword(page, password, debugLog);
    if (!passFilled2) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return { success: false, error: "No se encontró el campo de clave", screenshot: screenshot as string };
    }
  }

  await doSave(page, "02-pre-submit");

  // Submit login
  debugLog.push("4. Submitting login...");
  const submitted = await clickSubmitButton(page, debugLog);
  if (!submitted) {
    await page.keyboard.press("Enter");
    debugLog.push("  Pressed Enter as fallback");
  }

  // Wait for navigation after login
  try {
    await page.waitForNavigation({ timeout: 25000 });
  } catch {
    // SPA may not trigger navigation event
  }

  await delay(5000);
  await doSave(page, "03-after-login");

  // Check for login errors
  const loginError = await detectLoginError(page);
  if (loginError) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: `Error de login: ${loginError}`, screenshot: screenshot as string };
  }

  // Check for 2FA
  if (await has2FAChallenge(page)) {
    const timeoutSec = Math.min(600, Math.max(30, parseInt(process.env.BCHILE_2FA_TIMEOUT_SEC || "180", 10)));
    const timeoutMs = timeoutSec * 1000;
    debugLog.push(`  2FA detectado. Esperando aprobación manual (${timeoutSec}s máx)...`);
    const deadline = Date.now() + timeoutMs;
    let pollCount = 0;

    while (Date.now() < deadline) {
      if (!(await has2FAChallenge(page))) {
        debugLog.push("  2FA completado, continuando flujo.");
        break;
      }
      if (pollCount % 10 === 0) {
        const remaining = Math.round((deadline - Date.now()) / 1000);
        debugLog.push(`  Esperando aprobación... (${remaining}s restantes)`);
      }
      pollCount++;
      await delay(1500);
    }

    if (await has2FAChallenge(page)) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return { success: false, error: "Timeout esperando aprobación de 2FA", screenshot: screenshot as string };
    }
  }

  // Check if still on login page
  const currentUrl = page.url();
  if (currentUrl.includes("/login")) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "Login failed — aún en página de login", screenshot: screenshot as string };
  }

  debugLog.push(`4. Login OK!`);
  return { success: true };
}

// ─── REST API helpers ─────────────────────────────────────────────

async function apiGet<T>(page: Page, path: string): Promise<T> {
  return await page.evaluate(async (url: string) => {
    const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/);
    const xsrf = m ? decodeURIComponent(m[1]) : "";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (xsrf) headers["X-XSRF-TOKEN"] = xsrf;
    const r = await fetch(url, { credentials: "include", headers });
    if (!r.ok) throw new Error(`API GET ${url} → ${r.status}`);
    return r.json();
  }, `${API_BASE}/${path}`);
}

async function apiPost<T>(page: Page, path: string, body: unknown = {}): Promise<T> {
  return await page.evaluate(async (url: string, bodyStr: string) => {
    const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/);
    const xsrf = m ? decodeURIComponent(m[1]) : "";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (xsrf) headers["X-XSRF-TOKEN"] = xsrf;
    const r = await fetch(url, { method: "POST", credentials: "include", headers, body: bodyStr });
    if (!r.ok) throw new Error(`API POST ${url} → ${r.status}`);
    return r.json();
  }, `${API_BASE}/${path}`, JSON.stringify(body));
}

// ─── API response types ───────────────────────────────────────────

interface ApiAccountBalance {
  codProducto: string;
  tipo: string;
  numero: string;
  disponible: number;
  cupo: number;
  moneda: string;
  descripcion: string;
}

interface ApiProduct {
  id: string;
  numero: string;
  mascara: string;
  codigo: string;
  codigoMoneda: string;
  label: string;
  tipo: string;
  claseCuenta: string;
  tarjetaHabiente: string | null;
  descripcionLogo: string;
  tipoCliente: string;
}

interface ApiCardInfo {
  titular: boolean;
  marca: string;
  tipo: string;
  idProducto: string;
  numero: string;
}

interface ApiCardSaldo {
  cupoTotalNacional: number;
  cupoUtilizadoNacional: number;
  cupoDisponibleNacional: number;
  cupoTotalInternacional: number;
  cupoUtilizadoInternacional: number;
  cupoDisponibleInternacional: number;
}

interface ApiMovNoFactur {
  origenTransaccion: string;
  fechaTransaccionString: string;
  montoCompra: number;
  glosaTransaccion: string;
  despliegueCuotas: string;
}

interface ApiFechaFacturacion {
  fechaFacturacion: string;
  existeEstadoCuentaNacional: string;
  existeEstadoCuentaInternacional: string;
}

interface ApiTransaccionFacturada {
  fechaTransaccionString: string;
  montoTransaccion: number;
  descripcion: string;
  cuotas: string;
  grupo: string;
}

// ─── API-based data extraction ────────────────────────────────────

const MONTH_NAMES = ["", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

interface ApiClientData {
  datosCliente: { rut: string; nombres: string; apellidoPaterno: string; apellidoMaterno: string };
}

interface ApiProductsResponse {
  rut: string;
  nombre: string;
  productos: ApiProduct[];
}

type ApiResumenResponse = {
  existeEstadoCuenta: boolean;
  seccionOperaciones?: {
    transaccionesTarjetas: ApiTransaccionFacturada[];
  };
};

function buildBaseCardBody(card: ApiCardInfo, nombreTitular: string) {
  const mascara = card.numero.replace(/\*/g, "").length <= 4
    ? `****${card.numero.slice(-4)}`
    : card.numero;
  return {
    idTarjeta: card.idProducto,
    codigoProducto: "TNM",
    tipoTarjeta: `${card.marca} ${card.tipo}`.trim(),
    mascara,
    nombreTitular,
  };
}

function buildCardBody(card: ApiCardInfo, nombreTitular: string) {
  return { ...buildBaseCardBody(card, nombreTitular), tipoCliente: "T" as const };
}

interface ApiCartolaMov {
  descripcion: string;
  monto: number;
  saldo: number;
  tipo: string; // "cargo" | "abono"
  fechaContable: string;
}

type ApiCartolaResponse = {
  movimientos: ApiCartolaMov[];
  pagina: Array<{ totalRegistros: number; masPaginas: boolean }>;
};

function cartolaMovToMovement(mov: ApiCartolaMov): BankMovement {
  return {
    date: normalizeDate(mov.fechaContable),
    description: mov.descripcion.trim(),
    amount: mov.tipo === "cargo" ? -Math.abs(mov.monto) : Math.abs(mov.monto),
    balance: mov.saldo,
    source: MOVEMENT_SOURCE.account,
  };
}

function facturadoToMovement(tx: ApiTransaccionFacturada, source: MovementSource): BankMovement {
  return {
    date: normalizeDate(tx.fechaTransaccionString),
    description: tx.descripcion.trim(),
    amount: tx.grupo === "pagos" ? Math.abs(tx.montoTransaccion) : -Math.abs(tx.montoTransaccion),
    balance: 0,
    source,
    installments: normalizeInstallments(tx.cuotas),
  };
}

const MAX_PAGES = 25;

async function fetchAccountMovements(
  page: Page,
  products: ApiProduct[],
  fullName: string,
  rut: string,
  debugLog: string[],
): Promise<{ movements: BankMovement[]; balance?: number }> {
  const accounts = products.filter(p =>
    p.tipo === "cuenta" || p.tipo === "cuentaCorrienteMonedaLocal"
  );

  // Deduplicate by numero (CTD appears twice with different tipo)
  const seenNums = new Set<string>();
  const uniqueAccounts = accounts.filter(a => {
    if (seenNums.has(a.numero)) return false;
    seenNums.add(a.numero);
    return true;
  });

  if (uniqueAccounts.length === 0) return { movements: [], balance: undefined };

  // Navigate to movements page to load the microfrontend
  const baseUrl = page.url().split("#")[0];
  await page.goto(`${baseUrl}#/movimientos/cuenta/saldos-movimientos`, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(5000);

  const movements: BankMovement[] = [];
  let balance: number | undefined;

  for (const acct of uniqueAccounts) {
    debugLog.push(`  Fetching movements for ${acct.descripcionLogo} ${acct.mascara} (${acct.codigoMoneda})`);

    const cuentaSeleccionada = {
      nombreCliente: fullName,
      rutCliente: rut,
      numero: acct.numero,
      mascara: acct.mascara,
      selected: true,
      codigoProducto: acct.codigo,
      claseCuenta: acct.claseCuenta,
      moneda: acct.codigoMoneda,
    };

    try {
      // Must call getConfigConsultaMovimientos first to establish session context
      await apiPost(page, "movimientos/getConfigConsultaMovimientos", {
        cuentasSeleccionadas: [cuentaSeleccionada],
      });

      const cartola = await apiPost<ApiCartolaResponse>(
        page, "bff-pper-prd-cta-movimientos/movimientos/getCartola",
        { cuentaSeleccionada, cabecera: { statusGenerico: true, paginacionDesde: 1 } },
      );

      if (cartola.movimientos) {
        const tag = `[${acct.descripcionLogo} ${acct.mascara}]`;
        for (const mov of cartola.movimientos) {
          movements.push(cartolaMovToMovement(mov));
        }

        if (balance === undefined && acct.codigoMoneda === "CLP" && cartola.movimientos.length > 0) {
          balance = cartola.movimientos[0].saldo;
        }

        const pageSize = cartola.movimientos.length;
        debugLog.push(`    → ${pageSize} movements`);

        // paginacionDesde is a 1-based record offset, not a page number
        let hasMore = pageSize > 0 && (cartola.pagina?.[0]?.masPaginas ?? false);
        let offset = 1 + pageSize;
        for (let p = 2; hasMore && p <= MAX_PAGES; p++) {
          try {
            const nextPage = await apiPost<ApiCartolaResponse>(
              page, "bff-pper-prd-cta-movimientos/movimientos/getCartola",
              { cuentaSeleccionada, cabecera: { statusGenerico: true, paginacionDesde: offset } },
            );

            const count = nextPage.movimientos?.length ?? 0;
            if (count === 0) break;

            for (const mov of nextPage.movimientos) {
              movements.push(cartolaMovToMovement(mov));
            }
            debugLog.push(`    → offset ${offset}: ${count} movements`);

            offset += count;
            hasMore = nextPage.pagina?.[0]?.masPaginas ?? false;
          } catch {
            hasMore = false;
          }
        }
      }
    } catch (err) {
      debugLog.push(`    → Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { movements, balance };
}

async function fetchResumenMovements(
  page: Page,
  endpoint: "nacional" | "internacional",
  resumenBody: Record<string, unknown>,
  tag: string,
): Promise<BankMovement[]> {
  const movements: BankMovement[] = [];
  const resumen = await apiPost<ApiResumenResponse>(
    page, `tarjetas/estadocuenta/${endpoint}/resumen-por-fecha`, resumenBody,
  );

  if (resumen.existeEstadoCuenta && resumen.seccionOperaciones?.transaccionesTarjetas) {
    for (const tx of resumen.seccionOperaciones.transaccionesTarjetas ?? []) {
      if (tx.grupo === "totales") continue;
      movements.push(facturadoToMovement(tx, MOVEMENT_SOURCE.credit_card_billed));
    }
  }
  return movements;
}

async function fetchCreditCardData(
  page: Page,
  fullName: string,
  debugLog: string[],
): Promise<{ movements: BankMovement[]; creditCards: CreditCardBalance[] }> {
  const movements: BankMovement[] = [];
  const creditCards: CreditCardBalance[] = [];

  // Get card list
  let cards: ApiCardInfo[];
  try {
    cards = await apiPost<ApiCardInfo[]>(page, "tarjetas/widget/informacion-tarjetas", {});
  } catch (err) {
    debugLog.push(`  Could not fetch card list: ${err instanceof Error ? err.message : String(err)}`);
    return { movements, creditCards };
  }

  if (cards.length === 0) {
    debugLog.push("  No credit cards found");
    return { movements, creditCards };
  }

  debugLog.push(`  Found ${cards.length} credit card(s)`);

  for (const card of cards) {
    const cardLabel = `${card.marca} ${card.tipo} ${card.numero.slice(-8)}`.trim();
    const tag = `[TC ${cardLabel}]`;
    debugLog.push(`  Processing card: ${cardLabel}`);

    const baseBody = buildBaseCardBody(card, fullName);
    const body = { ...baseBody, tipoCliente: "T" as const };

    // 1 & 2. Get balances and non-billed movements in parallel
    const [saldoResult, noFacturadosResult] = await Promise.allSettled([
      apiPost<ApiCardSaldo>(page, "tarjeta-credito-digital/saldo/obtener-saldo", body),
      apiPost<{
        fechaProximaFacturacionCalendario: string;
        listaMovNoFactur: ApiMovNoFactur[];
      }>(page, "tarjeta-credito-digital/movimientos-no-facturados", body),
    ]);

    // Process balances
    if (saldoResult.status === "fulfilled") {
      const saldo = saldoResult.value;
      creditCards.push({
        label: cardLabel,
        national: {
          used: saldo.cupoUtilizadoNacional,
          available: saldo.cupoDisponibleNacional,
          total: saldo.cupoTotalNacional,
        },
        international: {
          used: saldo.cupoUtilizadoInternacional,
          available: saldo.cupoDisponibleInternacional,
          total: saldo.cupoTotalInternacional,
          currency: "USD",
        },
      });
      debugLog.push(`    Balances: NAC used=$${saldo.cupoUtilizadoNacional}, INT used=$${saldo.cupoUtilizadoInternacional}`);
    } else {
      debugLog.push(`    Could not fetch balances: ${saldoResult.reason}`);
      creditCards.push({ label: cardLabel });
    }

    // Process non-billed movements
    if (noFacturadosResult.status === "fulfilled") {
      const noFacturados = noFacturadosResult.value;
      const ccEntry = creditCards[creditCards.length - 1];
      if (noFacturados.fechaProximaFacturacionCalendario) {
        ccEntry.nextBillingDate = noFacturados.fechaProximaFacturacionCalendario;
      }

      for (const mov of noFacturados.listaMovNoFactur || []) {
        movements.push({
          date: normalizeDate(mov.fechaTransaccionString),
          description: mov.glosaTransaccion.trim(),
          amount: mov.montoCompra < 0 ? Math.abs(mov.montoCompra) : -Math.abs(mov.montoCompra),
          balance: 0,
          source: MOVEMENT_SOURCE.credit_card_unbilled,
          installments: normalizeInstallments(mov.despliegueCuotas),
        });
      }

      debugLog.push(`    No-facturados: ${(noFacturados.listaMovNoFactur || []).length} movements`);
    } else {
      debugLog.push(`    Could not fetch no-facturados: ${noFacturadosResult.reason}`);
    }

    // 3. Get billed movements (facturados) — need fechas-facturacion first
    try {
      const fechasBody = baseBody;

      const fechas = await apiPost<{
        existenEstadosDeCuenta: boolean;
        numeroCuenta: string | null;
        listaNacional: ApiFechaFacturacion[];
        listaInternacional: ApiFechaFacturacion[];
      }>(page, "tarjetas/estadocuenta/fechas-facturacion", fechasBody);

      if (fechas.existenEstadosDeCuenta) {
        const ccEntry = creditCards[creditCards.length - 1];
        if (fechas.listaNacional?.[0]) {
          const parts = fechas.listaNacional[0].fechaFacturacion.split("-");
          if (parts.length >= 2) {
            const monthIdx = parseInt(parts[1], 10);
            ccEntry.billingPeriod = `${MONTH_NAMES[monthIdx] ?? parts[1]} ${parts[0]}`;
          }
        }

        const latestFecha = fechas.listaNacional?.[0]?.fechaFacturacion;
        const numeroCuenta = fechas.numeroCuenta;
        if (latestFecha && numeroCuenta) {
          try {
            const resumenBody = { ...fechasBody, fechaFacturacion: latestFecha, numeroCuenta };

            const [nacMovs, intMovs] = await Promise.allSettled([
              fetchResumenMovements(page, "nacional", resumenBody, tag),
              fetchResumenMovements(page, "internacional", resumenBody, tag),
            ]);

            if (nacMovs.status === "fulfilled") {
              movements.push(...nacMovs.value);
              debugLog.push(`    Facturados NAC: ${nacMovs.value.length} movements`);
            }
            if (intMovs.status === "fulfilled") {
              movements.push(...intMovs.value);
              debugLog.push(`    Facturados INT: ${intMovs.value.length} movements`);
            }
          } catch (err) {
            debugLog.push(`    Could not fetch facturados: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (!numeroCuenta) {
          debugLog.push("    No numeroCuenta in fechas-facturacion response (no billing history)");
        }
      }
    } catch (err) {
      debugLog.push(`    Could not fetch fechas-facturacion: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { movements, creditCards };
}

// ─── Main scraper ────────────────────────────────────────────────

async function scrape(options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, chromePath, saveScreenshots: doScreenshots, headful } = options;
  const bank = "bchile";

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

    // Login (DOM-based — required for auth + 2FA)
    const loginResult = await login(page, rut, password, debugLog, doSave);
    if (!loginResult.success) {
      return { success: false, bank, movements: [], error: loginResult.error, screenshot: loginResult.screenshot, debug: debugLog.join("\n") };
    }

    // Close modal overlay (Banco de Chile shows a promotional modal after login)
    try {
      await page.waitForSelector("#modal_emergente_close, .cdk-overlay-container .btn-no-mas", { timeout: 8000 });
      const modalClosed = await page.evaluate(() => {
        const closeBtn = document.querySelector("#modal_emergente_close") as HTMLElement | null;
        if (closeBtn) { closeBtn.click(); return true; }
        const noMasBtn = document.querySelector(".btn-no-mas") as HTMLElement | null;
        if (noMasBtn) { noMasBtn.click(); return true; }
        return false;
      });
      if (modalClosed) {
        debugLog.push("  Modal overlay closed");
        await delay(1500);
      }
    } catch {
      debugLog.push("  No modal overlay detected (or already closed)");
    }

    await closePopups(page);

    // ── All data extraction via REST API calls ──

    // 1. Get product list and client data (needed by multiple endpoints)
    debugLog.push("5. Fetching products and client data via API...");
    let products: ApiProductsResponse;
    let clientData: ApiClientData;
    try {
      [products, clientData] = await Promise.all([
        apiGet<ApiProductsResponse>(page, "selectorproductos/selectorProductos/obtenerProductos?incluirTarjetas=true"),
        apiGet<ApiClientData>(page, "bff-ppersonas-clientes/clientes/"),
      ]);
      debugLog.push(`  Found ${products.productos.length} products`);
    } catch (err) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        success: false, bank, movements: [],
        error: `No se pudo obtener datos iniciales: ${err instanceof Error ? err.message : String(err)}`,
        screenshot: screenshot as string, debug: debugLog.join("\n"),
      };
    }

    // 2. Get account balance from saldos endpoint
    let balance: number | undefined;
    try {
      const saldos = await apiGet<ApiAccountBalance[]>(
        page, "bff-pp-prod-ctas-saldos/productos/cuentas/saldos"
      );
      const clpAccount = saldos.find(s => s.moneda === "CLP" && s.tipo === "CUENTA_CORRIENTE");
      if (clpAccount) {
        balance = clpAccount.disponible;
        debugLog.push(`  Balance CLP: $${balance}`);
      }
    } catch (err) {
      debugLog.push(`  Could not fetch balances: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Fetch account movements (requires navigation to movements page)
    const fullName = products.nombre
      || `${clientData.datosCliente.nombres} ${clientData.datosCliente.apellidoPaterno}`.trim();

    debugLog.push("6. Fetching account movements via API...");
    const acctResult = await fetchAccountMovements(page, products.productos, fullName, products.rut, debugLog);
    const accountMovements = acctResult.movements;
    if (balance === undefined && acctResult.balance !== undefined) balance = acctResult.balance;
    debugLog.push(`  Total account movements: ${accountMovements.length}`);

    // 4. Fetch credit card data via API
    debugLog.push("7. Fetching credit card data via API...");
    const tcResult = await fetchCreditCardData(page, fullName, debugLog);
    debugLog.push(`  Total TC movements: ${tcResult.movements.length}, cards: ${tcResult.creditCards.length}`);

    // Combine and deduplicate
    const allMovements = [...accountMovements, ...tcResult.movements];
    const deduplicated = deduplicateMovements(allMovements);

    debugLog.push(`8. Total: ${deduplicated.length} unique movements`);

    await doSave(page, "06-final");
    const screenshot = doScreenshots ? await page.screenshot({ encoding: "base64" }) as string : undefined;

    return {
      success: true, bank, movements: deduplicated,
      balance,
      creditCards: tcResult.creditCards.length > 0 ? tcResult.creditCards : undefined,
      screenshot, debug: debugLog.join("\n"),
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

// ─── Export ───────────────────────────────────────────────────────

const bchile: BankScraper = {
  id: "bchile",
  name: "Banco de Chile",
  url: "https://portalpersonas.bancochile.cl",
  scrape,
};

export default bchile;
