import { describe, expect, it } from "vitest";
import { MOVEMENT_SOURCE } from "../types.js";
import { currencyFromBchileCode, facturadoToMovement, noFacturadoToMovement } from "./bchile.js";

describe("currencyFromBchileCode", () => {
  it("maps Banco de Chile numeric ISO currency codes", () => {
    expect(currencyFromBchileCode(840)).toBe("USD");
    expect(currencyFromBchileCode("978")).toBe("EUR");
  });

  it("keeps CLP implicit for backwards compatibility", () => {
    expect(currencyFromBchileCode(152)).toBeUndefined();
    expect(currencyFromBchileCode("152")).toBeUndefined();
  });

  it("ignores missing or unknown codes", () => {
    expect(currencyFromBchileCode(undefined)).toBeUndefined();
    expect(currencyFromBchileCode(999)).toBeUndefined();
  });
});

describe("noFacturadoToMovement", () => {
  it("preserves the original currency for international unbilled credit card movements", () => {
    const movement = noFacturadoToMovement({
      origenTransaccion: "INT",
      fechaTransaccionString: "01/05/2026",
      codigoMonedaOrigen: 840,
      glosaTransaccion: "GOOGLE *CLOUD wBWSZ COMPRAS INT.VI",
      montoCompra: 6.08,
      montoMonedaOrigen: "6.08",
      despliegueCuotas: "01/01",
    }, "****1234");

    expect(movement).toMatchObject({
      date: "01-05-2026",
      description: "GOOGLE *CLOUD wBWSZ COMPRAS INT.VI",
      amount: -6.08,
      currency: "USD",
      balance: 0,
      source: MOVEMENT_SOURCE.credit_card_unbilled,
      card: "****1234",
      installments: "01/01",
    });
  });

  it("does not add currency for local CLP unbilled movements", () => {
    const movement = noFacturadoToMovement({
      origenTransaccion: "NAC",
      fechaTransaccionString: "02/05/2026",
      codigoMonedaOrigen: 152,
      glosaTransaccion: "SUPERMERCADO",
      montoCompra: 10000,
      despliegueCuotas: "01/01",
    });

    expect(movement.currency).toBeUndefined();
    expect(movement.amount).toBe(-10000);
  });
});

describe("facturadoToMovement", () => {
  it("can annotate billed international credit card movements as USD", () => {
    const movement = facturadoToMovement({
      fechaTransaccionString: "03/05/2026",
      montoTransaccion: 12.5,
      descripcion: "AMAZON.COM",
      cuotas: "01/01",
      grupo: "compras",
    }, MOVEMENT_SOURCE.credit_card_billed, "****9876", "USD");

    expect(movement).toMatchObject({
      amount: -12.5,
      currency: "USD",
      source: MOVEMENT_SOURCE.credit_card_billed,
      card: "****9876",
    });
  });
});
