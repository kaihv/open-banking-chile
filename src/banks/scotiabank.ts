import puppeteer, { type Page } from "puppeteer-core";
import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, findChrome, saveScreenshot, normalizeDate, parseChileanAmount, deduplicateMovements, logout } from "../utils.js";

const BANK_URL = "https://www.scotiabank.cl";

// ─── Login helpers ─────────────────────────────────────────────

async function fillRut(page: Page, rut: string): Promise<boolean> {
  // Scotiabank validates RUT without dots: "12345678-9" format
  const clean = rut.replace(/[.\-]/g, "");
  const rutNoDots = `${clean.slice(0, -1)}-${clean.slice(-1)}`;

  // Primary selectors: known Scotiabank field IDs/names
  const selectors = [
    "#inputDni",
    'input[name="inputDni"]',
    'input[id*="Dni"]',
    'input[name*="Dni"]',
    'input[name*="rut"]',
    'input[id*="rut"]',
    'input[placeholder*="RUT"]',
    'input[placeholder*="Rut"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(rutNoDots, { delay: 50 });
        return true;
      }
    } catch { /* try next */ }
  }

  // Fallback: first visible non-password text input
  try {
    const filled = await page.evaluate((rutVal: string) => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      for (const input of inputs) {
        const el = input as HTMLInputElement;
        if (el.offsetParent !== null && !el.disabled) {
          el.focus();
          el.value = rutVal;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      return false;
    }, rutNoDots);
    if (filled) return true;
  } catch { /* continue */ }

  return false;
}

async function fillPassword(page: Page, password: string): Promise<boolean> {
  // Primary selectors: known Scotiabank field IDs/names
  const selectors = [
    "#inputPassword",
    'input[name="inputPassword"]',
    'input[id*="Password"]',
    'input[name*="Password"]',
    'input[type="password"]',
    'input[name*="pass"]',
    'input[id*="pass"]',
    'input[name*="clave"]',
    'input[id*="clave"]',
    'input[placeholder*="Clave"]',
    'input[placeholder*="Contraseña"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await el.type(password, { delay: 50 });
        return true;
      }
    } catch { /* try next */ }
  }

  return false;
}

async function clickSubmitButton(page: Page): Promise<void> {
  const selectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button[class*="login"]',
    'button[class*="submit"]',
    'button[id*="login"]',
    'button[id*="submit"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); return; }
    } catch { /* try next */ }
  }

  const texts = ["Ingresar", "Iniciar sesión", "Entrar", "Login", "Continuar", "Acceder"];
  for (const text of texts) {
    try {
      const clicked = await page.evaluate((t: string) => {
        const buttons = Array.from(document.querySelectorAll("button, input[type='submit'], a"));
        for (const btn of buttons) {
          if ((btn as HTMLElement).innerText?.trim().toLowerCase() === t.toLowerCase()) {
            (btn as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, text);
      if (clicked) return;
    } catch { /* try next */ }
  }

  await page.keyboard.press("Enter");
}

// ─── Navigation ────────────────────────────────────────────────

async function tryExpandDateRange(page: Page, debugLog: string[]): Promise<void> {
  try {
    const selectInfo = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      return selects.map((sel, i) => ({
        index: i,
        name: sel.name || sel.id || `select-${i}`,
        options: Array.from(sel.querySelectorAll("option")).map((o) => ({
          text: o.text.trim(), value: o.value, selected: o.selected,
        })),
      }));
    });

    for (const sel of selectInfo) {
      for (const opt of sel.options) {
        const text = opt.text.toLowerCase();
        if (text.includes("todos") || text.includes("último mes") || text.includes("30 día") || text.includes("mes anterior")) {
          await page.evaluate((selIdx: number, optValue: string) => {
            const selects = document.querySelectorAll("select");
            const select = selects[selIdx] as HTMLSelectElement;
            if (select) {
              select.value = optValue;
              select.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }, sel.index, opt.value);
          debugLog.push(`  Changed [${sel.name}] to "${opt.text}"`);
          await delay(3000);
          break;
        }
      }
    }

    const clickedSearch = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, input[type='submit']"));
      for (const btn of buttons) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
        if (text === "buscar" || text === "consultar" || text === "filtrar") {
          (btn as HTMLElement).click();
          return text;
        }
      }
      return null;
    });

    if (clickedSearch) {
      debugLog.push(`  Clicked "${clickedSearch}" button`);
      await delay(3000);
    }
  } catch { /* ignore */ }
}

async function waitForDashboardContent(page: Page): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const hasContent = await page.evaluate(() => {
      function allDeep(root: Element | ShadowRoot | Document, sel: string): Element[] {
        const out: Element[] = Array.from(root.querySelectorAll(sel));
        for (const el of Array.from(root.querySelectorAll("*"))) {
          if ((el as Element & { shadowRoot?: ShadowRoot }).shadowRoot) {
            out.push(...allDeep((el as Element & { shadowRoot: ShadowRoot }).shadowRoot, sel));
          }
        }
        return out;
      }
      return allDeep(document, "a, button, span").some((el) => {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
        return text === "ver cartola" || text === "cuenta corriente";
      });
    });
    if (hasContent) break;
    await delay(1500);
  }
}

/** Dismiss Scotiabank's onboarding tutorial popup (1 de N / Continuar) */
async function dismissScotiaTutorial(page: Page, debugLog: string[]): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const dismissed = await page.evaluate(() => {
      function allDeep(root: Element | ShadowRoot | Document, sel: string): Element[] {
        const out: Element[] = Array.from(root.querySelectorAll(sel));
        for (const el of Array.from(root.querySelectorAll("*"))) {
          if ((el as Element & { shadowRoot?: ShadowRoot }).shadowRoot) {
            out.push(...allDeep((el as Element & { shadowRoot: ShadowRoot }).shadowRoot, sel));
          }
        }
        return out;
      }
      for (const el of allDeep(document, "button, a, span")) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
        if (text === "continuar" || text === "terminar" || text === "cerrar" || text === "omitir" || text === "saltar") {
          (el as HTMLElement).click();
          return text;
        }
      }
      return null;
    });
    if (!dismissed) break;
    debugLog.push(`  Tutorial dismissed: "${dismissed}"`);
    await delay(600);
  }
}

/**
 * Navigate to the full cartola page via the sidebar Cuentas submenu, then
 * click the "anterior" period control. Returns false when navigation fails.
 */
async function navigateToPreviousPeriod(
  page: Page,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>,
  stepIndex: number
): Promise<boolean> {
  // Step A: expand sidebar "Cuentas >"
  const expandedCuentas = await page.evaluate(() => {
    function allDeep(root: Element | ShadowRoot | Document, sel: string): Element[] {
      const out: Element[] = Array.from(root.querySelectorAll(sel));
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if ((el as Element & { shadowRoot?: ShadowRoot }).shadowRoot) {
          out.push(...allDeep((el as Element & { shadowRoot: ShadowRoot }).shadowRoot, sel));
        }
      }
      return out;
    }
    // Target the sidebar item (typically has an arrow/chevron) — prefer the nav element
    for (const el of allDeep(document, "nav a, nav button, nav li, nav span, aside a, aside button, aside li, aside span")) {
      const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (text === "cuentas") { (el as HTMLElement).click(); return true; }
    }
    // Broader fallback
    for (const el of allDeep(document, "a, button, li, span")) {
      const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (text === "cuentas") { (el as HTMLElement).click(); return true; }
    }
    return false;
  });
  if (expandedCuentas) {
    debugLog.push("  Sidebar: expanded Cuentas");
    await delay(2000);
  }

  // Step B: click "Cartola" / "Movimientos" / "Cuenta Corriente" submenu item
  const subTargets = ["cartola", "movimientos cuenta", "cuenta corriente", "movimientos"];
  let enteredCartola = false;
  for (const target of subTargets) {
    const clicked = await page.evaluate((t: string) => {
      function allDeep(root: Element | ShadowRoot | Document, sel: string): Element[] {
        const out: Element[] = Array.from(root.querySelectorAll(sel));
        for (const el of Array.from(root.querySelectorAll("*"))) {
          if ((el as Element & { shadowRoot?: ShadowRoot }).shadowRoot) {
            out.push(...allDeep((el as Element & { shadowRoot: ShadowRoot }).shadowRoot, sel));
          }
        }
        return out;
      }
      for (const el of allDeep(document, "a, button, [role='menuitem'], li, span")) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
        if (text.includes(t) && text.length < 80) {
          (el as HTMLElement).click();
          return `"${text}"`;
        }
      }
      return null;
    }, target);
    if (clicked) {
      debugLog.push(`  Sidebar: clicked submenu ${clicked}`);
      await delay(5000);
      enteredCartola = true;
      break;
    }
  }

  await doSave(page, `period-${stepIndex}-cartola`);

  if (!enteredCartola) {
    debugLog.push("  Could not find cartola submenu item");
    return false;
  }

  // Step C: click "Consultar Movimientos Anteriores" — search page + all frames + shadow DOM
  const targets = ["movimientos anteriores", "consultar movimientos", "consultar cartolas"];

  let clickedMovAnt: string | null = null;

  // Try main page first
  clickedMovAnt = await page.evaluate((tgts: string[]) => {
    function allDeep(root: Element | ShadowRoot | Document, sel: string): Element[] {
      const out: Element[] = Array.from(root.querySelectorAll(sel));
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if ((el as Element & { shadowRoot?: ShadowRoot }).shadowRoot) {
          out.push(...allDeep((el as Element & { shadowRoot: ShadowRoot }).shadowRoot, sel));
        }
      }
      return out;
    }
    for (const t of tgts) {
      for (const el of allDeep(document, "a, button, span, [role='tab'], [role='link'], li")) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
        if (text.includes(t) && text.length < 80) {
          (el as HTMLElement).click();
          return `"${text}"`;
        }
      }
    }
    return null;
  }, targets);

  // If not found in main page, try all child frames
  if (!clickedMovAnt) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        clickedMovAnt = await frame.evaluate((tgts: string[]) => {
          function allDeep(root: Element | ShadowRoot | Document, sel: string): Element[] {
            const out: Element[] = Array.from(root.querySelectorAll(sel));
            for (const el of Array.from(root.querySelectorAll("*"))) {
              if ((el as Element & { shadowRoot?: ShadowRoot }).shadowRoot) {
                out.push(...allDeep((el as Element & { shadowRoot: ShadowRoot }).shadowRoot, sel));
              }
            }
            return out;
          }
          for (const t of tgts) {
            for (const el of allDeep(document, "a, button, span, [role='tab'], [role='link'], li")) {
              const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
              if (text.includes(t) && text.length < 80) {
                (el as HTMLElement).click();
                return `"${text}" (frame)`;
              }
            }
          }
          return null;
        }, targets);
        if (clickedMovAnt) break;
      } catch { /* detached frame */ }
    }
  }

  // Debug: log visible text snippets from body if still not found
  if (!clickedMovAnt) {
    const bodySnippet = await page.evaluate(() =>
      (document.body?.innerText || "").substring(0, 500)
    );
    debugLog.push(`  Page text snippet: ${bodySnippet.replace(/\n/g, " | ").substring(0, 200)}`);
    debugLog.push("  No 'Consultar Movimientos Anteriores' link found");
    return false;
  }

  debugLog.push(`  Clicked: ${clickedMovAnt}`);
  await delay(4000);
  await doSave(page, `period-${stepIndex}-form`);

  return true;
}

/** Fill date range form for historical movements and submit.
 *  Scotiabank uses split fields (idd/imm/iaa, fdd/fmm/faa) inside an iframe.
 *  startDate / endDate format: "dd/mm/yyyy"
 */
async function fillAndSubmitDateRange(
  page: Page,
  startDate: string,
  endDate: string,
  debugLog: string[]
): Promise<boolean> {
  const [sd, sm, sy] = startDate.split("/");
  const [ed, em, ey] = endDate.split("/");

  // Find the frame that contains the date form (has >= 4 visible text inputs)
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];

  for (const frame of frames) {
    try {
      // Check if this frame has the date form inputs
      const inputNames = await frame.evaluate(() => {
        const inputs = Array.from(
          document.querySelectorAll('input[type="text"], input:not([type])')
        ).filter((el) => {
          const inp = el as HTMLInputElement;
          return inp.offsetParent !== null && !inp.disabled;
        });
        return inputs.map((el) => (el as HTMLInputElement).name || (el as HTMLInputElement).id || "?");
      }).catch(() => [] as string[]);

      if (inputNames.length < 4) continue;
      debugLog.push(`  Form frame has inputs: ${inputNames.join(", ")}`);

      // Fill by name (idd/imm/iaa = inicio day/month/year; fdd/fmm/faa = fin day/month/year)
      const filled = await frame.evaluate(
        (vals: Record<string, string>) => {
          function setVal(el: HTMLInputElement, val: string) {
            el.focus();
            el.value = val;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.blur();
          }

          const inputs = Array.from(
            document.querySelectorAll('input[type="text"], input:not([type])')
          ).filter((el) => {
            const inp = el as HTMLInputElement;
            return inp.offsetParent !== null && !inp.disabled;
          }) as HTMLInputElement[];

          let filled = 0;
          for (const inp of inputs) {
            const key = inp.name || inp.id;
            if (key && key in vals) {
              setVal(inp, vals[key]);
              filled++;
            }
          }

          // Fallback: if none matched by name, fill positionally (first 6 in order)
          if (filled === 0 && inputs.length >= 6) {
            const order = ["sd", "sm", "sy", "ed", "em", "ey"];
            for (let i = 0; i < 6; i++) setVal(inputs[i], vals[order[i]]);
            return "positional";
          }

          return filled > 0 ? `by-name:${filled}` : "none";
        },
        { idd: sd, imm: sm, iaa: sy, fdd: ed, fmm: em, faa: ey, sd, sm, sy, ed, em, ey }
      );

      debugLog.push(`  Fill result: ${filled}`);
      if (filled === "none") continue;

      await delay(500);

      // Click the submit button (Aceptar or similar) — broaden selector for classic HTML forms
      const submitted = await frame.evaluate(() => {
        // Log all clickable elements for debugging
        const allClickable = Array.from(
          document.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="image"], a[href="#"]')
        );
        // Try exact match first
        for (const el of allClickable) {
          const text = ((el as HTMLElement).innerText?.trim() || (el as HTMLInputElement).value || (el as HTMLInputElement).alt || "").toLowerCase();
          if (text === "aceptar" || text === "buscar" || text === "consultar" || text === "enviar") {
            (el as HTMLElement).click();
            return `exact:${text}`;
          }
        }
        // Try any submit-type input
        for (const el of allClickable) {
          const inp = el as HTMLInputElement;
          if (inp.type === "submit" || inp.type === "image") {
            inp.click();
            return `type:${inp.type}`;
          }
        }
        // Try any button/input with "acept" in value/text
        const all = Array.from(document.querySelectorAll("button, input, a"));
        for (const el of all) {
          const text = ((el as HTMLElement).innerText?.trim() || (el as HTMLInputElement).value || "").toLowerCase();
          if (text.includes("acept") || text.includes("buscar") || text.includes("consultar")) {
            (el as HTMLElement).click();
            return `partial:${text}`;
          }
        }
        return `none (${allClickable.length} clickable els found)`;
      });

      debugLog.push(`  Submit result: ${submitted}`);
      if (submitted && !submitted.startsWith("none")) {
        debugLog.push(`  Submitted form "${submitted}": ${startDate} → ${endDate}`);
        await delay(6000);
        return true;
      }

      debugLog.push("  Could not find submit button in frame");
    } catch { /* detached frame */ }
  }

  debugLog.push(`  Could not fill date range (${startDate} → ${endDate})`);
  return false;
}

async function navigateToMovements(page: Page, debugLog: string[]): Promise<void> {
  await waitForDashboardContent(page);

  // Scotiabank dashboard shows "Ver cartola" — pierce Shadow DOM to find and click it
  const clickedCartola = await page.evaluate(() => {
    function allDeep(root: Element | ShadowRoot | Document, sel: string): Element[] {
      const out: Element[] = Array.from(root.querySelectorAll(sel));
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if ((el as Element & { shadowRoot?: ShadowRoot }).shadowRoot) {
          out.push(...allDeep((el as Element & { shadowRoot: ShadowRoot }).shadowRoot, sel));
        }
      }
      return out;
    }
    for (const el of allDeep(document, "a, button, span")) {
      const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (text === "ver cartola" || text === "ver saldo y movimientos") {
        (el as HTMLElement).click();
        return `Clicked: "${text}"`;
      }
    }
    return null;
  });
  if (clickedCartola) {
    debugLog.push(`  ${clickedCartola}`);
    await delay(5000);
    return;
  }

  // Fallback: sidebar Cuentas → submenu (also piercing Shadow DOM)
  const clickedCuentas = await page.evaluate(() => {
    function allDeep(root: Element | ShadowRoot | Document, sel: string): Element[] {
      const out: Element[] = Array.from(root.querySelectorAll(sel));
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if ((el as Element & { shadowRoot?: ShadowRoot }).shadowRoot) {
          out.push(...allDeep((el as Element & { shadowRoot: ShadowRoot }).shadowRoot, sel));
        }
      }
      return out;
    }
    for (const el of allDeep(document, "a, button, li, span")) {
      const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (text === "cuentas") { (el as HTMLElement).click(); return true; }
    }
    return false;
  });
  if (clickedCuentas) {
    debugLog.push("  Clicked: Cuentas (sidebar)");
    await delay(2500);
  }

  const subTargets = ["cartola", "movimientos", "últimos movimientos", "estado de cuenta"];
  for (const target of subTargets) {
    const clicked = await page.evaluate((t: string) => {
      function allDeep(root: Element | ShadowRoot | Document, sel: string): Element[] {
        const out: Element[] = Array.from(root.querySelectorAll(sel));
        for (const el of Array.from(root.querySelectorAll("*"))) {
          if ((el as Element & { shadowRoot?: ShadowRoot }).shadowRoot) {
            out.push(...allDeep((el as Element & { shadowRoot: ShadowRoot }).shadowRoot, sel));
          }
        }
        return out;
      }
      for (const el of allDeep(document, "a, button, [role='menuitem'], li, span")) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
        if (text.includes(t) && text.length < 60) {
          (el as HTMLElement).click();
          return `Clicked: "${text}"`;
        }
      }
      return null;
    }, target);
    if (clicked) {
      debugLog.push(`  ${clicked}`);
      await delay(5000);
      return;
    }
  }
}

// ─── Extraction ────────────────────────────────────────────────

type RawMovement = { date: string; description: string; amount: string; balance: string };

/** Extract raw movements from a single frame/page context */
async function extractRaw(ctx: { evaluate: Page["evaluate"] }): Promise<RawMovement[]> {
  return ctx.evaluate(() => {
    function allDeep(root: Element | ShadowRoot | Document, sel: string): Element[] {
      const out: Element[] = Array.from(root.querySelectorAll(sel));
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if ((el as Element & { shadowRoot?: ShadowRoot }).shadowRoot) {
          out.push(...allDeep((el as Element & { shadowRoot: ShadowRoot }).shadowRoot, sel));
        }
      }
      return out;
    }

    const results: Array<{ date: string; description: string; amount: string; balance: string }> = [];

    // Strategy 1: Traditional tables with Fecha/Cargo/Abono/Saldo headers
    const tables = allDeep(document, "table") as HTMLTableElement[];
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

        const headerTexts = Array.from(headers).map((h) => (h as HTMLElement).innerText?.trim().toLowerCase() || "");
        if (!headerTexts.some((h) => h.includes("fecha"))) continue;

        hasHeader = true;
        dateIndex = headerTexts.findIndex((h) => h.includes("fecha"));
        descriptionIndex = headerTexts.findIndex((h) => h.includes("descrip") || h.includes("detalle") || h.includes("glosa"));
        cargoIndex = headerTexts.findIndex((h) => h.includes("cargo") || h.includes("débito") || h.includes("debito"));
        abonoIndex = headerTexts.findIndex((h) => h.includes("abono") || h.includes("crédito") || h.includes("credito"));
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

    // Strategy 2: SPA movement card/list components (also pierce shadow DOM)
    if (results.length === 0) {
      const cards = allDeep(document, "[class*='mov'], [class*='tran'], [class*='transaction'], li, article");
      for (const card of cards) {
        const text = (card as HTMLElement).innerText || "";
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
        if (lines.length < 3 || lines.length > 10) continue;

        const date = lines.find((l) => /\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/.test(l));
        const amount = lines.find((l) => /[$]\s*[\d.]+/.test(l));
        if (!date || !amount) continue;

        const description = lines.find((l) => l !== date && l !== amount && l.length > 3) || "";
        const balance = lines.find((l) => l.toLowerCase().includes("saldo") && /[$]\s*[\d.]+/.test(l)) || "";

        const isCargo = text.toLowerCase().includes("cargo") || text.toLowerCase().includes("débito") || text.toLowerCase().includes("debito") || amount.includes("-");
        const normalizedAmount = isCargo
          ? (amount.startsWith("-") ? amount : `-${amount}`)
          : amount;

        results.push({ date, description, amount: normalizedAmount, balance });
      }
    }

    return results;
  });
}

function parseRawMovements(rawMovements: RawMovement[]): BankMovement[] {
  const seen = new Set<string>();
  return rawMovements
    .map((m) => {
      const amount = parseChileanAmount(m.amount);
      if (amount === 0) return null;
      const balance = m.balance ? parseChileanAmount(m.balance) : 0;
      return {
        date: normalizeDate(m.date),
        description: m.description,
        amount,
        balance,
        source: MOVEMENT_SOURCE.account,
      } as BankMovement;
    })
    .filter((m): m is BankMovement => {
      if (!m) return false;
      const key = `${m.date}|${m.description}|${m.amount}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Extract movements from page + all child frames */
async function extractMovements(page: Page): Promise<BankMovement[]> {
  const contexts: Array<{ evaluate: Page["evaluate"] }> = [page];
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame()) contexts.push(frame as unknown as { evaluate: Page["evaluate"] });
  }

  const allRaw: RawMovement[] = [];
  for (const ctx of contexts) {
    try {
      const raw = await extractRaw(ctx);
      allRaw.push(...raw);
    } catch { /* detached frame */ }
  }
  return parseRawMovements(allRaw);
}

async function paginateAndExtract(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  const allMovements: BankMovement[] = [];

  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    const movements = await extractMovements(page);
    allMovements.push(...movements);

    const urlBefore = page.url();

    const nextClicked = await page.evaluate(() => {
      function allDeep(root: Element | ShadowRoot | Document, sel: string): Element[] {
        const out: Element[] = Array.from(root.querySelectorAll(sel));
        for (const el of Array.from(root.querySelectorAll("*"))) {
          if ((el as Element & { shadowRoot?: ShadowRoot }).shadowRoot) {
            out.push(...allDeep((el as Element & { shadowRoot: ShadowRoot }).shadowRoot, sel));
          }
        }
        return out;
      }
      const candidates = allDeep(document, "button, a, [role='button']");
      for (const btn of candidates) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || "";
        if (!text.includes("siguiente") && !text.includes("ver más") && !text.includes("mostrar más") && text !== "›" && text !== ">") continue;
        const disabled =
          (btn as HTMLButtonElement).disabled ||
          btn.getAttribute("aria-disabled") === "true" ||
          (btn as HTMLElement).classList.contains("disabled");
        if (disabled) return false;
        (btn as HTMLElement).click();
        return true;
      }
      return false;
    });

    if (!nextClicked) break;

    await delay(3000);

    // If the URL changed significantly after clicking "Siguiente", we left the
    // movements section (e.g. a banner carousel navigated us elsewhere). Stop.
    const urlAfter = page.url();
    const pathBefore = new URL(urlBefore).pathname.split("/").slice(0, 6).join("/");
    const pathAfter = new URL(urlAfter).pathname.split("/").slice(0, 6).join("/");
    if (pathBefore !== pathAfter) {
      debugLog.push(`  Pagination stopped: URL changed (${urlAfter})`);
      break;
    }

    debugLog.push(`  Pagination: loaded page ${pageIndex + 2}`);
  }

  const seen = new Set<string>();
  return allMovements.filter((m) => {
    const key = `${m.date}|${m.description}|${m.amount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Main scraper ──────────────────────────────────────────────

async function scrape(options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, chromePath, saveScreenshots: doScreenshots, headful } = options;
  const bank = "scotiabank";

  if (!rut || !password) {
    return { success: false, bank, movements: [], error: "Debes proveer RUT y clave." };
  }

  const executablePath = findChrome(chromePath);
  if (!executablePath) {
    return {
      success: false, bank, movements: [],
      error: "No se encontró Chrome/Chromium. Instala Google Chrome o pasa chromePath en las opciones.\n  Ubuntu/Debian: sudo apt install google-chrome-stable\n  macOS: brew install --cask google-chrome",
    };
  }

  let browser;
  const debugLog: string[] = [];
  const doSave = async (page: Page, name: string) => saveScreenshot(page, name, !!doScreenshots, debugLog);

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: !headful,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=1280,900",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // Step 1: Navigate to homepage
    debugLog.push("1. Navigating to Scotiabank...");
    await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 30000 });
    await delay(2000);

    // Dismiss cookie banners / popups
    try {
      await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll("button, a, span"));
        for (const btn of candidates) {
          const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
          if (text === "aceptar" || text === "entendido" || text === "cerrar" || text === "continuar") {
            (btn as HTMLElement).click();
          }
        }
      });
      await delay(1000);
    } catch { /* no banner */ }

    await doSave(page, "01-homepage");

    // Step 2: Click login button
    debugLog.push("2. Clicking login button...");
    const loginClicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("a, button"));
      for (const el of candidates) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
        const href = (el as HTMLAnchorElement).href || "";
        if (
          text === "ingresar" ||
          text === "acceso clientes" ||
          text === "banca en línea" ||
          text === "banca en linea" ||
          text.includes("iniciar sesión") ||
          text.includes("iniciar sesion") ||
          href.includes("login") ||
          href.includes("auth")
        ) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    });

    if (!loginClicked) {
      debugLog.push("  No login button found on homepage, trying direct navigation...");
      // Scotiabank may redirect directly to login form — continue anyway
    }

    await delay(4000);
    await doSave(page, "02-login-form");

    // Step 3: Fill RUT (field name: inputDni)
    debugLog.push("3. Filling RUT (inputDni)...");
    const rutFilled = await fillRut(page, rut);
    if (!rutFilled) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        success: false, bank, movements: [],
        error: `No se encontró campo de RUT (inputDni) en ${page.url()}`,
        screenshot: screenshot as string,
        debug: debugLog.join("\n"),
      };
    }
    await delay(1000);

    // Step 4: Fill password (field name: inputPassword)
    debugLog.push("4. Filling password (inputPassword)...");
    let passwordFilled = await fillPassword(page, password);
    if (!passwordFilled) {
      // Some banks show password field only after RUT is submitted
      await page.keyboard.press("Enter");
      await delay(3000);
      await doSave(page, "02b-after-rut");
      passwordFilled = await fillPassword(page, password);
    }
    if (!passwordFilled) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        success: false, bank, movements: [],
        error: `No se encontró campo de clave (inputPassword) en ${page.url()}`,
        screenshot: screenshot as string,
        debug: debugLog.join("\n"),
      };
    }
    await delay(800);

    // Step 5: Submit login
    debugLog.push("5. Submitting login...");
    await clickSubmitButton(page);
    await delay(8000);
    await doSave(page, "03-after-login");

    // Check 2FA
    const pageContent = (await page.content()).toLowerCase();
    if (
      pageContent.includes("clave dinámica") ||
      pageContent.includes("clave dinamica") ||
      pageContent.includes("segundo factor") ||
      pageContent.includes("código de verificación") ||
      pageContent.includes("token")
    ) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        success: false, bank, movements: [],
        error: "El banco pide clave dinámica o 2FA. No se puede automatizar este paso.",
        screenshot: screenshot as string,
        debug: debugLog.join("\n"),
      };
    }

    // Check login errors — only flag messages that look like auth failures
    const authErrorPattern = /(error|incorrect|inv[aá]lid|rechazad|bloquead|fall[oó]|intenta nuevamente|credencial|autentic|clave.*(err[oó]nea|incorrecta)|rut.*(err[oó]neo|incorrecto)|ingresa un rut)/i;
    const errorCheck = await page.evaluate(() => {
      const errorEls = document.querySelectorAll('[class*="error"], [class*="alert"], [role="alert"], [class*="Error"]');
      const texts: string[] = [];
      for (const el of errorEls) {
        const text = (el as HTMLElement).innerText?.trim();
        if (text && text.length > 5 && text.length < 200) texts.push(text);
      }
      return texts;
    });
    const authError = errorCheck.find((t) => authErrorPattern.test(t));
    if (authError) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        success: false, bank, movements: [],
        error: `Error del banco: ${authError}`,
        screenshot: screenshot as string,
        debug: debugLog.join("\n"),
      };
    }

    debugLog.push(`6. Login OK!`);

    // Step 6: Close popups + Scotia tutorial
    await closePopups(page);
    await dismissScotiaTutorial(page, debugLog);

    // Step 7: Navigate to cartola
    debugLog.push("7. Looking for Cartola/Movimientos...");
    await navigateToMovements(page, debugLog);
    await dismissScotiaTutorial(page, debugLog);
    await doSave(page, "04-movements-page");

    // Step 8: Expand date range if possible
    await tryExpandDateRange(page, debugLog);

    // Step 9: Extract current period movements (with pagination)
    const movements = await paginateAndExtract(page, debugLog);
    debugLog.push(`9. Extracted ${movements.length} movements (current period)`);

    // Step 10: Historical periods via SCOTIABANK_MONTHS
    const monthsStr = process.env.SCOTIABANK_MONTHS || "0";
    const months = Math.min(Math.max(parseInt(monthsStr, 10) || 0, 0), 12);

    if (months > 0) {
      debugLog.push(`10. Fetching ${months} additional period(s)...`);
      const now = new Date();

      for (let m = 0; m < months; m++) {
        await dismissScotiaTutorial(page, debugLog);

        const navOk = await navigateToPreviousPeriod(page, debugLog, doSave, m + 1);
        if (!navOk) {
          debugLog.push(`  Could not navigate to period form at step ${m + 1}, stopping.`);
          await doSave(page, `period-${m + 1}-notfound`);
          break;
        }

        // Calculate date range: first → last day of (current month - (m+1))
        const target = new Date(now.getFullYear(), now.getMonth() - (m + 1), 1);
        const firstDay = new Date(target.getFullYear(), target.getMonth(), 1);
        const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0);
        const fmt = (d: Date) =>
          `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
        const startDate = fmt(firstDay);
        const endDate = fmt(lastDay);

        const formOk = await fillAndSubmitDateRange(page, startDate, endDate, debugLog);
        if (!formOk) {
          debugLog.push(`  Date range form failed for period ${m + 1}`);
          await doSave(page, `period-${m + 1}-form-error`);
          break;
        }

        await doSave(page, `period-${m + 1}-results`);
        const periodMovements = await paginateAndExtract(page, debugLog);
        debugLog.push(`  Period -${m + 1} (${startDate}–${endDate}): ${periodMovements.length} movements`);
        movements.push(...periodMovements);
      }
    }

    // Deduplicate
    const deduplicated = deduplicateMovements(movements);
    debugLog.push(`  Total: ${deduplicated.length} unique movements`);

    // Step 11: Get balance
    let balance: number | undefined;
    if (deduplicated.length > 0 && deduplicated[0].balance > 0) {
      balance = deduplicated[0].balance;
    } else {
      balance = await page.evaluate(() => {
        const bodyText = document.body?.innerText || "";
        const patterns = [
          /saldo disponible[\s\S]{0,50}\$\s*([\d.]+)/i,
          /saldo actual[\s\S]{0,50}\$\s*([\d.]+)/i,
        ];
        for (const pattern of patterns) {
          const match = bodyText.match(pattern);
          if (match) return parseInt(match[1].replace(/[^0-9]/g, ""), 10);
        }
        return undefined;
      });
    }

    await doSave(page, "05-final");
    const screenshot = doScreenshots ? ((await page.screenshot({ encoding: "base64", fullPage: true })) as string) : undefined;

    return {
      success: true,
      bank,
      movements: deduplicated,
      balance: balance ?? undefined,
      screenshot,
      debug: debugLog.join("\n"),
    };
  } catch (error) {
    return {
      success: false, bank, movements: [],
      error: `Error del scraper: ${error instanceof Error ? error.message : String(error)}`,
      debug: debugLog.join("\n"),
    };
  } finally {
    if (browser) {
      try {
        const pages = await browser.pages();
        if (pages.length > 0) await logout(pages[pages.length - 1], debugLog);
      } catch { /* best effort */ }
      await browser.close().catch(() => {});
    }
  }
}

// ─── Export ────────────────────────────────────────────────────

const scotiabank: BankScraper = {
  id: "scotiabank",
  name: "Scotiabank Chile",
  url: "https://www.scotiabank.cl",
  scrape,
};

export default scotiabank;
