import type { Frame, Page } from "puppeteer-core";
import type { BankMovement, MovementSource } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { parseChileanAmount, normalizeDate, deduplicateMovements } from "../utils.js";

type ExtractionContext = Page | Frame;

export interface RawMovement {
  date: string;
  description: string;
  amount: string;
  balance: string;
}

/**
 * Extract movements from HTML tables using header-based column detection.
 * Looks for tables with Fecha/Cargo/Abono/Saldo-style headers.
 * Falls back to card/list extraction if no tables found.
 */
export async function extractRawMovements(
  ctx: ExtractionContext,
): Promise<RawMovement[]> {
  return await ctx.evaluate(() => {
    const results: Array<{ date: string; description: string; amount: string; balance: string }> = [];

    // Strategy 1: Traditional tables
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

        const headerTexts = Array.from(headers).map(
          (h) => (h as HTMLElement).innerText?.trim().toLowerCase() || "",
        );
        if (!headerTexts.some((h) => h.includes("fecha"))) continue;

        hasHeader = true;
        dateIndex = headerTexts.findIndex((h) => h.includes("fecha"));
        descriptionIndex = headerTexts.findIndex(
          (h) => h.includes("descrip") || h.includes("detalle") || h.includes("glosa"),
        );
        cargoIndex = headerTexts.findIndex(
          (h) => h.includes("cargo") || h.includes("débito") || h.includes("debito"),
        );
        abonoIndex = headerTexts.findIndex(
          (h) => h.includes("abono") || h.includes("crédito") || h.includes("credito"),
        );
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
        if (cargoIndex >= 0 && values[cargoIndex]) {
          amount = `-${values[cargoIndex]}`;
        } else if (abonoIndex >= 0 && values[abonoIndex]) {
          amount = values[abonoIndex];
        } else if (amountIndex >= 0) {
          amount = values[amountIndex] || "";
        }

        const balance = balanceIndex >= 0 ? (values[balanceIndex] || "") : "";
        if (!amount) continue;

        results.push({ date, description, amount, balance });
      }
    }

    // Strategy 2: Card/list components
    if (results.length === 0) {
      const cards = document.querySelectorAll(
        "[class*='mov'], [class*='tran'], li, article, section",
      );
      for (const card of cards) {
        const text = (card as HTMLElement).innerText || "";
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
        if (lines.length < 3 || lines.length > 10) continue;

        const date = lines.find((l) => /\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/.test(l));
        const amount = lines.find((l) => /[$]\s*[\d.]+/.test(l));
        if (!date || !amount) continue;

        const description =
          lines.find((l) => l !== date && l !== amount && l.length > 3) || "";
        const balance =
          lines.find(
            (l) => l.toLowerCase().includes("saldo") && /[$]\s*[\d.]+/.test(l),
          ) || "";

        const normalizedAmount =
          text.toLowerCase().includes("cargo") ||
          text.toLowerCase().includes("débito") ||
          text.toLowerCase().includes("debito") ||
          amount.includes("-")
            ? `-${amount}`
            : amount;

        results.push({ date, description, amount: normalizedAmount, balance });
      }
    }

    return results;
  });
}

/** Parse raw extracted data into typed BankMovement objects */
export function parseRawMovements(
  raw: RawMovement[],
  source: MovementSource,
): BankMovement[] {
  const parsed = raw
    .map((m) => {
      const amount = parseChileanAmount(m.amount);
      if (amount === 0) return null;
      const balance = m.balance ? parseChileanAmount(m.balance) : 0;
      return {
        date: normalizeDate(m.date),
        description: m.description,
        amount,
        balance,
        source,
      } as BankMovement;
    })
    .filter(Boolean) as BankMovement[];

  return deduplicateMovements(parsed);
}

/** Extract account movements (table + card strategies) and return typed results */
export async function extractAccountMovements(
  ctx: ExtractionContext,
): Promise<BankMovement[]> {
  const raw = await extractRawMovements(ctx);
  return parseRawMovements(raw, MOVEMENT_SOURCE.account);
}
