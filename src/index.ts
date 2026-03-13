import bchile from "./banks/bchile";
import bice from "./banks/bice";
import edwards from "./banks/edwards";
import falabella from "./banks/falabella";
import santander from "./banks/santander";
import type { BankScraper } from "./types";

/** Registro de todos los bancos disponibles */
export const banks: Record<string, BankScraper> = {
  bchile,
  bice,
  edwards,
  falabella,
  santander,
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
} from "./types";

// Re-export individual banks for direct import
export { default as bchile } from "./banks/bchile";
export { default as bice } from "./banks/bice";
export { default as edwards } from "./banks/edwards";
export { default as falabella } from "./banks/falabella";
export { default as santander } from "./banks/santander";
