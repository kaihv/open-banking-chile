import type { Page } from "puppeteer-core";
import { delay, deduplicateMovements } from "../utils.js";
import type { BankMovement } from "../types.js";

export interface PaginationConfig {
  /** Max pages to iterate (default 25) */
  maxPages?: number;
  /** Delay after clicking next (default 2500ms) */
  delayMs?: number;
  /** Custom next-button text patterns */
  nextTexts?: string[];
}

const DEFAULT_NEXT_TEXTS = ["siguiente", "ver más", "mostrar más"];

async function clickNext(page: Page, texts: string[]): Promise<boolean> {
  return await page.evaluate((txts: string[]) => {
    const candidates = Array.from(document.querySelectorAll("button, a"));
    for (const candidate of candidates) {
      const text = (candidate as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (!text) continue;
      if (!txts.some((t) => text.includes(t))) continue;

      const disabled =
        (candidate as HTMLButtonElement).disabled ||
        candidate.getAttribute("aria-disabled") === "true" ||
        candidate.classList.contains("disabled");
      if (disabled) return false;

      (candidate as HTMLElement).click();
      return true;
    }
    return false;
  }, texts);
}

/**
 * Paginate through movement pages, extracting data from each.
 * Calls extractFn on each page and accumulates results.
 */
export async function paginateAndExtract(
  page: Page,
  extractFn: (page: Page) => Promise<BankMovement[]>,
  debugLog: string[],
  config?: PaginationConfig,
): Promise<BankMovement[]> {
  const maxPages = config?.maxPages ?? 25;
  const delayMs = config?.delayMs ?? 2500;
  const texts = config?.nextTexts ?? DEFAULT_NEXT_TEXTS;
  const allMovements: BankMovement[] = [];

  for (let i = 0; i < maxPages; i++) {
    const movements = await extractFn(page);
    allMovements.push(...movements);

    const nextClicked = await clickNext(page, texts);
    if (!nextClicked) break;

    debugLog.push(`  Pagination: loaded page ${i + 2}`);
    await delay(delayMs);
  }

  return deduplicateMovements(allMovements);
}
