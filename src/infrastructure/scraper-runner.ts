import type { ScrapeResult, ScraperOptions } from "../types.js";
import { logout } from "../utils.js";
import { launchBrowser, type BrowserOptions, type BrowserSession } from "./browser.js";

export type ScrapeFn = (
  session: BrowserSession,
  options: ScraperOptions,
) => Promise<ScrapeResult>;

/**
 * Wraps the full scraper lifecycle:
 * 1. Validate credentials
 * 2. Find Chrome
 * 3. Launch browser
 * 4. Run bank-specific scrapeFn
 * 5. Logout + close browser
 * 6. Catch errors → return ScrapeResult
 */
export async function runScraper(
  bankId: string,
  options: ScraperOptions,
  browserOptions: Partial<BrowserOptions>,
  scrapeFn: ScrapeFn,
): Promise<ScrapeResult> {
  const { rut, password, chromePath, saveScreenshots, headful } = options;

  if (!rut || !password) {
    return {
      success: false,
      bank: bankId,
      accounts: [],
      error: "Debes proveer RUT y clave.",
    };
  }

  let session: BrowserSession | undefined;

  try {
    session = await launchBrowser(
      { chromePath, headful, ...browserOptions },
      !!saveScreenshots,
    );

    return await scrapeFn(session, options);
  } catch (error) {
    return {
      success: false,
      bank: bankId,
      accounts: [],
      error: `Error del scraper: ${error instanceof Error ? error.message : String(error)}`,
      debug: session?.debugLog.join("\n"),
    };
  } finally {
    if (session?.browser) {
      try {
        const pages = await session.browser.pages();
        if (pages.length > 0) await logout(pages[pages.length - 1], session.debugLog);
      } catch { /* best effort */ }
      await session.browser.close().catch(() => {});
    }
  }
}
