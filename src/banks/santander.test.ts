import { describe, it, expect } from "vitest";
import { MOVEMENT_SOURCE } from "../types.js";
import {
  isSaldoInicial,
  normalizeSantanderCheckingApiMovements,
  normalizeSantanderUnbilledApiMovements,
  normalizeSantanderBilledApiMovements,
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
