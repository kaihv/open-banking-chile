import type { Page, HTTPResponse } from "puppeteer-core";
import type { AccountBalance, BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, formatRut, deduplicateMovements } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { detect2FA, waitFor2FA } from "../actions/two-factor.js";
import { detectLoginError } from "../actions/login.js";

// ─── BCI Pyme constants ──────────────────────────────────────────
//
// El portal Pyme NO usa el sitio de "personas". Tras el login redirige al
// nuevo portal OSS (oss.bci.cl), una SPA embebida en un iframe de
// bel.bci.cl que se alimenta de una API REST JSON. En vez de raspar tablas
// HTML, interceptamos la API:
//   - POST ms-oss-cuentas/v2/cuentas              → cuentas + saldos
//   - POST bff-oss-resumen-cta/vX/cuentas/movimientos → movimientos
// La UI pide solo 100 movimientos; nosotros capturamos la request (headers
// de auth + body) y la re-ejecutamos con un rango amplio para traer todo el
// historial disponible.

const LOGIN_URL = "https://www.bci.cl/corporativo/banco-en-linea/pyme";
const CUENTAS_PREFIX = "https://oss.bci.cl/ms-oss-cuentas/v2/cuentas";
const MOVIMIENTOS_RE = /oss\.bci\.cl\/bff-oss-resumen-cta\/v[\d.]+\/cuentas\/movimientos/;

// Cuántos años de historial pedir y tope de registros por cuenta.
const HISTORY_YEARS = 6;
const MAX_RECORDS = 5000;

const TWO_FACTOR_CONFIG = {
  keywords: ["bci pass", "segundo factor", "aprobación en tu app", "autorizar en tu app", "confirmar en tu app"],
  timeoutEnvVar: "BCIPYME_2FA_TIMEOUT_SEC",
};

// ─── Tipos de la API OSS ─────────────────────────────────────────

interface OssCuenta {
  tipoCuenta: string;
  numeroCuenta: string;
  moneda: string;
  saldoContable?: number;
  saldoDisponible?: number;
  saldoDisponibleTotal?: number;
  rutEmpresa?: string;
}

interface OssCuentasResponse {
  numeroCuentas?: number;
  detalleCuentas?: OssCuenta[];
}

interface OssMovimiento {
  fechaMovimiento?: string; // MM/DD/YYYY
  fechaContable?: string;   // YYYY-MM-DD
  descripcion?: string;
  monto?: string;           // "36850.0000"
  saldoContable?: number;
  tipo?: string;            // 'C' = cargo, 'A' = abono
}

interface OssMovimientosResponse {
  movimientos?: OssMovimiento[];
}

interface MovRequestTemplate {
  url: string;
  headers: Record<string, string>;
  body: string;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** "2026-06-19" → "19-06-2026" */
export function isoToDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}

function isoNYearsAgo(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function normalizeMovements(resp: OssMovimientosResponse): BankMovement[] {
  const out: BankMovement[] = [];
  for (const m of resp.movimientos ?? []) {
    const raw = Math.round(parseFloat(m.monto ?? "0"));
    if (!raw || isNaN(raw)) continue;
    const amount = m.tipo === "C" ? -raw : raw;
    const dateSrc = m.fechaContable ?? "";
    out.push({
      date: isoToDate(dateSrc),
      description: (m.descripcion ?? "").trim(),
      amount,
      balance: typeof m.saldoContable === "number" ? m.saldoContable : 0,
      source: MOVEMENT_SOURCE.account,
    });
  }
  return out;
}

async function bciPymeLogin(
  page: Page, rut: string, password: string, debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>,
): Promise<{ success: boolean; error?: string; screenshot?: string }> {
  debugLog.push("1. Navigating to BCI Pyme login...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await delay(3000);
  await doSave(page, "01-login-form");

  debugLog.push("2. Filling RUT...");
  const cleanRut = rut.replace(/[.\-\s]/g, "");
  const rutBody = cleanRut.slice(0, -1);
  const rutDv = cleanRut.slice(-1);
  const filled = await page.evaluate((formatted: string, body: string, dv: string) => {
    const rutAux = document.getElementById("rut_aux") as HTMLInputElement | null;
    const rutHidden = document.getElementById("rut") as HTMLInputElement | null;
    const digHidden = document.getElementById("dig") as HTMLInputElement | null;
    if (!rutAux) return false;
    rutAux.value = formatted;
    rutAux.dispatchEvent(new Event("input", { bubbles: true }));
    rutAux.dispatchEvent(new Event("change", { bubbles: true }));
    rutAux.dispatchEvent(new Event("blur", { bubbles: true }));
    if (rutHidden) rutHidden.value = body;
    if (digHidden) digHidden.value = dv;
    return true;
  }, formatRut(rut), rutBody, rutDv);
  if (!filled) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "Campo de RUT no encontrado.", screenshot: ss as string };
  }

  debugLog.push("  Filling password...");
  const passFilled = await page.evaluate((pass: string) => {
    const clave = document.getElementById("clave") as HTMLInputElement | null;
    if (!clave) return false;
    clave.value = pass;
    clave.dispatchEvent(new Event("input", { bubbles: true }));
    clave.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, password);
  if (!passFilled) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "Campo de clave no encontrado.", screenshot: ss as string };
  }

  await delay(500);
  debugLog.push("3. Submitting login...");
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    if (btn) btn.disabled = false;
    const form = document.getElementById("frm") as HTMLFormElement | null;
    if (form) form.submit();
    else if (btn) btn.click();
  });
  try { await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }); } catch { /* SPA */ }
  await delay(3000);
  await doSave(page, "03-post-login");

  if (await detect2FA(page, TWO_FACTOR_CONFIG)) {
    await doSave(page, "03b-2fa-challenge");
    const approved = await waitFor2FA(page, debugLog, TWO_FACTOR_CONFIG);
    if (!approved) {
      const ss = await page.screenshot({ encoding: "base64" });
      return { success: false, error: "Timeout esperando segundo factor.", screenshot: ss as string };
    }
    await delay(3000);
  }

  const loginError = await detectLoginError(page);
  if (loginError) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: `Error del banco: ${loginError}`, screenshot: ss as string };
  }

  // El login exitoso redirige al layout OSS en bel.bci.cl. Si seguimos en la
  // página de login (banco-en-linea/pyme), las credenciales fueron rechazadas.
  if (page.url().includes("banco-en-linea/pyme")) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "Login no navegó fuera de la página (RUT/clave incorrectos?).", screenshot: ss as string };
  }

  debugLog.push("4. Login OK!");
  return { success: true };
}

/**
 * Navega la SPA para gatillar una llamada a la API de movimientos. Solo nos
 * interesa capturar la request (headers de auth + body con idGrupoEmpresa);
 * luego la re-ejecutamos con un rango más amplio.
 */
async function triggerMovimientos(page: Page, debugLog: string[]): Promise<void> {
  for (const f of page.frames()) {
    if (!/oss\.bci\.cl/.test(f.url())) continue;
    try {
      const clicked = await f.evaluate(() => {
        for (const el of document.querySelectorAll("a,button,[role=button],div,span,li,tr")) {
          const t = (el as HTMLElement).innerText?.trim() ?? "";
          if (/ver movimientos|mis movimientos|movimientos|cartola/i.test(t) && t.length < 60) {
            (el as HTMLElement).click();
            return t.slice(0, 50);
          }
        }
        return null;
      });
      if (clicked) {
        debugLog.push(`  Triggered movimientos via: "${clicked}"`);
        return;
      }
    } catch { /* cross-origin frame not ready */ }
  }
  debugLog.push("  WARN: no movimientos menu entry found to click");
}

/** Re-ejecuta la API de movimientos para una cuenta con rango amplio. */
async function fetchAccountMovements(
  page: Page, template: MovRequestTemplate, account: OssCuenta, debugLog: string[],
): Promise<BankMovement[]> {
  const ossFrame = page.frames().find((f) => /oss\.bci\.cl/.test(f.url()));
  if (!ossFrame) {
    debugLog.push("  WARN: no oss.bci.cl frame for replay");
    return [];
  }

  let baseBody: Record<string, unknown>;
  try { baseBody = JSON.parse(template.body) as Record<string, unknown>; }
  catch { baseBody = {}; }

  const body = {
    ...baseBody,
    numeroDeCuenta: account.numeroCuenta,
    ...(account.rutEmpresa ? { rutEmpresa: account.rutEmpresa.replace(/\./g, "") } : {}),
    fechaTransaccionDesde: isoNYearsAgo(HISTORY_YEARS),
    fechaTransaccionHasta: isoToday(),
    cantidadDeRegistros: MAX_RECORDS,
    numeroDeRegistros: MAX_RECORDS,
  };

  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const k of ["authorization", "ocp-apim-subscription-key"]) {
    if (template.headers[k]) headers[k] = template.headers[k];
  }

  const result = await ossFrame.evaluate(
    async (url: string, hdrs: Record<string, string>, payload: unknown) => {
      try {
        const res = await fetch(url, {
          method: "POST", headers: hdrs, body: JSON.stringify(payload), credentials: "include",
        });
        if (!res.ok) return { error: `HTTP ${res.status}` };
        return { data: await res.json() };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
    template.url, headers, body,
  ) as { data?: OssMovimientosResponse; error?: string };

  if (result.error || !result.data) {
    debugLog.push(`  Movimientos replay failed for ${account.numeroCuenta}: ${result.error ?? "no data"}`);
    return [];
  }

  const movements = normalizeMovements(result.data);
  if ((result.data.movimientos?.length ?? 0) >= MAX_RECORDS) {
    debugLog.push(`  WARN: cuenta ${account.numeroCuenta} alcanzó el tope de ${MAX_RECORDS} registros; podría haber más historial.`);
  }
  debugLog.push(`  Cuenta ${account.numeroCuenta}: ${movements.length} movimientos`);
  return movements;
}

// ─── Main scrape ─────────────────────────────────────────────────

async function scrapeBciPyme(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const progress = options.onProgress || (() => {});
  const bank = "bcipyme";

  // Capturamos la respuesta de cuentas y la request de movimientos vía CDP.
  let cuentas: OssCuentasResponse | undefined;
  let movTemplate: MovRequestTemplate | undefined;
  const onResponse = async (resp: HTTPResponse) => {
    const url = resp.url();
    try {
      if (url.startsWith(CUENTAS_PREFIX) && resp.request().method() === "POST") {
        cuentas = (await resp.json()) as OssCuentasResponse;
      } else if (MOVIMIENTOS_RE.test(url) && !movTemplate) {
        const req = resp.request();
        const body = req.postData();
        if (body) movTemplate = { url, headers: req.headers(), body };
      }
    } catch { /* body not JSON / already consumed */ }
  };
  page.on("response", onResponse);

  try {
    progress("Abriendo sitio del banco...");
    const loginResult = await bciPymeLogin(page, rut, password, debugLog, doSave);
    if (!loginResult.success) {
      return { success: false, bank, accounts: [], error: loginResult.error, screenshot: loginResult.screenshot, debug: debugLog.join("\n") };
    }

    progress("Sesión iniciada correctamente");
    await closePopups(page);
    await delay(3000); // deja cargar el dashboard (gatilla ms-oss-cuentas)

    // Espera a que el dashboard cargue las cuentas.
    for (let i = 0; i < 20 && !cuentas; i++) await delay(500);
    const accountList = cuentas?.detalleCuentas ?? [];
    debugLog.push(`5. Cuentas detectadas: ${accountList.length}`);

    // Gatilla la API de movimientos para capturar la plantilla de request.
    progress("Extrayendo movimientos...");
    await triggerMovimientos(page, debugLog);
    for (let i = 0; i < 30 && !movTemplate; i++) await delay(500);

    const accounts: AccountBalance[] = [];
    if (movTemplate && accountList.length > 0) {
      const multi = accountList.length > 1;
      for (const acc of accountList) {
        const movements = await fetchAccountMovements(page, movTemplate, acc, debugLog);
        const label = `Cuenta ${acc.tipoCuenta} ${acc.numeroCuenta}`;
        const prefixed = multi
          ? movements.map((m) => ({ ...m, description: `[${label}] ${m.description}`.trim() }))
          : movements;
        accounts.push({
          label,
          balance: acc.saldoDisponible ?? acc.saldoDisponibleTotal ?? acc.saldoContable,
          movements: deduplicateMovements(prefixed),
        });
      }
    } else {
      // No pudimos capturar la plantilla de movimientos: al menos devolvemos saldos.
      debugLog.push("  WARN: no se capturó la request de movimientos; devolviendo solo saldos.");
      for (const acc of accountList) {
        accounts.push({
          label: `Cuenta ${acc.tipoCuenta} ${acc.numeroCuenta}`,
          balance: acc.saldoDisponible ?? acc.saldoDisponibleTotal ?? acc.saldoContable,
          movements: [],
        });
      }
    }

    const total = accounts.reduce((s, a) => s + a.movements.length, 0);
    progress(`Listo — ${total} movimientos totales`);
    await doSave(page, "06-final");
    const ss = doScreenshots ? ((await page.screenshot({ encoding: "base64" })) as string) : undefined;

    return { success: true, bank, accounts, screenshot: ss, debug: debugLog.join("\n") };
  } finally {
    page.off("response", onResponse);
  }
}

// ─── Export ──────────────────────────────────────────────────────

const bciPyme: BankScraper = {
  id: "bcipyme",
  name: "BCI Pyme",
  url: "https://www.bci.cl/corporativo/banco-en-linea/pyme",
  scrape: (options) => runScraper("bcipyme", options, {}, scrapeBciPyme),
};

export default bciPyme;
