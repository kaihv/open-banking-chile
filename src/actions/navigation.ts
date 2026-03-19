import type { Page } from "puppeteer-core";
import { delay } from "../utils.js";

/** Click an element matching one of the given text labels */
export async function clickByText(
  page: Page,
  texts: string[],
  elementTypes = "button, a, span, div",
): Promise<boolean> {
  for (const text of texts) {
    const clicked = await page.evaluate(
      (targetText: string, types: string) => {
        const candidates = Array.from(document.querySelectorAll(types));
        for (const candidate of candidates) {
          const innerText = (candidate as HTMLElement).innerText?.trim().toLowerCase();
          if (!innerText) continue;
          if (innerText === targetText || innerText.includes(targetText)) {
            (candidate as HTMLElement).click();
            return true;
          }
        }
        return false;
      },
      text.toLowerCase(),
      elementTypes,
    );

    if (clicked) return true;
  }

  return false;
}

/** Click a sidebar/menu item by ID, falling back to text match constrained by maxX */
export async function clickSidebarItem(
  page: Page,
  selectorIds: string[],
  textPatterns: string[],
  maxX = 300,
): Promise<boolean> {
  const clicked = await page.evaluate(
    (ids: string[], texts: string[], mx: number) => {
      for (const id of ids) {
        const el = document.querySelector(id) as HTMLElement | null;
        if (el) {
          el.click();
          return true;
        }
      }

      const items = Array.from(document.querySelectorAll("button, a, span, li, div"));
      for (const item of items) {
        const text = (item as HTMLElement).innerText?.trim().toLowerCase() || "";
        const rect = (item as HTMLElement).getBoundingClientRect();
        if (rect.x > mx) continue;
        if (texts.some((t) => text === t || text.includes(t))) {
          (item as HTMLElement).click();
          return true;
        }
      }

      return false;
    },
    selectorIds,
    textPatterns,
    maxX,
  );

  return clicked;
}

/** Dismiss cookie banners, welcome popups, etc. */
export async function dismissBanners(page: Page): Promise<void> {
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button, a"));
    for (const button of buttons) {
      const text = (button as HTMLElement).innerText?.trim().toLowerCase();
      if (text === "aceptar" || text === "entendido" || text === "continuar") {
        (button as HTMLElement).click();
      }
    }
  });
}

/** Click a dashboard widget element by selector list */
export async function clickWidget(
  page: Page,
  selectors: string[],
  delayMs = 4000,
): Promise<string | null> {
  const matched = await page.evaluate((sels: string[]) => {
    for (const sel of sels) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) continue;
      el.click();
      return sel;
    }
    return null;
  }, selectors);

  if (matched) await delay(delayMs);
  return matched;
}
