# Open Banking Chile

Scrapers open source para bancos chilenos. Obtén tus movimientos bancarios y saldo como JSON limpio.

> **Disclaimer**: Este proyecto no está afiliado con ningún banco. Úsalo bajo tu propia responsabilidad y solo con tus propias credenciales.

## Bancos soportados

| Banco | ID | Estado |
|-------|----|--------|
| Banco Falabella | `falabella` | ✅ Funcional |
| Banco BICE | `bice` | ✅ Funcional |
| Banco Santander | `santander` | ✅ Funcional |
| Banco Edwards | `edwards` | ✅ Funcional |
| Banco de Chile | `bchile` | 🟡 Solo saldo |
| BCI | `bci` | 🔜 Próximamente |
| Banco Estado | `estado` | 🔜 Próximamente |

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
# Desde npm
npm install open-banking-chile

# O clonar el repo
git clone https://github.com/kaihv/open-banking-chile.git
cd open-banking-chile
npm install
npm run build
```

## Uso

### CLI

```bash
# Configurar credenciales

# Banco Falabella
export FALABELLA_RUT=12345678-9
export FALABELLA_PASS=tu_clave

# Banco BICE
export BICE_RUT=12345678-9
export BICE_PASS=tu_clave
## Opcional:  
export BICE_MONTHS=1 

# Banco Santander
export SANTANDER_RUT=12345678-9
export SANTANDER_PASS=tu_clave

<<<<<<< HEAD
# Banco de Chile
export BANCOCHILE_RUT=12345678-9
export BANCOCHILE_PASS=tu_clave
=======
# Banco Edwards
export EDWARDS_RUT=12345678-9
export EDWARDS_PASS=tu_clave
>>>>>>> pr-7-edwards

# Consultar banco
npx open-banking-chile --bank falabella --pretty
npx open-banking-chile --bank santander --pretty
<<<<<<< HEAD
npx open-banking-chile --bank bchile --pretty

=======
npx open-banking-chile --bank edwards --pretty
>>>>>>> pr-7-edwards

# Solo movimientos
npx open-banking-chile --bank falabella --movements | jq .

# Listar bancos disponibles
npx open-banking-chile --list

# Con screenshots para debugging
npx open-banking-chile --bank falabella --screenshots --pretty
```

**Santander (alcance actual):**

- Extrae movimientos de **Cuenta Corriente** y **Cuenta Vista** (si existen).
- Extrae movimientos de **Tarjeta de Crédito**:
  - `MOVIMIENTOS POR FACTURAR`
  - `MOVIMIENTOS FACTURADOS`
- En `description`, agrega prefijos para distinguir origen:
  - `[Cuenta Corriente ...]`
  - `[Cuenta Vista ...]`
  - `[TC Por Facturar]`
  - `[TC Facturados]`

**Opciones CLI:**

| Flag | Descripción |
|------|-------------|
| `--bank <id>` | Banco a consultar (requerido) |
| `--list` | Listar bancos disponibles |
| `--pretty` | JSON formateado |
| `--movements` | Solo array de movimientos |
| `--screenshots` | Guardar screenshots locales en `./screenshots/` |
| `--headful` | Chrome visible (debugging) |

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
    console.log(`${m.date} | ${m.description.padEnd(40)} | ${sign}$${m.amount.toLocaleString("es-CL")}`);
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
      "balance": 1250000
    },
    {
      "date": "07-03-2026",
      "description": "TRANSFERENCIA RECIBIDA",
      "amount": 500000,
      "balance": 1295230
    }
  ],
  "balance": 1250000
}
```

### Output Santander (ejemplo)

```json
{
  "success": true,
  "bank": "santander",
  "movements": [
    {
      "date": "15-03-2026",
      "description": "[Cuenta Corriente 0 000 00 00000 0] TRANSFERENCIA A TERCEROS",
      "amount": -25000,
      "balance": 1285000
    },
    {
      "date": "14-03-2026",
      "description": "[Cuenta Vista 0 000 00 00000 0] DEPÓSITO RECIBIDO",
      "amount": 42000,
      "balance": 185000
    },
    {
      "date": "13-03-2026",
      "description": "[TC Por Facturar] COMPRA COMERCIO DEMO",
      "amount": -15990,
      "balance": 0
    },
    {
      "date": "01-03-2026",
      "description": "[TC Facturados] PAGO TARJETA DE CRÉDITO",
      "amount": 70000,
      "balance": 0
    }
  ],
  "balance": 1285000
}
```

## Seguridad

- **Tus credenciales nunca salen de tu máquina**. Todo corre 100% local.
- No hay analytics, telemetría, ni tracking.
- Las credenciales se pasan por env vars, nunca se guardan en disco.
- Los screenshots de debug pueden contener datos sensibles — no los compartas.
- Lee [SECURITY.md](SECURITY.md) para más detalles.

## Contribuir

Queremos cubrir **todos los bancos de Chile**. Si tienes cuenta en un banco que falta:

1. Lee [CONTRIBUTING.md](CONTRIBUTING.md) para la guía paso a paso
2. Implementa la interfaz `BankScraper` en `src/banks/<tu-banco>.ts`
3. Regístralo en `src/index.ts`
4. Abre un PR

```typescript
// La interfaz es simple:
interface BankScraper {
  id: string;        // "mi-banco"
  name: string;      // "Mi Banco Chile"
  url: string;       // "https://www.mibanco.cl"
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

| Problema | Solución |
|----------|----------|
| Chrome no encontrado | Instala Chrome o usa `CHROME_PATH=/ruta/chrome` |
| 2FA / Clave dinámica | Si aparece, apruébalo manualmente en tu banco y vuelve a intentar |
| 0 movimientos | Usa `--screenshots --pretty` y revisa el debug log |
| Login falla | Verifica RUT y clave, prueba con `--headful` |

### Limitaciones actuales Santander

- El campo `balance` representa la cuenta principal de movimientos (no resume todos los productos).
- Los movimientos de TC se entregan junto a los bancarios en el mismo array, diferenciados por prefijo en `description`.
- Cartolas históricas fuera de las vistas cargadas por defecto del portal no están incluidas automáticamente.

## License

MIT — Hecho en Chile 🇨🇱
