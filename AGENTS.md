# Open Banking Chile

## For all Agents (open standard)

### What this project does
Open source multi-bank scraping framework for Chilean banks. Extracts movements and balances as JSON using Puppeteer (headless Chrome). Plugin architecture for adding new banks.

### Currently supported banks
- Banco Falabella (`falabella`)

### Setup
```bash
git clone https://github.com/kaihv/open-banking-chile.git
cd open-banking-chile
npm install && npm run build
cp .env.example .env  # edit with credentials
```

### Usage
```bash
# CLI
source .env && node dist/cli.js --bank falabella --pretty

# Library
import { getBank } from "open-banking-chile";
const result = await getBank("falabella")!.scrape({ rut: "...", password: "..." });
```

### Adding a new bank
1. Create `src/banks/<id>.ts` implementing `BankScraper` from `src/types.ts`
2. Register in `src/index.ts`
3. See CONTRIBUTING.md for details

### File structure
```
src/banks/falabella.ts  — Banco Falabella scraper
src/types.ts            — BankScraper, BankMovement, ScrapeResult interfaces
src/utils.ts            — Shared utilities
src/index.ts            — Bank registry
src/cli.ts              — CLI entry point
```

### Security
All local, no external servers, credentials via env vars only.

## Scraper development workflow

When extending bank scrapers (e.g. Banco Edwards/Banco Chile), follow this procedure:

1. **Get to a point** — Run the scraper and reach the target page (e.g. post-login dashboard).
2. **Scrape page** — Save HTML with `--screenshots` (writes to `debug/*.html` when enabled).
3. **Analyze scraped HTML** — Inspect the DOM to identify selectors, menu labels, and structure.
4. **Implement** — Add or adjust navigation/extraction logic based on findings.
5. **Start again** — Run scraper, verify, then repeat for the next step (e.g. movements page).

Do not skip step 2–3. Do not implement without inspecting the scraped HTML first.
