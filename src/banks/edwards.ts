import * as fs from "fs";
import * as path from "path";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";
import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types";
import { closePopups, delay, findChrome, formatRut, saveScreenshot } from "../utils";

const BANK_URL = "https://portalpersonas.bancochile.cl/persona/";

const SIDEBAR_MAX_X = 300;

type MovementAccount = { index: number; label: string; active: boolean };
type TcTab = "por-facturar" | "facturados";

// ─── Extraction helpers (Santander parity) ─────────────────────

function deduplicateMovements(movements: BankMovement[]): BankMovement[] {
  const seen = new Set<string>();
  return movements.filter((m) => {
    const key = `${m.date}|${m.description}|${m.amount}|${m.balance}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseChileanAmount(value: string): number {
  const clean = value.replace(/[^0-9-]/g, "");
  if (!clean) return 0;
  const isNegative = clean.startsWith("-") || value.includes("-$");
  const amount = parseInt(clean.replace(/-/g, ""), 10) || 0;
  return isNegative ? -amount : amount;
}

function normalizeMovementDate(raw: string): string {
  const value = raw.trim();
  const fullMatch = value.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (fullMatch) {
    const day = fullMatch[1].padStart(2, "0");
    const month = fullMatch[2].padStart(2, "0");
    const year = fullMatch[3].length === 2 ? `20${fullMatch[3]}` : fullMatch[3];
    return `${day}-${month}-${year}`;
  }
  const shortMatch = value.match(/^(\d{1,2})[\/.\-](\d{1,2})$/);
  if (shortMatch) {
    const day = shortMatch[1].padStart(2, "0");
    const month = shortMatch[2].padStart(2, "0");
    const year = String(new Date().getFullYear());
    return `${day}-${month}-${year}`;
  }
  return value;
}

// ─── Login helpers ─────────────────────────────────────────────

async function fillRut(page: Page, rut: string): Promise<boolean> {
  const formattedRut = formatRut(rut);
  const cleanRut = rut.replace(/[.\-]/g, "");

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
        await el.type(sel.includes("id") && sel.includes("user") ? cleanRut : formattedRut, {
          delay: 50,
        });
        return true;
      }
    } catch { /* try next */ }
  }

  try {
    const filled = await page.evaluate((rutVal: string, rutClean: string) => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      for (const input of inputs) {
        const el = input as HTMLInputElement;
        if (el.offsetParent !== null && !el.disabled) {
          el.focus();
          el.value = el.maxLength > 0 && el.maxLength <= 10 ? rutClean : rutVal;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      return false;
    }, formattedRut, cleanRut);
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

  // Use page.keyboard (Frame doesn't have keyboard, need parent Page)
  const pageForKeyboard = "keyboard" in page ? page : (page as Frame).page();
  await pageForKeyboard.keyboard.press("Enter");
  return true;
}

// ─── Navigation ────────────────────────────────────────────────

async function tryExpandDateRange(page: Page, debugLog: string[]): Promise<void> {
  try {
    const selectInfo = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      return selects.map((sel, i) => ({
        index: i,
        name: sel.name || sel.id || `select-${i}`,
        options: Array.from(sel.querySelectorAll("option")).map((o) => ({
          text: o.text.trim(), value: o.value, selected: o.selected,
        })),
      }));
    });

    if (selectInfo.length > 0) {
      for (const sel of selectInfo) {
        for (const opt of sel.options) {
          const text = opt.text.toLowerCase();
          if (
            text.includes("todos") ||
            text.includes("último mes") ||
            text.includes("30 día") ||
            text.includes("60 día") ||
            text.includes("90 día") ||
            text.includes("6 mes") ||
            text.includes("3 mes") ||
            text.includes("mes anterior")
          ) {
            await page.evaluate((selIdx: number, optValue: string) => {
              const selects = document.querySelectorAll("select");
              const select = selects[selIdx] as HTMLSelectElement;
              if (select) {
                select.value = optValue;
                select.dispatchEvent(new Event("change", { bubbles: true }));
              }
            }, sel.index, opt.value);
            debugLog.push(`  Changed [${sel.name}] to "${opt.text}"`);
            await delay(3000);
            break;
          }
        }
      }
    }

    const clickedSearch = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, input[type='submit']"));
      for (const btn of buttons) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
        if (text === "buscar" || text === "consultar" || text === "filtrar") {
          (btn as HTMLElement).click();
          return text;
        }
      }
      return null;
    });

    if (clickedSearch) {
      debugLog.push(`  Clicked "${clickedSearch}" button`);
      await delay(3000);
    }
  } catch { /* ignore */ }
}

// Banco Chile post-login: Accesos Directos use "SALDOS Y MOV. CUENTAS" / "SALDOS Y MOV.TARJETAS CRÉDITO"
const NAV_TARGETS = [
  { text: "saldos y mov. cuentas", exact: false },
  { text: "saldos y mov. tarjetas", exact: false },
  { text: "cartola", exact: false },
  { text: "últimos movimientos", exact: false },
  { text: "movimientos", exact: true },
  { text: "estado de cuenta", exact: false },
  { text: "historial", exact: false },
];

async function clickNavTarget(page: Page, debugLog: string[]): Promise<boolean> {
  for (const target of NAV_TARGETS) {
    const result = await page.evaluate((t: { text: string; exact: boolean }) => {
      const elements = Array.from(document.querySelectorAll("a, button, [role='tab'], [role='menuitem'], li, span"));
      for (const el of elements) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
        const match = t.exact ? text === t.text : text.includes(t.text);
        if (match && text.length < 50) {
          (el as HTMLElement).click();
          return `Clicked: "${text}"`;
        }
      }
      return null;
    }, target);

    if (result) {
      debugLog.push(`  ${result}`);
      await delay(4000);
      return true;
    }
  }
  return false;
}

const TC_NAV_TARGETS = [
  { text: "saldos y mov. tarjetas", exact: false },
  { text: "tarjetas crédito", exact: false },
];

async function clickTcNavTarget(page: Page, debugLog: string[]): Promise<boolean> {
  for (const target of TC_NAV_TARGETS) {
    const result = await page.evaluate((t: { text: string; exact: boolean }) => {
      const elements = Array.from(document.querySelectorAll("a, button, [role='tab'], [role='menuitem'], li, span"));
      for (const el of elements) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
        const match = t.exact ? text === t.text : text.includes(t.text);
        if (match && text.length < 50) {
          (el as HTMLElement).click();
          return `Clicked: "${text}"`;
        }
      }
      return null;
    }, target);

    if (result) {
      debugLog.push(`  ${result}`);
      await delay(4000);
      return true;
    }
  }
  return false;
}

// ─── Extraction ────────────────────────────────────────────────

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

      let lastDate = "";
      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 3) continue;
        const values = Array.from(cells).map((c) => (c as HTMLElement).innerText?.trim() || "");
        const rawDate = values[dateIndex] || "";
        const hasDate = /^\d{1,2}[\/.\-]\d{1,2}([\/.\-]\d{2,4})?$/.test(rawDate);
        const date = hasDate ? rawDate : lastDate;
        if (!date) continue;
        if (hasDate) lastDate = rawDate;

        const description = descriptionIndex >= 0 ? (values[descriptionIndex] || "") : "";
        let amount = "";
        if (cargoIndex >= 0 && values[cargoIndex]) amount = `-${values[cargoIndex]}`;
        else if (abonoIndex >= 0 && values[abonoIndex]) amount = values[abonoIndex];
        else if (amountIndex >= 0) amount = values[amountIndex] || "";
        const balance = balanceIndex >= 0 ? (values[balanceIndex] || "") : "";
        if (!amount) continue;
        results.push({ date, description, amount, balance });
      }
    }

    // Strategy 2: Card/list components.
    if (results.length === 0) {
      const cards = document.querySelectorAll("[class*='mov'], [class*='tran'], [class*='movement'], [class*='transaction'], li, article, section");
      for (const card of cards) {
        const text = (card as HTMLElement).innerText || "";
        const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
        if (lines.length < 3 || lines.length > 10) continue;
        const date = lines.find((line) => /\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/.test(line));
        const amount = lines.find((line) => /[$]\s*[\d.]+/.test(line));
        if (!date || !amount) continue;
        const description = lines.find((line) => line !== date && line !== amount && line.length > 3) || "";
        const balance = lines.find((line) => line.toLowerCase().includes("saldo") && /[$]\s*[\d.]+/.test(line)) || "";
        const normalizedAmount = text.toLowerCase().includes("cargo") || text.toLowerCase().includes("debito") || text.toLowerCase().includes("débito") || amount.includes("-") ? `-${amount}` : amount;
        results.push({ date, description, amount: normalizedAmount, balance });
      }
    }

    return results;
  });

  const parsed = rawMovements
    .map((m) => {
      const amount = parseChileanAmount(m.amount);
      if (amount === 0) return null;
      return {
        date: normalizeMovementDate(m.date),
        description: m.description,
        amount,
        balance: m.balance ? parseChileanAmount(m.balance) : 0,
      } satisfies BankMovement;
    })
    .filter((x): x is BankMovement => x !== null);

  return deduplicateMovements(parsed);
}

// ─── Pagination ────────────────────────────────────────────────

async function clickNextPage(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    // Angular Material / bch-paginator: next button
    const matNext = document.querySelector(".mat-paginator-navigation-next:not([disabled])");
    if (matNext) {
      (matNext as HTMLElement).click();
      return true;
    }
    const bchNext = document.querySelector("bch-paginator button[aria-label*='siguiente'], bch-paginator button[aria-label*='Siguiente'], bch-paginator button[aria-label*='next']");
    if (bchNext && !(bchNext as HTMLButtonElement).disabled) {
      (bchNext as HTMLElement).click();
      return true;
    }
    // Text buttons
    const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
    for (const btn of candidates) {
      const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
      const aria = (btn as HTMLElement).getAttribute("aria-label")?.toLowerCase() || "";
      if (
        text === "siguiente" ||
        text === "›" ||
        text === ">" ||
        text.includes("ver más") ||
        text.includes("cargar más") ||
        aria.includes("siguiente") ||
        aria.includes("next")
      ) {
        if ((btn as HTMLButtonElement).disabled || (btn as HTMLElement).classList.contains("disabled")) return false;
        (btn as HTMLElement).click();
        return true;
      }
    }
    return false;
  });
}

async function hasNextPage(page: Page): Promise<boolean> {
  const disabled = await page.evaluate(() => {
    const matNext = document.querySelector(".mat-paginator-navigation-next");
    if (matNext) return (matNext as HTMLButtonElement).disabled;
    const bchNext = document.querySelector("bch-paginator button[aria-label*='siguiente'], bch-paginator button[aria-label*='Siguiente']");
    if (bchNext) return (bchNext as HTMLButtonElement).disabled;
    const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
    for (const btn of candidates) {
      const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
      if (text === "siguiente" || text === "›" || text === ">" || text.includes("ver más")) {
        return (btn as HTMLButtonElement).disabled || (btn as HTMLElement).classList.contains("disabled");
      }
    }
    return true; // no next button = last page
  });
  return !disabled;
}

async function paginateAndExtract(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  const allMovements: BankMovement[] = [];

  for (let i = 0; i < 50; i++) {
    const movements = await extractMovements(page);
    allMovements.push(...movements);

    const canNext = await hasNextPage(page);
    if (!canNext) break;

    const clicked = await clickNextPage(page);
    if (!clicked) break;

    if (i > 0) debugLog.push(`  Pagination: page ${i + 2}`);
    await delay(3000);
  }

  return deduplicateMovements(allMovements);
}

function accountTag(label: string): string {
  return `[${label}]`;
}

function prefixAccountToMovements(movements: BankMovement[], label: string, enabled: boolean): BankMovement[] {
  if (!enabled) return movements;
  const tag = accountTag(label);
  return movements.map((m) =>
    m.description.startsWith(tag) ? m : { ...m, description: `${tag} ${m.description}`.trim() }
  );
}

async function listMovementAccounts(page: Page): Promise<MovementAccount[]> {
  return await page.evaluate((maxX: number) => {
    const out: Array<{ index: number; label: string; active: boolean }> = [];
    const slides = Array.from(document.querySelectorAll("#tabs-carousel-movs .swiper-slide, [class*='swiper-slide']"));
    if (slides.length > 0) {
      for (let i = 0; i < slides.length; i++) {
        const slide = slides[i] as HTMLElement;
        const text = slide.innerText?.replace(/\s+/g, " ").trim() || "";
        if (!text) continue;
        const typeMatch = text.match(/Cuenta\s+(Corriente|Vista)/i);
        const numberMatch = text.match(/\d(?:[\s.]\d+){3,}/);
        const type = typeMatch ? `Cuenta ${typeMatch[1]}` : "Cuenta";
        const number = numberMatch ? numberMatch[0].replace(/\s+/g, " ").trim() : `#${i + 1}`;
        out.push({ index: i, label: `${type} ${number}`.trim(), active: slide.className.includes("swiper-slide-active") });
      }
      return out;
    }
    const tabs = Array.from(document.querySelectorAll("[role='tab'], [data-role='tab'], .tab, [class*='tab']"));
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i] as HTMLElement;
      const text = tab.innerText?.trim() || "";
      if (!text || !/cuenta|corriente|vista/i.test(text)) continue;
      const rect = tab.getBoundingClientRect();
      if (rect.x > maxX) continue;
      const label = text.length > 30 ? `Cuenta #${i + 1}` : text;
      out.push({ index: i, label, active: tab.getAttribute("aria-selected") === "true" || tab.classList.contains("active") });
    }
    return out;
  }, SIDEBAR_MAX_X);
}

async function selectMovementAccount(page: Page, index: number): Promise<boolean> {
  const clicked = await page.evaluate((targetIndex: number) => {
    const byAria = document.querySelector(`#tabs-carousel-movs [aria-label='Go to slide ${targetIndex + 1}']`) as HTMLElement | null;
    if (byAria) { byAria.click(); return true; }
    const dots = Array.from(document.querySelectorAll("#tabs-carousel-movs .swiper-pagination-bullet, [class*='pagination-bullet']"));
    const dot = dots[targetIndex] as HTMLElement | undefined;
    if (dot) { dot.click(); return true; }
    const slides = Array.from(document.querySelectorAll("#tabs-carousel-movs .swiper-slide, [class*='swiper-slide']"));
    const slide = slides[targetIndex] as HTMLElement | undefined;
    if (slide) {
      const clickable = slide.querySelector(".container-account, .container-image, a") as HTMLElement | null || slide;
      clickable.click();
      return true;
    }
    const tabs = Array.from(document.querySelectorAll("[role='tab'], [data-role='tab'], .tab, [class*='tab']"));
    if (tabs[targetIndex]) { (tabs[targetIndex] as HTMLElement).click(); return true; }
    return false;
  }, index);
  if (!clicked) return false;
  await delay(1200);
  return true;
}

async function extractBalance(page: Page): Promise<number | undefined> {
  return await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const patterns = [
      /saldo disponible[^\d$-]*\$\s*([\d.]+)/i,
      /saldo actual[^\d$-]*\$\s*([\d.]+)/i,
      /saldo cuenta[^\d$-]*\$\s*([\d.]+)/i,
      /cuenta corriente[\s\S]{0,80}\$\s*([\d.]+)/i,
      /cuenta vista[\s\S]{0,80}\$\s*([\d.]+)/i,
      /Saldo[\s\S]{0,80}\$?\s*([\d.]+)/i,
      /Disponible[\s\S]{0,50}\$?\s*([\d.]+)/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m?.[1]) {
        const v = parseInt(m[1].replace(/[^0-9]/g, ""), 10);
        if (!Number.isNaN(v)) return v;
      }
    }
    return undefined;
  });
}

async function navigateToCreditCardSection(page: Page, debugLog: string[]): Promise<boolean> {
  const clickedTarjetas = await page.evaluate((maxX: number) => {
    const items = Array.from(document.querySelectorAll("button, a, span, li"));
    for (const item of items) {
      const text = (item as HTMLElement).innerText?.trim().toLowerCase() || "";
      const rect = (item as HTMLElement).getBoundingClientRect();
      if (rect.x > maxX) continue;
      if (text === "tarjetas" || text.includes("tarjetas")) {
        (item as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, SIDEBAR_MAX_X);
  if (clickedTarjetas) {
    debugLog.push("  Tarjetas menu opened");
    await delay(2000);
  }

  const clickedMyCards = await page.evaluate((maxX: number) => {
    const items = Array.from(document.querySelectorAll("button, a, span, li"));
    for (const item of items) {
      const text = (item as HTMLElement).innerText?.trim().toLowerCase() || "";
      const rect = (item as HTMLElement).getBoundingClientRect();
      if (rect.x > maxX) continue;
      if (text.includes("mis tarjetas") || text.includes("tarjetas de crédito") || text.includes("tarjetas de credito")) {
        (item as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, SIDEBAR_MAX_X);
  if (clickedMyCards) {
    debugLog.push("  Opened Mis Tarjetas de Credito");
    await delay(3500);
  }
  return page.url().toLowerCase().includes("tarjeta") || page.url().toLowerCase().includes("tc");
}

async function clickTcTab(page: Page, tab: TcTab): Promise<boolean> {
  const targetText = tab === "por-facturar" ? "movimientos por facturar" : "movimientos facturados";
  const clicked = await page.evaluate((text: string) => {
    const items = Array.from(document.querySelectorAll("button, a, div, span"));
    for (const item of items) {
      const content = (item as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (content !== text && !content.includes(text)) continue;
      (item as HTMLElement).click();
      return true;
    }
    return false;
  }, targetText);
  if (!clicked) return false;
  await delay(3000);
  return true;
}

function isCreditCardCredit(description: string): boolean {
  const t = description.toLowerCase();
  return t.includes("abono") || t.includes("cancelado") || t.includes("nota de credito") || t.includes("reverso") || /^pago\b/.test(t);
}

async function extractCreditCardMovements(page: Page, tab: TcTab): Promise<BankMovement[]> {
  const raw = await page.evaluate(() => {
    const table = Array.from(document.querySelectorAll("table")).find((t) => {
      const ht = Array.from(t.querySelectorAll("th")).map((th) => (th as HTMLElement).innerText?.trim().toLowerCase() || "").join("|");
      return ht.includes("fecha") && (ht.includes("detalle") || ht.includes("descrip")) && (ht.includes("monto") || ht.includes("cargo"));
    });
    if (!table) return [];
    const headers = Array.from(table.querySelectorAll("th")).map((th) => (th as HTMLElement).innerText?.trim().toLowerCase() || "");
    const dateIdx = headers.findIndex((h) => h.includes("fecha"));
    const detailIdx = headers.findIndex((h) => h.includes("detalle") || h.includes("descrip"));
    const cargoIdx = headers.findIndex((h) => h.includes("cargo"));
    const abonoIdx = headers.findIndex((h) => h.includes("abono"));
    const amountIdx = headers.findIndex((h) => h === "monto" || h.includes("importe"));
    const rows = Array.from(table.querySelectorAll("tbody tr"));
    let lastDate = "";
    const out: Array<{ date: string; description: string; amount: string }> = [];
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td")).map((td) => (td as HTMLElement).innerText?.trim() || "");
      if (cells.length < 2) continue;
      const rawDate = dateIdx >= 0 ? (cells[dateIdx] || "") : "";
      const hasDate = /^\d{1,2}[\/.\-]\d{1,2}([\/.\-]\d{2,4})?$/.test(rawDate);
      const date = hasDate ? rawDate : lastDate;
      if (!date) continue;
      if (hasDate) lastDate = rawDate;
      const description = detailIdx >= 0 ? (cells[detailIdx] || "") : "";
      let amount = "";
      if (cargoIdx >= 0 && cells[cargoIdx]) amount = `-${cells[cargoIdx]}`;
      else if (abonoIdx >= 0 && cells[abonoIdx]) amount = cells[abonoIdx];
      else if (amountIdx >= 0) amount = cells[amountIdx] || "";
      if (!description || !amount) continue;
      out.push({ date, description, amount });
    }
    return out;
  });

  const tag = tab === "por-facturar" ? "[TC Por Facturar]" : "[TC Facturados]";
  return raw
    .map((row) => {
      const abs = Math.abs(parseChileanAmount(row.amount));
      if (abs === 0) return null;
      let amount = abs;
      if (row.amount.includes("-")) amount = -abs;
      else if (!row.amount.includes("+") && !isCreditCardCredit(row.description)) amount = -abs;
      return {
        date: normalizeMovementDate(row.date),
        description: `${tag} ${row.description}`.trim(),
        amount,
        balance: 0,
      } satisfies BankMovement;
    })
    .filter((m): m is BankMovement => m !== null);
}

async function paginateTcAndExtract(page: Page, tab: TcTab, debugLog: string[]): Promise<BankMovement[]> {
  const allMovements: BankMovement[] = [];

  for (let i = 0; i < 50; i++) {
    const movements = await extractCreditCardMovements(page, tab);
    allMovements.push(...movements);

    const canNext = await hasNextPage(page);
    if (!canNext) break;

    const clicked = await clickNextPage(page);
    if (!clicked) break;

    if (i > 0) debugLog.push(`  TC pagination: page ${i + 2}`);
    await delay(3000);
  }

  return deduplicateMovements(allMovements);
}

// ─── Logout ─────────────────────────────────────────────────────

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
    // best effort — browser.close() ends the session anyway
  }
}

// ─── Main scraper ──────────────────────────────────────────────

async function scrape(options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, chromePath, saveScreenshots: doScreenshots, headful } = options;
  const bank = "edwards";

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

  let browser: Browser | undefined;
  const debugLog: string[] = [];
  const doSave = async (page: Page, name: string) => saveScreenshot(page, name, !!doScreenshots, debugLog);

  try {
    const launchedBrowser = await puppeteer.launch({
      executablePath,
      headless: !headful,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--window-size=1280,900", "--disable-blink-features=AutomationControlled"],
    });
    browser = launchedBrowser;

    const page = await launchedBrowser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // Step 1: Navigate to login page (Edwards uses direct login URL)
    debugLog.push("1. Navigating to Banco Edwards login...");
    await page.goto(BANK_URL, { waitUntil: "load", timeout: 30000 });
    await delay(5000); // Allow SPA to render

    // Dismiss cookie banner if present
    try {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, a, span"));
        for (const btn of btns) {
          const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
          if (text === "entendido" || text === "aceptar" || text === "aceptar cookies") {
            (btn as HTMLElement).click();
            return;
          }
        }
      });
      await delay(1000);
    } catch { /* no banner */ }

    await doSave(page, "01-loaded");

    // Login form: try main page first, then first iframe if main has empty body
    const frames = page.frames();
    const bodyLen = await page.evaluate(() => document.body?.innerText?.length ?? 0);
    let loginCtx: Page | Frame = page;
    if (bodyLen === 0 && frames.length > 1) {
      const f = frames.find((fr) => fr !== page.mainFrame() && fr.url() && !fr.url().startsWith("about:"));
      if (f) {
        loginCtx = f;
        debugLog.push("  Formulario en iframe");
      }
    }

    debugLog.push("2. Filling RUT...");
    const rutFilled = await fillRut(loginCtx as unknown as Page, rut);
    if (!rutFilled) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return { success: false, bank, movements: [], error: `No se encontró campo de RUT en ${page.url()}`, screenshot: screenshot as string, debug: debugLog.join("\n") };
    }
    await delay(1500);

    // Step 3: Fill password
    debugLog.push("3. Filling password...");
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

    // Step 4: Submit login
    debugLog.push("4. Submitting login...");
    await clickSubmitButton(page);
    await delay(8000);
    await doSave(page, "02-after-login");

    // When --screenshots: save HTML for DOM inspection (debug/ is in .gitignore)
    if (doScreenshots) {
      const html = await page.content();
      const debugDir = path.resolve("debug");
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
      fs.writeFileSync(path.join(debugDir, "02-after-login.html"), html, "utf8");
      debugLog.push("  HTML saved: debug/02-after-login.html");
    }

    // Banco de Chile/Edwards: no 2FA in login flow

    // Check login errors
    const errorCheck = await page.evaluate(() => {
      const errorEls = document.querySelectorAll('[class*="error"], [class*="alert"], [role="alert"], [class*="Error"]');
      const ignore = ["emergencias"];
      for (const el of errorEls) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase();
        if (text && text.length > 5 && text.length < 200 && !ignore.some((i) => text === i)) return text;
      }
      return null;
    });
    if (errorCheck) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return { success: false, bank, movements: [], error: `Error del banco: ${errorCheck}`, screenshot: screenshot as string, debug: debugLog.join("\n") };
    }

    debugLog.push(`5. Login OK! URL: ${page.url()}`);

    // Step 5: Close popups
    await closePopups(page);

    // Step 6: Navigate to Cartola/Movimientos
    debugLog.push("6. Looking for Cartola/Movimientos...");
    let navigated = await clickNavTarget(page, debugLog);

    if (!navigated) {
      debugLog.push("7. No Cartola link found. Looking for account to click...");
      const clickedAccount = await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll("a, div, button, tr, li"));
        for (const el of allElements) {
          const text = (el as HTMLElement).innerText?.trim() || "";
          if ((text.toLowerCase().includes("cuenta corriente") || text.toLowerCase().includes("cuenta vista") || text.toLowerCase().includes("cuenta")) && text.length < 100) {
            if (el.tagName === "A") { (el as HTMLElement).click(); return `Clicked: "${text.substring(0, 60)}"`; }
            const childLink = el.querySelector("a");
            if (childLink) { (childLink as HTMLElement).click(); return `Clicked: "${(childLink as HTMLElement).innerText?.trim().substring(0, 60)}"`; }
            (el as HTMLElement).click();
            return `Clicked: "${text.substring(0, 60)}"`;
          }
        }
        return null;
      });

      if (clickedAccount) {
        debugLog.push(`  ${clickedAccount}`);
        await delay(4000);
        navigated = await clickNavTarget(page, debugLog);
      }
    }

    await doSave(page, "03-movements-page");
    if (doScreenshots) {
      const html = await page.content();
      const debugDir = path.resolve("debug");
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
      fs.writeFileSync(path.join(debugDir, "03-movements-page.html"), html, "utf8");
      debugLog.push("  HTML saved: debug/03-movements-page.html");
    }

    // Step 7: Expand date range if available
    await tryExpandDateRange(page, debugLog);

    // Step 8: List accounts and extract movements (multi-account or single)
    const accounts = await listMovementAccounts(page);
    const multiAccounts = accounts.length > 1;
    if (accounts.length > 0) {
      debugLog.push(`  Accounts detected: ${accounts.map((a) => a.label).join(" | ")}`);
    }

    let movements: BankMovement[] = [];
    if (accounts.length <= 1) {
      movements = await paginateAndExtract(page, debugLog);
      if (accounts.length === 1) {
        movements = prefixAccountToMovements(movements, accounts[0].label, multiAccounts);
      }
    } else {
      for (const account of accounts) {
        const switched = await selectMovementAccount(page, account.index);
        if (!switched) {
          debugLog.push(`  Could not switch to account ${account.label}`);
          continue;
        }
        const accountMovements = await paginateAndExtract(page, debugLog);
        movements.push(...prefixAccountToMovements(accountMovements, account.label, multiAccounts));
        debugLog.push(`  ${account.label}: ${accountMovements.length} movement(s)`);
      }
    }

    movements = deduplicateMovements(movements);

    // Step 7b: Credit card movements
    debugLog.push("7b. Navigating to Tarjetas de Crédito...");
    const baseUrl = page.url().split("#")[0];
    await page.goto(`${baseUrl}#/home`, { waitUntil: "load", timeout: 15000 });
    await delay(3000);

    const tcClicked = await clickTcNavTarget(page, debugLog);
    if (tcClicked) {
      await delay(4000);
      if (doScreenshots) {
        const html = await page.content();
        const debugDir = path.resolve("debug");
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
        fs.writeFileSync(path.join(debugDir, "03-tc-movements.html"), html, "utf8");
        debugLog.push("  HTML saved: debug/03-tc-movements.html");
      }
      const porFacturar = await clickTcTab(page, "por-facturar");
      if (porFacturar) {
        const tcPorFact = await paginateTcAndExtract(page, "por-facturar", debugLog);
        movements.push(...tcPorFact);
        debugLog.push(`  TC por facturar: ${tcPorFact.length} movement(s)`);
      }
      const facturados = await clickTcTab(page, "facturados");
      if (facturados) {
        const tcFact = await paginateTcAndExtract(page, "facturados", debugLog);
        movements.push(...tcFact);
        debugLog.push(`  TC facturados: ${tcFact.length} movement(s)`);
      }
      movements = deduplicateMovements(movements);
    }

    debugLog.push(`8. Extracted ${movements.length} movements`);

    // Step 9: Get balance
    let balance: number | undefined;
    if (movements.length > 0) {
      const withBalance = movements.find((m) => m.balance > 0);
      if (withBalance) balance = withBalance.balance;
    }
    if (balance === undefined || balance === 0) {
      balance = await extractBalance(page);
    }

    await doSave(page, "04-final");
    const screenshot = await page.screenshot({ encoding: "base64", fullPage: true });

    return { success: true, bank, movements, balance: balance || undefined, screenshot: screenshot as string, debug: debugLog.join("\n") };
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

// ─── Export ────────────────────────────────────────────────────

const edwards: BankScraper = {
  id: "edwards",
  name: "Banco Edwards",
  url: "https://portalpersonas.bancochile.cl/persona/",
  scrape,
};

export default edwards;
