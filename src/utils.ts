import * as fs from "fs";
import * as path from "path";
import type { Page } from "puppeteer-core";
import type { BankMovement, CardOwner } from "./types.js";
import { CARD_OWNER } from "./types.js";

/**
 * Array de strings que llama a un callback en cada push.
 * Úsalo en lugar de `string[]` para transmitir logs en tiempo real.
 */
export class DebugLog extends Array<string> {
  private readonly _onDebug?: (line: string) => void;

  constructor(onDebug?: (line: string) => void) {
    super();
    this._onDebug = onDebug;
  }

  override push(...items: string[]): number {
    for (const item of items) {
      super.push(item);
      this._onDebug?.(item);
    }
    return this.length;
  }
}

/** Formatea un RUT chileno (ej: "123456789" → "12.345.678-9") */
export function formatRut(rut: string): string {
  const clean = rut.replace(/[.\-]/g, "");
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  const formatted = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${formatted}-${dv}`;
}

/** Delay en milisegundos */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Busca Chrome/Chromium en el sistema */
export function findChrome(customPath?: string): string | null {
  if (customPath && fs.existsSync(customPath)) return customPath;

  const candidates = [
    // Linux
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "/snap/bin/chromium-browser",
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    // Windows (WSL)
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Guarda un screenshot si saveScreenshots está habilitado */
export async function saveScreenshot(
  page: Page,
  name: string,
  enabled: boolean,
  debugLog: string[]
): Promise<void> {
  if (!enabled) return;
  // Sanitize name to prevent path traversal
  const safeName = name.replace(/[/\\:*?"<>|]/g, "_");
  const dir = path.resolve("screenshots");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({
    path: path.join(dir, `${safeName}.png`),
    fullPage: true,
  });
  debugLog.push(`  Screenshot saved: screenshots/${safeName}.png`);
}

/** Cierra popups y modales genéricos */
export async function closePopups(page: Page): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Escape");
    await delay(300);
  }
  await page.evaluate(() => {
    const closeButtons = Array.from(
      document.querySelectorAll(
        '[class*="close"], [aria-label*="close"], [aria-label*="cerrar"], button'
      )
    );
    for (const btn of closeButtons) {
      const text = (btn as HTMLElement).innerText?.trim();
      if (text === "X" || text === "×" || text === "✕" || text === "Cerrar") {
        (btn as HTMLElement).click();
      }
    }
  });
  await delay(1000);
}

// ─── Parsing ──────────────────────────────────────────────────

/** Mapa de meses en español a número */
export const MONTHS_MAP: Record<string, string> = {
  ene: "01", feb: "02", mar: "03", abr: "04", may: "05", jun: "06",
  jul: "07", ago: "08", sep: "09", oct: "10", nov: "11", dic: "12",
};

/**
 * Parsea un monto en formato chileno a número entero.
 * Maneja: "$1.234.567", "-$50.000", "$1.234,56" (CLP con decimales).
 */
export function parseChileanAmount(text: string): number {
  const clean = text.replace(/[^0-9.,-]/g, "");
  if (!clean) return 0;
  const isNegative = clean.startsWith("-") || text.includes("-$");
  // Remove thousand separators (dots), convert decimal comma to dot
  const normalized = clean.replace(/-/g, "").replace(/\./g, "").replace(",", ".");
  const amount = parseInt(normalized, 10) || 0;
  return isNegative ? -amount : amount;
}

// ─── Dates ────────────────────────────────────────────────────

/**
 * Normaliza fechas a formato DD-MM-YYYY.
 * Soporta: dd/mm/yyyy, dd.mm.yyyy, dd-mm-yyyy, dd/mm, "9 mar 2026".
 */
export function normalizeDate(raw: string): string {
  const value = raw.trim();

  // dd/mm/yyyy, dd.mm.yyyy, dd-mm-yyyy (con año 2 o 4 dígitos)
  const fullMatch = value.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (fullMatch) {
    const day = fullMatch[1].padStart(2, "0");
    const month = fullMatch[2].padStart(2, "0");
    const year = fullMatch[3].length === 2 ? `20${fullMatch[3]}` : fullMatch[3];
    return `${day}-${month}-${year}`;
  }

  // dd/mm (sin año, asume año actual)
  const shortMatch = value.match(/^(\d{1,2})[\/.\-](\d{1,2})$/);
  if (shortMatch) {
    const day = shortMatch[1].padStart(2, "0");
    const month = shortMatch[2].padStart(2, "0");
    return `${day}-${month}-${new Date().getFullYear()}`;
  }

  // "9 mar 2026" (día mes_texto año)
  const parts = value.split(/\s+/);
  if (parts.length >= 2) {
    const monthKey = parts.length === 3 ? parts[1].toLowerCase() : parts[0].toLowerCase();
    if (MONTHS_MAP[monthKey]) {
      if (parts.length === 3) {
        return `${parts[0].padStart(2, "0")}-${MONTHS_MAP[monthKey]}-${parts[2]}`;
      }
      const dayPart = parts.find((p) => /^\d{1,2}$/.test(p));
      if (dayPart) {
        return `${dayPart.padStart(2, "0")}-${MONTHS_MAP[monthKey]}-${new Date().getFullYear()}`;
      }
    }
  }

  return value;
}

// ─── Movements ────────────────────────────────────────────────

/**
 * Normaliza cuotas a formato NN/NN (ej: "1/3" → "01/03", "01/1" → "01/01").
 */
export function normalizeInstallments(raw?: string): string | undefined {
  if (!raw) return undefined;
  const match = raw.trim().match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!match) return raw.trim();
  return `${match[1].padStart(2, "0")}/${match[2].padStart(2, "0")}`;
}

/**
 * Normaliza el campo owner a valores fijos.
 * "Titular" / "TITULAR" → "titular", "Adicional" / "ADICIONAL" → "adicional"
 */
export function normalizeOwner(raw?: string): CardOwner | undefined {
  if (!raw) return undefined;
  const lower = raw.trim().toLowerCase();
  if (lower.includes("adicional")) return CARD_OWNER.adicional;
  if (lower.includes("titular")) return CARD_OWNER.titular;
  return CARD_OWNER.titular; // default si hay owner pero no matchea
}

/** Elimina movimientos duplicados por fecha+descripción+monto+balance+source+owner */
export function deduplicateMovements(movements: BankMovement[]): BankMovement[] {
  const seen = new Set<string>();
  return movements.filter((m) => {
    // API-sourced movements have balance=0 (we don't get per-movement balance from the API).
    // These should never be deduplicated — the API is authoritative and two identical
    // charges (e.g. same toll twice in a day) are both real transactions.
    if (m.balance === 0) return true;

    // HTML-scraped movements carry the running account balance after each transaction.
    // The same row re-fetched across paginated pages will have the same balance,
    // so including it in the key correctly removes pagination duplicates while
    // keeping legitimately repeated transactions (which have different balances).
    const key = `${m.date}|${m.description}|${m.amount}|${m.balance ?? ""}|${m.source}|${m.owner ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Converts a DD-MM-YYYY date to a human-readable month+year label.
 * Example: "19-03-2026" → "Marzo 2026"
 */
export function monthYearLabel(dateStr: string): string {
  const monthNames = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const parts = dateStr.split("-");
  if (parts.length < 3) return dateStr;
  const monthIdx = parseInt(parts[1], 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return dateStr;
  return `${monthNames[monthIdx]} ${parts[2]}`;
}

/**
 * Deduplicates movements that appear in both unbilled and billed sources.
 * If the same transaction (date+description+amount) appears as both
 * credit_card_unbilled and credit_card_billed, keep only the billed one.
 */
export function deduplicateAcrossSources(movements: BankMovement[]): BankMovement[] {
  const billedKeys = new Set<string>();
  for (const m of movements) {
    if (m.source === "credit_card_billed") {
      billedKeys.add(`${m.date}|${m.description}|${m.amount}`);
    }
  }
  return movements.filter(m => {
    if (m.source !== "credit_card_unbilled") return true;
    return !billedKeys.has(`${m.date}|${m.description}|${m.amount}`);
  });
}

// ─── Spinner ──────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Spinner de terminal que muestra el paso actual del scraper */
export class Spinner {
  private frameIdx = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private currentStep = "";
  private stream: NodeJS.WriteStream;

  constructor(stream: NodeJS.WriteStream = process.stderr) {
    this.stream = stream;
  }

  /** Inicia el spinner con un mensaje inicial */
  start(message: string): void {
    this.currentStep = message;
    this.interval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.frameIdx % SPINNER_FRAMES.length];
      this.stream.write(`\r${frame} ${this.currentStep}\x1b[K`);
      this.frameIdx++;
    }, 80);
  }

  /** Actualiza el mensaje del spinner */
  update(message: string): void {
    this.currentStep = message;
  }

  /** Detiene el spinner y muestra un mensaje final */
  stop(finalMessage?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (finalMessage) {
      this.stream.write(`\r✔ ${finalMessage}\x1b[K\n`);
    } else {
      this.stream.write(`\r\x1b[K`);
    }
  }

  /** Detiene el spinner con un mensaje de error */
  fail(message: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.stream.write(`\r✖ ${message}\x1b[K\n`);
  }
}

// ─── Session ──────────────────────────────────────────────────

/** Cierra sesión buscando botones de logout comunes */
export async function logout(page: Page, debugLog: string[]): Promise<void> {
  try {
    const clicked = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll("a, button, span, div, li"));
      for (const el of elements) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase();
        if (
          text === "cerrar sesión" ||
          text === "cerrar sesion" ||
          text === "salir" ||
          text === "logout" ||
          text === "sign out"
        ) {
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
    // best effort — browser.close() ends the session anyway
  }
}
