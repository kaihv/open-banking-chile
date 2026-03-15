import bchile from "./banks/bchile";
import bci from "./banks/bci";
import bice from "./banks/bice";
import cmr from "./banks/cmr";
import itau from "./banks/itau";
import edwards from "./banks/edwards";
import falabella from "./banks/falabella";
import santander from "./banks/santander";
import scotiabank from "./banks/scotiabank";
import type { BankScraper } from "./types";

/** Registro de todos los bancos disponibles */
export const banks: Record<string, BankScraper> = {
  bchile,
  bci,
  bice,
  cmr,
  edwards,
  falabella,
  itau,
  santander,
  scotiabank,
};

/** Lista de bancos soportados */
export function listBanks(): Array<{ id: string; name: string; url: string }> {
  return Object.values(banks).map((b) => ({
    id: b.id,
    name: b.name,
    url: b.url,
  }));
}

/** Obtener un scraper por ID */
export function getBank(id: string): BankScraper | undefined {
  return banks[id];
}

// Re-export types
export type {
  BankMovement,
  BankScraper,
  BankCredentials,
  ScrapeResult,
  ScraperOptions,
  CreditCardBalance,
} from "./types";

// Re-export individual banks for direct import
export { default as bchile } from "./banks/bchile";
export { default as bci } from "./banks/bci";
export { default as bice } from "./banks/bice";
export { default as cmr } from "./banks/cmr";
export { default as edwards } from "./banks/edwards";
export { default as falabella } from "./banks/falabella";
export { default as itau } from "./banks/itau";
export { default as santander } from "./banks/santander";
export { default as scotiabank } from "./banks/scotiabank";
