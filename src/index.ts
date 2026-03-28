import bancosecurity from "./banks/bancosecurity.js";
import bchile from "./banks/bchile.js";
import bci from "./banks/bci.js";
import bestado from "./banks/bestado.js";
import bice from "./banks/bice.js";
import edwards from "./banks/edwards.js";
import falabella from "./banks/falabella.js";
import itau from "./banks/itau.js";
import santander from "./banks/santander.js";
import scotiabank from "./banks/scotiabank.js";
import type { BankScraper } from "./types.js";

/** Registro de todos los bancos disponibles */
export const banks: Record<string, BankScraper> = {
  bancosecurity,
  bchile,
  bci,
  bestado,
  bice,
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
  MovementSource,
  CardOwner,
  BankScraper,
  BankCredentials,
  ScrapeResult,
  ScraperOptions,
  CreditCardBalance,
} from "./types.js";

export { MOVEMENT_SOURCE, CARD_OWNER } from "./types.js";

// Re-export individual banks for direct import
export { default as bchile } from "./banks/bchile.js";
export { default as bci } from "./banks/bci.js";
export { default as bestado } from "./banks/bestado.js";
export { default as bice } from "./banks/bice.js";
export { default as edwards } from "./banks/edwards.js";
export { default as falabella } from "./banks/falabella.js";
export { default as itau } from "./banks/itau.js";
export { default as santander } from "./banks/santander.js";
export { default as bancosecurity } from "./banks/bancosecurity.js";
export { default as scotiabank } from "./banks/scotiabank.js";
