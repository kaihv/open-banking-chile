/** Origen del movimiento */
export const MOVEMENT_SOURCE = {
  account: "account",
  credit_card_unbilled: "credit_card_unbilled",
  credit_card_billed: "credit_card_billed",
} as const;

export type MovementSource = typeof MOVEMENT_SOURCE[keyof typeof MOVEMENT_SOURCE];

/** Titular de la tarjeta */
export const CARD_OWNER = {
  titular: "titular",
  adicional: "adicional",
} as const;

export type CardOwner = typeof CARD_OWNER[keyof typeof CARD_OWNER];

/** Un movimiento bancario individual */
export interface BankMovement {
  /** Fecha del movimiento (formato dd-mm-yyyy) */
  date: string;
  /** Descripción del movimiento (sin prefijos de origen) */
  description: string;
  /** Monto: positivo = abono (depósito), negativo = cargo (gasto) */
  amount: number;
  /** Saldo después del movimiento */
  balance: number;
  /** Origen: cuenta corriente, TC no facturada, TC facturada */
  source: MovementSource;
  /** Titular o adicional de la tarjeta */
  owner?: CardOwner;
  /** Cuotas (ej: "01/01", "02/06") */
  installments?: string;
}

/** Saldo de una tarjeta de crédito */
export interface CreditCardBalance {
  /** Etiqueta de la tarjeta (ej: "Mastercard Black ****5824") */
  label: string;
  /** Cupo nacional */
  national?: {
    used: number;
    available: number;
    total: number;
  };
  /** Cupo internacional */
  international?: {
    used: number;
    available: number;
    total: number;
    currency: string;
  };
  /** Periodo de facturación actual (ej: "Febrero 2026") */
  billingPeriod?: string;
  /** Próxima fecha de facturación (ej: "19 de marzo") */
  nextBillingDate?: string;
}

/** Resultado del scraping */
export interface ScrapeResult {
  /** Si el scraping fue exitoso */
  success: boolean;
  /** Nombre del banco */
  bank: string;
  /** Lista de movimientos encontrados */
  movements: BankMovement[];
  /** Saldo actual de la cuenta */
  balance?: number;
  /** Saldos de tarjetas de crédito */
  creditCards?: CreditCardBalance[];
  /** Mensaje de error si success = false */
  error?: string;
  /** Screenshot en base64 (para debugging) */
  screenshot?: string;
  /** Log de debug con pasos del scraper */
  debug?: string;
}

/** Credenciales de autenticación */
export interface BankCredentials {
  /** RUT del titular (con o sin formato, ej: "12345678-9" o "123456789") */
  rut: string;
  /** Clave de internet del banco */
  password: string;
}

/** Opciones para el scraper */
export interface ScraperOptions extends BankCredentials {
  /** Ruta al ejecutable de Chrome/Chromium. Si no se provee, busca automáticamente. */
  chromePath?: string;
  /** Si es true, guarda screenshots en ./screenshots/ para debugging */
  saveScreenshots?: boolean;
  /** Si es true, usa headless: false (para debugging visual) */
  headful?: boolean;
  /** Filtro Titular/Adicional para TC (ej: "T" = titular, "A" = adicional, "B" = todos). Default: "B" */
  owner?: "T" | "A" | "B";
}

/** Interfaz que debe implementar cada banco */
export interface BankScraper {
  /** Identificador único del banco (ej: "falabella", "santander") */
  id: string;
  /** Nombre completo del banco */
  name: string;
  /** URL del portal web del banco */
  url: string;
  /** Ejecutar el scraping */
  scrape(options: ScraperOptions): Promise<ScrapeResult>;
}
