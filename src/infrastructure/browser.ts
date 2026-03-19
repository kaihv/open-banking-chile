import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { saveScreenshot } from "../utils.js";

export interface BrowserOptions {
  chromePath: string;
  headful?: boolean;
  /** Force headless mode off (e.g., Banco Estado TLS fingerprinting) */
  forceHeadful?: boolean;
  extraArgs?: string[];
  viewport?: { width: number; height: number };
}

export interface BrowserSession {
  browser: Browser;
  page: Page;
  debugLog: string[];
  /** Save a named screenshot (noop if screenshots disabled) */
  screenshot: (page: Page, name: string) => Promise<void>;
}

const DEFAULT_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--window-size=1280,900",
  "--disable-blink-features=AutomationControlled",
];

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export async function launchBrowser(
  options: BrowserOptions,
  saveScreenshots: boolean,
): Promise<BrowserSession> {
  const { chromePath, headful, forceHeadful, extraArgs, viewport } = options;
  const debugLog: string[] = [];

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: forceHeadful ? false : !headful,
    args: [...DEFAULT_ARGS, ...(extraArgs || [])],
  });

  const page = await browser.newPage();
  const vp = viewport || { width: 1280, height: 900 };
  await page.setViewport(vp);
  await page.setUserAgent(DEFAULT_UA);

  // Hide automation signals
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const doSave = async (p: Page, name: string) =>
    saveScreenshot(p, name, saveScreenshots, debugLog);

  return { browser, page, debugLog, screenshot: doSave };
}
