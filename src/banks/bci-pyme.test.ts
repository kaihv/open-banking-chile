import { describe, it, expect } from "vitest";
import { MOVEMENT_SOURCE } from "../types.js";
import { normalizeMovements, isoToDate } from "./bci-pyme.js";

describe("isoToDate", () => {
  it("converts YYYY-MM-DD to dd-mm-yyyy", () => {
    expect(isoToDate("2026-06-19")).toBe("19-06-2026");
  });

  it("ignores a trailing time portion", () => {
    expect(isoToDate("2026-06-19T11:04:00")).toBe("19-06-2026");
  });

  it("passes through unrecognized formats unchanged", () => {
    expect(isoToDate("06/19/2026")).toBe("06/19/2026");
  });
});

describe("normalizeMovements", () => {
  it("returns empty array when there are no movimientos", () => {
    expect(normalizeMovements({})).toEqual([]);
    expect(normalizeMovements({ movimientos: [] })).toEqual([]);
  });

  it("parses a cargo (tipo=C → negative amount) using fechaContable", () => {
    const result = normalizeMovements({
      movimientos: [
        { fechaMovimiento: "06/19/2026", fechaContable: "2026-06-19", descripcion: "Pago proveedor demo", monto: "12345.0000", saldoContable: 1000000, tipo: "C" },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(-12345);
    expect(result[0].date).toBe("19-06-2026");
    expect(result[0].description).toBe("Pago proveedor demo");
    expect(result[0].balance).toBe(1000000);
    expect(result[0].source).toBe(MOVEMENT_SOURCE.account);
  });

  it("parses an abono (tipo=A → positive amount)", () => {
    const result = normalizeMovements({
      movimientos: [
        { fechaContable: "2026-06-15", descripcion: "Abono demo", monto: "50000.0000", saldoContable: 1050000, tipo: "A" },
      ],
    });
    expect(result[0].amount).toBe(50000);
    expect(result[0].amount).toBeGreaterThan(0);
  });

  it("rounds fractional montos to the nearest integer", () => {
    const result = normalizeMovements({
      movimientos: [{ fechaContable: "2026-01-01", descripcion: "x", monto: "1499.9", tipo: "C" }],
    });
    expect(result[0].amount).toBe(-1500);
  });

  it("skips movements with zero or NaN monto", () => {
    const result = normalizeMovements({
      movimientos: [
        { fechaContable: "2026-01-01", descripcion: "zero", monto: "0", tipo: "C" },
        { fechaContable: "2026-01-01", descripcion: "nan", monto: "abc", tipo: "A" },
      ],
    });
    expect(result).toHaveLength(0);
  });

  it("defaults balance to 0 when saldoContable is missing", () => {
    const result = normalizeMovements({
      movimientos: [{ fechaContable: "2026-01-01", descripcion: "x", monto: "1000", tipo: "A" }],
    });
    expect(result[0].balance).toBe(0);
  });
});
