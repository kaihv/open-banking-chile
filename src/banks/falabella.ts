import * as fs from "fs";
import * as path from "path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { BankMovement, BankScraper, CreditCardBalance, MovementSource, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { DebugLog, delay, deduplicateAcrossSources, deduplicateMovements, findChrome, monthYearLabel, normalizeDate, normalizeOwner, normalizeInstallments, parseChileanAmount } from "../utils.js";

// ─── Constants ───────────────────────────────────────────────────

const BANK_URL = "https://www.bancofalabella.cl";
const MAX_PAGES = 20;
const CMR_WAIT_MS = 30_000;

// ─── Browser helpers ─────────────────────────────────────────────

async function launchPlaywright(options: ScraperOptions): Promise<{ browser: Browser; page: Page; debugLog: string[] }> {
  const { chromePath, headful, onDebug } = options;
  const debugLog: string[] = onDebug ? new DebugLog(onDebug) : [];

  const execPath = findChrome(chromePath);
  if (!execPath) {
    throw new Error(
      "No se encontró Chrome/Chromium. Instala Google Chrome o pasa chromePath.\n" +
      "  Ubuntu/Debian: sudo apt install google-chrome-stable\n" +
      "  macOS: brew install --cask google-chrome",
    );
  }

  const browser = await chromium.launch({
    executablePath: execPath,
    headless: !headful,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
      "--disable-notifications",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  // Hide automation signals
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();
  return { browser, page, debugLog };
}

async function screenshotIfEnabled(page: Page, name: string, enabled: boolean, debugLog: string[]): Promise<string | undefined> {
  if (!enabled) return undefined;
  const safeName = name.replace(/[/\\:*?"<>|]/g, "_");
  const dir = path.resolve("screenshots");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${safeName}.png`), fullPage: true });
  debugLog.push(`  Screenshot: ${safeName}.png`);
  return undefined;
}

// ─── Login ───────────────────────────────────────────────────────

async function login(page: Page, rut: string, password: string, debugLog: string[], doScreenshots: boolean, progress: (s: string) => void): Promise<{ success: true } | { success: false; error: string; screenshot?: string }> {
  debugLog.push("1. Navigating to bank homepage...");
  progress("Abriendo sitio del banco...");
  await page.goto(BANK_URL, { waitUntil: "networkidle" });
  await delay(2000);

  // Dismiss banners/popups
  try {
    const acceptBtn = page.locator('button, a').filter({ hasText: /^(Aceptar|Entendido|Continuar)$/i }).first();
    if (await acceptBtn.isVisible({ timeout: 2000 }).catch(() => false)) await acceptBtn.click();
  } catch { /* no banner */ }
  await screenshotIfEnabled(page, "01-homepage", doScreenshots, debugLog);

  // Click "Mi cuenta" (triggers navigation)
  debugLog.push("2. Clicking 'Mi cuenta'...");
  progress("Ingresando a Mi cuenta...");
  try {
    await page.locator('a, button').filter({ hasText: "Mi cuenta" }).first().click({ timeout: 5000 });
  } catch { /* may cause navigation context change */ }
  await page.waitForLoadState("networkidle").catch(() => {});
  await delay(3000);
  await screenshotIfEnabled(page, "02-login-form", doScreenshots, debugLog);

  // Fill RUT
  debugLog.push("3. Filling RUT...");
  progress("Ingresando RUT...");
  const rutInput = page.getByRole("textbox", { name: "RUT", exact: true })
    .or(page.locator('input[name*="rut"], input[id*="rut"], input[placeholder*="RUT"]').first());
  try {
    await rutInput.fill(rut, { timeout: 10000 });
  } catch {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "No se encontró campo de RUT", screenshot: ss };
  }
  await delay(1000);

  // Advance to password step (Falabella uses two-step modal)
  await page.keyboard.press("Enter");
  debugLog.push("  Pressed Enter to advance to password step");
  await delay(2000);

  // Fill password
  debugLog.push("4. Filling password...");
  progress("Ingresando clave...");
  const pwdInput = page.locator('input[type="password"]').first()
    .or(page.getByRole("textbox", { name: /[Cc]lave/ }).first());
  try {
    await pwdInput.fill(password, { timeout: 10000 });
  } catch {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "No se encontró campo de clave", screenshot: ss };
  }
  await delay(500);

  // Submit login
  debugLog.push("5. Submitting login...");
  progress("Iniciando sesión...");
  // Try clicking submit button, fallback to Enter
  const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first()
    .or(page.getByRole("button", { name: /ingresar|entrar|btn-md/i }).first());
  try {
    await submitBtn.click({ timeout: 3000 });
  } catch {
    await page.keyboard.press("Enter");
  }

  await page.waitForLoadState("networkidle").catch(() => {});
  await delay(8000);
  await screenshotIfEnabled(page, "03-after-login", doScreenshots, debugLog);

  // Close post-login popups
  try {
    const closeBtn = page.getByRole("button", { name: "cerrar", exact: true });
    if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) await closeBtn.click();
  } catch { /* no popup */ }

  // Retry if products failed to load
  try {
    const retryBtn = page.getByText("Reintentar");
    if (await retryBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await retryBtn.click();
      await delay(5000);
    }
  } catch { /* products loaded fine */ }

  // 2FA check
  const content = await page.content();
  if (content.toLowerCase().includes("clave dinámica") || content.toLowerCase().includes("segundo factor")) {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "El banco pide clave dinámica (2FA).", screenshot: ss };
  }

  // Error check
  const errorText = await page.locator('[class*="error"], [class*="alert"], [role="alert"]')
    .first()
    .textContent({ timeout: 2000 })
    .catch(() => null);
  if (errorText && errorText.trim().length > 5 && errorText.trim().length < 200) {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: `Error del banco: ${errorText.trim()}`, screenshot: ss };
  }

  debugLog.push("6. Login OK!");
  progress("Sesión iniciada correctamente");
  return { success: true };
}

// ─── Account movements ──────────────────────────────────────────

async function scrapeAccountMovements(page: Page, debugLog: string[], doScreenshots: boolean, progress: (s: string) => void): Promise<{ movements: BankMovement[]; balance?: number }> {
  debugLog.push("7. [Cuenta] Looking for account...");
  progress("Buscando cartola de cuenta...");

  // Try clicking on Cuenta Corriente product card
  const ccLink = page.getByRole("link", { name: /Cuenta Corriente \d/ });
  let navigated = false;

  if (await ccLink.isVisible({ timeout: 5000 }).catch(() => false)) {
    await ccLink.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await delay(3000);
    navigated = true;
  }

  if (!navigated) {
    // Fallback: try clicking Cartola/Movimientos text links
    for (const text of ["cartola", "últimos movimientos", "movimientos", "estado de cuenta"]) {
      const link = page.locator("a, button, [role='tab']").filter({ hasText: new RegExp(text, "i") }).first();
      if (await link.isVisible({ timeout: 2000 }).catch(() => false)) {
        try {
          await link.click();
          await delay(4000);
          navigated = true;
          break;
        } catch { /* try next */ }
      }
    }
  }

  if (!navigated) {
    // Try clicking any account-like element
    const acctEl = page.locator("a, div, button").filter({ hasText: /cuenta corriente|cuenta vista/i }).first();
    if (await acctEl.isVisible({ timeout: 3000 }).catch(() => false)) {
      await acctEl.click();
      await delay(4000);
    }
  }

  await screenshotIfEnabled(page, "05-account-movements", doScreenshots, debugLog);

  // Expand date range if possible
  await tryExpandDateRange(page, debugLog);

  // Extract movements via pagination
  progress("Extrayendo movimientos de cuenta...");
  const movements = await paginateAccountMovements(page, debugLog);
  debugLog.push(`8. [Cuenta] Extracted ${movements.length} movements`);
  progress(`Cuenta: ${movements.length} movimientos encontrados`);

  // Extract balance
  let balance: number | undefined;
  if (movements.length > 0 && movements[0].balance > 0) {
    balance = movements[0].balance;
  }
  if (balance === undefined) {
    const bodyText = await page.locator("body").textContent().catch(() => "");
    const match = bodyText?.match(/Saldo disponible[\s\S]{0,50}\$\s*([\d.]+)/i);
    if (match) balance = parseInt(match[1].replace(/[^0-9]/g, ""), 10);
  }

  return { movements, balance };
}

async function tryExpandDateRange(page: Page, debugLog: string[]): Promise<void> {
  try {
    const selects = page.locator("select");
    const count = await selects.count();
    for (let i = 0; i < count; i++) {
      const sel = selects.nth(i);
      const options = await sel.locator("option").allTextContents();
      for (const text of options) {
        const lower = text.toLowerCase();
        if (lower.includes("todos") || lower.includes("último mes") || lower.includes("30 día") || lower.includes("mes anterior")) {
          await sel.selectOption({ label: text });
          debugLog.push(`  Changed select to "${text}"`);
          await delay(3000);
          break;
        }
      }
    }
  } catch { /* best effort */ }
}

async function extractMovementsFromPage(page: Page): Promise<BankMovement[]> {
  return page.evaluate(() => {
    const results: Array<{ date: string; description: string; amount: number; balance: number; source: string }> = [];

    const tables = Array.from(document.querySelectorAll("table"));
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll("tr"));
      if (rows.length < 2) continue;

      // Find header row to determine column indices
      let dateIdx = 0, descIdx = 1, cargoIdx = -1, abonoIdx = -1, amountIdx = -1, balanceIdx = -1;
      let hasHeader = false;

      for (const row of rows) {
        const headers = row.querySelectorAll("th");
        if (headers.length < 2) continue;
        const hTexts = Array.from(headers).map(h => (h as HTMLElement).innerText?.trim().toLowerCase() || "");
        if (!hTexts.some(h => h.includes("fecha"))) continue;
        hasHeader = true;
        dateIdx = hTexts.findIndex(h => h.includes("fecha"));
        descIdx = hTexts.findIndex(h => h.includes("descrip") || h.includes("detalle") || h.includes("glosa"));
        cargoIdx = hTexts.findIndex(h => h.includes("cargo") || h.includes("débito"));
        abonoIdx = hTexts.findIndex(h => h.includes("abono") || h.includes("crédito"));
        amountIdx = hTexts.findIndex(h => h === "monto" || h.includes("importe"));
        balanceIdx = hTexts.findIndex(h => h.includes("saldo"));
        break;
      }
      if (!hasHeader) continue;

      let lastDate = "";
      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 3) continue;
        const vals = Array.from(cells).map(c => (c as HTMLElement).innerText?.trim() || "");
        const rawDate = vals[dateIdx] || "";
        const hasDate = /^\d{1,2}[\/.\-]\d{1,2}([\/.\-]\d{2,4})?$/.test(rawDate);
        const date = hasDate ? rawDate : lastDate;
        if (!date) continue;
        if (hasDate) lastDate = rawDate;

        const description = descIdx >= 0 ? (vals[descIdx] || "") : "";
        let amountStr = "";
        if (cargoIdx >= 0 && vals[cargoIdx]?.replace(/\s/g, "")) {
          amountStr = `-${vals[cargoIdx]}`;
        } else if (abonoIdx >= 0 && vals[abonoIdx]?.replace(/\s/g, "")) {
          amountStr = vals[abonoIdx];
        } else if (amountIdx >= 0) {
          amountStr = vals[amountIdx] || "";
        }
        if (!amountStr) continue;

        const balStr = balanceIdx >= 0 ? (vals[balanceIdx] || "") : "";

        // Parse amounts inline (can't call external functions inside evaluate)
        function parseCLP(text: string): number {
          const clean = text.replace(/[^0-9.,-]/g, "");
          if (!clean) return 0;
          const isNeg = clean.startsWith("-") || text.includes("-$");
          const norm = clean.replace(/-/g, "").replace(/\./g, "").replace(",", ".");
          const val = parseInt(norm, 10) || 0;
          return isNeg ? -val : val;
        }

        results.push({
          date,
          description,
          amount: parseCLP(amountStr),
          balance: parseCLP(balStr),
          source: "account",
        });
      }
    }
    return results;
  }).then(raw =>
    raw
      .filter(m => m.description || m.amount !== 0)
      .map(m => ({
        date: normalizeDate(m.date),
        description: m.description,
        amount: m.amount,
        balance: m.balance,
        source: MOVEMENT_SOURCE.account as MovementSource,
      }))
  );
}

async function paginateAccountMovements(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  const all: BankMovement[] = [];

  for (let i = 0; i < MAX_PAGES; i++) {
    const movements = await extractMovementsFromPage(page);
    all.push(...movements);

    // Try clicking "Siguiente" or "Ver más"
    let clicked = false;
    for (const text of ["siguiente", "ver más", "mostrar más"]) {
      const btn = page.locator("button, a").filter({ hasText: new RegExp(text, "i") }).first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        const disabled = await btn.isDisabled().catch(() => true);
        if (!disabled) {
          await btn.click();
          await delay(2500);
          clicked = true;
          debugLog.push(`  Pagination: loaded page ${i + 2}`);
          break;
        }
      }
    }
    if (!clicked) break;
  }

  return deduplicateMovements(all);
}

// ─── CMR credit card ────────────────────────────────────────────

async function scrapeCreditCard(page: Page, debugLog: string[], doScreenshots: boolean, progress: (s: string) => void, ownerFilter: string): Promise<{ movements: BankMovement[]; creditCard: CreditCardBalance }> {
  const creditCard: CreditCardBalance = { label: "CMR" };
  const allMovements: BankMovement[] = [];

  debugLog.push("9. [CMR] Looking for CMR card...");
  progress("Navegando a tarjeta de crédito...");

  // Extract cupos from dashboard
  const cupoData = await extractCupos(page, debugLog);
  if (cupoData) Object.assign(creditCard, cupoData);

  // Click on CMR product card
  const cmrLink = page.getByRole("link", { name: /CMR/ }).first()
    .or(page.locator("#cardDetail0, [id^='cardDetail']").first())
    .or(page.locator("a, button, div").filter({ hasText: /CMR/i }).first());

  if (!(await cmrLink.isVisible({ timeout: 5000 }).catch(() => false))) {
    debugLog.push("  [CMR] No CMR card found on dashboard");
    return { movements: [], creditCard };
  }

  await cmrLink.click();
  await page.waitForLoadState("networkidle").catch(() => {});
  await delay(5000);
  await screenshotIfEnabled(page, "06-cmr-card", doScreenshots, debugLog);

  // Wait for CMR shadow DOM to render
  await waitForCmrContent(page, CMR_WAIT_MS);

  // Owner filter
  if (ownerFilter !== "B") {
    await page.evaluate(({ host, value }: { host: string; value: string }) => {
      const shadowEl = document.querySelector(host) as Element & { shadowRoot?: ShadowRoot };
      const root = shadowEl?.shadowRoot || document;
      const select = root.querySelector("select[name='searchownership']") as HTMLSelectElement | null;
      if (select) { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }
    }, { host: "credit-card-movements", value: ownerFilter });
    await waitForCmrContent(page, CMR_WAIT_MS);
  }

  // ── No facturados (default tab) ────────────────────────────────
  debugLog.push("10. [CMR] Extracting unbilled movements...");
  progress("Extrayendo movimientos TC por facturar...");

  // Extract billing period info
  const unbilledInfo = await extractUnbilledPeriodInfo(page);
  if (unbilledInfo.nextBillingDate) creditCard.nextBillingDate = normalizeDate(unbilledInfo.nextBillingDate);
  if (unbilledInfo.nextDueDate) creditCard.nextDueDate = normalizeDate(unbilledInfo.nextDueDate);
  if (unbilledInfo.periodExpenses !== undefined) creditCard.periodExpenses = unbilledInfo.periodExpenses;

  const unbilledMovements = await paginateCmrMovements(page, MOVEMENT_SOURCE.credit_card_unbilled, debugLog);
  debugLog.push(`  Unbilled: ${unbilledMovements.length} movements`);
  allMovements.push(...unbilledMovements);

  await screenshotIfEnabled(page, "07-cmr-no-facturados", doScreenshots, debugLog);

  // ── Facturados tab ─────────────────────────────────────────────
  debugLog.push("11. [CMR] Switching to facturados tab...");
  progress("Extrayendo movimientos TC facturados...");

  const tabClicked = await clickCmrTab(page, debugLog);
  if (tabClicked) {
    await delay(2000);
    await waitForCmrContent(page, CMR_WAIT_MS);
    await delay(3000);
    await screenshotIfEnabled(page, "07-cmr-facturados", doScreenshots, debugLog);

    // Extract last statement info
    const billedInfo = await extractBilledStatementInfo(page);
    if (billedInfo.billingDate && billedInfo.billedAmount && billedInfo.dueDate) {
      creditCard.lastStatement = {
        billingDate: normalizeDate(billedInfo.billingDate),
        billedAmount: billedInfo.billedAmount,
        dueDate: normalizeDate(billedInfo.dueDate),
        minimumPayment: billedInfo.minimumPayment,
      };
      creditCard.billingPeriod = monthYearLabel(creditCard.lastStatement.billingDate);
    }

    const billedMovements = await paginateCmrMovements(page, MOVEMENT_SOURCE.credit_card_billed, debugLog);
    debugLog.push(`  Billed: ${billedMovements.length} movements`);
    allMovements.push(...billedMovements);
  }

  // Tag movements with card mask
  const cardMask = creditCard.label.match(/\*{4}\d{4}/)?.[0];
  const tagged = cardMask ? allMovements.map(m => ({ ...m, card: cardMask })) : allMovements;
  creditCard.movements = deduplicateAcrossSources(deduplicateMovements(tagged));

  return { movements: creditCard.movements, creditCard };
}

// ─── CMR Shadow DOM helpers ─────────────────────────────────────

async function waitForCmrContent(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.waitForFunction((host: string) => {
      const el = document.querySelector(host) as Element & { shadowRoot?: ShadowRoot };
      if (!el?.shadowRoot) return false;
      function collectAll(root: ShadowRoot | Element): Array<ShadowRoot | Element> {
        const found: Array<ShadowRoot | Element> = [root];
        for (const child of Array.from((root as Element).querySelectorAll("*"))) {
          const sr = (child as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
          if (sr) found.push(...collectAll(sr));
        }
        return found;
      }
      return collectAll(el.shadowRoot).some(
        r => (r as Element).querySelectorAll("table tbody tr td").length > 0,
      );
    }, "credit-card-movements", { timeout: timeoutMs });
  } catch { /* timeout */ }
  await delay(500);
}

async function extractCupos(page: Page, debugLog: string[]): Promise<Partial<CreditCardBalance> | null> {
  try {
    const cupoData = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const labelMatch = text.match(/(CMR\s+\w+(?:\s+\w+)?)\s*\n?\s*[•·*\s]+\s*(\d{4})/i);
      const label = labelMatch ? `${labelMatch[1]} ****${labelMatch[2]}` : "";
      const cupoMatch = text.match(/\$([\d.,]+)\s*\n?\s*Cupo de compras/i);
      const usadoMatch = text.match(/\$([\d.,]+)\s*\n?\s*Cupo utilizado/i);
      const disponibleMatch = text.match(/\$([\d.,]+)\s*\n?\s*Cupo disponible/i);
      return { label, cupo: cupoMatch?.[1], usado: usadoMatch?.[1], disponible: disponibleMatch?.[1] };
    });
    if (!cupoData.cupo && !cupoData.disponible) return null;
    const total = cupoData.cupo ? parseChileanAmount(cupoData.cupo) : 0;
    const used = cupoData.usado ? parseChileanAmount(cupoData.usado) : 0;
    const available = cupoData.disponible ? parseChileanAmount(cupoData.disponible) : 0;
    debugLog.push(`  CMR cupos: total=$${total}, used=$${used}, available=$${available}`);
    return { label: cupoData.label || "CMR", national: { total, used, available } };
  } catch {
    return null;
  }
}

async function extractUnbilledPeriodInfo(page: Page): Promise<{ nextBillingDate?: string; nextDueDate?: string; periodExpenses?: number }> {
  return page.evaluate((host: string) => {
    const shadowEl = document.querySelector(host) as Element & { shadowRoot?: ShadowRoot };
    const topRoot = shadowEl?.shadowRoot || document;

    function collectAllRoots(root: ShadowRoot | Element): Array<ShadowRoot | Element> {
      const found: Array<ShadowRoot | Element> = [root];
      for (const el of Array.from((root as Element).querySelectorAll("*"))) {
        const sr = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
        if (sr) found.push(...collectAllRoots(sr));
      }
      return found;
    }

    function extractFromSameDiv(root: ShadowRoot | Element, label: string): string | undefined {
      for (const div of Array.from((root as Element).querySelectorAll("div"))) {
        const text = div.textContent?.trim() || "";
        if (text.toLowerCase().startsWith(label.toLowerCase())) {
          const rest = text.slice(label.length).trim();
          if (rest) return rest;
        }
      }
      return undefined;
    }

    function parseAmount(text?: string): number | undefined {
      if (!text) return undefined;
      const m = text.match(/\$([\d.,]+)/);
      if (!m) return undefined;
      return parseInt(m[1].replace(/\./g, "").replace(",", ""), 10) || undefined;
    }

    function extractDate(text?: string): string | undefined {
      if (!text) return undefined;
      const m = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
      return m ? m[1] : undefined;
    }

    let billingRaw: string | undefined;
    let dueRaw: string | undefined;
    let expensesRaw: string | undefined;

    for (const root of collectAllRoots(topRoot)) {
      if (!billingRaw) billingRaw = extractFromSameDiv(root, "Próxima facturación");
      if (!dueRaw) dueRaw = extractFromSameDiv(root, "Próximo vencimiento");
      if (!expensesRaw) expensesRaw = extractFromSameDiv(root, "Gastos del periodo");
    }

    return {
      nextBillingDate: extractDate(billingRaw),
      nextDueDate: extractDate(dueRaw),
      periodExpenses: parseAmount(expensesRaw),
    };
  }, "credit-card-movements");
}

async function extractBilledStatementInfo(page: Page): Promise<{ billingDate?: string; billedAmount?: number; dueDate?: string; minimumPayment?: number }> {
  return page.evaluate((host: string) => {
    const shadowEl = document.querySelector(host) as Element & { shadowRoot?: ShadowRoot };
    const topRoot = shadowEl?.shadowRoot || document;

    function collectAllRoots(root: ShadowRoot | Element): Array<ShadowRoot | Element> {
      const found: Array<ShadowRoot | Element> = [root];
      for (const el of Array.from((root as Element).querySelectorAll("*"))) {
        const sr = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
        if (sr) found.push(...collectAllRoots(sr));
      }
      return found;
    }

    function findNextSiblingValue(root: ShadowRoot | Element, labelText: string): string | undefined {
      const divs = Array.from((root as Element).querySelectorAll<HTMLElement>("div"));
      for (let i = 0; i < divs.length - 1; i++) {
        if ((divs[i].textContent?.trim() || "").toLowerCase() === labelText.toLowerCase()) {
          const val = divs[i + 1]?.textContent?.trim() || "";
          if (val) return val;
        }
      }
      return undefined;
    }

    function parseAmount(text?: string): number | undefined {
      if (!text) return undefined;
      const m = text.match(/\$([\d.,]+)/);
      if (!m) return undefined;
      return parseInt(m[1].replace(/\./g, "").replace(",", ""), 10) || undefined;
    }

    function extractDate(text?: string): string | undefined {
      if (!text) return undefined;
      const m = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
      return m ? m[1] : undefined;
    }

    let billingDate: string | undefined;
    let billedAmount: number | undefined;
    let dueDate: string | undefined;
    let minimumPayment: number | undefined;

    for (const root of collectAllRoots(topRoot)) {
      if (!billingDate) billingDate = extractDate(findNextSiblingValue(root, "Fecha de facturación"));
      if (!billedAmount) billedAmount = parseAmount(findNextSiblingValue(root, "Monto facturado"));
      if (!dueDate) dueDate = extractDate(findNextSiblingValue(root, "Fecha de vencimiento"));
      if (!minimumPayment) minimumPayment = parseAmount(findNextSiblingValue(root, "Pago minimo"));
    }

    return { billingDate, billedAmount, dueDate, minimumPayment };
  }, "credit-card-movements");
}

async function clickCmrTab(page: Page, debugLog: string[]): Promise<boolean> {
  const result = await page.evaluate(({ host, radioId }: { host: string; radioId: string }) => {
    const shadowEl = document.querySelector(host) as Element & { shadowRoot?: ShadowRoot };
    const roots: Array<Document | ShadowRoot> = [];
    if (shadowEl?.shadowRoot) roots.push(shadowEl.shadowRoot);
    roots.push(document);

    // Try well-known radio id first
    for (const root of roots) {
      const radio = root.querySelector(`#${radioId}`) as HTMLInputElement | null;
      if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event("change", { bubbles: true }));
        radio.click();
        const label = root.querySelector(`label[for="${radio.id}"]`) as HTMLElement | null
          ?? (radio.closest("label") as HTMLElement | null);
        if (label) label.click();
        return `radio#${radio.id}`;
      }
    }

    // Fallback: find label containing "facturado"
    for (const root of roots) {
      for (const label of Array.from(root.querySelectorAll<HTMLLabelElement>("label"))) {
        if (!label.innerText?.trim().toLowerCase().includes("facturado")) continue;
        const forId = label.getAttribute("for");
        const radio = forId
          ? (root.querySelector(`#${forId}`) as HTMLInputElement | null)
          : (label.querySelector("input[type='radio']") as HTMLInputElement | null);
        if (radio) {
          radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
          radio.click();
        }
        label.click();
        return `label: "${label.innerText.trim()}"`;
      }
    }
    return null;
  }, { host: "credit-card-movements", radioId: "invoicedMovements" });

  if (result) debugLog.push(`  CMR: Clicked facturados tab via ${result}`);
  return result !== null;
}

async function paginateCmrMovements(page: Page, source: MovementSource, debugLog: string[]): Promise<BankMovement[]> {
  const all: BankMovement[] = [];
  const host = "credit-card-movements";

  for (let i = 0; i < MAX_PAGES; i++) {
    // Extract + click next in a single evaluate
    const result: { rows: BankMovement[]; firstRow: string; clicked: boolean } = await page.evaluate(
      ({ host: h, src, isBilled }: { host: string; src: string; isBilled: boolean }) => {
        const shadowEl = document.querySelector(h) as Element & { shadowRoot?: ShadowRoot };
        const topRoot = shadowEl?.shadowRoot || document;

        function collectAll(root: ShadowRoot | Element | Document): Array<ShadowRoot | Element> {
          const found: Array<ShadowRoot | Element> = root instanceof Document ? [] : [root as Element];
          for (const el of Array.from((root as ParentNode).querySelectorAll("*"))) {
            const sr = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
            if (sr) found.push(...collectAll(sr));
          }
          return found;
        }
        const roots = collectAll(topRoot);

        // Extract movements from visible tables
        const allTables: HTMLTableElement[] = roots.flatMap(
          r => Array.from((r as Element).querySelectorAll<HTMLTableElement>("table")),
        );
        function isVisible(t: HTMLTableElement): boolean {
          const r = t.getBoundingClientRect();
          return r.width > 0 || r.height > 0;
        }

        const rows: BankMovement[] = [];
        const tablesToUse = isBilled
          ? allTables.filter(t => {
              if (!isVisible(t)) return false;
              const hdr = (t.querySelector("thead, tr:first-child") as HTMLElement | null)?.innerText?.toLowerCase() ?? "";
              return hdr.includes("fecha de compra") || hdr.includes("monto total") || hdr.includes("cuota a pagar");
            })
          : allTables.filter(t => isVisible(t));

        const finalTables = tablesToUse.length > 0
          ? tablesToUse
          : allTables.filter(t => isVisible(t) && !t.closest("app-last-movements"));

        for (const table of finalTables) {
          for (const row of Array.from(table.querySelectorAll("tbody tr"))) {
            const cells = row.querySelectorAll("td");
            if (cells.length < 4) continue;
            const texts = Array.from(cells).map(c => (c as HTMLElement).innerText?.trim() || "");
            const dateMatch = texts[0]?.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
            const pendingImg = row.querySelector("td:first-child img[alt*='pendiente'], td:first-child .td-time-img");
            if (!dateMatch && !pendingImg && texts[0] !== "") continue;
            const date = dateMatch ? dateMatch[1].replace(/\//g, "-") : "pendiente";
            const description = texts[1] || "";
            const totalText = texts[3] || "";
            const cuotaText = texts[5] || "";
            const montoText = cuotaText || totalText;
            const isNeg = montoText.includes("-$");
            const amountMatch = montoText.match(/\$\s*([\d.,]+)/);
            let amount = 0;
            if (amountMatch) {
              const value = parseInt(amountMatch[1].replace(/\./g, "").replace(",", "."), 10) || 0;
              amount = isNeg ? value : -value;
            }
            const totalAmountMatch = totalText.match(/\$\s*([\d.,]+)/);
            const totalAmount = totalAmountMatch
              ? parseInt(totalAmountMatch[1].replace(/\./g, "").replace(",", "."), 10) || undefined
              : undefined;
            if (description && amount !== 0) {
              rows.push({
                date, description, amount, balance: 0,
                source: src as MovementSource,
                owner: (texts[2] || undefined) as any,
                installments: texts[4] || undefined,
                totalAmount,
              });
            }
          }
        }

        // First row signature for change detection.
        // For billed movements, prefer the "fecha de compra" table — "pendientes de
        // confirmación" rows don't change across pages and cause false negatives.
        let firstRow = "";
        if (isBilled) {
          outer: for (const r of roots) {
            for (const tbl of Array.from((r as Element).querySelectorAll<HTMLTableElement>("table"))) {
              const hdr = (tbl.querySelector("thead, tr:first-child") as HTMLElement | null)?.innerText?.toLowerCase() ?? "";
              if (!hdr.includes("fecha de compra")) continue;
              const cells = tbl.querySelectorAll("tbody tr:first-child td");
              if (cells.length > 0) {
                firstRow = Array.from(cells).map(c => (c as HTMLElement).innerText?.trim()).join("|");
                break outer;
              }
            }
          }
        }
        if (!firstRow) {
          for (const r of roots) {
            const cells = (r as Element).querySelectorAll("table tbody tr:first-child td");
            if (cells.length > 0) {
              firstRow = Array.from(cells).map(c => (c as HTMLElement).innerText?.trim()).join("|");
              break;
            }
          }
        }

        // Click next button
        let clicked = false;
        for (const root of roots) {
          if (clicked) break;
          for (const btn of Array.from((root as Element).querySelectorAll<HTMLButtonElement>(".btn-pagination, button"))) {
            if (btn.disabled) continue;
            const img = btn.querySelector("img");
            const imgAlt = (img?.getAttribute("alt") || "").toLowerCase();
            const imgSrc = img?.getAttribute("src") || "";
            const label = (btn.getAttribute("aria-label") || btn.innerText || "").toLowerCase();
            const isNext =
              imgAlt.includes("avanzar") || imgAlt.includes("siguiente") || imgAlt.includes("next") ||
              imgSrc.includes("right-arrow") || imgSrc.includes("arrow-right") || imgSrc.includes("next") ||
              label.includes("siguiente") || label.includes("next") || label.includes("avanzar");
            if (isNext) { btn.click(); clicked = true; break; }
          }
        }

        return { rows, firstRow, clicked };
      },
      { host, src: source, isBilled: source === MOVEMENT_SOURCE.credit_card_billed },
    );

    debugLog.push(`  [CMR pag] page ${i + 1}: ${result.rows.length} rows`);
    all.push(...result.rows);

    if (!result.clicked) break;

    // Wait for content to change — use the same "fecha de compra" preference as above
    const prevRow = result.firstRow;
    const isBilled = source === MOVEMENT_SOURCE.credit_card_billed;
    const changed = await page.waitForFunction(
      ({ host: h, prev, billed }: { host: string; prev: string; billed: boolean }) => {
        const el = document.querySelector(h) as Element & { shadowRoot?: ShadowRoot };
        const topRoot = el?.shadowRoot || document;
        function collectAll(root: ShadowRoot | Element | Document): Array<ShadowRoot | Element> {
          const found: Array<ShadowRoot | Element> = root instanceof Document ? [] : [root as Element];
          for (const child of Array.from((root as ParentNode).querySelectorAll("*"))) {
            const sr = (child as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
            if (sr) found.push(...collectAll(sr));
          }
          return found;
        }
        const roots = collectAll(topRoot);
        // Prefer "fecha de compra" table for billed to avoid false negatives
        if (billed) {
          for (const r of roots) {
            for (const tbl of Array.from((r as Element).querySelectorAll<HTMLTableElement>("table"))) {
              const hdr = (tbl.querySelector("thead, tr:first-child") as HTMLElement | null)?.innerText?.toLowerCase() ?? "";
              if (!hdr.includes("fecha de compra")) continue;
              const cells = tbl.querySelectorAll("tbody tr:first-child td");
              if (cells.length > 0) {
                const sig = Array.from(cells).map(c => (c as HTMLElement).innerText?.trim()).join("|");
                return sig !== prev && sig !== "";
              }
            }
          }
        }
        // Fallback: any table's first row
        for (const root of roots) {
          const cells = (root as Element).querySelectorAll("table tbody tr:first-child td");
          if (cells.length > 0) {
            const sig = Array.from(cells).map(c => (c as HTMLElement).innerText?.trim()).join("|");
            return sig !== prev && sig !== "";
          }
        }
        return false;
      },
      { host, prev: prevRow, billed: isBilled },
      { timeout: 15000 },
    ).then(() => true, () => false);

    if (!changed) break;
    await delay(300);
  }

  return deduplicateMovements(
    all.map(m => ({
      ...m,
      date: normalizeDate(m.date),
      owner: normalizeOwner(m.owner),
      installments: normalizeInstallments(m.installments),
    })),
  );
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeFalabella(options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots = false, owner = "B" } = options;
  const progress = options.onProgress || (() => {});
  const bank = "falabella";

  if (!rut || !password) {
    return { success: false, bank, accounts: [], error: "Debes proveer RUT y clave." };
  }

  let browser: Browser | undefined;

  try {
    const session = await launchPlaywright(options);
    browser = session.browser;
    const { page, debugLog } = session;

    // Login
    const loginResult = await login(page, rut, password, debugLog, doScreenshots, progress);
    if (!loginResult.success) {
      return {
        success: false,
        bank,
        accounts: [],
        error: loginResult.error,
        screenshot: loginResult.screenshot,
        debug: debugLog.join("\n"),
      };
    }

    const dashboardUrl = page.url();
    await screenshotIfEnabled(page, "04-post-login", doScreenshots, debugLog);

    // Phase 1: Account movements
    const { movements: accountMovements, balance } = await scrapeAccountMovements(page, debugLog, doScreenshots, progress);

    // Phase 2: CMR credit card — navigate back to dashboard first
    debugLog.push("  Navigating back to dashboard for CMR...");
    progress("Navegando a tarjeta de crédito...");
    await page.goto(dashboardUrl, { waitUntil: "networkidle" });
    await delay(2000);

    // Close popups again
    try {
      const closeBtn = page.getByRole("button", { name: "cerrar", exact: true });
      if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) await closeBtn.click();
    } catch { /* no popup */ }

    const { creditCard } = await scrapeCreditCard(page, debugLog, doScreenshots, progress, owner);

    const totalMov = accountMovements.length + (creditCard.movements?.length ?? 0);
    debugLog.push(`12. Total: ${accountMovements.length} account + ${creditCard.movements?.length ?? 0} TC = ${totalMov}`);
    progress(`Listo — ${totalMov} movimientos totales`);

    await screenshotIfEnabled(page, "08-final", doScreenshots, debugLog);
    const ss = doScreenshots ? (await page.screenshot({ fullPage: true })).toString("base64") : undefined;

    // Logout
    try {
      await page.evaluate(() => {
        for (const el of Array.from(document.querySelectorAll("a, button, span"))) {
          const text = (el as HTMLElement).innerText?.trim().toLowerCase();
          if (text === "cerrar sesión" || text === "cerrar sesion" || text === "salir") {
            (el as HTMLElement).click();
            return;
          }
        }
      });
      await delay(2000);
    } catch { /* best effort */ }

    return {
      success: true,
      bank,
      accounts: [{ balance, movements: deduplicateMovements(accountMovements) }],
      creditCards: [creditCard],
      screenshot: ss,
      debug: debugLog.join("\n"),
    };
  } catch (error) {
    return {
      success: false,
      bank,
      accounts: [],
      error: `Error del scraper: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── Export ──────────────────────────────────────────────────────

const falabella: BankScraper = {
  id: "falabella",
  name: "Banco Falabella",
  url: BANK_URL,
  scrape: scrapeFalabella,
};

export default falabella;
