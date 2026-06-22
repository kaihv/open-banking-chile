import { describe, it, expect, vi } from "vitest";
import { MOVEMENT_SOURCE } from "../types.js";
import {
  isSaldoInicial,
  normalizeSantanderCheckingApiMovements,
  normalizeSantanderUnbilledApiMovements,
  normalizeSantanderBilledApiMovements,
  parseUsdAmount,
  creditCardDedupKey,
  buildCreditCardFromRaw,
} from "./santander.js";

// ─── isSaldoInicial ──────────────────────────────────────────────

describe("isSaldoInicial", () => {
  it("matches exact casing", () => {
    expect(isSaldoInicial("Saldo Inicial")).toBe(true);
  });

  it("matches lower case", () => {
    expect(isSaldoInicial("saldo inicial")).toBe(true);
  });

  it("matches upper case", () => {
    expect(isSaldoInicial("SALDO INICIAL")).toBe(true);
  });

  it("matches with extra whitespace between words", () => {
    expect(isSaldoInicial("saldo  inicial")).toBe(true);
  });

  it("does not match regular transactions", () => {
    expect(isSaldoInicial("Compra supermercado")).toBe(false);
    expect(isSaldoInicial("Pago tarjeta")).toBe(false);
    expect(isSaldoInicial("saldo disponible")).toBe(false);
  });
});

// ─── normalizeSantanderCheckingApiMovements ──────────────────────

describe("normalizeSantanderCheckingApiMovements", () => {
  it("returns empty array for empty captures", () => {
    expect(normalizeSantanderCheckingApiMovements([])).toEqual([]);
  });

  it("skips captures without a movements array", () => {
    expect(normalizeSantanderCheckingApiMovements([{ other: "data" }])).toEqual([]);
    expect(normalizeSantanderCheckingApiMovements([null])).toEqual([]);
  });

  it("parses a debit movement (chargePaymentFlag=D)", () => {
    const capture = {
      movements: [
        {
          transactionDate: "2026-01-15",
          movementAmount: "00000300000",
          chargePaymentFlag: "D",
          observation: "Supermercado Lider",
          expandedCode: "",
        },
      ],
    };
    const result = normalizeSantanderCheckingApiMovements([capture]);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBeLessThan(0);
    expect(result[0].description).toBe("Supermercado Lider");
    expect(result[0].source).toBe(MOVEMENT_SOURCE.account);
    // normalizeDate doesn't handle YYYY-MM-DD (no regex match), passes through as-is
    expect(result[0].date).toBe("2026-01-15");
  });

  it("parses a credit movement (chargePaymentFlag=H)", () => {
    const capture = {
      movements: [
        {
          transactionDate: "2026-02-10",
          movementAmount: "00000500000",
          chargePaymentFlag: "H",
          observation: "Depósito sueldo",
          expandedCode: "",
        },
      ],
    };
    const result = normalizeSantanderCheckingApiMovements([capture]);
    expect(result[0].amount).toBeGreaterThan(0);
  });

  it("detects debit from trailing minus sign when flag is missing", () => {
    const capture = {
      movements: [
        {
          transactionDate: "2026-03-01",
          movementAmount: "00000100000-",
          chargePaymentFlag: "H", // contradictory — trailing minus wins via original logic
          observation: "Cargo",
          expandedCode: "",
        },
      ],
    };
    const result = normalizeSantanderCheckingApiMovements([capture]);
    // The trailing '-' takes precedence in the original logic
    expect(result[0].amount).toBeLessThan(0);
  });

  it("converts centavos to pesos (divides by 100)", () => {
    const capture = {
      movements: [
        {
          transactionDate: "2026-01-01",
          movementAmount: "00000500000", // 500000 centavos = 5000 pesos
          chargePaymentFlag: "D",
          observation: "Test",
          expandedCode: "",
        },
      ],
    };
    const result = normalizeSantanderCheckingApiMovements([capture]);
    expect(result[0].amount).toBe(-5000);
  });

  it("extracts balance from newBalance field", () => {
    const capture = {
      movements: [
        {
          transactionDate: "2026-01-01",
          movementAmount: "00000100000",
          chargePaymentFlag: "D",
          observation: "Test",
          expandedCode: "",
          newBalance: "10000000", // 10_000_000 centavos = 100_000 pesos
        },
      ],
    };
    const result = normalizeSantanderCheckingApiMovements([capture]);
    // 10_000_000 centavos / 100 = 100_000 pesos
    expect(result[0].balance).toBe(100000);
  });

  it("falls back to expandedCode when observation is empty", () => {
    const capture = {
      movements: [
        {
          transactionDate: "2026-01-01",
          movementAmount: "00000100000",
          chargePaymentFlag: "D",
          observation: "",
          expandedCode: "Descripción expandida",
        },
      ],
    };
    const result = normalizeSantanderCheckingApiMovements([capture]);
    expect(result[0].description).toBe("Descripción expandida");
  });

  it("skips movements with zero or invalid amount", () => {
    const capture = {
      movements: [
        {
          transactionDate: "2026-01-01",
          movementAmount: "00000000000",
          chargePaymentFlag: "D",
          observation: "Zero",
          expandedCode: "",
        },
      ],
    };
    expect(normalizeSantanderCheckingApiMovements([capture])).toHaveLength(0);
  });

  it("accumulates movements across multiple captures", () => {
    const makeCapture = (obs: string) => ({
      movements: [
        { transactionDate: "2026-01-01", movementAmount: "00000100000", chargePaymentFlag: "D", observation: obs, expandedCode: "" },
      ],
    });
    const result = normalizeSantanderCheckingApiMovements([makeCapture("A"), makeCapture("B")]);
    expect(result).toHaveLength(2);
  });
});

// ─── normalizeSantanderUnbilledApiMovements ──────────────────────

describe("normalizeSantanderUnbilledApiMovements", () => {
  it("returns empty array for empty captures", () => {
    expect(normalizeSantanderUnbilledApiMovements([])).toEqual([]);
  });

  it("parses a debit CC movement (IndicadorDebeHaber=D)", () => {
    const capture = {
      DATA: {
        MatrizMovimientos: [
          { Fecha: "15/01/2026", Comercio: "Netflix", Descripcion: "", Importe: "15.990", IndicadorDebeHaber: "D" },
        ],
      },
    };
    const result = normalizeSantanderUnbilledApiMovements([capture]);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(-15990);
    expect(result[0].description).toBe("Netflix");
    expect(result[0].source).toBe(MOVEMENT_SOURCE.credit_card_unbilled);
    expect(result[0].date).toBe("15-01-2026");
    expect(result[0].balance).toBe(0);
  });

  it("parses a credit movement (IndicadorDebeHaber=H)", () => {
    const capture = {
      DATA: {
        MatrizMovimientos: [
          { Fecha: "20/01/2026", Comercio: "Nota crédito", Descripcion: "", Importe: "5.000", IndicadorDebeHaber: "H" },
        ],
      },
    };
    const result = normalizeSantanderUnbilledApiMovements([capture]);
    expect(result[0].amount).toBeGreaterThan(0);
  });

  it("falls back to Descripcion when Comercio is empty", () => {
    const capture = {
      DATA: {
        MatrizMovimientos: [
          { Fecha: "01/02/2026", Comercio: "", Descripcion: "Pago online", Importe: "1.000", IndicadorDebeHaber: "D" },
        ],
      },
    };
    const result = normalizeSantanderUnbilledApiMovements([capture]);
    expect(result[0].description).toBe("Pago online");
  });

  it("filters out Saldo Inicial rows", () => {
    const capture = {
      DATA: {
        MatrizMovimientos: [
          { Fecha: "01/01/2026", Comercio: "Saldo Inicial", Descripcion: "", Importe: "100.000", IndicadorDebeHaber: "D" },
          { Fecha: "02/01/2026", Comercio: "Tienda", Descripcion: "", Importe: "5.000", IndicadorDebeHaber: "D" },
        ],
      },
    };
    const result = normalizeSantanderUnbilledApiMovements([capture]);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("Tienda");
  });

  it("skips captures with missing or malformed DATA path", () => {
    expect(normalizeSantanderUnbilledApiMovements([{}])).toEqual([]);
    expect(normalizeSantanderUnbilledApiMovements([{ DATA: {} }])).toEqual([]);
    expect(normalizeSantanderUnbilledApiMovements([{ DATA: { MatrizMovimientos: null } }])).toEqual([]);
  });

  it("skips movements with zero amount", () => {
    const capture = {
      DATA: {
        MatrizMovimientos: [
          { Fecha: "01/01/2026", Comercio: "Zero", Descripcion: "", Importe: "0", IndicadorDebeHaber: "D" },
        ],
      },
    };
    expect(normalizeSantanderUnbilledApiMovements([capture])).toHaveLength(0);
  });
});

// ─── normalizeSantanderBilledApiMovements ────────────────────────

describe("normalizeSantanderBilledApiMovements", () => {
  const makeCapture = (overrides: object[]) => ({
    DATA: {
      AS_TIB_WM02_CONEstCtaNacional_Response: {
        OUTPUT: {
          Matriz: overrides,
        },
      },
    },
  });

  it("returns empty array for empty captures", () => {
    expect(normalizeSantanderBilledApiMovements([])).toEqual([]);
  });

  it("parses a regular purchase (negative amount)", () => {
    const capture = makeCapture([
      { FechaTxs: "2026-01-20", NombreComercio: "Farmacia Cruz Verde", MontoTxs: "0000025000", NumeroCuotas: "00", TotalCuotas: "00" },
    ]);
    const result = normalizeSantanderBilledApiMovements([capture]);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(-25000);
    expect(result[0].description).toBe("Farmacia Cruz Verde");
    expect(result[0].source).toBe(MOVEMENT_SOURCE.credit_card_billed);
    // normalizeDate doesn't handle YYYY-MM-DD (no regex match), passes through as-is
    expect(result[0].date).toBe("2026-01-20");
    expect(result[0].balance).toBe(0);
  });

  it("treats 'Monto Cancelado' as a positive payment", () => {
    const capture = makeCapture([
      { FechaTxs: "2026-01-25", NombreComercio: "Monto Cancelado", MontoTxs: "0000200000", NumeroCuotas: "00", TotalCuotas: "00" },
    ]);
    const result = normalizeSantanderBilledApiMovements([capture]);
    expect(result[0].amount).toBeGreaterThan(0);
    expect(result[0].amount).toBe(200000);
  });

  it("parses Chilean thousands format (dots as separators)", () => {
    const capture = makeCapture([
      { FechaTxs: "2026-02-01", NombreComercio: "Compra", MontoTxs: "50.000", NumeroCuotas: "00", TotalCuotas: "00" },
    ]);
    const result = normalizeSantanderBilledApiMovements([capture]);
    expect(result[0].amount).toBe(-50000);
  });

  it("includes installments field when TotalCuotas > 0", () => {
    const capture = makeCapture([
      { FechaTxs: "2026-01-10", NombreComercio: "Notebook", MontoTxs: "0000100000", NumeroCuotas: "01", TotalCuotas: "06" },
    ]);
    const result = normalizeSantanderBilledApiMovements([capture]);
    expect(result[0].installments).toBe("01/06");
  });

  it("omits installments field when TotalCuotas is 0", () => {
    const capture = makeCapture([
      { FechaTxs: "2026-01-10", NombreComercio: "Café", MontoTxs: "0000003500", NumeroCuotas: "00", TotalCuotas: "00" },
    ]);
    const result = normalizeSantanderBilledApiMovements([capture]);
    expect(result[0].installments).toBeUndefined();
  });

  it("filters out Saldo Inicial rows", () => {
    const capture = makeCapture([
      { FechaTxs: "2026-01-01", NombreComercio: "Saldo Inicial", MontoTxs: "0000050000", NumeroCuotas: "00", TotalCuotas: "00" },
      { FechaTxs: "2026-01-05", NombreComercio: "Amazon", MontoTxs: "0000029990", NumeroCuotas: "00", TotalCuotas: "00" },
    ]);
    const result = normalizeSantanderBilledApiMovements([capture]);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("Amazon");
  });

  it("skips movements with zero amount", () => {
    const capture = makeCapture([
      { FechaTxs: "2026-01-01", NombreComercio: "Zero", MontoTxs: "0000000000", NumeroCuotas: "00", TotalCuotas: "00" },
    ]);
    expect(normalizeSantanderBilledApiMovements([capture])).toHaveLength(0);
  });

  it("skips captures with missing nested path", () => {
    expect(normalizeSantanderBilledApiMovements([{}])).toEqual([]);
    expect(normalizeSantanderBilledApiMovements([{ DATA: {} }])).toEqual([]);
  });
});

// ─── parseUsdAmount ──────────────────────────────────────────────

describe("parseUsdAmount", () => {
  it("parses Chilean-formatted USD amounts (. thousands, , decimals)", () => {
    expect(parseUsdAmount("USD 1.234,56")).toBeCloseTo(1234.56);
    expect(parseUsdAmount("$ 2.000,00")).toBe(2000);
    expect(parseUsdAmount("500,50")).toBeCloseTo(500.5);
  });

  it("returns 0 for empty/null without warning (no USD section is normal)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseUsdAmount(null)).toBe(0);
    expect(parseUsdAmount(undefined)).toBe(0);
    expect(parseUsdAmount("")).toBe(0);
    expect(parseUsdAmount("   ")).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns and returns 0 when a non-empty value cannot be parsed (format change)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseUsdAmount("N/A")).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("formato inesperado");
    warn.mockRestore();
  });
});

// ─── creditCardDedupKey ──────────────────────────────────────────

describe("creditCardDedupKey", () => {
  it("keeps twin cards (same product/balance, different last4) apart", () => {
    const a = { label: "Mastercard Black ****1234", national: { used: 0, available: 0, total: 1_000_000 } };
    const b = { label: "Mastercard Black ****5678", national: { used: 0, available: 0, total: 1_000_000 } };
    expect(creditCardDedupKey(a)).not.toBe(creditCardDedupKey(b));
  });

  it("collapses swiper clones (identical last4)", () => {
    const a = { label: "Visa Gold ****4321", national: { used: 0, available: 0, total: 500_000 } };
    const clone = { label: "Visa Gold ****4321", national: { used: 1, available: 2, total: 500_000 } };
    expect(creditCardDedupKey(a)).toBe(creditCardDedupKey(clone));
  });

  it("falls back to label+totals when no last4 is present", () => {
    const a = { label: "Tarjeta Santander", national: { used: 0, available: 0, total: 100 } };
    const b = { label: "Tarjeta Santander", national: { used: 0, available: 0, total: 200 } };
    expect(creditCardDedupKey(a)).not.toBe(creditCardDedupKey(b));
    expect(creditCardDedupKey(a)).toBe(creditCardDedupKey({ ...a }));
  });
});

// ─── buildCreditCardFromRaw (selector parsing smoke test) ────────

describe("buildCreditCardFromRaw", () => {
  it("parses at least one card with national + international cupo", () => {
    const card = buildCreditCardFromRaw({
      cardName: "Mastercard Black",
      last4: "5824",
      sections: [
        { header: "Cupo Nacional", available: "700.000", used: "300.000", total: "1.000.000", currency: "CLP" },
        { header: "Cupo en Dólares", available: "1.500,00", used: "500,00", total: "2.000,00", currency: "USD" },
      ],
      billingPeriod: "Febrero 2026",
      nextBillingDate: "05-03-2026",
    });
    expect(card).not.toBeNull();
    expect(card!.label).toBe("Mastercard Black ****5824");
    expect(card!.national).toEqual({ used: 300_000, available: 700_000, total: 1_000_000 });
    expect(card!.international).toEqual({ used: 500, available: 1500, total: 2000, currency: "USD" });
    expect(card!.billingPeriod).toBe("Febrero 2026");
    expect(card!.nextBillingDate).toBe("05-03-2026");
  });

  it("returns null when no cupo section yields data (selectors broke)", () => {
    const card = buildCreditCardFromRaw({
      cardName: "Visa",
      last4: "0000",
      sections: [{ header: "", available: null, used: null, total: null, currency: "CLP" }],
      billingPeriod: null,
      nextBillingDate: null,
    });
    expect(card).toBeNull();
  });
});
