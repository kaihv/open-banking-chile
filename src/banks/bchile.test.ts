import { describe, expect, it } from "vitest";

import { isBchileDepositAccount } from "./bchile.js";

describe("isBchileDepositAccount", () => {
  it("includes cuenta corriente and vista product types", () => {
    expect(
      isBchileDepositAccount({
        tipo: "cuentaCorrienteMonedaLocal",
        descripcionLogo: "Cuenta Corriente",
        numero: "1",
        mascara: "****2706",
        codigo: "x",
        codigoMoneda: "CLP",
        claseCuenta: "",
        label: "",
        tarjetaHabiente: null,
        tipoCliente: "",
      }),
    ).toBe(true);

    expect(
      isBchileDepositAccount({
        tipo: "cuentaVistaMonedaLocal",
        descripcionLogo: "Cuenta Vista",
        numero: "2",
        mascara: "****1234",
        codigo: "y",
        codigoMoneda: "CLP",
        claseCuenta: "",
        label: "",
        tarjetaHabiente: null,
        tipoCliente: "",
      }),
    ).toBe(true);
  });

  it("includes products identified by descripcionLogo", () => {
    expect(
      isBchileDepositAccount({
        tipo: "other",
        descripcionLogo: "Cuenta Vista",
        numero: "2",
        mascara: "****1234",
        codigo: "y",
        codigoMoneda: "CLP",
        claseCuenta: "",
        label: "",
        tarjetaHabiente: null,
        tipoCliente: "",
      }),
    ).toBe(true);
  });

  it("excludes credit card products", () => {
    expect(
      isBchileDepositAccount({
        tipo: "tarjetaCredito",
        descripcionLogo: "Visa Platinum",
        numero: "3",
        mascara: "****9999",
        codigo: "z",
        codigoMoneda: "CLP",
        claseCuenta: "",
        label: "",
        tarjetaHabiente: null,
        tipoCliente: "",
      }),
    ).toBe(false);
  });
});
