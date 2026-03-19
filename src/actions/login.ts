import type { Frame, Page } from "puppeteer-core";
import { formatRut } from "../utils.js";

type LoginContext = Page | Frame;

export interface LoginSelectors {
  /** Bank-specific RUT selectors (tried before generic fallbacks) */
  rutSelectors?: string[];
  /** Bank-specific password selectors (tried before generic fallbacks) */
  passwordSelectors?: string[];
  /** Bank-specific submit selectors (tried before generic fallbacks) */
  submitSelectors?: string[];
  /** How to format RUT: "formatted" = 12.345.678-9, "clean" = 123456789, "dash" = 12345678-9 */
  rutFormat?: "formatted" | "clean" | "dash";
  /** Custom submit button texts */
  submitTexts?: string[];
}

const GENERIC_RUT_SELECTORS = [
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

const GENERIC_PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name*="pass"]',
  'input[id*="pass"]',
  'input[name*="clave"]',
  'input[id*="clave"]',
  'input[placeholder*="Clave"]',
  'input[placeholder*="contraseña"]',
];

const GENERIC_SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  "#btn_login",
];

const DEFAULT_SUBMIT_TEXTS = ["ingresar", "entrar"];

function formatRutValue(rut: string, format: LoginSelectors["rutFormat"]): string {
  const clean = rut.replace(/[.\-]/g, "");
  switch (format) {
    case "clean": return clean;
    case "dash": return clean.slice(0, -1) + "-" + clean.slice(-1);
    case "formatted":
    default: return formatRut(rut);
  }
}

export async function fillRut(
  context: LoginContext,
  rut: string,
  selectors?: LoginSelectors,
): Promise<boolean> {
  const formatted = formatRutValue(rut, selectors?.rutFormat);
  const clean = rut.replace(/[.\-]/g, "");
  const allSelectors = [...(selectors?.rutSelectors || []), ...GENERIC_RUT_SELECTORS];

  for (const sel of allSelectors) {
    try {
      const el = await context.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        // For short-maxlength fields, use clean RUT; otherwise formatted
        await el.type(sel === "#rut" ? clean : formatted, { delay: 45 });
        return true;
      }
    } catch {
      // Try next selector
    }
  }

  // Fallback: find first visible text input
  try {
    return await context.evaluate((rutFormatted: string, rutClean: string) => {
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
    }, formatted, clean);
  } catch {
    return false;
  }
}

export async function fillPassword(
  context: LoginContext,
  password: string,
  selectors?: LoginSelectors,
): Promise<boolean> {
  const allSelectors = [...(selectors?.passwordSelectors || []), ...GENERIC_PASSWORD_SELECTORS];

  for (const sel of allSelectors) {
    try {
      const el = await context.$(sel);
      if (el) {
        await el.click();
        await el.type(password, { delay: 45 });
        return true;
      }
    } catch {
      // Try next selector
    }
  }

  return false;
}

export async function clickSubmit(
  context: LoginContext,
  page: Page,
  selectors?: LoginSelectors,
): Promise<void> {
  const allSelectors = [...(selectors?.submitSelectors || []), ...GENERIC_SUBMIT_SELECTORS];
  const texts = selectors?.submitTexts || DEFAULT_SUBMIT_TEXTS;

  const clicked = await context.evaluate(
    (sels: string[], txts: string[]) => {
      // Try selectors first
      for (const sel of sels) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) continue;
        const disabled =
          (el as HTMLButtonElement).disabled ||
          el.getAttribute("aria-disabled") === "true" ||
          el.className.includes("disabled");
        if (disabled) continue;
        el.click();
        return true;
      }

      // Try text-based matching
      const candidates = Array.from(document.querySelectorAll("button, a"));
      for (const candidate of candidates) {
        const text = (candidate as HTMLElement).innerText?.trim().toLowerCase() || "";
        if (!txts.some((t) => text.includes(t))) continue;
        const disabled =
          (candidate as HTMLButtonElement).disabled ||
          candidate.getAttribute("aria-disabled") === "true" ||
          candidate.className.includes("disabled");
        if (disabled) continue;
        (candidate as HTMLElement).click();
        return true;
      }

      return false;
    },
    allSelectors,
    texts,
  );

  if (!clicked) {
    await page.keyboard.press("Enter");
  }
}

/** Detect login error messages on page and/or iframe */
export async function detectLoginError(
  page: Page,
  frame?: Frame | null,
  customKeywords?: RegExp,
): Promise<string | null> {
  const pattern =
    customKeywords ||
    /(error|incorrect|inv[aá]lid|rechazad|bloquead|fall[oó]|intenta nuevamente|credencial|autentic|clave.*(err[oó]nea|incorrecta)|rut.*(err[oó]neo|incorrecto))/i;

  const extractMessages = async (ctx: Page | Frame): Promise<string[]> => {
    return await ctx.evaluate(() => {
      const selectors = [
        '[class*="error"]',
        '[class*="alert"]',
        '[role="alert"]',
        '[class*="warning"]',
      ];
      const messages: string[] = [];
      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
          const text = (element as HTMLElement).innerText?.trim();
          if (text) messages.push(text);
        }
      }
      return messages;
    });
  };

  const pickError = (candidates: string[]): string | null => {
    for (const candidate of candidates) {
      const text = candidate.trim();
      if (!text || text.length < 4 || text.length > 250) continue;
      if (pattern.test(text)) return text;
    }
    return null;
  };

  const pageMessages = await extractMessages(page);
  const error = pickError(pageMessages);
  if (error) return error;

  if (frame) {
    try {
      const frameMessages = await extractMessages(frame);
      return pickError(frameMessages);
    } catch {
      // frame may have detached
    }
  }

  return null;
}
