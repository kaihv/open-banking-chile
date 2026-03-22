import type { Page } from "puppeteer-core";
import type { BankMovement } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { parseChileanAmount, normalizeDate, deduplicateMovements, delay } from "../utils.js";

type TcTab = "unbilled" | "billed";

function isSaldoInicial(description: string): boolean {
  return /saldo\s+inicial/i.test(description);
}

function isCreditCardCredit(description: string): boolean {
  const text = description.toLowerCase();
  return (
    text.includes("abono") ||
    text.includes("cancelado") ||
    text.includes("nota de credito") ||
    text.includes("nota de crédito") ||
    text.includes("reverso") ||
    /^pago\b/.test(text)
  );
}

/** Click a TC tab by matching text content */
export async function clickTcTab(
  page: Page,
  tabText: string,
  delayMs = 3000,
): Promise<boolean> {
  const clicked = await page.evaluate((text: string) => {
    const items = Array.from(document.querySelectorAll("button, a, div, span"));
    for (const item of items) {
      const content = (item as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (content !== text) continue;
      (item as HTMLElement).click();
      return true;
    }
    return false;
  }, tabText);

  if (!clicked) return false;
  await delay(delayMs);
  return true;
}

/**
 * Extract credit card movements from a table with Fecha/Detalle/Monto headers.
 * Determines sign based on cargo/abono columns or description heuristics.
 */
export async function extractCreditCardMovements(
  page: Page,
  tab: TcTab,
): Promise<BankMovement[]> {
  const raw = await page.evaluate(() => {
    const table = Array.from(document.querySelectorAll("table")).find((t) => {
      const headerText = Array.from(t.querySelectorAll("th"))
        .map((th) => (th as HTMLElement).innerText?.trim().toLowerCase() || "")
        .join("|");
      return headerText.includes("fecha") && headerText.includes("detalle") && headerText.includes("monto");
    });
    if (!table) return [];

    const headers = Array.from(table.querySelectorAll("th")).map(
      (th) => (th as HTMLElement).innerText?.trim().toLowerCase() || "",
    );
    const dateIndex = headers.findIndex((h) => h.includes("fecha"));
    const detailIndex = headers.findIndex(
      (h) => h.includes("detalle") || h.includes("descrip") || h.includes("glosa"),
    );
    const cargoIndex = headers.findIndex((h) => h.includes("cargo"));
    const abonoIndex = headers.findIndex((h) => h.includes("abono"));
    const amountIndex = headers.findIndex((h) => h === "monto" || h.includes("importe"));

    const rows = Array.from(table.querySelectorAll("tbody tr"));
    let lastDate = "";
    const out: Array<{ date: string; description: string; amount: string }> = [];

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td")).map(
        (td) => (td as HTMLElement).innerText?.trim() || "",
      );
      if (cells.length < 2) continue;

      const rawDate = dateIndex >= 0 ? (cells[dateIndex] || "") : "";
      const hasDate = /^\d{1,2}[\/.\-]\d{1,2}([\/.\-]\d{2,4})?$/.test(rawDate);
      const date = hasDate ? rawDate : lastDate;
      if (!date) continue;
      if (hasDate) lastDate = rawDate;

      const description = detailIndex >= 0 ? (cells[detailIndex] || "") : "";
      if (isSaldoInicial(description)) continue;

      let amount = "";
      if (cargoIndex >= 0 && cells[cargoIndex]) {
        amount = `-${cells[cargoIndex]}`;
      } else if (abonoIndex >= 0 && cells[abonoIndex]) {
        amount = cells[abonoIndex];
      } else if (amountIndex >= 0 && cells[amountIndex]) {
        amount = cells[amountIndex];
      }

      if (!description || !amount) continue;
      out.push({ date, description, amount });
    }

    return out;
  });

  const source =
    tab === "unbilled"
      ? MOVEMENT_SOURCE.credit_card_unbilled
      : MOVEMENT_SOURCE.credit_card_billed;

  const movements = raw
    .map((row) => {
      const absAmount = Math.abs(parseChileanAmount(row.amount));
      if (absAmount === 0) return null;

      let amount = absAmount;
      if (row.amount.includes("-")) {
        amount = -absAmount;
      } else if (row.amount.includes("+")) {
        amount = absAmount;
      } else {
        amount = isCreditCardCredit(row.description) ? absAmount : -absAmount;
      }

      return {
        date: normalizeDate(row.date),
        description: row.description.trim(),
        amount,
        balance: 0,
        source,
      } as BankMovement;
    })
    .filter(Boolean) as BankMovement[];

  return deduplicateMovements(movements);
}
