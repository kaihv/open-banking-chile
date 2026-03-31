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
  /** Identificador de la tarjeta (ej: "****8335") — útil cuando hay múltiples tarjetas */
  card?: string;
  /** Cuotas (ej: "01/01", "02/06") */
  installments?: string;
  /** Monto total de la compra (distinto de amount cuando es en cuotas) */
  totalAmount?: number;
}

/** Saldo y movimientos de una cuenta bancaria */
export interface AccountBalance {
  /** Identificador de la cuenta (ej: "Cuenta Corriente ****2706") */
  label?: string;
  /** Saldo actual */
  balance?: number;
  /** Movimientos de la cuenta */
  movements: BankMovement[];
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
  /** Próxima fecha de facturación (formato dd-mm-yyyy) */
  nextBillingDate?: string;
  /** Próxima fecha de vencimiento de pago (formato dd-mm-yyyy) */
  nextDueDate?: string;
  /** Gastos del período actual (no facturados) */
  periodExpenses?: number;
  /** Datos del último estado de cuenta facturado */
  lastStatement?: {
    /** Fecha de facturación dd-mm-yyyy */
    billingDate: string;
    /** Monto total facturado */
    billedAmount: number;
    /** Fecha de vencimiento dd-mm-yyyy */
    dueDate: string;
    /** Pago mínimo */
    minimumPayment?: number;
  };
  /** Movimientos de la tarjeta */
  movements?: BankMovement[];
}

/** Resultado del scraping */
export interface ScrapeResult {
  /** Si el scraping fue exitoso */
  success: boolean;
  /** Nombre del banco */
  bank: string;
  /** Cuentas bancarias con sus movimientos */
  accounts?: AccountBalance[];
  /** Saldos de tarjetas de crédito */
  creditCards?: CreditCardBalance[];
  /** @deprecated Use accounts[].movements instead. Kept for compatibility during migration. */
  movements?: BankMovement[];
  /** @deprecated Use accounts[].balance instead. Kept for compatibility during migration. */
  balance?: number;
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
  /** Callback de progreso para mostrar estado al usuario */
  onProgress?: (step: string) => void;
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
