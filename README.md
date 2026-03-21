# Open Banking Chile

Scrapers open source para bancos chilenos. Obtén tus movimientos bancarios y saldo como JSON limpio.

> **Disclaimer**: Este proyecto no está afiliado con ningún banco. Úsalo bajo tu propia responsabilidad y solo con tus propias credenciales.

## Migración v1 → v2

**v2.0.0 introduce un cambio breaking en la interfaz `BankMovement`:**

El campo `source` ahora es **obligatorio** e indica el origen del movimiento:

| Valor                    | Descripción                       |
| ------------------------ | --------------------------------- |
| `"account"`              | Cuenta corriente o vista          |
| `"credit_card_unbilled"` | Tarjeta de crédito — por facturar |
| `"credit_card_billed"`   | Tarjeta de crédito — facturado    |

Si construyes objetos `BankMovement` manualmente en tu código, agrega el campo `source`. Si solo **consumes** los resultados del scraper, no hay cambios necesarios — todos los scrapers ya lo incluyen.

```ts
// v1 (ya no válido en TypeScript)
const mov: BankMovement = { date, description, amount, balance };

// v2
const mov: BankMovement = {
  date,
  description,
  amount,
  balance,
  source: "account",
};
```

También en esta versión: utilidades compartidas (`parseChileanAmount`, `normalizeDate`, `deduplicateMovements`, etc.) disponibles como exports desde `open-banking-chile/utils`.

## Bancos soportados

| Banco                             | ID           | Estado       |
| --------------------------------- | ------------ | ------------ |
| Banco Falabella (cuenta + CMR TC) | `falabella`  | ✅ Funcional |
| Banco BICE                        | `bice`       | ✅ Funcional |
| Banco Santander                   | `santander`  | ✅ Funcional |
| Banco Edwards                     | `edwards`    | ✅ Funcional |
| Scotiabank                        | `scotiabank` | ✅ Funcional |
| Banco de Chile                    | `bchile`     | ✅ Funcional |
| BCI                               | `bci`        | ✅ Funcional |
| Itaú                              | `itau`       | ✅ Funcional |
| Banco Estado (CuentaRUT)          | `bestado`    | ✅ Funcional |

**¿Tu banco no está?** → [Contribuir](#contribuir)

## Requisitos

- **Node.js** >= 18
- **Google Chrome** o **Chromium**

```bash
# Instalar Chrome — Ubuntu/Debian
sudo apt update && sudo apt install -y google-chrome-stable

# macOS
brew install --cask google-chrome
```

## Instalación

```bash
# Desde GitHub
npm install github:kaihv/open-banking-chile

# O clonar el repo
git clone https://github.com/kaihv/open-banking-chile.git
cd open-banking-chile
npm install
npm run build
```

## Uso

### CLI

Configura tu archivo `.env` con tus credenciales:

```bash
# Banco Falabella
FALABELLA_RUT=12345678-9
FALABELLA_PASS=tu_clave

# Banco BICE
BICE_RUT=12345678-9
BICE_PASS=tu_clave
## Opcional:
BICE_MONTHS=1

# Banco Santander
SANTANDER_RUT=12345678-9
SANTANDER_PASS=tu_clave

# Banco de Chile
BANCOCHILE_RUT=12345678-9
BANCOCHILE_PASS=tu_clave

# Banco Edwards
EDWARDS_RUT=12345678-9
EDWARDS_PASS=tu_clave


# Itaú
ITAU_RUT=12345678-9
ITAU_PASS=tu_clave

# Banco Estado
BESTADO_RUT=12345678-9
BESTADO_PASS=tu_clave
```

Ejecuta la librería con el comando `npx`, `dotenv` incluirá automáticamente las variables de entorno.

```bash

# Consultar banco
npx open-banking-chile --bank falabella --pretty
npx open-banking-chile --bank santander --pretty
npx open-banking-chile --bank bchile --pretty
npx open-banking-chile --bank edwards --pretty
npx open-banking-chile --bank itau --pretty
npx open-banking-chile --bank bestado --pretty

# Solo movimientos
npx open-banking-chile --bank falabella --movements | jq .

# Listar bancos disponibles
npx open-banking-chile --list

# Con screenshots para debugging
npx open-banking-chile --bank falabella --screenshots --pretty
```

**Opciones CLI:**

| Flag                | Descripción                                                     |
| ------------------- | --------------------------------------------------------------- |
| `--bank <id>`       | Banco a consultar (requerido)                                   |
| `--list`            | Listar bancos disponibles                                       |
| `--pretty`          | JSON formateado                                                 |
| `--movements`       | Solo array de movimientos                                       |
| `--screenshots`     | Guardar screenshots locales en `./screenshots/`                 |
| `--headful`         | Chrome visible (debugging). **BancoEstado siempre usa headful** |
| `--owner <T\|A\|B>` | Filtro Titular/Adicional para TC (default: B = todos)           |

### Como librería

```typescript
import { banks, getBank } from "open-banking-chile";

// Opción 1: por ID
const falabella = getBank("falabella");
const result = await falabella!.scrape({
  rut: "12345678-9",
  password: "mi_clave",
});

// Opción 2: import directo
import { falabella } from "open-banking-chile";
const result = await falabella.scrape({
  rut: "12345678-9",
  password: "mi_clave",
});

if (result.success) {
  console.log(`Banco: ${result.bank}`);
  console.log(`Saldo: $${result.balance?.toLocaleString("es-CL")}`);
  console.log(`${result.movements.length} movimientos`);

  for (const m of result.movements) {
    const sign = m.amount > 0 ? "+" : "";
    console.log(
      `${m.date} | ${m.description.padEnd(40)} | ${sign}$${m.amount.toLocaleString("es-CL")}`,
    );
  }
}
```

### Output

```json
{
  "success": true,
  "bank": "falabella",
  "movements": [
    {
      "date": "08-03-2026",
      "description": "COMPRA SUPERMERCADO LIDER",
      "amount": -45230,
      "balance": 1250000,
      "source": "account"
    },
    {
      "date": "07-03-2026",
      "description": "COMPRA COMERCIO",
      "amount": -15990,
      "balance": 0,
      "source": "credit_card_unbilled",
      "owner": "titular",
      "installments": "01/03"
    },
    {
      "date": "01-03-2026",
      "description": "PAGO TARJETA DE CRÉDITO",
      "amount": 70000,
      "balance": 0,
      "source": "credit_card_billed"
    }
  ],
  "balance": 1250000
}
```

### Campo `source`

Cada movimiento incluye un campo `source` que indica su origen:

| Valor                  | Descripción                       |
| ---------------------- | --------------------------------- |
| `account`              | Cuenta corriente o vista          |
| `credit_card_unbilled` | Tarjeta de crédito — por facturar |
| `credit_card_billed`   | Tarjeta de crédito — facturado    |

Campos opcionales:

- `owner`: `"titular"` o `"adicional"` (solo Falabella CMR por ahora)
- `installments`: cuotas en formato `NN/NN`, ej: `"02/06"` = cuota 2 de 6 (Falabella, BChile, Itaú)

## Seguridad

- **Tus credenciales nunca salen de tu máquina**. Todo corre 100% local.
- No hay analytics, telemetría, ni tracking.
- Las credenciales se pasan por env vars, nunca se guardan en disco.
- Los screenshots de debug pueden contener datos sensibles — no los compartas.
- Lee [SECURITY.md](SECURITY.md) para más detalles.

## Arquitectura

El proyecto sigue una **arquitectura limpia en tres capas**, separando responsabilidades para facilitar la reutilización y la adición de nuevos bancos:

```
src/
  index.ts                    — Registro de bancos, getBank(), listBanks()
  types.ts                    — Interfaces: BankScraper, BankMovement, ScrapeResult
  utils.ts                    — Utilidades compartidas (parsing, fechas, dedup)
  cli.ts                      — CLI entry point
  infrastructure/
    browser.ts                — Gestión centralizada del browser (launch, sesión, cleanup)
    scraper-runner.ts         — Pipeline de ejecución (credenciales → browser → scrape → logout → resultado)
  actions/
    login.ts                  — Login genérico (RUT, password, submit, detección de errores)
    navigation.ts             — Navegación DOM (click por texto, sidebars, banners)
    extraction.ts             — Extracción de movimientos desde tablas HTML
    pagination.ts             — Iteración multi-página (Siguiente, Ver más)
    credit-card.ts            — Extracción de movimientos de tarjeta de crédito
    balance.ts                — Extracción de saldo
    two-factor.ts             — Detección y espera de 2FA
  banks/
    falabella.ts              — Banco Falabella + CMR (cuenta + tarjeta de crédito)
    bestado.ts                — Banco Estado (CuentaRUT, requiere headful)
    bchile.ts                 — Banco de Chile
    bci.ts                    — BCI (iframes + BCI Pass)
    bice.ts                   — Banco BICE
    edwards.ts                — Banco Edwards
    itau.ts                   — Itaú
    santander.ts              — Banco Santander
    scotiabank.ts             — Scotiabank Chile
```

### Capas

**Infrastructure** — Gestión del ciclo de vida del browser. `launchBrowser()` centraliza la configuración de Chrome (anti-detección, user agent, modo headful/headless). `runScraper()` envuelve toda la ejecución: valida credenciales, abre el browser, ejecuta el scraper del banco, hace logout y cierra el browser. Los errores se capturan y retornan como `ScrapeResult`.

**Actions** — Operaciones reutilizables e independientes del banco. Cada banco compone estas acciones en vez de reimplementarlas. Por ejemplo, `fillRut()` soporta múltiples formatos de RUT y funciona tanto en `Page` como en iframes; `paginateAndExtract()` navega automáticamente por páginas acumulando movimientos; `detect2FA()` detecta segundo factor por keywords configurables.

**Banks** — Orquestación específica de cada banco. Solo contienen la lógica particular: selectores CSS propios, flujo de navegación, y configuración de 2FA. Usan `runScraper()` como wrapper y componen acciones del layer anterior.

### Utilidades compartidas (`utils.ts`)

Funciones comunes usadas por scrapers y acciones:

| Función                                         | Descripción                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| `parseChileanAmount(text)`                      | Parsea montos en formato chileno ($1.234.567) a número                 |
| `normalizeDate(raw)`                            | Normaliza fechas a DD-MM-YYYY (soporta dd/mm/yyyy, "9 mar 2026", etc.) |
| `normalizeOwner(raw)`                           | Normaliza owner a `"titular"` o `"adicional"`                          |
| `normalizeInstallments(raw)`                    | Normaliza cuotas a formato NN/NN (ej: "1/3" → "01/03")                 |
| `deduplicateMovements(movements)`               | Elimina movimientos duplicados por fecha+descripción+monto+source      |
| `logout(page, debugLog)`                        | Cierra sesión buscando botones comunes (cerrar sesión, salir, etc.)    |
| `formatRut(rut)`                                | Formatea RUT (12345678-9 → 12.345.678-9)                               |
| `findChrome()`                                  | Busca Chrome/Chromium en el sistema                                    |
| `closePopups(page)`                             | Cierra popups y modales genéricos                                      |
| `delay(ms)`                                     | Espera N milisegundos                                                  |
| `saveScreenshot(page, name, enabled, debugLog)` | Guarda screenshot si está habilitado                                   |

## Contribuir

Queremos cubrir **todos los bancos de Chile**. Si tienes cuenta en un banco que falta:

1. Lee [CONTRIBUTING.md](CONTRIBUTING.md) para la guía paso a paso
2. Crea `src/banks/<tu-banco>.ts` implementando `BankScraper`
3. Usa `runScraper()` de `infrastructure/` y compone acciones de `actions/` (login, extracción, paginación, etc.)
4. Usa las utilidades compartidas de `utils.ts` (parsing, fechas, dedup, logout)
5. Regístralo en `src/index.ts`
6. Abre un PR

```typescript
// La interfaz es simple:
interface BankScraper {
  id: string; // "mi-banco"
  name: string; // "Mi Banco Chile"
  url: string; // "https://www.mibanco.cl"
  scrape(options: ScraperOptions): Promise<ScrapeResult>;
}
```

## Automatización (cron)

```bash
# Ejemplo: sincronizar Falabella diariamente a las 7 AM
0 7 * * * source /home/user/.env && node /path/to/dist/cli.js --bank falabella >> /var/log/bank-sync.log 2>&1

# Ejemplo: sincronizar BICE diariamente y con 3 meses históricos
0 7 * * * source /home/user/.env && BICE_MONTHS=3 node /path/to/dist/cli.js --bank bice >> /var/log/bank-sync.log 2>&1
```

## Troubleshooting

| Problema              | Solución                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Chrome no encontrado  | Instala Chrome o usa `CHROME_PATH=/ruta/chrome`                                                |
| 2FA / Clave dinámica  | Si aparece, apruébalo manualmente en tu banco y vuelve a intentar                              |
| 0 movimientos         | Usa `--screenshots --pretty` y revisa el debug log                                             |
| Login falla           | Verifica RUT y clave, prueba con `--headful`                                                   |
| BancoEstado bloqueado | BancoEstado bloquea headless (TLS fingerprinting). Siempre abre Chrome visible. Ver nota abajo |

### BancoEstado y modo headless

BancoEstado detecta navegadores headless a nivel de red (TLS fingerprinting), no solo por JavaScript. Ni `puppeteer-extra-plugin-stealth` ni `rebrowser-puppeteer-core` logran evadir esta detección. El scraper siempre corre en modo headful (Chrome visible).

**En servidores Linux sin GUI**, usa Xvfb (display virtual):

```bash
# Instalar
sudo apt install xvfb

# Correr con display virtual
xvfb-run node dist/cli.js --bank bestado --pretty

# O como parte de tu app
xvfb-run node tu-app.js
```

**En Docker:**

```dockerfile
RUN apt-get update && apt-get install -y xvfb google-chrome-stable
CMD ["xvfb-run", "node", "server.js"]
```

**En Mac/Windows** no necesitas nada extra — Chrome se abre y cierra automáticamente.

## License

MIT — Hecho en Chile 🇨🇱
