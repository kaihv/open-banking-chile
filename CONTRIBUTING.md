# Contribuir a Open Banking Chile

Queremos que este proyecto cubra todos los bancos de Chile. Si tienes cuenta en un banco que no está soportado, **tu contribución es bienvenida**.

## Agregar un nuevo banco

### 1. Crea el archivo del banco

```
src/banks/<nombre-banco>.ts
```

Debe exportar por defecto un objeto que implemente la interfaz `BankScraper`:

```typescript
import type { BankScraper, ScrapeResult, ScraperOptions } from "../types";

async function scrape(options: ScraperOptions): Promise<ScrapeResult> {
  // Tu lógica de scraping aquí
  // ...
  return {
    success: true,
    bank: "mi-banco",
    movements: [...],
    balance: 1234567,
  };
}

const miBanco: BankScraper = {
  id: "mi-banco",           // identificador único, lowercase, sin espacios
  name: "Mi Banco Chile",   // nombre completo
  url: "https://www.mibanco.cl",
  scrape,
};

export default miBanco;
```

### 2. Regístralo en el index

Edita `src/index.ts`:

```typescript
import falabella from "./banks/falabella";
import miBanco from "./banks/mi-banco";     // ← agregar

export const banks: Record<string, BankScraper> = {
  falabella,
  "mi-banco": miBanco,                      // ← agregar
};
```

### 3. Actualiza el .env.example

Agrega las variables de entorno para tu banco:

```bash
# Mi Banco
MI_BANCO_RUT=123456789
MI_BANCO_PASS=tu_clave_aqui
```

### 4. Documenta en el README

Agrega tu banco a la tabla de bancos soportados en el README.

### 5. Prueba

```bash
npm run build
MI_BANCO_RUT=xxx MI_BANCO_PASS=xxx node dist/cli.js --bank mi-banco --pretty
```

## Interfaz BankScraper

```typescript
interface BankScraper {
  id: string;           // ID único del banco
  name: string;         // Nombre completo
  url: string;          // URL del portal web
  scrape(options: ScraperOptions): Promise<ScrapeResult>;
}

interface ScraperOptions {
  rut: string;              // RUT del titular
  password: string;         // Clave de internet
  chromePath?: string;      // Ruta a Chrome (opcional)
  saveScreenshots?: boolean; // Guardar screenshots de debug
  headful?: boolean;        // Chrome visible
}

interface ScrapeResult {
  success: boolean;
  bank: string;              // ID del banco
  movements: BankMovement[]; // Movimientos extraídos
  balance?: number;          // Saldo actual
  error?: string;            // Error si falló
  screenshot?: string;       // Screenshot base64 (debug)
  debug?: string;            // Log paso a paso
}

interface BankMovement {
  date: string;        // Fecha "dd-mm-yyyy"
  description: string; // Descripción
  amount: number;      // +abono, -cargo
  balance: number;     // Saldo post-movimiento
}
```

## Utilidades disponibles

En `src/utils.ts` hay funciones compartidas que puedes usar:

- `formatRut(rut)` — Formatea un RUT chileno
- `delay(ms)` — Espera N milisegundos
- `findChrome(customPath?)` — Busca Chrome/Chromium en el sistema
- `saveScreenshot(page, name, enabled, debugLog)` — Guarda screenshot de debug
- `closePopups(page)` — Cierra modales y popups genéricos

## Reglas de seguridad

**CRÍTICO**: Lee SECURITY.md antes de contribuir.

- **NUNCA** incluyas credenciales, screenshots, ni datos bancarios reales en commits
- **NUNCA** envíes datos a servidores externos — todo debe correr 100% local
- **NUNCA** guardes credenciales en disco (solo env vars y memoria)
- Si tu PR incluye screenshots de prueba, asegúrate de que sean de cuentas de prueba o censurados

## Tips para scraping de bancos chilenos

1. **Login en 2 pasos**: Muchos bancos piden RUT primero y clave después. Maneja ambos flujos.
2. **SPA Angular/React**: La mayoría de los bancos chilenos usan SPAs. No confíes en URLs, navega por clicks.
3. **Popups post-login**: Siempre cierra popups después del login (ofertas, encuestas, etc.).
4. **2FA**: Si el banco pide clave dinámica, retorna error claro. No intentes bypassear seguridad.
5. **Tablas de movimientos**: Busca `<th>` con "Fecha", "Cargo", "Abono", "Saldo" — es el patrón estándar.
6. **Delays**: Usa delays generosos (2-4s) entre acciones. Los SPAs bancarios son lentos.
7. **User-Agent**: Siempre setea un User-Agent de Chrome reciente.
8. **Screenshots de debug**: Usa `saveScreenshot()` en cada paso para facilitar troubleshooting.

## Bancos que faltan (wishlist)

- Banco de Chile (BancoChile)
- Banco Santander
- BCI
- Banco Estado
- Banco Itaú
- Banco Scotiabank
- Banco BICE
- Banco Security
- Banco Ripley
- Banco Consorcio
- Coopeuch
- Tenpo
- Mach / BCI

**¿Tienes cuenta en alguno?** ¡Anímate a contribuir!

## Estándares de calidad

### Estados en el README

| Estado | Criterio |
|--------|----------|
| ✅ Funcional | Retorna `movements[]` con transacciones + saldo. Multi-cuenta si aplica. |
| 🟡 Solo saldo | Login implementado, retorna saldo pero `movements: []` siempre. |
| 🔜 Próximamente | No implementado aún. |

Un scraper mergeado como `🟡 Solo saldo` **no se marca `✅ Funcional`** hasta que implemente movimientos.

### Multi-cuenta: retorna todas, no elijas por el usuario

Si el banco tiene varias cuentas (corriente, vista, ahorro, crédito), el scraper debe retornar movimientos de **todas**. Prefija la descripción para identificar el origen:

```ts
// ✅ Correcto
{ description: "[Cuenta Corriente 1234] SUPERMERCADO XXX", amount: -50000, balance: 1500000 }
{ description: "[Cuenta Vista 5678] TRANSFERENCIA RECIBIDA", amount: 100000, balance: 200000 }

// ❌ Incorrecto
{ description: "SUPERMERCADO XXX", amount: -50000, balance: 1500000 }  // ¿de cuál cuenta?
```

Ver `src/banks/santander.ts` como referencia (maneja cuentas múltiples y tarjetas de crédito).

### Formato de fecha: siempre dd-mm-yyyy

```ts
"13-03-2026"  // ✅
"2026-03-13"  // ❌
"13/3/26"     // ❌
```

### Montos: negativos para cargos, positivos para abonos

```ts
amount: -50000   // cargo / débito ✅
amount: 100000   // abono / crédito ✅
```

### Selectores con fallback

Los bancos cambian su HTML. Usa arrays de selectores con fallback para robustez:

```ts
const RUT_SELECTORS = [
  "#id-especifico",
  'input[placeholder*="RUT"]',
  'input[name*="rut"]',
];
for (const sel of RUT_SELECTORS) {
  try {
    await page.waitForSelector(sel, { visible: true, timeout: 2000 });
    selector = sel; break;
  } catch { continue; }
}
```

## Proceso de review

1. Fork el repo
2. Crea una rama: `git checkout -b bank/nombre-banco`
3. Implementa el scraper
4. Asegúrate de que `npm run build` pase sin errores
5. Abre un PR con descripción de qué banco agregaste

Revisaremos que:
- No haya credenciales ni datos personales en el código
- El scraper siga la interfaz `BankScraper`
- Los errores se manejen correctamente (especialmente 2FA)
- El código sea razonablemente limpio y documentado
