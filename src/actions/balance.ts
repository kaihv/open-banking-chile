import type { Page } from "puppeteer-core";

/** Default regex patterns to find balance text on page */
const DEFAULT_PATTERNS = [
  /saldo disponible[^\d$-]*\$\s*([\d.]+)/i,
  /saldo actual[^\d$-]*\$\s*([\d.]+)/i,
  /saldo cuenta[^\d$-]*\$\s*([\d.]+)/i,
  /cuenta corriente[\s\S]{0,80}\$\s*([\d.]+)/i,
  /cuenta vista[\s\S]{0,80}\$\s*([\d.]+)/i,
];

/** Default element selectors to find balance values */
const DEFAULT_SELECTORS = [
  '[class*="amount"]',
  '[class*="saldo"]',
  "#cuentas strong",
  "#cuentas b",
];

/** Extract balance from page using regex patterns and element selectors */
export async function extractBalance(
  page: Page,
  customPatterns?: RegExp[],
  customSelectors?: string[],
): Promise<number | undefined> {
  const patterns = (customPatterns || DEFAULT_PATTERNS).map((p) => ({
    source: p.source,
    flags: p.flags,
  }));
  const selectors = customSelectors || DEFAULT_SELECTORS;

  return await page.evaluate(
    (pats: Array<{ source: string; flags: string }>, sels: string[]) => {
      const text = document.body?.innerText || "";

      for (const pat of pats) {
        const regex = new RegExp(pat.source, pat.flags);
        const match = text.match(regex);
        if (match && match[1]) {
          const value = parseInt(match[1].replace(/[^0-9]/g, ""), 10);
          if (!Number.isNaN(value)) return value;
        }
      }

      for (const selector of sels) {
        const elements = Array.from(document.querySelectorAll(selector));
        for (const element of elements) {
          const value = (element as HTMLElement).innerText?.trim() || "";
          if (!/^\$?\s*[\d.]+$/.test(value)) continue;
          const amount = parseInt(value.replace(/[^0-9]/g, ""), 10);
          if (!Number.isNaN(amount) && amount > 0) return amount;
        }
      }

      return undefined;
    },
    patterns,
    selectors,
  );
}
