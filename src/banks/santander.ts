import type { Frame, Page } from "puppeteer-core";
import type { BankMovement, BankScraper, CreditCardBalance, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { deduplicateMovements, closePopups, delay, normalizeDate, parseChileanAmount } from "../utils.js";
import { createInterceptor } from "../intercept.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { fillRut, fillPassword, clickSubmit, detectLoginError } from "../actions/login.js";
import { detect2FA, waitFor2FA } from "../actions/two-factor.js";
import { clickByText, clickSidebarItem, dismissBanners, clickWidget } from "../actions/navigation.js";
import { extractAccountMovements } from "../actions/extraction.js";
import { paginateAndExtract } from "../actions/pagination.js";
import { extractBalance } from "../actions/balance.js";
import { clickTcTab, extractCreditCardMovements } from "../actions/credit-card.js";

// ─── Santander-specific constants ────────────────────────────────────

const BANK_URL = "https://banco.santander.cl/personas";

// ─── API endpoint prefixes ───────────────────────────────────────
const SANTANDER_CHECKING_API_PREFIX =
  "https://openbanking.santander.cl/account_balances_transactions_and_withholdings_retail/v1/current-accounts/transactions";
const SANTANDER_CC_API_PREFIX =
  "https://api-dsk.santander.cl/perdsk/tarjetasDeCredito/consultaUltimosMovimientos";
const SANTANDER_CC_BILLED_API_PREFIX =
  "https://api-dsk.santander.cl/perdsk/tarjetasDeCredito/estadoCuentaNacional";

// ─── API response normalizers ────────────────────────────────────

interface SantanderCheckingApiMovement {
  transactionDate: string; // "2026-03-19"
  movementAmount: string; // "00000010000000-" (centavos, trailing - = debit)
  chargePaymentFlag: string; // "D" = debit, "H" = haber/credit
  observation: string;
  expandedCode: string;
  newBalance?: string;
}

export function normalizeSantanderCheckingApiMovements(captures: unknown[]): BankMovement[] {
  const movements: BankMovement[] = [];
  for (const capture of captures) {
    const obj = capture as { movements?: SantanderCheckingApiMovement[] };
    const list = obj?.movements;
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      const digits = m.movementAmount.replace(/[^0-9]/g, "");
      const raw = parseInt(digits, 10);
      if (!raw || isNaN(raw)) continue;
      const clp = raw / 100;
      const isDebit = m.chargePaymentFlag === "D" || m.movementAmount.endsWith("-");
      const amount = isDebit ? -clp : clp;
      const description = (m.observation?.trim() || m.expandedCode?.trim() || "").trim();
      let balance = 0;
      if (m.newBalance) {
        const balDigits = m.newBalance.replace(/[^0-9]/g, "");
        balance = Math.round(parseInt(balDigits, 10) / 100);
      }
      movements.push({
        date: normalizeDate(m.transactionDate),
        description,
        amount,
        balance,
        source: MOVEMENT_SOURCE.account,
      });
    }
  }
  return movements;
}

interface SantanderCcApiMovement {
  Fecha: string; // "18/01/2026"
  Comercio: string;
  Descripcion: string;
  Importe: string; // "3.990" (Chilean thousands)
  IndicadorDebeHaber: string; // "D" = debit, "H" = credit
}

export function isSaldoInicial(description: string): boolean {
  return /saldo\s+inicial/i.test(description);
}

export function normalizeSantanderUnbilledApiMovements(captures: unknown[]): BankMovement[] {
  const movements: BankMovement[] = [];
  for (const capture of captures) {
    const obj = capture as { DATA?: { MatrizMovimientos?: SantanderCcApiMovement[] } };
    const list = obj?.DATA?.MatrizMovimientos;
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      const raw = parseChileanAmount(m.Importe);
      if (!raw || isNaN(raw)) continue;
      const isDebit = m.IndicadorDebeHaber === "D";
      const amount = isDebit ? -raw : raw;
      const description = (m.Comercio?.trim() || m.Descripcion?.trim() || "").trim();
      if (isSaldoInicial(description)) continue;
      movements.push({
        date: normalizeDate(m.Fecha),
        description,
        amount,
        balance: 0,
        source: MOVEMENT_SOURCE.credit_card_unbilled,
      });
    }
  }
  return movements;
}

interface SantanderBilledApiMovement {
  FechaTxs: string; // "2026-01-28"
  NombreComercio: string;
  MontoTxs: string; // "0000833685" or "50.000" (Chilean thousands, leading zeros)
  NumeroCuotas: string; // "00"
  TotalCuotas: string; // "00"
}

export function normalizeSantanderBilledApiMovements(captures: unknown[]): BankMovement[] {
  const movements: BankMovement[] = [];
  for (const capture of captures) {
    const path = (capture as Record<string, unknown>)?.DATA as Record<string, unknown> | undefined;
    const response = path?.AS_TIB_WM02_CONEstCtaNacional_Response as
      | Record<string, unknown>
      | undefined;
    const output = response?.OUTPUT as Record<string, unknown> | undefined;
    const list = output?.Matriz as SantanderBilledApiMovement[] | undefined;
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      // Strip leading zeros + dots (Chilean thousands separator), parse as integer pesos
      const cleaned = m.MontoTxs.replace(/^0+/, "").replace(/\./g, "") || "0";
      const raw = parseInt(cleaned, 10);
      if (!raw || isNaN(raw)) continue;
      if (isSaldoInicial(m.NombreComercio)) continue;
      const isPayment = m.NombreComercio.toLowerCase().includes("monto cancelado");
      const amount = isPayment ? raw : -raw;
      const totalCuotas = parseInt(m.TotalCuotas.replace(/^0+/, "") || "0", 10);
      const currentCuota = parseInt(m.NumeroCuotas.replace(/^0+/, "") || "0", 10);
      const installments =
        totalCuotas > 0
          ? `${String(currentCuota).padStart(2, "0")}/${String(totalCuotas).padStart(2, "0")}`
          : undefined;
      movements.push({
        date: normalizeDate(m.FechaTxs),
        description: m.NombreComercio,
        amount,
        balance: 0,
        source: MOVEMENT_SOURCE.credit_card_billed,
        ...(installments ? { installments } : {}),
      });
    }
  }
  return movements;
}

// Sidebar menu IDs — generated by Santander's Angular framework, may change
const SIDEBAR = {
  cuentas: "#menu-uid-0410",
  movimientos: "#menu-uid-0413",
  tarjetas: "#menu-uid-0420",
  misTc: ["#menu-uid-0421", "#menu-uid-042182"],
  maxX: 300,
};

const LOGIN_SELECTORS = {
  rutSelectors: ["#rut"],
  passwordSelectors: ["#pass"],
  rutFormat: "clean" as const,
};

const TWO_FACTOR_CONFIG = {
  timeoutEnvVar: "SANTANDER_2FA_TIMEOUT_SEC",
  frameFn: async (page: Page) => {
    const handle = await page.$("iframe#login-frame");
    return handle ? await handle.contentFrame() : null;
  },
};

// ─── Santander-specific helpers ──────────────────────────────────────

type MovementAccount = { index: number; label: string };
type CreditCardSlide = { index: number; label: string };

async function getLoginFrame(page: Page): Promise<Frame | null> {
  const handle = await page.$("iframe#login-frame");
  return handle ? await handle.contentFrame() : null;
}

async function listMovementAccounts(page: Page): Promise<MovementAccount[]> {
  return await page.evaluate(() => {
    const slides = Array.from(document.querySelectorAll("#tabs-carousel-movs .swiper-slide"));
    const out: Array<{ index: number; label: string }> = [];
    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i] as HTMLElement;
      const text = slide.innerText?.replace(/\s+/g, " ").trim() || "";
      if (!text) continue;
      const typeMatch = text.match(/Cuenta\s+(Corriente|Vista)/i);
      const numberMatch = text.match(/\d(?:[\s.]\d+){3,}/);
      const type = typeMatch ? `Cuenta ${typeMatch[1]}` : "Cuenta";
      const number = numberMatch ? numberMatch[0].replace(/\s+/g, " ").trim() : `#${i + 1}`;
      out.push({ index: i, label: `${type} ${number}`.trim() });
    }
    return out;
  });
}

async function selectMovementAccount(page: Page, index: number): Promise<boolean> {
  const clicked = await page.evaluate((targetIndex: number) => {
    const byAria = document.querySelector(
      `#tabs-carousel-movs [aria-label='Go to slide ${targetIndex + 1}']`,
    ) as HTMLElement | null;
    if (byAria) { byAria.click(); return true; }

    const dots = Array.from(document.querySelectorAll("#tabs-carousel-movs .swiper-pagination-bullet"));
    if (dots[targetIndex]) { (dots[targetIndex] as HTMLElement).click(); return true; }

    const slides = Array.from(document.querySelectorAll("#tabs-carousel-movs .swiper-slide"));
    if (slides[targetIndex]) {
      const slide = slides[targetIndex] as HTMLElement;
      const clickable =
        (slide.querySelector(".container-account, .container-account-ccc, .container-image") as HTMLElement | null) ||
        slide;
      clickable.click();
      return true;
    }
    return false;
  }, index);

  if (!clicked) return false;
  await delay(1200);

  // Verify the correct slide activated
  const verify = async () =>
    page.evaluate(() => {
      const slides = Array.from(document.querySelectorAll("#tabs-carousel-movs .swiper-slide"));
      return slides.findIndex((s) => (s as HTMLElement).className.includes("swiper-slide-active"));
    });

  if ((await verify()) === index) return true;
  await delay(1800);
  return (await verify()) === index;
}

async function navigateToMovements(page: Page, debugLog: string[]): Promise<void> {
  // Try sidebar: Cuentas → Movimientos
  const cuentasClicked = await clickSidebarItem(
    page, [SIDEBAR.cuentas], ["cuentas"], SIDEBAR.maxX,
  );
  if (cuentasClicked) {
    debugLog.push("  Sidebar: Cuentas");
    await delay(2000);
  }

  const movClicked = await clickSidebarItem(
    page, [SIDEBAR.movimientos], ["movimientos"], SIDEBAR.maxX,
  );
  if (movClicked) {
    debugLog.push("  Sidebar: Movimientos");
    await delay(4500);
    return;
  }

  // Fallback: click account widget on dashboard
  const widgetSel = await clickWidget(page, [
    "#cuentas .box-product",
    "#cuentas .mat-ripple.box-product",
    "#cuentas .datos",
    "#cuentas .product-container .mat-ripple",
  ], 4500);
  if (widgetSel) {
    debugLog.push(`  Account widget: ${widgetSel}`);
    return;
  }

  // Last resort: TC movements widget
  const tcWidget = await clickWidget(page, [
    "#tarjetas-creditos .movement",
    "#tarjetas-creditos .menu-popup .movement",
    "#tarjetas-creditos .container-hover .movement",
  ], 4500);
  if (tcWidget) {
    debugLog.push(`  TC widget: ${tcWidget}`);
  } else {
    debugLog.push("  No direct movement entry point found from dashboard.");
  }
}

async function navigateToCreditCardSection(page: Page, debugLog: string[]): Promise<boolean> {
  // Open Tarjetas submenu
  const tarjetasClicked = await clickSidebarItem(
    page, [SIDEBAR.tarjetas], ["tarjetas"], SIDEBAR.maxX,
  );
  if (tarjetasClicked) {
    debugLog.push("  Tarjetas menu opened");
    await delay(1500);
  }

  // Click "Mis Tarjetas de Crédito"
  const tcClicked = await clickSidebarItem(
    page, SIDEBAR.misTc, ["mis tarjetas de crédito", "mis tarjetas de credito"], SIDEBAR.maxX,
  );
  if (tcClicked) {
    debugLog.push("  Opened 'Mis Tarjetas de Credito'");
    await delay(3500);
  }

  if (page.url().toLowerCase().includes("saldos_tc")) return true;

  // Fallback: dashboard TC widget
  const widget = await clickWidget(page, [
    "#tarjetas-creditos .movement",
    "#tarjetas-creditos .container-hover .movement",
    "#tarjetas-creditos .menu-popup .movement",
  ]);
  if (widget) {
    debugLog.push("  Opened TC from dashboard widget");
  }

  return page.url().toLowerCase().includes("saldos_tc");
}

function formatCardLabel(cardName?: string, last4?: string): string {
  const name = (cardName || "Tarjeta Santander").replace(/\s+/g, " ").trim();
  if (!last4) return name;
  if (name.includes(last4) || name.includes(`****${last4}`)) return name;
  return `${name} ****${last4}`;
}

function parseUsdAmount(text?: string | null): number {
  const clean = (text || "").replace(/[^0-9.,-]/g, "");
  if (!clean) return 0;
  const normalized = clean.replace(/\./g, "").replace(",", ".");
  const amount = Number.parseFloat(normalized);
  return Number.isNaN(amount) ? 0 : amount;
}

async function getActiveCreditCardSlideIndex(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const slides = Array.from(document.querySelectorAll(".container-carusel .swiper-slide"));
    return slides.findIndex((slide) => (slide as HTMLElement).className.includes("swiper-slide-active"));
  });
}

async function listCreditCardSlides(page: Page): Promise<CreditCardSlide[]> {
  const rawSlides = await page.evaluate(() => {
    const slides = Array.from(document.querySelectorAll(".container-carusel .swiper-slide"));
    return slides
      .map((slide, index) => {
        const text = (slide as HTMLElement).innerText?.replace(/\s+/g, " ").trim() || "";
        if (!text) return null;

        const cardName =
          text.match(/^(.*?)\s+Cupo Disponible/i)?.[1]?.trim() ||
          text.match(/^(.*?)\s+\$\s*[\d.,]+/i)?.[1]?.trim() ||
          "";
        const last4 = text.match(/\*\s*(\d{4})/)?.[1] || text.match(/(\d{4})(?!.*\d)/)?.[1] || "";
        return { index, cardName, last4 };
      })
      .filter((slide): slide is { index: number; cardName: string; last4: string } => Boolean(slide));
  });

  return rawSlides.map((slide) => ({
    index: slide.index,
    label: formatCardLabel(slide.cardName, slide.last4),
  }));
}

async function selectCreditCardSlide(page: Page, index: number): Promise<boolean> {
  const clicked = await page.evaluate((targetIndex: number) => {
    const byAria = document.querySelector(
      `.container-carusel [aria-label='Go to slide ${targetIndex + 1}']`,
    ) as HTMLElement | null;
    if (byAria) {
      byAria.click();
      return true;
    }

    const dots = Array.from(document.querySelectorAll(".container-carusel .swiper-pagination-bullet"));
    if (dots[targetIndex]) {
      (dots[targetIndex] as HTMLElement).click();
      return true;
    }

    const slides = Array.from(document.querySelectorAll(".container-carusel .swiper-slide"));
    if (slides[targetIndex]) {
      const slide = slides[targetIndex] as HTMLElement;
      const clickable =
        (slide.querySelector(".container-image, .container-tcr") as HTMLElement | null) ||
        slide;
      clickable.click();
      return true;
    }

    return false;
  }, index);

  if (!clicked) return false;
  await delay(1200);

  if ((await getActiveCreditCardSlideIndex(page)) === index) return true;
  await delay(1800);
  return (await getActiveCreditCardSlideIndex(page)) === index;
}

async function extractActiveCreditCardMetadata(page: Page): Promise<CreditCardBalance | null> {
  const raw = await page.evaluate(() => {
    const normalizeText = (value?: string | null) => value?.replace(/\s+/g, " ").trim() || "";
    const activeSlide = document.querySelector(
      ".container-carusel .swiper-slide.swiper-slide-active",
    ) as HTMLElement | null;
    const slideText = normalizeText(activeSlide?.innerText);

    const cardName =
      slideText.match(/^(.*?)\s+Cupo Disponible/i)?.[1]?.trim() ||
      slideText.match(/^(.*?)\s+\$\s*[\d.,]+/i)?.[1]?.trim() ||
      "";
    const last4 =
      slideText.match(/\*\s*(\d{4})/)?.[1] ||
      slideText.match(/(\d{4})(?!.*\d)/)?.[1] ||
      "";

    const sections = Array.from(
      document.querySelectorAll(".card-detail .balance__container"),
    ).map((section) => {
      const header = normalizeText(
        (section.querySelector(".header .big") as HTMLElement | null)?.innerText ||
          (section.querySelector(".header") as HTMLElement | null)?.innerText,
      );
      const text = normalizeText((section as HTMLElement).innerText);
      const available = text.match(/Disponible\s+(?:USD|\$)?\s*([\d.,]+)/i)?.[1] || null;
      const used = text.match(/Utilizado\s+(?:USD|\$)?\s*([\d.,]+)/i)?.[1] || null;
      const total = text.match(/Autorizado\s+(?:USD|\$)?\s*([\d.,]+)/i)?.[1] || null;
      const currency = header.toLowerCase().includes("dólar") || header.toLowerCase().includes("dolar")
        ? "USD"
        : "CLP";

      return { header, available, used, total, currency };
    });

    const bodyText = normalizeText(document.body?.innerText);
    const billingPeriod =
      bodyText.match(/Periodo de facturaci[oó]n\s+([^\n]+)/i)?.[1]?.trim() || null;
    const nextBillingDate =
      bodyText.match(
        /Pr[oó]xima facturaci[oó]n\s+(\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?|\d{1,2}\s+[A-Za-záéíóúñ]+\s+\d{4})/i,
      )?.[1] || null;

    return { cardName, last4, sections, billingPeriod, nextBillingDate };
  });

  const label = formatCardLabel(raw.cardName, raw.last4);
  const card: CreditCardBalance = { label };

  for (const section of raw.sections) {
    if (!section.available && !section.used && !section.total) continue;

    if (section.currency === "USD") {
      card.international = {
        used: Math.abs(parseUsdAmount(section.used)),
        available: parseUsdAmount(section.available),
        total: parseUsdAmount(section.total),
        currency: "USD",
      };
      continue;
    }

    card.national = {
      used: Math.abs(parseChileanAmount(section.used || "0")),
      available: parseChileanAmount(section.available || "0"),
      total: parseChileanAmount(section.total || "0"),
    };
  }

  if (!card.national && !card.international) return null;
  if (raw.billingPeriod) card.billingPeriod = raw.billingPeriod;
  if (raw.nextBillingDate) card.nextBillingDate = raw.nextBillingDate;
  return card;
}

async function extractCreditCardMetadata(page: Page, debugLog: string[]): Promise<CreditCardBalance[]> {
  const slides = await listCreditCardSlides(page);
  const activeIndex = await getActiveCreditCardSlideIndex(page);
  const seen = new Set<string>();
  const creditCards: CreditCardBalance[] = [];

  const captureCurrentSlide = async (slide: CreditCardSlide | null) => {
    const metadata = await extractActiveCreditCardMetadata(page);
    if (!metadata) return;

    const key = `${metadata.label}|${metadata.national?.total ?? ""}|${metadata.international?.total ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    creditCards.push(metadata);

    const national =
      metadata.national
        ? `CLP total=$${metadata.national.total.toLocaleString("es-CL")}, used=$${metadata.national.used.toLocaleString("es-CL")}, available=$${metadata.national.available.toLocaleString("es-CL")}`
        : "sin cupo CLP";
    const international =
      metadata.international
        ? `USD total=${metadata.international.total}, used=${metadata.international.used}, available=${metadata.international.available}`
        : "sin cupo USD";

    debugLog.push(`  TC metadata${slide ? ` [${slide.label}]` : ""}: ${national}; ${international}`);
  };

  if (slides.length === 0) {
    await captureCurrentSlide(null);
    return creditCards;
  }

  for (const slide of slides) {
    const switched = slide.index === activeIndex || (await selectCreditCardSlide(page, slide.index));
    if (!switched) {
      debugLog.push(`  Could not switch to credit card slide ${slide.index + 1}: ${slide.label}`);
      continue;
    }
    await captureCurrentSlide(slide);
  }

  if (activeIndex >= 0) {
    await selectCreditCardSlide(page, activeIndex);
  }

  return creditCards;
}

type LastStatementRaw = {
  billingDate?: string;
  billedAmount?: number;
  dueDate?: string;
  minimumPayment?: number;
};

const MONTH_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
] as const;

function normalizeDateDashes(value?: string | null): string | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!match) return undefined;
  const [, dd, mm, yy] = match;
  const year = yy.length === 2 ? `20${yy}` : yy;
  return `${dd.padStart(2, "0")}-${mm.padStart(2, "0")}-${year}`;
}

function billingPeriodFromDate(billingDate?: string): string | undefined {
  if (!billingDate) return undefined;
  const match = billingDate.match(/^\d{2}-(\d{2})-(\d{4})$/);
  if (!match) return undefined;
  const monthIdx = Number.parseInt(match[1], 10) - 1;
  const year = match[2];
  if (monthIdx < 0 || monthIdx > 11) return undefined;
  return `${MONTH_NAMES[monthIdx]} ${year}`;
}

async function waitForStatementRender(page: Page, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      const txt = document.body?.innerText?.replace(/\s+/g, " ") || "";
      return /Monto\s*total\s*facturado|Pagar\s*hasta/i.test(txt);
    });
    if (ready) return true;
    await delay(500);
  }
  return false;
}

async function extractLastStatement(page: Page): Promise<LastStatementRaw> {
  return await page.evaluate(() => {
    const normalize = (value?: string | null) => value?.replace(/\s+/g, " ").trim() || "";
    const bodyText = normalize(document.body?.innerText);
    const dateRe = /(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/;
    const amountRe = /\$\s*([\d.,]+)/;

    // Text-based matcher near a label. Keep the window tight (default 40)
    // so we don't accidentally pair a label with the next section's value —
    // e.g. "Fecha facturación" jumping ahead to "Pagar hasta 08/05/2026".
    const nearLabel = (labelRe: string, valueRe: RegExp, windowChars = 40): string | null => {
      const re = new RegExp(`${labelRe}[\\s\\S]{0,${windowChars}}?${valueRe.source}`, "i");
      return bodyText.match(re)?.[1] || null;
    };

    // Billing date lives inside an Angular Material mat-select; its selected
    // value is rendered in a `.mat-select-min-line` span that is NOT reflected
    // in document.body.innerText. Find the first such span whose text looks
    // like a date.
    const billingDateFromDom = (() => {
      for (const el of document.querySelectorAll<HTMLElement>(".mat-select-min-line")) {
        const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(txt)) return txt;
      }
      return null;
    })();

    const billingDate = billingDateFromDom;
    const dueDate = nearLabel("Pagar\\s*hasta", dateRe);
    const billedAmountRaw = nearLabel("Monto\\s*total\\s*facturado", amountRe, 80);
    const minimumPaymentRaw = nearLabel("Pago\\s*M[ií]nimo(?:\\s*del\\s*mes)?", amountRe, 80);

    const parseAmount = (raw: string | null): number | null => {
      if (!raw) return null;
      const clean = raw.replace(/[^0-9.,-]/g, "").replace(/\./g, "").replace(",", ".");
      const n = Number.parseFloat(clean);
      return Number.isNaN(n) ? null : Math.round(n);
    };

    return {
      billingDate: billingDate || undefined,
      dueDate: dueDate || undefined,
      billedAmount: parseAmount(billedAmountRaw) ?? undefined,
      minimumPayment: parseAmount(minimumPaymentRaw) ?? undefined,
    };
  });
}

function applyLastStatement(card: CreditCardBalance, raw: LastStatementRaw): boolean {
  const billingDate = normalizeDateDashes(raw.billingDate);
  const dueDate = normalizeDateDashes(raw.dueDate);
  if (!billingDate || !dueDate || raw.billedAmount === undefined) return false;

  card.lastStatement = {
    billingDate,
    billedAmount: raw.billedAmount,
    dueDate,
    ...(raw.minimumPayment !== undefined ? { minimumPayment: raw.minimumPayment } : {}),
  };
  if (!card.nextDueDate) card.nextDueDate = dueDate;
  if (!card.billingPeriod) {
    const derived = billingPeriodFromDate(billingDate);
    if (derived) card.billingPeriod = derived;
  }
  return true;
}

// ─── Main scrape function ────────────────────────────────────────────

async function scrapeSantander(
  session: BrowserSession,
  options: ScraperOptions,
): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots, onProgress } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const bank = "santander";
  const progress = onProgress || (() => {});

  // Install API interceptor before first page.goto()
  const interceptor = await createInterceptor(page, [
    { id: "santander-checking", urlPrefix: SANTANDER_CHECKING_API_PREFIX },
    { id: "santander-credit-card-unbilled", urlPrefix: SANTANDER_CC_API_PREFIX },
    { id: "santander-credit-card-billed", urlPrefix: SANTANDER_CC_BILLED_API_PREFIX },
  ]);

  // 1. Navigate
  debugLog.push("1. Navigating to Santander...");
  progress("Abriendo sitio del banco...");
  await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(2000);
  await dismissBanners(page);
  await doSave(page, "01-homepage");

  // 2. Open login
  debugLog.push("2. Opening login form...");
  const loginOpened =
    (await page.$eval("#btnIngresar", (el) => {
      (el as HTMLElement).click();
      return true;
    }).catch(() => false)) ||
    (await clickByText(page, [
      "ingresar", "acceso clientes", "banco en linea", "iniciar sesión", "iniciar sesion",
    ]));

  if (!loginOpened) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró el botón de ingreso.", screenshot: ss as string, debug: debugLog.join("\n") };
  }

  await delay(3500);
  await doSave(page, "02-login");

  // Detect login iframe
  const loginFrame = await getLoginFrame(page);
  const ctx = loginFrame || page;
  if (loginFrame) {
    debugLog.push("  Login iframe detectado.");
  }

  // Wait for login inputs
  try {
    await ctx.waitForSelector("#rut", { timeout: 15000 });
    await ctx.waitForSelector("#pass", { timeout: 15000 });
  } catch {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No cargaron los campos de login (#rut/#pass).", screenshot: ss as string, debug: debugLog.join("\n") };
  }

  // 3-5. Login
  debugLog.push("3. Filling RUT...");
  progress("Ingresando RUT...");
  const rutOk = await fillRut(ctx, rut, LOGIN_SELECTORS);
  if (!rutOk) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró campo de RUT.", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(3500);

  debugLog.push("4. Filling password...");
  const passOk = await fillPassword(ctx, password, LOGIN_SELECTORS);
  if (!passOk) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró campo de clave.", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(700);

  debugLog.push("5. Submitting login...");
  progress("Iniciando sesión...");
  await clickSubmit(ctx, page, LOGIN_SELECTORS);
  await delay(7000);
  await doSave(page, "03-post-login");

  // 2FA check
  if (await detect2FA(page, TWO_FACTOR_CONFIG)) {
    const approved = await waitFor2FA(page, debugLog, TWO_FACTOR_CONFIG);
    await doSave(page, "03b-after-2fa");
    if (!approved) {
      const ss = await page.screenshot({ encoding: "base64" });
      return { success: false, bank, accounts: [], error: "Timeout esperando aprobación de 2FA.", screenshot: ss as string, debug: debugLog.join("\n") };
    }
  }

  // Login error check
  const loginError = await detectLoginError(page, await getLoginFrame(page));
  if (loginError) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: `Error del banco: ${loginError}`, screenshot: ss as string, debug: debugLog.join("\n") };
  }

  debugLog.push("6. Login OK.");
  progress("Sesión iniciada correctamente");
  await closePopups(page);

  // 7. Navigate to movements
  debugLog.push("7. Navigating to movements...");
  progress("Extrayendo movimientos de cuenta...");
  await navigateToMovements(page, debugLog);
  await delay(4000);
  await doSave(page, "04-movements");

  // Multi-account handling
  const accounts = await listMovementAccounts(page);
  if (accounts.length > 0) {
    debugLog.push(`  Accounts: ${accounts.map((a) => a.label).join(" | ")}`);
  }

  let movements: BankMovement[] = [];

  // Try API interception for checking account
  const checkingCaptures = await interceptor.waitFor("santander-checking", 10_000);
  if (checkingCaptures.length > 0) {
    debugLog.push(`  Checking API: ${checkingCaptures.length} response(s) captured`);
    const apiMovements = normalizeSantanderCheckingApiMovements(checkingCaptures);
    debugLog.push(`  Checking API movements: ${apiMovements.length}`);
    if (apiMovements.length > 0) {
      movements.push(...apiMovements);
    }
  }

  if (movements.length === 0) {
    debugLog.push("  Checking API: no data, falling back to HTML extraction");
    if (accounts.length <= 1) {
      movements = await paginateAndExtract(page, extractAccountMovements, debugLog);
    } else {
      for (const account of accounts) {
        const switched = await selectMovementAccount(page, account.index);
        if (!switched) {
          debugLog.push(`  Could not switch to ${account.label}`);
          continue;
        }
        const acctMovements = await paginateAndExtract(page, extractAccountMovements, debugLog);
        movements.push(...acctMovements);
        debugLog.push(`  ${account.label}: ${acctMovements.length} movement(s)`);
      }
    }
  }
  movements = deduplicateMovements(movements);

  let balance: number | undefined;
  const withBalance = movements.find((m) => m.balance > 0);
  if (withBalance) {
    balance = withBalance.balance;
    debugLog.push(`  Balance from account movements: $${balance.toLocaleString("es-CL")}`);
  }
  if (balance === undefined || balance === 0) {
    balance = await extractBalance(page);
    if (balance !== undefined) {
      debugLog.push(`  Balance from account page: $${balance.toLocaleString("es-CL")}`);
    }
  }

  // 7b. Credit card movements
  debugLog.push("7b. Navigating to credit card movements...");
  progress("Extrayendo movimientos de tarjeta de crédito...");
  let creditCards: CreditCardBalance[] | undefined;
  const tcReady = await navigateToCreditCardSection(page, debugLog);
  if (tcReady) {
    const metadata = await extractCreditCardMetadata(page, debugLog);
    if (metadata.length > 0) {
      creditCards = metadata;
    }

    if (await clickTcTab(page, "movimientos por facturar")) {
      const unbilledCaptures = await interceptor.waitFor("santander-credit-card-unbilled", 10_000);
      if (unbilledCaptures.length > 0) {
        const unbilledMovements = normalizeSantanderUnbilledApiMovements(unbilledCaptures);
        movements.push(...unbilledMovements);
        debugLog.push(`  CC API (unbilled): ${unbilledMovements.length} movement(s)`);
      } else {
        debugLog.push("  CC API (unbilled): no data, falling back to HTML extraction");
        const unbilled = await extractCreditCardMovements(page, "unbilled");
        movements.push(...unbilled);
        debugLog.push(`  TC por facturar: ${unbilled.length} movement(s)`);
      }
    }
    if (await clickTcTab(page, "movimientos facturados")) {
      const billedCaptures = await interceptor.waitFor("santander-credit-card-billed", 10_000);
      if (billedCaptures.length > 0) {
        const billedMovements = normalizeSantanderBilledApiMovements(billedCaptures);
        movements.push(...billedMovements);
        debugLog.push(`  CC API (billed): ${billedMovements.length} movement(s)`);
      } else {
        debugLog.push("  CC API (billed): no data, falling back to HTML extraction");
        const billed = await extractCreditCardMovements(page, "billed");
        movements.push(...billed);
        debugLog.push(`  TC facturados: ${billed.length} movement(s)`);
      }

      if (creditCards && creditCards.length > 0) {
        // Re-select the "movimientos facturados" tab. The API interception
        // above captures movements without requiring the UI to stay on the
        // tab — but the billing summary (statement info) is only rendered
        // inside that tab's view, and other actions (carousel nav, tab
        // switching) can push the UI back to "Mi Tarjeta" before we extract.
        await clickTcTab(page, "movimientos facturados");
        const rendered = await waitForStatementRender(page);
        if (!rendered) {
          debugLog.push(`  Statement anchor text did not appear within 10s`);
        }
        const statementRaw = await extractLastStatement(page);
        const card = creditCards[0];
        if (applyLastStatement(card, statementRaw)) {
          debugLog.push(
            `  Last statement [${card.label}]: billed=$${card.lastStatement!.billedAmount.toLocaleString("es-CL")}, ` +
            `billingDate=${card.lastStatement!.billingDate}, dueDate=${card.lastStatement!.dueDate}` +
            (card.lastStatement!.minimumPayment !== undefined
              ? `, min=$${card.lastStatement!.minimumPayment.toLocaleString("es-CL")}`
              : ""),
          );
        } else {
          debugLog.push(
            `  Last statement [${card.label}]: partial (billingDate=${statementRaw.billingDate ?? "—"}, ` +
            `dueDate=${statementRaw.dueDate ?? "—"}, billed=${statementRaw.billedAmount ?? "—"}, ` +
            `min=${statementRaw.minimumPayment ?? "—"})`,
          );
        }
      }
    }
  } else {
    debugLog.push("  Could not open credit card section.");
  }
  movements = deduplicateMovements(movements);

  debugLog.push(`8. Extracted ${movements.length} movement(s)`);
  progress(`Listo — ${movements.length} movimientos totales`);
  debugLog.push(balance !== undefined ? `9. Balance: $${balance.toLocaleString("es-CL")}` : "9. Balance not found");

  await doSave(page, "05-final");
  const ss = doScreenshots ? ((await page.screenshot({ encoding: "base64", fullPage: true })) as string) : undefined;

  return {
    success: true,
    bank,
    accounts: [{ balance, movements }],
    creditCards: creditCards?.length ? creditCards : undefined,
    screenshot: ss,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────────────

const santander: BankScraper = {
  id: "santander",
  name: "Banco Santander",
  url: BANK_URL,
  scrape: (options) => runScraper("santander", options, {}, scrapeSantander),
};

export default santander;
