import type { Page } from "puppeteer-core";
import type { BankMovement, BankScraper, CardOwner, CreditCardBalance, ScrapeResult, ScraperOptions } from "../types.js";
import { CARD_OWNER, MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, parseChileanAmount, normalizeDate, deduplicateMovements } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { fillRut, fillPassword, clickSubmit, detectLoginError } from "../actions/login.js";
import { dismissBanners } from "../actions/navigation.js";
import { detect2FA, waitFor2FA } from "../actions/two-factor.js";

// ─── Constants ────────────────────────────────────────────────────

const BANK_ID = "security";
const BANK_URL = "https://personas.bancosecurity.cl/";
const LOGIN_URL = "https://www.bancosecurity.cl/widgets/wPersonasLogin/index.asp";
const SUMMARY_URL = "https://www.bancosecurity.cl/security/home/resumen_productos/resumen.asp";
const CARTOLA_URL = "https://www.bancosecurity.cl/Empresas/Cuentas/cartola_corriente.asp";

const LOGIN_SELECTORS = {
  rutSelectors: ["#frut", 'input[name="frut"]'],
  passwordSelectors: ["#clave", 'input[name="clave"]'],
  submitSelectors: ["#btnIngresar"],
  submitTexts: ["ingresar"],
  // Portal expects formatted RUT: "12.345.678-9"
  rutFormat: "formatted" as const,
};

const TWO_FACTOR_CONFIG = {
  keywords: [
    "security pass",
    "segundo factor",
    "clave dinámica",
    "clave dinamica",
    "código de verificación",
    "codigo de verificacion",
    "autoriza",
    "aprueba",
    "aprobación",
    "aprobacion",
  ],
  timeoutEnvVar: "SECURITY_2FA_TIMEOUT_SEC",
};

interface SecurityCardSummary {
  label: string;
  card?: string;
  unbilledUrl?: string;
  statementUrl?: string;
}

interface SecurityStatementForm {
  name: string;
  action: string;
  selectName: string;
  hidden: Record<string, string>;
  options: Array<{ value: string; text: string }>;
  kind: "national" | "international";
}

// ─── Helpers ─────────────────────────────────────────────────────

async function waitForDashboard(page: Page): Promise<void> {
  const start = Date.now();
  const keywords = ["cartola", "movimientos", "cuenta corriente", "mi cuenta", "saldo", "bienvenido", "productos", "cerrar sesión"];
  while (Date.now() - start < 20000) {
    try {
      const found = await page.evaluate((kws: string[]) => {
        const text = document.body?.innerText?.toLowerCase() || "";
        return kws.some((k) => text.includes(k));
      }, keywords);
      if (found) break;
    } catch {
      // Login redirects can destroy the current execution context between polls.
    }
    await delay(1500);
  }
}

/** Finds an element by visible text and clicks it with Puppeteer's native click (triggers real browser events). */
async function nativeClick(page: Page, texts: string[], selectors = "a, button, li, span, [role='menuitem']"): Promise<string | null> {
  const result = await page.evaluate((txts: string[], sels: string) => {
    for (const el of Array.from(document.querySelectorAll(sels))) {
      const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (txts.some((t) => text === t || text.includes(t)) && text.length < 80 && (el as HTMLElement).offsetParent !== null) {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const href = (el as HTMLAnchorElement).href || null;
        return { text: (el as HTMLElement).innerText.trim().slice(0, 40), x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, href };
      }
    }
    return null;
  }, texts, selectors);
  if (!result) return null;
  if (result.href && !result.href.startsWith("javascript")) {
    await page.goto(result.href, { waitUntil: "networkidle2", timeout: 30000 });
  } else {
    await page.mouse.click(result.x, result.y);
  }
  return result.text;
}

async function navigateToMovements(page: Page, debugLog: string[]): Promise<void> {
  await waitForDashboard(page);

  const clickedProductos = await nativeClick(page, ["productos"]);
  if (clickedProductos) {
    debugLog.push(`  Clicked: ${clickedProductos}`);
    await delay(1500);
  }

  const clicked = await nativeClick(page, ["saldos y movimientos"]);
  if (clicked) {
    debugLog.push(`  Clicked: ${clicked}`);
    await delay(5000);
    return;
  }

  const fallbacks = ["movimientos", "últimos movimientos", "ver movimientos", "cartola histórica", "cartola"];
  for (const target of fallbacks) {
    const c = await nativeClick(page, [target]);
    if (c) {
      debugLog.push(`  Clicked fallback: ${c}`);
      await delay(5000);
      return;
    }
  }

  debugLog.push("  (no movement link found)");
}

async function extractFromContext(ctx: { evaluate: Page["evaluate"] }): Promise<Array<{ date: string; description: string; amount: string; balance: string }>> {
  return ctx.evaluate(() => {
    const results: Array<{ date: string; description: string; amount: string; balance: string }> = [];

    for (const table of Array.from(document.querySelectorAll("table"))) {
      const rows = Array.from(table.querySelectorAll("tr"));
      if (rows.length < 2) continue;

      let dateIndex = -1, descIndex = -1, cargoIndex = -1, abonoIndex = -1, balanceIndex = -1;
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("th, td"));
        if (cells.length < 3) continue;
        const ht = cells.map((c) => (c as HTMLElement).innerText?.trim().toLowerCase() || "");
        if (!ht.some((h) => h === "fecha" || h.startsWith("fecha"))) continue;
        dateIndex    = ht.findIndex((h) => h === "fecha" || h.startsWith("fecha"));
        descIndex    = ht.findIndex((h) => h.includes("descrip") || h.includes("detalle") || h.includes("glosa"));
        cargoIndex   = ht.findIndex((h) => h.includes("cargo") || h.includes("débito") || h.includes("debito"));
        abonoIndex   = ht.findIndex((h) => h.includes("abono") || h.includes("crédito") || h.includes("credito"));
        balanceIndex = ht.findIndex((h) => h === "saldo" || h.includes("saldo"));
        break;
      }
      if (dateIndex === -1) continue;

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td"));
        if (cells.length < 3) continue;
        const values = cells.map((c) => (c as HTMLElement).innerText?.trim() || "");
        const rawDate = values[dateIndex] || "";
        if (!/\d{1,2}[\/.\-]\d{1,2}/.test(rawDate)) continue;
        const description = descIndex >= 0 ? values[descIndex] || "" : "";
        const cargo  = cargoIndex >= 0  ? values[cargoIndex].replace(/[^\d.,]/g, "")  : "";
        const abono  = abonoIndex >= 0  ? values[abonoIndex].replace(/[^\d.,]/g, "")  : "";
        const balance = balanceIndex >= 0 ? values[balanceIndex] || "" : "";
        let amount = "";
        if (cargo) amount = "-" + cargo;
        else if (abono) amount = abono;
        if (!amount) continue;
        results.push({ date: rawDate, description, amount, balance });
      }
    }

    return results;
  }) as Promise<Array<{ date: string; description: string; amount: string; balance: string }>>;
}

async function extractMovements(page: Page): Promise<BankMovement[]> {
  const allRaw: Array<{ date: string; description: string; amount: string; balance: string }> = [];

  const contexts: Array<{ evaluate: Page["evaluate"] }> = [page];
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame()) contexts.push(frame as unknown as { evaluate: Page["evaluate"] });
  }
  for (const ctx of contexts) {
    try { allRaw.push(...(await extractFromContext(ctx))); } catch { /* detached */ }
  }

  const seen = new Set<string>();
  return allRaw
    .map((m) => {
      const amount = parseChileanAmount(m.amount);
      if (amount === 0) return null;
      return {
        date: normalizeDate(m.date),
        description: m.description,
        amount,
        balance: m.balance ? parseChileanAmount(m.balance) : 0,
        source: MOVEMENT_SOURCE.account,
      } as BankMovement;
    })
    .filter((m): m is BankMovement => {
      if (!m) return false;
      const key = `${m.date}|${m.description}|${m.amount}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function paginate(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  const all: BankMovement[] = [];
  for (let i = 0; i < 20; i++) {
    all.push(...(await extractMovements(page)));
    const urlBefore = page.url();
    const nextClicked = await page.evaluate(() => {
      for (const btn of Array.from(document.querySelectorAll("button, a, [role='button']"))) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || "";
        if (!text.includes("siguiente") && !text.includes("ver más") && !text.includes("mostrar más") && text !== "›" && text !== ">") continue;
        if ((btn as HTMLButtonElement).disabled || btn.getAttribute("aria-disabled") === "true" || btn.classList.contains("disabled")) return false;
        (btn as HTMLElement).click();
        return true;
      }
      return false;
    });
    if (!nextClicked) break;
    await delay(3000);
    const urlAfter = page.url();
    if (urlBefore !== urlAfter) { debugLog.push("  Pagination stopped: URL changed"); break; }
    debugLog.push(`  Pagination: page ${i + 2}`);
  }
  return deduplicateMovements(all);
}

// ─── Historical months (Cartola histórica via TXT) ───────────────

/**
 * Parses the fixed-width TXT format from Banco Security cartola histórica.
 * Lines starting with "2" are movement records:
 *   "2" + 10-char date (DD/MM/YYYY) + 50-char description + 9-char doc + 1-char type (C/A) + "+" + amount + balance
 * "C" = Cargo (debit → negative), "A" = Abono (credit → positive)
 */
function parseTxtMovements(txt: string): BankMovement[] {
  const movements: BankMovement[] = [];
  for (const rawLine of txt.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("2")) continue;
    const rawDate    = line.slice(1, 11).trim();
    const rawDesc    = line.slice(11, 61).trim();
    const typeChar   = line.slice(70, 71);
    const rest       = line.slice(72);
    if (!/\d{1,2}\/\d{1,2}\/\d{4}/.test(rawDate)) continue;

    const parts = rest.trim().split(/\s+/);
    if (parts.length < 1) continue;
    const rawAmount  = parts[0];
    const rawBalance = parts[1] ?? "";

    let amount = parseChileanAmount(rawAmount);
    if (amount === 0) continue;
    if (typeChar === "C") amount = -Math.abs(amount);
    else amount = Math.abs(amount);

    movements.push({
      date:        normalizeDate(rawDate),
      description: rawDesc,
      amount,
      balance:     rawBalance ? parseChileanAmount(rawBalance) : 0,
      source:      MOVEMENT_SOURCE.account,
    } as BankMovement);
  }
  return movements;
}

async function fetchHistoricalMonths(page: Page, months: number, debugLog: string[]): Promise<BankMovement[]> {
  debugLog.push(`  Fetching up to ${months} historical month(s)...`);

  const clickedProductos = await nativeClick(page, ["productos"]);
  if (clickedProductos) await delay(1500);

  const clickedCartola = await nativeClick(page, ["cartola histórica", "cartola historica"]);
  if (clickedCartola) {
    debugLog.push(`  Clicked: ${clickedCartola}`);
    await delay(3000);
  } else {
    await page.goto(CARTOLA_URL, { waitUntil: "networkidle2", timeout: 30000 });
    await delay(2000);
  }

  type FrameCtx = { evaluate: Page["evaluate"] };
  const allFrames: FrameCtx[] = [page, ...page.frames().filter(f => f !== page.mainFrame()) as unknown as FrameCtx[]];

  let cartolaFrame: FrameCtx | null = null;
  for (const ctx of allFrames) {
    const found: boolean = await ctx.evaluate(() => !!document.querySelector("#fecha")).catch(() => false);
    if (found) { cartolaFrame = ctx; break; }
  }

  if (!cartolaFrame) {
    debugLog.push("  select#fecha not found in any frame — skipping historical");
    return [];
  }

  const options: Array<{ value: string; text: string }> = await cartolaFrame.evaluate(() => {
    const sel = document.querySelector("#fecha") as HTMLSelectElement | null;
    if (!sel) return [];
    return Array.from(sel.options).map((o) => ({ value: o.value, text: o.text.trim() }));
  });
  const realOptions = options.filter(o => o.value && o.text.toLowerCase() !== "seleccionar");
  debugLog.push(`  Available months: ${realOptions.map(o => o.text).join(", ")}`);
  const historicalOptions = realOptions.slice(1);

  const all: BankMovement[] = [];
  const take = Math.min(months, historicalOptions.length);

  for (let i = 0; i < take; i++) {
    const opt = historicalOptions[i];
    debugLog.push(`  Fetching month: ${opt.text}`);

    await cartolaFrame.evaluate((val: string) => {
      const sel = document.querySelector("#fecha") as HTMLSelectElement | null;
      if (sel) sel.value = val;
    }, opt.value);
    await delay(300);

    const submitted: boolean = await cartolaFrame.evaluate(() => {
      const btn = document.querySelector("#buscar") as HTMLElement | null;
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!submitted) { debugLog.push(`  Could not click Consultar for ${opt.text}`); continue; }

    let txtHref: string | null = null;
    const deadline = Date.now() + 8000;
    while (!txtHref && Date.now() < deadline) {
      const searchContexts: FrameCtx[] = [cartolaFrame, ...page.frames().filter(f => f !== page.mainFrame()) as unknown as FrameCtx[]];
      for (const ctx of searchContexts) {
        txtHref = await ctx.evaluate(() => {
          for (const a of Array.from(document.querySelectorAll("a")) as HTMLAnchorElement[]) {
            if (a.innerText?.trim().toUpperCase() === "TXT" && (a as HTMLElement).offsetParent !== null) return a.href;
          }
          return null;
        }).catch(() => null);
        if (txtHref) break;
      }
      if (!txtHref) await delay(500);
    }

    if (!txtHref) { debugLog.push(`  No TXT link found for ${opt.text}`); continue; }

    const content: string = await cartolaFrame.evaluate(async (url: string) => {
      const r = await fetch(url, { credentials: "include" });
      return r.text();
    }, txtHref);

    const parsed = parseTxtMovements(content);
    debugLog.push(`  Parsed ${parsed.length} movements from ${opt.text}`);
    all.push(...parsed);
  }

  return all;
}

// ─── Credit cards ────────────────────────────────────────────────

const MONTHS_ES: Record<string, string> = {
  ene: "01", enero: "01",
  feb: "02", febrero: "02",
  mar: "03", marzo: "03",
  abr: "04", abril: "04",
  may: "05", mayo: "05",
  jun: "06", junio: "06",
  jul: "07", julio: "07",
  ago: "08", agosto: "08",
  sep: "09", septiembre: "09", setiembre: "09",
  oct: "10", octubre: "10",
  nov: "11", noviembre: "11",
  dic: "12", diciembre: "12",
};

function normalizeSecurityDate(raw: string): string {
  const value = raw.trim().replace(/\s+/g, " ");
  const monthName = value.match(/^(\d{1,2})[\/.\-\s]([A-Za-zÁÉÍÓÚáéíóúñÑ]+)[\/.\-\s](\d{2,4})$/);
  if (monthName) {
    const day = monthName[1].padStart(2, "0");
    const key = monthName[2].toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    const month = MONTHS_ES[key] || MONTHS_ES[key.slice(0, 3)];
    const year = monthName[3].length === 2 ? `20${monthName[3]}` : monthName[3];
    if (month) return `${day}-${month}-${year}`;
  }
  return normalizeDate(value);
}

function maskCard(raw?: string): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return undefined;
  return `****${digits.slice(-4)}`;
}

function cardOwner(card: string | undefined, primary: string | undefined): CardOwner | undefined {
  if (!card || !primary) return undefined;
  return card === primary ? CARD_OWNER.titular : CARD_OWNER.adicional;
}

function isCreditCardCredit(description: string): boolean {
  const text = description.toLowerCase();
  return (
    text.includes("abono") ||
    text.includes("cancelado") ||
    text.includes("nota de credito") ||
    text.includes("nota de crédito") ||
    text.includes("pago") ||
    text.includes("reverso") ||
    text.includes("devolucion") ||
    text.includes("devolución")
  );
}

function parseSecurityAmount(raw: string): number {
  const clean = raw.replace(/[^0-9.,-]/g, "");
  if (!clean) return 0;
  const negative = clean.startsWith("-") || raw.includes("-$") || raw.includes("$ -") || raw.includes("US -");
  const hasDecimalComma = /,\d{1,2}$/.test(clean);
  const normalized = hasDecimalComma
    ? clean.replace(/-/g, "").replace(/\./g, "").replace(",", ".")
    : clean.replace(/-/g, "").replace(/\./g, "").replace(",", "");
  const parsed = hasDecimalComma ? Number.parseFloat(normalized) : Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed === 0) return 0;
  return negative ? -parsed : parsed;
}

function signedCardAmount(rawAmount: string, description: string): number {
  const amount = Math.abs(parseSecurityAmount(rawAmount));
  if (amount === 0) return 0;
  return isCreditCardCredit(description) ? amount : -amount;
}

function normalizeInstallments(raw?: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!match) return value;
  return `${match[1].padStart(2, "0")}/${match[2].padStart(2, "0")}`;
}

function dedupeCardMovements(movements: BankMovement[]): BankMovement[] {
  const seen = new Set<string>();
  return movements.filter((m) => {
    const key = `${m.source}|${m.card ?? ""}|${m.date}|${m.description}|${m.amount}|${m.installments ?? ""}|${m.totalAmount ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function extractCardSummary(page: Page, debugLog: string[]): Promise<SecurityCardSummary | null> {
  await page.goto(SUMMARY_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(2000);

  const summary = await page.evaluate(() => {
    const redirectTarget = (onclick: string): string | undefined => {
      const match = onclick.match(/redirect\(['"]([^'"]+)['"]\)/i);
      if (!match) return undefined;
      return new URL(match[1], location.href).href;
    };

    const anchors = Array.from(document.querySelectorAll("a")) as HTMLAnchorElement[];
    const linkData = anchors.map((a) => {
      const onclick = a.getAttribute("onclick") || "";
      const href = a.href || "";
      return {
        text: a.innerText?.trim() || "",
        onclick,
        href,
        target: redirectTarget(onclick) || href,
      };
    });

    const unbilled = linkData.find((a) => /mc_mov_no_fact\.asp/i.test(`${a.target} ${a.onclick} ${a.href}`));
    const statement = linkData.find((a) => /Mc_consulta_nacional\.asp/i.test(`${a.target} ${a.onclick} ${a.href}`));
    const body = document.body?.innerText || "";
    const cardNumber = unbilled?.text || body.match(/N[°º]\s*\*+\s*(\d{4})/)?.[1] || "";
    const brand = body.match(/(Mastercard|Visa|American Express|Amex)[^\n]*/i)?.[0]?.replace(/\s+/g, " ").trim();

    return {
      cardNumber,
      brand,
      unbilledUrl: unbilled?.target,
      statementUrl: statement?.target,
    };
  });

  const card = maskCard(summary.cardNumber);
  const label = `${summary.brand || "Tarjeta de Crédito"}${card ? ` ${card}` : ""}`.trim();
  debugLog.push(`TC: Summary links found (unbilled=${summary.unbilledUrl ? "yes" : "no"}, statement=${summary.statementUrl ? "yes" : "no"})`);

  if (!summary.unbilledUrl && !summary.statementUrl && !card) return null;
  return {
    label,
    card,
    unbilledUrl: summary.unbilledUrl,
    statementUrl: summary.statementUrl,
  };
}

async function extractUnbilledMovements(page: Page, summary: SecurityCardSummary, debugLog: string[]): Promise<BankMovement[]> {
  if (!summary.unbilledUrl) return [];

  await page.goto(summary.unbilledUrl, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(1500);

  const raw = await page.evaluate(() => {
    const out: Array<{ card?: string; date: string; description: string; amount: string }> = [];
    let currentCard = "";
    for (const table of Array.from(document.querySelectorAll("table"))) {
      for (const row of Array.from(table.querySelectorAll("tr"))) {
        const cells = Array.from(row.querySelectorAll("td, th")).map((c) => (c as HTMLElement).innerText?.replace(/\s+/g, " ").trim() || "");
        if (cells.length === 0) continue;
        const only = cells.join(" ").trim();
        const cardMatch = only.match(/Tarjeta:\s*([0-9*Xx\s-]+)/i);
        if (cardMatch) {
          currentCard = cardMatch[1];
          continue;
        }
        if (cells.length < 4) continue;
        if (!/^\d{1,2}[\/.\-\s][A-Za-zÁÉÍÓÚáéíóúñÑ0-9]+[\/.\-\s]\d{2,4}$/.test(cells[0])) continue;
        const description = cells[1] || "";
        if (!description || /^total\b/i.test(description)) continue;
        out.push({ card: currentCard, date: cells[0], description, amount: cells[cells.length - 1] || "" });
      }
    }
    return out;
  });

  const movements = raw
    .map((row) => {
      const card = maskCard(row.card) || summary.card;
      const amount = signedCardAmount(row.amount, row.description);
      if (amount === 0) return null;
      return {
        date: normalizeSecurityDate(row.date),
        description: row.description,
        amount,
        balance: 0,
        source: MOVEMENT_SOURCE.credit_card_unbilled,
        ...(card && { card }),
        ...(cardOwner(card, summary.card) && { owner: cardOwner(card, summary.card) }),
      } as BankMovement;
    })
    .filter(Boolean) as BankMovement[];

  debugLog.push(`TC: Parsed ${movements.length} unbilled movement(s)`);
  return dedupeCardMovements(movements);
}

async function readStatementForms(page: Page, statementUrl: string): Promise<SecurityStatementForm[]> {
  await page.goto(statementUrl, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(1200);

  return page.evaluate(() => {
    const forms: SecurityStatementForm[] = [];
    const collect = (formName: string, selectName: string, kind: "national" | "international") => {
      const form = document.forms.namedItem(formName) as HTMLFormElement | null;
      const select = document.querySelector(`select[name="${selectName}"]`) as HTMLSelectElement | null;
      if (!form || !select) return;
      const hidden: Record<string, string> = {};
      for (const input of Array.from(form.querySelectorAll("input"))) {
        if (input.name) hidden[input.name] = input.value || "";
      }
      forms.push({
        name: formName,
        action: form.action || new URL(form.getAttribute("action") || "", location.href).href,
        selectName,
        hidden,
        options: Array.from(select.options).map((o) => ({ value: o.value, text: o.textContent?.trim() || "" })).filter((o) => o.value),
        kind,
      });
    };
    collect("Formulario", "fecha", "national");
    collect("Formularioi", "fechai", "international");
    return forms;
  });
}

async function postStatementPeriod(page: Page, form: SecurityStatementForm, option: { value: string; text: string }): Promise<string> {
  return page.evaluate(async ({ form, option }) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form.hidden)) params.set(key, value);
    params.set(form.selectName, option.value);
    const response = await fetch(form.action, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    return response.text();
  }, { form, option });
}

async function parseStatementHtml(
  page: Page,
  html: string,
  kind: "national" | "international",
  summary: SecurityCardSummary,
): Promise<{ movements: BankMovement[]; national?: CreditCardBalance["national"]; international?: CreditCardBalance["international"]; lastStatement?: CreditCardBalance["lastStatement"]; billingPeriod?: string; nextDueDate?: string }> {
  const raw = await page.evaluate(({ html, kind }) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const tableRows = Array.from(doc.querySelectorAll("table")).map((table) =>
      Array.from(table.querySelectorAll("tr")).map((row) =>
        Array.from(row.querySelectorAll("th, td")).map((cell) => (cell as HTMLElement).innerText?.replace(/\s+/g, " ").trim() || "")
      )
    );

    const movements: Array<{ date: string; description: string; amount: string; totalAmount?: string; installments?: string }> = [];
    for (const rows of tableRows) {
      const header = rows[0]?.join("|").toLowerCase() || "";
      if (kind === "national" && header.includes("fecha operación") && header.includes("descripción")) {
        for (const cells of rows.slice(1)) {
          if (cells.length < 8) continue;
          if (!/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(cells[1] || "")) continue;
          const description = cells[3] || "";
          if (!description || /^total\b/i.test(description)) continue;
          movements.push({
            date: cells[1],
            description,
            amount: cells[4] || "",
            totalAmount: cells[5] || "",
            installments: cells[6] || "",
          });
        }
      }
      if (kind === "international" && header.includes("fecha") && header.includes("descripción") && header.includes("monto")) {
        for (const cells of rows.slice(1)) {
          if (cells.length < 7) continue;
          if (!/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(cells[1] || "")) continue;
          const description = cells[2] || "";
          if (!description || /^total\b/i.test(description)) continue;
          movements.push({
            date: cells[1],
            description,
            amount: cells[cells.length - 1] || "",
          });
        }
      }
    }

    const findLabel = (pattern: RegExp): string | undefined => {
      for (const rows of tableRows) {
        for (const cells of rows) {
          for (let i = 0; i < cells.length; i++) {
            if (pattern.test(cells[i])) return cells[i + 1];
          }
        }
      }
      return undefined;
    };

    let national: { total: string; used: string; available: string } | undefined;
    let international: { total: string; used: string; available: string } | undefined;
    for (const rows of tableRows) {
      const header = rows[0]?.join("|").toLowerCase() || "";
      if (kind === "national" && header.includes("cupo total") && header.includes("cupo utilizado") && header.includes("cupo disponible")) {
        const row = rows.find((r) => (r[0] || "").toLowerCase() === "cupo total" && r.length >= 4);
        if (row) national = { total: row[1], used: row[2], available: row[3] };
      }
      if (kind === "international") {
        const total = rows.find((r) => /^cupo total$/i.test(r[0] || ""))?.[1];
        const used = rows.find((r) => /^cupo utilizado$/i.test(r[0] || ""))?.[1];
        const available = rows.find((r) => /^cupo disponible$/i.test(r[0] || ""))?.[1];
        if (total || used || available) international = { total: total || "", used: used || "", available: available || "" };
      }
    }

    return {
      movements,
      national,
      international,
      statementDate: findLabel(/Fecha Estado de Cuenta/i) || doc.body.innerText.match(/Estado de Cuenta Nacional al\s+(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1],
      dueDate: findLabel(/Pagar hasta/i),
      billedAmount: findLabel(/Monto Total Facturado a Pagar/i) || findLabel(/Monto Facturado/i),
      minimumPayment: findLabel(/Monto Mínimo a Pagar/i) || findLabel(/Pago Mínimo/i),
    };
  }, { html, kind });

  const card = summary.card;
  const movements = raw.movements
    .map((row) => {
      const amount = signedCardAmount(row.amount, row.description);
      if (amount === 0) return null;
      const totalAmount = row.totalAmount ? Math.abs(parseSecurityAmount(row.totalAmount)) : undefined;
      return {
        date: normalizeSecurityDate(row.date),
        description: row.description,
        amount,
        balance: 0,
        source: MOVEMENT_SOURCE.credit_card_billed,
        ...(card && { card }),
        ...(cardOwner(card, summary.card) && { owner: cardOwner(card, summary.card) }),
        ...(normalizeInstallments(row.installments) && { installments: normalizeInstallments(row.installments) }),
        ...(totalAmount && totalAmount !== Math.abs(amount) && { totalAmount }),
      } as BankMovement;
    })
    .filter(Boolean) as BankMovement[];

  const statementDate = raw.statementDate ? normalizeSecurityDate(raw.statementDate) : undefined;
  const dueDate = raw.dueDate ? normalizeSecurityDate(raw.dueDate) : undefined;
  const billedAmount = raw.billedAmount ? Math.abs(parseSecurityAmount(raw.billedAmount)) : undefined;
  const minimumPayment = raw.minimumPayment ? Math.abs(parseSecurityAmount(raw.minimumPayment)) : undefined;

  return {
    movements,
    national: raw.national ? {
      total: Math.abs(parseSecurityAmount(raw.national.total)),
      used: Math.abs(parseSecurityAmount(raw.national.used)),
      available: Math.abs(parseSecurityAmount(raw.national.available)),
    } : undefined,
    international: raw.international ? {
      total: Math.abs(parseSecurityAmount(raw.international.total)),
      used: Math.abs(parseSecurityAmount(raw.international.used)),
      available: Math.abs(parseSecurityAmount(raw.international.available)),
      currency: "USD",
    } : undefined,
    lastStatement: statementDate && billedAmount !== undefined && dueDate ? {
      billingDate: statementDate,
      billedAmount,
      dueDate,
      ...(minimumPayment !== undefined && { minimumPayment }),
    } : undefined,
    billingPeriod: statementDate ? monthYearLabel(statementDate) : undefined,
    nextDueDate: dueDate,
  };
}

function monthYearLabel(date: string): string {
  const [, month, year] = date.split("-");
  const names: Record<string, string> = {
    "01": "Enero", "02": "Febrero", "03": "Marzo", "04": "Abril",
    "05": "Mayo", "06": "Junio", "07": "Julio", "08": "Agosto",
    "09": "Septiembre", "10": "Octubre", "11": "Noviembre", "12": "Diciembre",
  };
  return `${names[month] || month} ${year}`;
}

async function fetchStatementData(page: Page, summary: SecurityCardSummary, debugLog: string[]): Promise<{ movements: BankMovement[]; cardPatch: Partial<CreditCardBalance> }> {
  if (!summary.statementUrl) return { movements: [], cardPatch: {} };

  const periodCount = Math.min(Math.max(parseInt(process.env.SECURITY_TC_PERIODS ?? "3", 10) || 3, 1), 24);
  const forms = await readStatementForms(page, summary.statementUrl);
  debugLog.push(`TC: Found statement forms (${forms.map(f => `${f.kind}:${f.options.length}`).join(", ")})`);

  const movements: BankMovement[] = [];
  const cardPatch: Partial<CreditCardBalance> = {};

  for (const form of forms) {
    const options = form.options.slice(0, periodCount);
    for (let i = 0; i < options.length; i++) {
      const html = await postStatementPeriod(page, form, options[i]);
      const parsed = await parseStatementHtml(page, html, form.kind, summary);
      movements.push(...parsed.movements);

      if (i === 0) {
        if (parsed.national) cardPatch.national = parsed.national;
        if (parsed.international) cardPatch.international = parsed.international;
        if (parsed.lastStatement && !cardPatch.lastStatement) cardPatch.lastStatement = parsed.lastStatement;
        if (parsed.billingPeriod && !cardPatch.billingPeriod) cardPatch.billingPeriod = parsed.billingPeriod;
        if (parsed.nextDueDate && !cardPatch.nextDueDate) cardPatch.nextDueDate = parsed.nextDueDate;
      }
      debugLog.push(`TC: Parsed ${parsed.movements.length} ${form.kind} billed movement(s) from ${options[i].text}`);
    }
  }

  return { movements: dedupeCardMovements(movements), cardPatch };
}

async function fetchCreditCards(page: Page, debugLog: string[]): Promise<CreditCardBalance[]> {
  debugLog.push("TC: Extracting credit card data from product summary...");
  const summary = await extractCardSummary(page, debugLog);
  if (!summary) return [];

  const unbilledMovements = await extractUnbilledMovements(page, summary, debugLog);
  const statementResult = await fetchStatementData(page, summary, debugLog);
  const allMovements = dedupeCardMovements([...unbilledMovements, ...statementResult.movements]);

  const cards = new Map<string, CreditCardBalance>();
  const primaryKey = summary.card || summary.label;
  cards.set(primaryKey, {
    label: summary.label,
    movements: [],
    ...statementResult.cardPatch,
  });

  for (const movement of allMovements) {
    const key = movement.card || primaryKey;
    if (!cards.has(key)) {
      cards.set(key, {
        label: `Tarjeta de Crédito ${key}`,
        movements: [],
      });
    }
    cards.get(key)!.movements!.push(movement);
  }

  for (const card of cards.values()) {
    card.movements = dedupeCardMovements(card.movements || []);
    if (!card.periodExpenses) {
      const expenses = card.movements
        .filter((m) => m.source === MOVEMENT_SOURCE.credit_card_unbilled && m.amount < 0)
        .reduce((sum, m) => sum + Math.abs(m.amount), 0);
      if (expenses > 0) card.periodExpenses = expenses;
    }
  }

  debugLog.push(`TC: Returning ${cards.size} credit card(s), ${allMovements.length} total card movement(s)`);
  return [...cards.values()];
}

// ─── Main scrape function ─────────────────────────────────────────

async function scrapeBancoSecurity(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, onProgress } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const progress = onProgress || (() => {});
  const bank = BANK_ID;

  debugLog.push("1. Navigating to Banco Security login...");
  progress("Abriendo sitio del banco...");
  await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(2000);
  await dismissBanners(page);
  await doSave(page, "01-homepage");

  debugLog.push("2. Clicking Ingresar...");
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll("a, button"))) {
      const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (text === "ingresar") { (el as HTMLElement).click(); return; }
    }
  });
  await delay(4000);
  await doSave(page, "02-login-form");

  if (!page.url().includes("wPersonasLogin")) {
    debugLog.push("  Fallback: navigating directly to login URL");
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 20000 });
    await delay(2000);
  }

  debugLog.push("3. Filling RUT...");
  progress("Ingresando RUT...");
  if (!(await fillRut(page, rut, LOGIN_SELECTORS))) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró campo de RUT", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(800);

  debugLog.push("4. Filling password...");
  if (!(await fillPassword(page, password, LOGIN_SELECTORS))) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró campo de clave", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(800);

  debugLog.push("5. Submitting login...");
  progress("Iniciando sesión...");
  const navigation = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => undefined);
  await clickSubmit(page, page, LOGIN_SELECTORS);
  await navigation;
  await delay(3000);
  await waitForDashboard(page);
  await doSave(page, "03-after-login");

  if (await detect2FA(page, TWO_FACTOR_CONFIG)) {
    await doSave(page, "03b-security-pass");
    const approved = await waitFor2FA(page, debugLog, TWO_FACTOR_CONFIG);
    if (!approved) {
      const ss = await page.screenshot({ encoding: "base64" });
      return { success: false, bank, accounts: [], error: "Timeout esperando aprobación de Security PASS.", screenshot: ss as string, debug: debugLog.join("\n") };
    }
    await delay(3000);
  }

  const loginError = await detectLoginError(page);
  if (loginError) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: `Error del banco: ${loginError}`, screenshot: ss as string, debug: debugLog.join("\n") };
  }

  const currentUrl = page.url();
  const stillOnLogin = currentUrl.includes("wPersonasLogin") || currentUrl.includes("login");
  if (stillOnLogin) {
    const visibleText = await page.evaluate(() => document.body?.innerText?.toLowerCase() || "");
    const is2FA =
      visibleText.includes("ingresa tu código") ||
      visibleText.includes("ingrese su código") ||
      visibleText.includes("segundo factor") ||
      visibleText.includes("clave dinámica");
    if (is2FA) {
      const ss = await page.screenshot({ encoding: "base64" });
      return { success: false, bank, accounts: [], error: "El banco pide Security PASS. No fue posible continuar automáticamente.", screenshot: ss as string, debug: debugLog.join("\n") };
    }
  }

  debugLog.push("6. Login OK!");
  progress("Sesión iniciada");
  await closePopups(page);

  debugLog.push("7. Navigating to cartola...");
  progress("Buscando cartola...");
  await navigateToMovements(page, debugLog);
  await doSave(page, "04-movements");

  if (await detect2FA(page, TWO_FACTOR_CONFIG)) {
    await doSave(page, "04b-security-pass-movements");
    const approved = await waitFor2FA(page, debugLog, TWO_FACTOR_CONFIG);
    if (!approved) {
      const ss = await page.screenshot({ encoding: "base64" });
      return { success: false, bank, accounts: [], error: "Timeout esperando Security PASS para acceder a movimientos.", screenshot: ss as string, debug: debugLog.join("\n") };
    }
    await delay(3000);
  }

  debugLog.push("8. Extracting movements...");
  progress("Extrayendo movimientos...");
  const currentMovements = await paginate(page, debugLog);
  debugLog.push(`9. Extracted ${currentMovements.length} current-period movements`);

  const historicalMonths = Math.min(Math.max(parseInt(process.env.SECURITY_MONTHS ?? "0", 10) || 0, 0), 24);
  let allMovements = currentMovements;
  if (historicalMonths > 0) {
    progress(`Obteniendo ${historicalMonths} mes(es) histórico(s)...`);
    const historical = await fetchHistoricalMonths(page, historicalMonths, debugLog);
    allMovements = deduplicateMovements([...currentMovements, ...historical]);
    debugLog.push(`10. Total after merging historical: ${allMovements.length} movements`);
  }

  debugLog.push("11. Extracting credit card data...");
  progress("Extrayendo tarjeta de crédito...");
  const creditCards = await fetchCreditCards(page, debugLog);

  const movements = allMovements;
  const cardMovements = creditCards.reduce((sum, card) => sum + (card.movements?.length ?? 0), 0);
  progress(`Listo — ${movements.length + cardMovements} movimientos`);
  await doSave(page, "05-final");

  let balance: number | undefined;
  if (movements.length > 0 && movements[0].balance > 0) balance = movements[0].balance;

  return {
    success: true,
    bank,
    accounts: [{ balance, movements }],
    creditCards: creditCards.length > 0 ? creditCards : undefined,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ───────────────────────────────────────────────────────

const security: BankScraper = {
  id: BANK_ID,
  name: "Banco Security",
  url: BANK_URL,
  scrape: (options) => runScraper(BANK_ID, options, {}, scrapeBancoSecurity),
};

export default security;
