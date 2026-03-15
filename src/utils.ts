import * as fs from "fs";
import * as path from "path";
import type { Page } from "puppeteer-core";

/** Formatea un RUT chileno (ej: "123456789" → "12.345.678-9") */
export function formatRut(rut: string): string {
  const clean = rut.replace(/[.\-]/g, "");
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  const formatted = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${formatted}-${dv}`;
}

/** Delay en milisegundos */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Busca Chrome/Chromium en el sistema */
export function findChrome(customPath?: string): string | null {
  if (customPath && fs.existsSync(customPath)) return customPath;

  const candidates = [
    // Linux
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "/snap/bin/chromium-browser",
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    // Windows (WSL)
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Guarda un screenshot si saveScreenshots está habilitado */
export async function saveScreenshot(
  page: Page,
  name: string,
  enabled: boolean,
  debugLog: string[]
): Promise<void> {
  if (!enabled) return;
  // Sanitize name to prevent path traversal
  const safeName = name.replace(/[/\\:*?"<>|]/g, "_");
  const dir = path.resolve("screenshots");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({
    path: path.join(dir, `${safeName}.png`),
    fullPage: true,
  });
  debugLog.push(`  Screenshot saved: screenshots/${safeName}.png`);
}

/** Cierra popups y modales genéricos */
export async function closePopups(page: Page): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Escape");
    await delay(300);
  }
  await page.evaluate(() => {
    const closeButtons = Array.from(
      document.querySelectorAll(
        '[class*="close"], [aria-label*="close"], [aria-label*="cerrar"], button'
      )
    );
    for (const btn of closeButtons) {
      const text = (btn as HTMLElement).innerText?.trim();
      if (text === "X" || text === "×" || text === "✕" || text === "Cerrar") {
        (btn as HTMLElement).click();
      }
    }
  });
  await delay(1000);
}
