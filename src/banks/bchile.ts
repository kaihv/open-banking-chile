import type { Page } from "puppeteer-core";
import type { BankMovement, BankScraper, CreditCardBalance, MovementSource, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, formatRut, monthYearLabel, normalizeDate, deduplicateMovements, deduplicateAcrossSources, normalizeInstallments } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { detect2FA, waitFor2FA } from "../actions/two-factor.js";

// ─── Banco de Chile constants ────────────────────────────────────

const BANK_URL = "https://portalpersonas.bancochile.cl/persona/";
const API_BASE = "https://portalpersonas.bancochile.cl/mibancochile/rest/persona";


const TWO_FACTOR_CONFIG = {
  timeoutEnvVar: "BCHILE_2FA_TIMEOUT_SEC",
};

// ─── API types ───────────────────────────────────────────────────

interface ApiProduct { id: string; numero: string; mascara: string; codigo: string; codigoMoneda: string; label: string; tipo: string; claseCuenta: string; tarjetaHabiente: string | null; descripcionLogo: string; tipoCliente: string; }
interface ApiCardInfo { titular: boolean; marca: string; tipo: string; idProducto: string; numero: string; }
interface ApiCardSaldo { cupoTotalNacional: number; cupoUtilizadoNacional: number; cupoDisponibleNacional: number; cupoTotalInternacional: number; cupoUtilizadoInternacional: number; cupoDisponibleInternacional: number; }
interface ApiMovNoFactur { origenTransaccion: string; fechaTransaccionString: string; montoCompra: number; glosaTransaccion: string; despliegueCuotas: string; }
interface ApiNoFacturResponse { fechaProximaFacturacionCalendario: string; fechaProximoVencimiento?: string; fechaVencimiento?: string; gastosPeriodo?: number; montoGastosPeriodo?: number; listaMovNoFactur: ApiMovNoFactur[]; }
interface ApiFechaFacturacion { fechaFacturacion: string; existeEstadoCuentaNacional: string; existeEstadoCuentaInternacional: string; }
interface ApiTransaccionFacturada { fechaTransaccionString: string; montoTransaccion: number; descripcion: string; cuotas: string; grupo: string; }
interface ApiResumenNested { montoFacturado?: number; pagoMinimo?: number; fechaFacturacionActual?: string; fechaVencimientoFacturacion?: string; fechaProximaFacturacion?: string; }
interface ApiResumenFacturado { existeEstadoCuenta: boolean; seccionOperaciones?: { transaccionesTarjetas: ApiTransaccionFacturada[] }; seccionCargosImpuestosAbonos?: { transaccionesTarjetas: ApiTransaccionFacturada[] | null }; resumen?: ApiResumenNested; totalFacturado?: number; montoTotalFacturado?: number; montoTotal?: number; fechaVencimiento?: string; fechaPago?: string; pagoMinimo?: number; montoMinimoPago?: number; montoMinimoAPagar?: number; }
interface ApiCartolaMov { descripcion: string; monto: number; saldo: number; tipo: string; fechaContable: string; }
type ApiCartolaResponse = { movimientos: ApiCartolaMov[]; pagina: Array<{ totalRegistros: number; masPaginas: boolean }> };

// ─── API helpers ─────────────────────────────────────────────────

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
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (xsrf) headers["X-XSRF-TOKEN"] = xsrf;
    const r = await fetch(url, { method: "POST", credentials: "include", headers, body: bodyStr });
    if (!r.ok) throw new Error(`API POST ${url} → ${r.status}`);
    return r.json();
  }, `${API_BASE}/${path}`, JSON.stringify(body));
}

// ─── Login ───────────────────────────────────────────────────────

async function bchileLogin(
  page: Page, rut: string, password: string, debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>,
): Promise<{ success: boolean; error?: string; screenshot?: string }> {
  debugLog.push("1. Navigating to bank homepage...");
  await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 45000 });
  await delay(3000);
  await doSave(page, "01-homepage");

  try { await page.waitForSelector('input[name="userRut"], input[name="rut"], #rut, input[placeholder*="RUT"]', { timeout: 15000 }); } catch { /* continue */ }
  await delay(1000);

  // Fill RUT
  debugLog.push("2. Filling RUT...");
  const formattedRut = formatRut(rut);
  const cleanRut = rut.replace(/[.\-]/g, "");
  const selectors = ["#ppriv_per-login-click-input-rut", 'input[name="userRut"]', "#rut", 'input[name="rut"]', 'input[placeholder*="RUT"]'];
  let rutFilled = false;
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const maxLen = await page.evaluate((s: string) => (document.querySelector(s) as HTMLInputElement | null)?.maxLength ?? -1, sel);
        await el.click({ clickCount: 3 });
        await el.type((maxLen > 0 && maxLen <= 10) ? cleanRut : formattedRut, { delay: 45 });
        rutFilled = true;
        break;
      }
    } catch { /* next */ }
  }
  if (!rutFilled) {
    // Fallback
    rutFilled = await page.evaluate((rf: string, rc: string) => {
      for (const input of Array.from(document.querySelectorAll("input"))) {
        const el = input as HTMLInputElement;
        if (el.offsetParent === null || el.disabled || el.type === "password") continue;
        el.focus();
        el.value = el.maxLength > 0 && el.maxLength <= 10 ? rc : rf;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    }, formattedRut, cleanRut);
  }
  if (!rutFilled) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró el campo de RUT", screenshot: ss as string };
  }
  await delay(500);

  // Fill password
  debugLog.push("3. Filling password...");
  const passSelectors = ["#ppriv_per-login-click-input-password", 'input[name="userPassword"]', "#pass", "#password", 'input[type="password"]'];
  let passFilled = false;
  for (const sel of passSelectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const isReadonly = await page.evaluate((s: string) => { const i = document.querySelector(s) as HTMLInputElement | null; return i?.readOnly || i?.disabled || false; }, sel);
      if (!isReadonly) { await el.click(); await el.type(password, { delay: 45 }); passFilled = true; break; }
      // Virtual keyboard fallback
      for (const kbSel of ['[class*="keyboard"]', '[class*="teclado"]', '[class*="virtual"]']) {
        const kb = await page.$(kbSel);
        if (!kb) continue;
        let allClicked = true;
        for (const char of password) {
          const clicked = await page.evaluate((ch: string, s: string) => {
            const kb = document.querySelector(s);
            if (!kb) return false;
            for (const btn of Array.from(kb.querySelectorAll("button, span, div, a"))) { if ((btn as HTMLElement).innerText?.trim() === ch) { (btn as HTMLElement).click(); return true; } }
            return false;
          }, char, kbSel);
          if (!clicked) { allClicked = false; break; }
        }
        if (allClicked) { passFilled = true; break; }
      }
      if (passFilled) break;
    } catch { /* next */ }
  }
  if (!passFilled) {
    // Two-step: submit RUT first
    const submitSelectors = ["#ppriv_per-login-click-ingresar-login", 'button[type="submit"]', "#btn-login"];
    for (const sel of submitSelectors) { const el = await page.$(sel); if (el) { await el.click(); break; } }
    await delay(3000);
    for (const sel of passSelectors) {
      try { const el = await page.$(sel); if (el) { await el.click(); await el.type(password, { delay: 45 }); passFilled = true; break; } } catch { /* next */ }
    }
  }
  if (!passFilled) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró el campo de clave", screenshot: ss as string };
  }

  // Submit
  debugLog.push("4. Submitting login...");
  const submitSelectors = ["#ppriv_per-login-click-ingresar-login", 'button[type="submit"]', "#btn-login", "#btn_login"];
  let submitted = false;
  for (const sel of submitSelectors) { const el = await page.$(sel); if (el) { await el.click(); submitted = true; break; } }
  if (!submitted) {
    await page.evaluate(() => {
      for (const btn of Array.from(document.querySelectorAll("button, a, input[type='submit']"))) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || "";
        if (text.includes("ingresar") || text.includes("continuar")) { (btn as HTMLElement).click(); return; }
      }
    });
  }
  try { await page.waitForNavigation({ timeout: 25000 }); } catch { /* SPA */ }
  await delay(5000);
  await doSave(page, "03-after-login");

  // Login error
  const loginError = await page.evaluate(() => {
    const keywords = ["clave incorrecta", "rut inválido", "bloqueada", "bloqueado", "suspendida", "sesión activa"];
    for (const sel of ['[class*="error"]', '[class*="alert"]', '[role="alert"]']) {
      for (const el of document.querySelectorAll(sel)) {
        const text = (el as HTMLElement).innerText?.trim();
        if (text && keywords.some(kw => text.toLowerCase().includes(kw))) return text;
      }
    }
    return null;
  });
  if (loginError) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: `Error de login: ${loginError}`, screenshot: ss as string };
  }

  // 2FA
  if (await detect2FA(page, TWO_FACTOR_CONFIG)) {
    const approved = await waitFor2FA(page, debugLog, TWO_FACTOR_CONFIG);
    if (!approved) {
      const ss = await page.screenshot({ encoding: "base64" });
      return { success: false, error: "Timeout esperando aprobación de 2FA", screenshot: ss as string };
    }
  }

  if (page.url().includes("/login")) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "Login failed — aún en página de login", screenshot: ss as string };
  }

  debugLog.push("4. Login OK!");
  return { success: true };
}

// ─── Data extraction ─────────────────────────────────────────────

function cartolaMovToMovement(mov: ApiCartolaMov): BankMovement {
  return { date: normalizeDate(mov.fechaContable), description: mov.descripcion.trim(), amount: mov.tipo === "cargo" ? -Math.abs(mov.monto) : Math.abs(mov.monto), balance: mov.saldo, source: MOVEMENT_SOURCE.account };
}

function facturadoToMovement(tx: ApiTransaccionFacturada, source: MovementSource, cardMask?: string): BankMovement {
  return { date: normalizeDate(tx.fechaTransaccionString), description: tx.descripcion.trim(), amount: tx.grupo === "pagos" ? Math.abs(tx.montoTransaccion) : -Math.abs(tx.montoTransaccion), balance: 0, source, card: cardMask, installments: normalizeInstallments(tx.cuotas) };
}

async function fetchAccountMovements(page: Page, products: ApiProduct[], fullName: string, rut: string, debugLog: string[]): Promise<{ movements: BankMovement[]; balance?: number }> {
  const accounts = products.filter(p => p.tipo === "cuenta" || p.tipo === "cuentaCorrienteMonedaLocal");
  const seenNums = new Set<string>();
  const unique = accounts.filter(a => { if (seenNums.has(a.numero)) return false; seenNums.add(a.numero); return true; });
  if (unique.length === 0) return { movements: [] };

  const baseUrl = page.url().split("#")[0];
  await page.goto(`${baseUrl}#/movimientos/cuenta/saldos-movimientos`, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(5000);

  const movements: BankMovement[] = [];
  let balance: number | undefined;

  for (const acct of unique) {
    debugLog.push(`  Fetching ${acct.descripcionLogo} ${acct.mascara}`);
    const cuentaSeleccionada = { nombreCliente: fullName, rutCliente: rut, numero: acct.numero, mascara: acct.mascara, selected: true, codigoProducto: acct.codigo, claseCuenta: acct.claseCuenta, moneda: acct.codigoMoneda };

    try {
      await apiPost(page, "movimientos/getConfigConsultaMovimientos", { cuentasSeleccionadas: [cuentaSeleccionada] });
      const cartola = await apiPost<ApiCartolaResponse>(page, "bff-pper-prd-cta-movimientos/movimientos/getCartola", { cuentaSeleccionada, cabecera: { statusGenerico: true, paginacionDesde: 1 } });

      if (cartola.movimientos) {
        for (const mov of cartola.movimientos) movements.push(cartolaMovToMovement(mov));
        if (balance === undefined && acct.codigoMoneda === "CLP" && cartola.movimientos.length > 0) balance = cartola.movimientos[0].saldo;

        let hasMore = cartola.movimientos.length > 0 && (cartola.pagina?.[0]?.masPaginas ?? false);
        let offset = 1 + cartola.movimientos.length;
        for (let p = 2; hasMore && p <= 25; p++) {
          try {
            const next = await apiPost<ApiCartolaResponse>(page, "bff-pper-prd-cta-movimientos/movimientos/getCartola", { cuentaSeleccionada, cabecera: { statusGenerico: true, paginacionDesde: offset } });
            if (!next.movimientos?.length) break;
            for (const mov of next.movimientos) movements.push(cartolaMovToMovement(mov));
            offset += next.movimientos.length;
            hasMore = next.pagina?.[0]?.masPaginas ?? false;
          } catch { hasMore = false; }
        }
      }
    } catch (err) { debugLog.push(`    → Error: ${err instanceof Error ? err.message : String(err)}`); }
  }

  return { movements, balance };
}

async function fetchCreditCardData(page: Page, fullName: string, debugLog: string[]): Promise<{ movements: BankMovement[]; creditCards: CreditCardBalance[] }> {
  const movements: BankMovement[] = [];
  const creditCards: CreditCardBalance[] = [];

  let cards: ApiCardInfo[];
  try { cards = await apiPost<ApiCardInfo[]>(page, "tarjetas/widget/informacion-tarjetas", {}); } catch { return { movements, creditCards }; }
  if (cards.length === 0) return { movements, creditCards };

  debugLog.push(`  Found ${cards.length} credit card(s)`);

  for (const card of cards) {
    const cardLabel = `${card.marca} ${card.tipo} ${card.numero.slice(-8)}`.trim();
    const mascara = card.numero.replace(/\*/g, "").length <= 4 ? `****${card.numero.slice(-4)}` : card.numero;
    const baseBody = { idTarjeta: card.idProducto, codigoProducto: "TNM", tipoTarjeta: `${card.marca} ${card.tipo}`.trim(), mascara, nombreTitular: fullName };
    const body = { ...baseBody, tipoCliente: "T" as const };

    const [saldoResult, noFactResult] = await Promise.allSettled([
      apiPost<ApiCardSaldo>(page, "tarjeta-credito-digital/saldo/obtener-saldo", body),
      apiPost<ApiNoFacturResponse>(page, "tarjeta-credito-digital/movimientos-no-facturados", body),
    ]);

    if (saldoResult.status === "fulfilled") {
      const s = saldoResult.value;
      creditCards.push({ label: cardLabel, national: { used: s.cupoUtilizadoNacional, available: s.cupoDisponibleNacional, total: s.cupoTotalNacional }, international: { used: s.cupoUtilizadoInternacional, available: s.cupoDisponibleInternacional, total: s.cupoTotalInternacional, currency: "USD" } });
    } else { creditCards.push({ label: cardLabel }); }

    if (noFactResult.status === "fulfilled") {
      const nf = noFactResult.value;
      const ccEntry = creditCards[creditCards.length - 1];
      if (nf.fechaProximaFacturacionCalendario) ccEntry.nextBillingDate = normalizeDate(nf.fechaProximaFacturacionCalendario);
      const nextDue = nf.fechaProximoVencimiento ?? nf.fechaVencimiento;
      if (nextDue) ccEntry.nextDueDate = normalizeDate(nextDue);
      const unbilledMovs: BankMovement[] = [];
      for (const mov of nf.listaMovNoFactur) {
        const amount = mov.montoCompra < 0 ? Math.abs(mov.montoCompra) : -Math.abs(mov.montoCompra);
        unbilledMovs.push({ date: normalizeDate(mov.fechaTransaccionString), description: mov.glosaTransaccion.trim(), amount, balance: 0, source: MOVEMENT_SOURCE.credit_card_unbilled, card: mascara, installments: normalizeInstallments(mov.despliegueCuotas) });
      }
      // periodExpenses: suma de cargos no facturados (montos negativos → gastos)
      const periodExpensesRaw = nf.gastosPeriodo ?? nf.montoGastosPeriodo;
      ccEntry.periodExpenses = periodExpensesRaw !== undefined
        ? periodExpensesRaw
        : unbilledMovs.filter(m => m.amount < 0).reduce((s, m) => s + Math.abs(m.amount), 0);
      movements.push(...unbilledMovs);
    }

    // Facturados
    try {
      const fechas = await apiPost<{ existenEstadosDeCuenta: boolean; numeroCuenta: string | null; listaNacional: ApiFechaFacturacion[]; listaInternacional: ApiFechaFacturacion[] }>(page, "tarjetas/estadocuenta/fechas-facturacion", baseBody);
      if (fechas.existenEstadosDeCuenta) {
        const ccEntry = creditCards[creditCards.length - 1];
        const latestFecha = fechas.listaNacional?.[0]?.fechaFacturacion;
        const numeroCuenta = fechas.numeroCuenta;
        if (latestFecha && numeroCuenta) {
          const resumenBody = { ...baseBody, fechaFacturacion: latestFecha, numeroCuenta };
          const [nacR, intR] = await Promise.allSettled([
            apiPost<ApiResumenFacturado>(page, "tarjetas/estadocuenta/nacional/resumen-por-fecha", resumenBody),
            apiPost<ApiResumenFacturado>(page, "tarjetas/estadocuenta/internacional/resumen-por-fecha", resumenBody),
          ]);
          for (const r of [nacR, intR]) {
            if (r.status !== "fulfilled" || !r.value.existeEstadoCuenta) continue;
            const res = r.value;

            const allTx = [
              ...(res.seccionOperaciones?.transaccionesTarjetas ?? []),
              ...(res.seccionCargosImpuestosAbonos?.transaccionesTarjetas ?? []),
            ];
            for (const tx of allTx) {
              // Skip section-subtotal rows (e.g. "TOTAL PAGOS A LA CUENTA").
              const desc = tx.descripcion.trim().toUpperCase();
              if (desc.startsWith("TOTAL ") && desc.endsWith("A LA CUENTA")) continue;
              movements.push(facturadoToMovement(tx, MOVEMENT_SOURCE.credit_card_billed, mascara));
            }

            // Override nextBillingDate/nextDueDate with accurate date-format values from resumen
            if (res.resumen?.fechaProximaFacturacion) ccEntry.nextBillingDate = normalizeDate(res.resumen.fechaProximaFacturacion);
            if (!ccEntry.nextDueDate && res.resumen?.fechaVencimientoFacturacion) ccEntry.nextDueDate = normalizeDate(res.resumen.fechaVencimientoFacturacion);

            if (!ccEntry.lastStatement) {
              const billedAmount = res.resumen?.montoFacturado ?? res.totalFacturado ?? res.montoTotalFacturado ?? res.montoTotal;
              const dueDateRaw = res.resumen?.fechaVencimientoFacturacion ?? res.fechaVencimiento ?? res.fechaPago;
              const minimumPayment = res.resumen?.pagoMinimo ?? res.pagoMinimo ?? res.montoMinimoPago ?? res.montoMinimoAPagar;
              const billingDateRaw = res.resumen?.fechaFacturacionActual ?? latestFecha;
              if (billedAmount && dueDateRaw) {
                const billingDate = normalizeDate(billingDateRaw);
                ccEntry.lastStatement = {
                  billingDate,
                  billedAmount,
                  dueDate: normalizeDate(dueDateRaw),
                  minimumPayment,
                };
                ccEntry.billingPeriod = monthYearLabel(billingDate);
              }
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  return { movements, creditCards };
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeBchile(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const { onProgress } = options;
  const bank = "bchile";
  const progress = onProgress || (() => {});

  progress("Abriendo sitio del banco...");
  const loginResult = await bchileLogin(page, rut, password, debugLog, doSave);
  if (!loginResult.success) {
    return { success: false, bank, accounts: [], error: loginResult.error, screenshot: loginResult.screenshot, debug: debugLog.join("\n") };
  }

  progress("Sesión iniciada correctamente");

  // Close modal overlay
  try {
    await page.waitForSelector("#modal_emergente_close, .cdk-overlay-container .btn-no-mas", { timeout: 8000 });
    await page.evaluate(() => {
      const closeBtn = document.querySelector("#modal_emergente_close") as HTMLElement | null;
      if (closeBtn) { closeBtn.click(); return; }
      const noMasBtn = document.querySelector(".btn-no-mas") as HTMLElement | null;
      if (noMasBtn) noMasBtn.click();
    });
    await delay(1500);
  } catch { /* no modal */ }
  await closePopups(page);

  // Fetch products & client data
  debugLog.push("5. Fetching products and client data via API...");
  progress("Obteniendo productos y datos del cliente...");
  let products: { rut: string; nombre: string; productos: ApiProduct[] };
  let clientData: { datosCliente: { rut: string; nombres: string; apellidoPaterno: string; apellidoMaterno: string } };
  try {
    [products, clientData] = await Promise.all([
      apiGet<typeof products>(page, "selectorproductos/selectorProductos/obtenerProductos?incluirTarjetas=true"),
      apiGet<typeof clientData>(page, "bff-ppersonas-clientes/clientes/"),
    ]);
    debugLog.push(`  Found ${products.productos.length} products`);
  } catch (err) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: `No se pudo obtener datos: ${err instanceof Error ? err.message : String(err)}`, screenshot: ss as string, debug: debugLog.join("\n") };
  }

  // Balance
  let balance: number | undefined;
  try {
    const saldos = await apiGet<Array<{ moneda: string; tipo: string; disponible: number }>>(page, "bff-pp-prod-ctas-saldos/productos/cuentas/saldos");
    const clp = saldos.find(s => s.moneda === "CLP" && s.tipo === "CUENTA_CORRIENTE");
    if (clp) { balance = clp.disponible; debugLog.push(`  Balance CLP: $${balance}`); }
  } catch { /* ignore */ }

  const fullName = products.nombre || `${clientData.datosCliente.nombres} ${clientData.datosCliente.apellidoPaterno}`.trim();

  // Account movements
  debugLog.push("6. Fetching account movements via API...");
  progress("Extrayendo movimientos de cuenta...");
  const acctResult = await fetchAccountMovements(page, products.productos, fullName, products.rut, debugLog);
  if (balance === undefined && acctResult.balance !== undefined) balance = acctResult.balance;
  debugLog.push(`  Account movements: ${acctResult.movements.length}`);

  // Credit card data
  debugLog.push("7. Fetching credit card data via API...");
  progress("Extrayendo datos de tarjeta de crédito...");
  const tcResult = await fetchCreditCardData(page, fullName, debugLog);
  debugLog.push(`  TC movements: ${tcResult.movements.length}`);

  // Distribute TC movements into each card's movements array
  for (const cc of tcResult.creditCards) {
    const mask = cc.label.match(/\*{4}\d{4}/)?.[0];
    const cardMovs = mask
      ? tcResult.movements.filter(m => m.card === mask)
      : tcResult.movements;
    cc.movements = deduplicateMovements(deduplicateAcrossSources(cardMovs));
  }

  const totalTc = tcResult.creditCards.reduce((s, cc) => s + (cc.movements?.length ?? 0), 0);
  debugLog.push(`8. Total: ${acctResult.movements.length} account + ${totalTc} TC movements`);
  progress(`Listo — ${acctResult.movements.length + totalTc} movimientos totales`);

  await doSave(page, "06-final");
  const ss = doScreenshots ? await page.screenshot({ encoding: "base64" }) as string : undefined;

  return {
    success: true,
    bank,
    accounts: [{ balance, movements: deduplicateMovements(acctResult.movements) }],
    creditCards: tcResult.creditCards.length > 0 ? tcResult.creditCards : undefined,
    screenshot: ss,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────────

const bchile: BankScraper = {
  id: "bchile",
  name: "Banco de Chile",
  url: "https://portalpersonas.bancochile.cl",
  scrape: (options) => runScraper("bchile", options, {}, scrapeBchile),
};

export default bchile;
