import type { Page } from "puppeteer-core";
import type {
  AccountBalance,
  BankMovement,
  BankScraper,
  CreditCardBalance,
  ScrapeResult,
  ScraperOptions,
} from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, parseChileanAmount, normalizeDate, deduplicateMovements } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { fillRut, fillPassword, detectLoginError } from "../actions/login.js";
import { dismissBanners } from "../actions/navigation.js";

// ─── Constants ────────────────────────────────────────────────────

const BANK_URL = "https://www.bancosecurity.cl";
const LOGIN_URL = "https://www.bancosecurity.cl/widgets/wPersonasLogin/index.asp";

const LOGIN_SELECTORS = {
  rutSelectors: ["#frut", 'input[name="frut"]'],
  passwordSelectors: ["#clave", 'input[name="clave"]'],
  // Portal expects formatted RUT: "12.345.678-9"
  rutFormat: "formatted" as const,
};

const NAV_TIMEOUT_MS = 15000;
const NAV_FALLBACK_MS = 20000;

// ─── Helpers ─────────────────────────────────────────────────────

async function waitForDashboard(page: Page): Promise<void> {
  const start = Date.now();
  const keywords = ["cartola", "movimientos", "cuenta corriente", "mi cuenta", "saldo", "bienvenido"];
  while (Date.now() - start < 20000) {
    const found = await page.evaluate((kws: string[]) => {
      const text = document.body?.innerText?.toLowerCase() || "";
      return kws.some((k) => text.includes(k));
    }, keywords);
    if (found) break;
    await delay(1500);
  }
}

/**
 * Wraps `page.goto` / form-submit to wait for the resulting page navigation
 * to settle, with a fallback timeout. Prevents "Execution context destroyed"
 * errors that occur when the next evaluate() runs before the new page loads.
 */
async function waitForNavigationSafe(page: Page, debugLog: string[]): Promise<void> {
  try {
    await Promise.race([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS }),
      delay(NAV_FALLBACK_MS),
    ]);
  } catch (err) {
    debugLog.push(`  Navigation warning: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Finds an element by visible text and clicks it with Puppeteer's native click (triggers real browser events). */
async function nativeClick(page: Page, texts: string[], selectors = "a, button, li, span, [role='menuitem']"): Promise<string | null> {
  // First locate the element and get its bounding box
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
  // Navigate directly if it's a link, otherwise use native mouse click
  if (result.href && !result.href.startsWith("javascript")) {
    await page.goto(result.href, { waitUntil: "networkidle2", timeout: 30000 });
  } else {
    await page.mouse.click(result.x, result.y);
  }
  return result.text;
}

async function navigateToMovements(page: Page, debugLog: string[]): Promise<void> {
  await waitForDashboard(page);

  // Step 1: open "Productos" in top nav (native click to trigger hover/dropdown)
  const clickedProductos = await nativeClick(page, ["productos"]);
  if (clickedProductos) {
    debugLog.push(`  Clicked: ${clickedProductos}`);
    await delay(1500);
  }

  // Step 2: click "Saldos y movimientos" (under Cuenta Corriente in the dropdown)
  const clicked = await nativeClick(page, ["saldos y movimientos"]);
  if (clicked) {
    debugLog.push(`  Clicked: ${clicked}`);
    await delay(5000);
    return;
  }

  // Fallback: try other movement-related links
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

      // Accept headers in <th> OR <td> (Banco Security uses <td> for headers)
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
        if (cargo)       amount = "-" + cargo;
        else if (abono)  amount = abono;
        if (!amount) continue;
        results.push({ date: rawDate, description, amount, balance });
      }
    }

    return results;
  }) as Promise<Array<{ date: string; description: string; amount: string; balance: string }>>;
}

async function extractMovements(page: Page): Promise<BankMovement[]> {
  const allRaw: Array<{ date: string; description: string; amount: string; balance: string }> = [];

  // Search main frame + all iframes (movements table is often in an iframe)
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

// ─── Credit-card extraction ──────────────────────────────────────

/**
 * Build a default card label from a card number / mask. Returns the last 4 digits
 * prefixed by `****`, or a placeholder if nothing usable is found.
 */
function defaultCardLabel(last4: string | null): string {
  return last4 ? `Tarjeta ****${last4}` : "Tarjeta Banco Security";
}

/**
 * Open "Productos" → "Tarjetas de Crédito" from the dashboard. Returns true if
 * the click was successful and we appear to be on the TC section.
 */
async function navigateToCreditCards(page: Page, debugLog: string[]): Promise<boolean> {
  await waitForDashboard(page);

  const clickedProductos = await nativeClick(page, ["productos"]);
  if (clickedProductos) {
    debugLog.push(`  TC nav: clicked ${clickedProductos}`);
    await delay(1500);
  }

  const targets = [
    "tarjetas de crédito",
    "tarjetas de credito",
    "mis tarjetas",
    "tarjetas",
  ];
  for (const target of targets) {
    const clicked = await nativeClick(page, [target]);
    if (clicked) {
      debugLog.push(`  TC nav: clicked ${clicked}`);
      await delay(4000);
      return true;
    }
  }
  debugLog.push("  TC nav: no link found");
  return false;
}

/**
 * Parse the "label" + last-4 digits of a credit card from the surrounding text.
 * Examples we try to match:
 *   "Mastercard Black ****5824"
 *   "Visa Platinum 1234"
 */
function extractCreditCardLabel(text: string): { label: string; last4: string | null } {
  const clean = text.replace(/\s+/g, " ").trim();
  // Match "****NNNN" (preferred) or "NNNN" at end of a 12-19 digit number
  const masked = clean.match(/\*{2,4}\s*(\d{4})/);
  if (masked) {
    return { label: clean.slice(0, masked.index! + masked[0].length).trim() || defaultCardLabel(masked[1]), last4: masked[1] };
  }
  const long = clean.match(/\b(\d{4})\s*$/);
  if (long) {
    return { label: clean, last4: long[1] };
  }
  return { label: clean, last4: null };
}

/**
 * Extract credit-card movements from the current page (main frame + iframes).
 * Detects tabs/sections like "No facturados" vs "Facturados" by looking at
 * visible headers; falls back to one combined list.
 */
async function extractCreditCardMovements(
  page: Page,
  source: "credit_card_unbilled" | "credit_card_billed",
  debugLog: string[],
): Promise<BankMovement[]> {
  const raw = await page.evaluate((srcKind: string) => {
    const isUnbilled = srcKind === "credit_card_unbilled";
    const tableHeaderHints = isUnbilled
      ? ["no facturad", "consumos", "saldo actual", "movimientos"]
      : ["facturad", "estado de cuenta", "periodo", "movimientos"];

    const tables = Array.from(document.querySelectorAll("table"));
    const results: Array<{ date: string; description: string; amount: string; cuota: string; total: string }> = [];

    for (const table of tables) {
      const headerCells = Array.from(table.querySelectorAll("th, td"))
        .slice(0, 8)
        .map((c) => (c as HTMLElement).innerText?.trim().toLowerCase() || "");
      const headerJoined = headerCells.join("|");
      if (!tableHeaderHints.some((h) => headerJoined.includes(h))) continue;
      if (!(headerJoined.includes("fecha") || headerJoined.includes("movimiento"))) continue;

      const dateIdx = headerCells.findIndex((h) => h.includes("fecha"));
      const descIdx = headerCells.findIndex(
        (h) => h.includes("descrip") || h.includes("detalle") || h.includes("glosa") || h.includes("comercio"),
      );
      const amountIdx = headerCells.findIndex(
        (h) => h === "monto" || h.includes("importe") || h.includes("monto $") || h.includes("cargo") || h.includes("abono"),
      );
      const cuotaIdx = headerCells.findIndex(
        (h) => h.includes("cuota") || h.includes("cuotas") || h === "n/n" || h === "n°/n°",
      );
      const totalIdx = headerCells.findIndex(
        (h) => h.includes("total") && !h.includes("cupo"),
      );

      const rows = Array.from(table.querySelectorAll("tbody tr, tr")).filter(
        (r) => r.querySelectorAll("td").length >= 3,
      );
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td")).map(
          (c) => (c as HTMLElement).innerText?.trim() || "",
        );
        if (cells.length < 2) continue;
        const date = dateIdx >= 0 ? (cells[dateIdx] || "") : "";
        if (!/\d{1,2}[\/.\-]\d{1,2}/.test(date)) continue;
        const description = descIdx >= 0 ? (cells[descIdx] || "") : "";
        const amount = amountIdx >= 0 ? (cells[amountIdx] || "") : "";
        if (!description || !amount) continue;
        const cuota = cuotaIdx >= 0 ? (cells[cuotaIdx] || "") : "";
        const total = totalIdx >= 0 ? (cells[totalIdx] || "") : "";
        results.push({ date, description, amount, cuota, total });
      }
    }
    return results;
  }, source);

  const movements = raw
    .map((row) => {
      const amt = parseChileanAmount(row.amount);
      if (amt === 0) return null;
      const isNegative = /-\s*\d/.test(row.amount) || /cargo|débito|debito/i.test(row.description);

      // Installments: prefer a dedicated "cuota" column ("02/06"), fall back
      // to a "NN/NN" pattern embedded in the description.
      let installments: string | undefined;
      const cuotaMatch = (row.cuota || "").match(/(\d{1,2}\s*\/\s*\d{1,2})/);
      if (cuotaMatch) {
        installments = cuotaMatch[1].replace(/\s+/g, "");
      } else {
        const descMatch = row.description.match(/(\d{1,2}\s*\/\s*\d{1,2})/);
        if (descMatch) installments = descMatch[1].replace(/\s+/g, "");
      }

      // totalAmount: explicit column wins; otherwise if installments look like
      // "02/06" we can compute it as amount * 6.
      let totalAmount: number | undefined;
      if (row.total) totalAmount = parseChileanAmount(row.total) || undefined;
      if (totalAmount === undefined && installments) {
        const m = installments.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
        if (m) {
          const total = parseInt(m[2], 10);
          if (total > 0) totalAmount = Math.abs(amt) * total;
        }
      }

      return {
        date: normalizeDate(row.date),
        description: row.description.trim(),
        amount: isNegative ? -Math.abs(amt) : Math.abs(amt),
        balance: 0,
        source,
        ...(installments ? { installments } : {}),
        ...(totalAmount !== undefined ? { totalAmount } : {}),
      } as BankMovement;
    })
    .filter((m): m is BankMovement => m !== null);

  debugLog.push(`  TC ${source}: ${movements.length} raw`);
  return deduplicateMovements(movements);
}

/**
 * Try to parse cupo (national / international) + billing dates from visible
 * page text. Returns the values that could be extracted; missing values stay
 * `undefined` so the caller can decide what to do.
 */
async function extractCardBalance(
  page: Page,
  debugLog: string[],
): Promise<{
  national?: { used: number; available: number; total: number };
  international?: { used: number; available: number; total: number; currency: string };
  nextBillingDate?: string;
  nextDueDate?: string;
  periodExpenses?: number;
}> {
  const text = (await page.evaluate(() => document.body?.innerText || "")).toLowerCase();

  function matchAmount(re: RegExp): number {
    const m = text.match(re);
    if (!m) return 0;
    return parseChileanAmount(m[1]);
  }

  // Nacional: "cupo nacional", or generic "cupo utilizado / disponible / total"
  const natUsed = matchAmount(/utilizado[^0-9$]*\$?\s*([\d.]+(?:[.,]\d+)?)/i);
  const natAvail = matchAmount(/disponible[^0-9$]*\$?\s*([\d.]+(?:[.,]\d+)?)/i);
  const natTotal = matchAmount(/cupo total[^0-9$]*\$?\s*([\d.]+(?:[.,]\d+)?)/i)
    || matchAmount(/total[^0-9$]*\$?\s*([\d.]+(?:[.,]\d+)?)/i);

  const nat: { used: number; available: number; total: number } | undefined =
    natUsed > 0 || natAvail > 0 || natTotal > 0
      ? { used: natUsed, available: natAvail, total: natTotal }
      : undefined;
  if (nat) debugLog.push(`  Cupo nacional: usado=${nat.used} disp=${nat.available} total=${nat.total}`);

  // Internacional: look for USD/UF/US$ prefix
  const intlUsed = matchAmount(/utilizado[^0-9$]*(?:usd|us\$|uf)\s*\$?\s*([\d.,]+)/i);
  const intlAvail = matchAmount(/disponible[^0-9$]*(?:usd|us\$|uf)\s*\$?\s*([\d.,]+)/i);
  const intlTotal = matchAmount(/cupo total[^0-9$]*(?:usd|us\$|uf)\s*\$?\s*([\d.,]+)/i);

  const intl = intlUsed > 0 || intlAvail > 0 || intlTotal > 0
    ? { used: intlUsed, available: intlAvail, total: intlTotal, currency: "USD" }
    : undefined;
  if (intl) debugLog.push(`  Cupo internacional: usado=${intl.used} disp=${intl.available} total=${intl.total} ${intl.currency}`);

  // Billing dates
  const nextBillingMatch = text.match(/pr[oó]xima\s+facturaci[oó]n[\s\S]{0,40}?(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i);
  const nextDueMatch = text.match(/pr[oó]ximo\s+vencimiento[\s\S]{0,40}?(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i);

  const nextBillingDate = nextBillingMatch ? normalizeDate(nextBillingMatch[1]) : undefined;
  const nextDueDate = nextDueMatch ? normalizeDate(nextDueMatch[1]) : undefined;
  if (nextBillingDate) debugLog.push(`  Next billing: ${nextBillingDate}`);
  if (nextDueDate) debugLog.push(`  Next due: ${nextDueDate}`);

  // Period expenses: "gastos del período" or "total consumos" or "saldo actual"
  const periodExpensesMatch = text.match(/(?:gastos\s+del\s+per[ií]odo|total\s+consumos|saldo\s+actual)[^0-9$]*\$?\s*([\d.]+(?:[.,]\d+)?)/i);
  const periodExpenses = periodExpensesMatch ? parseChileanAmount(periodExpensesMatch[1]) : undefined;
  if (periodExpenses !== undefined) debugLog.push(`  Period expenses: ${periodExpenses}`);

  return {
    national: nat,
    international: intl,
    nextBillingDate,
    nextDueDate,
    periodExpenses,
  };
}

/**
 * Owner extraction — Banco Security typically labels "Titular" vs "Adicional"
 * in the card detail section. Returns "titular" | "adicional" | undefined.
 */
async function extractOwner(page: Page): Promise<BankMovement["owner"] | undefined> {
  const text = (await page.evaluate(() => document.body?.innerText || "")).toLowerCase();
  if (/\badicional\b/.test(text)) return "adicional";
  if (/\btitular\b/.test(text)) return "titular";
  return undefined;
}

/**
 * Whole TC pipeline: navigate to credit card section, extract all visible
 * cards (movements + balance + dates). Returns an empty array if the user
 * has no cards or the navigation failed.
 */
async function fetchCreditCardData(page: Page, debugLog: string[]): Promise<CreditCardBalance[]> {
  const cards: CreditCardBalance[] = [];

  const navigated = await navigateToCreditCards(page, debugLog);
  if (!navigated) {
    debugLog.push("  TC: could not navigate to credit card section");
    return cards;
  }

  // Look for a card-selector (multi-card case)
  const cardOptions: Array<{ label: string; last4: string | null }> = await page
    .evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      for (const sel of selects) {
        const options = Array.from(sel.options || []);
        const matches = options.filter((o) => /\*{2,4}\d{2,4}|\b\d{4}\b/.test(o.text || ""));
        if (matches.length >= 1) {
          return matches.map((o) => ({ label: o.text?.trim() || "", value: o.value }));
        }
      }
      return [];
    })
    .catch(() => [] as Array<{ label: string; value: string }>)
    .then((opts) => opts.map((o) => extractCreditCardLabel(o.label)));

  // If we didn't find a selector, treat the visible card as the only one
  const cardList: Array<{ label: string; last4: string | null }> =
    cardOptions.length > 0
      ? cardOptions
      : [extractCreditCardLabel("Tarjeta Banco Security")];

  for (const cardMeta of cardList) {
    debugLog.push(`  TC card: ${cardMeta.label}`);

    if (cardOptions.length > 0) {
      // Re-select the option in the dropdown to switch card
      const switched = await page
        .evaluate((lbl: string) => {
          const selects = Array.from(document.querySelectorAll("select"));
          for (const sel of selects) {
            const opts = Array.from(sel.options || []);
            const match = opts.find((o) => (o.text || "").trim() === lbl);
            if (match) {
              (sel as HTMLSelectElement).value = match.value;
              sel.dispatchEvent(new Event("change", { bubbles: true }));
              return true;
            }
          }
          return false;
        }, cardMeta.label)
        .catch(() => false);
      if (switched) await delay(2500);
    }

    const [unbilled, billed, balance, owner] = await Promise.all([
      extractCreditCardMovements(page, MOVEMENT_SOURCE.credit_card_unbilled, debugLog),
      extractCreditCardMovements(page, MOVEMENT_SOURCE.credit_card_billed, debugLog),
      extractCardBalance(page, debugLog),
      extractOwner(page),
    ]);

    const movements = deduplicateMovements([...unbilled, ...billed]).map((m) => ({
      ...m,
      card: cardMeta.last4 ? `****${cardMeta.last4}` : cardMeta.label,
      ...(owner ? { owner } : {}),
    }));

    const card: CreditCardBalance = {
      label: cardMeta.label,
      ...(balance.national ? { national: balance.national } : {}),
      ...(balance.international ? { international: balance.international } : {}),
      ...(balance.nextBillingDate ? { nextBillingDate: balance.nextBillingDate } : {}),
      ...(balance.nextDueDate ? { nextDueDate: balance.nextDueDate } : {}),
      ...(balance.periodExpenses !== undefined ? { periodExpenses: balance.periodExpenses } : {}),
      movements,
    };
    cards.push(card);
  }

  return cards;
}

// ─── Historical months (Cartola histórica via TXT) ───────────────

const CARTOLA_URL = "https://www.bancosecurity.cl/Empresas/Cuentas/cartola_corriente.asp";

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
    // date: chars 1-10, desc: 11-60, doc: 61-69, type: 70, "+": 71, rest: amounts
    const rawDate    = line.slice(1, 11).trim();     // "DD/MM/YYYY"
    const rawDesc    = line.slice(11, 61).trim();
    const typeChar   = line.slice(70, 71);            // "C" or "A"
    const rest       = line.slice(72);                // "+       48000,00    16588418,00"
    if (!/\d{1,2}\/\d{1,2}\/\d{4}/.test(rawDate)) continue;

    // rest contains two Chilean amounts separated by whitespace
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

/**
 * Navigates to Cartola histórica, reads the month select options,
 * and fetches TXT content for up to `months` historical periods.
 */
async function fetchHistoricalMonths(page: Page, months: number, debugLog: string[]): Promise<BankMovement[]> {
  debugLog.push(`  Fetching up to ${months} historical month(s)...`);

  // Navigate to Cartola histórica via the Productos menu
  const clickedProductos = await nativeClick(page, ["productos"]);
  if (clickedProductos) await delay(1500);

  const clickedCartola = await nativeClick(page, ["cartola histórica", "cartola historica"]);
  if (clickedCartola) {
    debugLog.push(`  Clicked: ${clickedCartola}`);
    await delay(3000);
  } else {
    // Direct navigation as fallback
    await page.goto(CARTOLA_URL, { waitUntil: "networkidle2", timeout: 30000 });
    await delay(2000);
  }

  // Find the frame containing select#fecha (content may be in an iframe)
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

  // Read available month options from select#fecha
  const options: Array<{ value: string; text: string }> = await cartolaFrame.evaluate(() => {
    const sel = document.querySelector("#fecha") as HTMLSelectElement | null;
    if (!sel) return [];
    return Array.from(sel.options).map((o) => ({ value: o.value, text: o.text.trim() }));
  });
  // Skip placeholder "Seleccionar" and any option with no meaningful value
  const realOptions = options.filter(o => o.value && o.text.toLowerCase() !== "seleccionar");
  debugLog.push(`  Available months: ${realOptions.map(o => o.text).join(", ")}`);

  const all: BankMovement[] = [];
  const take = Math.min(months, realOptions.length);

  for (let i = 0; i < take; i++) {
    const opt = realOptions[i];
    debugLog.push(`  Fetching month: ${opt.text}`);

    // Set select value and click Consultar (in the same frame)
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

    // Poll for TXT link up to 8s instead of a fixed delay
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

// ─── Main scrape function ─────────────────────────────────────────

async function scrapeBancoSecurity(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, onProgress } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const progress = onProgress || (() => {});
  const bank = "bancosecurity";

  // 1. Navigate to login
  debugLog.push("1. Navigating to Banco Security login...");
  progress("Abriendo sitio del banco...");
  await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(2000);
  await dismissBanners(page);
  await doSave(page, "01-homepage");

  // Click "Ingresar" to load the login widget
  debugLog.push("2. Clicking Ingresar...");
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll("a, button"))) {
      const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (text === "ingresar") { (el as HTMLElement).click(); return; }
    }
  });
  await delay(4000);
  await doSave(page, "02-login-form");

  // If click didn't navigate, go directly
  if (!page.url().includes("wPersonasLogin")) {
    debugLog.push("  Fallback: navigating directly to login URL");
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 20000 });
    await delay(2000);
  }

  // 3. Fill RUT
  debugLog.push("3. Filling RUT...");
  progress("Ingresando RUT...");
  if (!(await fillRut(page, rut, LOGIN_SELECTORS))) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró campo de RUT", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(800);

  // 4. Fill password
  debugLog.push("4. Filling password...");
  if (!(await fillPassword(page, password, LOGIN_SELECTORS))) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró campo de clave", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(800);

  // 5. Submit — then wait for the post-submit navigation to settle
  //    (this is the fix for the "Execution context destroyed" bug: the form
  //    submit triggers a navigation; the next evaluate() ran on the old page)
  debugLog.push("5. Submitting login...");
  progress("Iniciando sesión...");
  const submitted = await page.evaluate(() => {
    const btn = document.querySelector('input[type="submit"], button[type="submit"]') as HTMLElement | null;
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!submitted) await page.keyboard.press("Enter");

  // Critical: wait for the navigation triggered by submit to settle before
  // calling waitForDashboard(). Race against a long timeout fallback so that
  // networks where the page is already loaded don't deadlock.
  try {
    await Promise.race([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS }),
      delay(NAV_FALLBACK_MS),
    ]);
  } catch (err) {
    debugLog.push(`  Navigation warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  await waitForDashboard(page);
  await doSave(page, "03-after-login");

  // 6. Validate login
  const loginError = await detectLoginError(page);
  if (loginError) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: `Error del banco: ${loginError}`, screenshot: ss as string, debug: debugLog.join("\n") };
  }

  // Check if we're still on the login page (login failed) vs on the dashboard (login OK)
  const currentUrl = page.url();
  const stillOnLogin = currentUrl.includes("wPersonasLogin") || currentUrl.includes("login");
  if (stillOnLogin) {
    // Only now check visible page text for 2FA prompts
    const visibleText = await page.evaluate(() => document.body?.innerText?.toLowerCase() || "");
    const is2FA =
      visibleText.includes("ingresa tu código") ||
      visibleText.includes("ingrese su código") ||
      visibleText.includes("segundo factor") ||
      visibleText.includes("clave dinámica");
    if (is2FA) {
      const ss = await page.screenshot({ encoding: "base64" });
      return { success: false, bank, accounts: [], error: "El banco pide 2FA. No automatizable.", screenshot: ss as string, debug: debugLog.join("\n") };
    }
  }

  debugLog.push("6. Login OK!");
  progress("Sesión iniciada");
  await closePopups(page);

  // 7. Navigate to cartola
  debugLog.push("7. Navigating to cartola...");
  progress("Buscando cartola...");
  await navigateToMovements(page, debugLog);
  await doSave(page, "04-movements");

  // 8. Extract movements
  debugLog.push("8. Extracting movements...");
  progress("Extrayendo movimientos...");
  const currentMovements = await paginate(page, debugLog);
  debugLog.push(`9. Extracted ${currentMovements.length} current-period movements`);

  // Historical months via Cartola histórica (TXT format)
  const historicalMonths = Math.min(Math.max(parseInt(process.env.BANCOSECURITY_MONTHS ?? "0", 10) || 0, 0), 24);
  let allMovements = currentMovements;
  if (historicalMonths > 0) {
    progress(`Obteniendo ${historicalMonths} mes(es) histórico(s)...`);
    const historical = await fetchHistoricalMonths(page, historicalMonths, debugLog);
    allMovements = deduplicateMovements([...currentMovements, ...historical]);
    debugLog.push(`10. Total after merging historical: ${allMovements.length} movements`);
  }

  // 11. Credit card extraction
  debugLog.push("11. Extracting credit cards...");
  progress("Extrayendo tarjetas de crédito...");
  const creditCards = await fetchCreditCardData(page, debugLog);
  // Tag credit card movements back into `allMovements` (deduped)
  for (const card of creditCards) {
    if (card.movements && card.movements.length > 0) {
      allMovements = deduplicateMovements([...allMovements, ...card.movements]);
    }
  }
  const accountMovements = deduplicateMovements(
    allMovements.filter((m) => m.source === MOVEMENT_SOURCE.account),
  );

  progress(`Listo — ${accountMovements.length} movimientos de cuenta, ${creditCards.length} tarjeta(s)`);
  await doSave(page, "05-final");

  // Pick the balance from the first movement that has one (typically the
  // most recent). If none do, leave the field undefined.
  let balance: number | undefined;
  for (const m of accountMovements) {
    if (m.balance > 0) { balance = m.balance; break; }
  }

  const accounts: AccountBalance[] = [
    {
      label: "Cuenta Corriente",
      balance,
      movements: accountMovements,
    },
  ];

  return {
    success: true,
    bank,
    accounts,
    creditCards: creditCards.length > 0 ? creditCards : undefined,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ───────────────────────────────────────────────────────

const bancosecurity: BankScraper = {
  id: "bancosecurity",
  name: "Banco Security",
  url: BANK_URL,
  scrape: (options) => runScraper("bancosecurity", options, {}, scrapeBancoSecurity),
};

export default bancosecurity;
