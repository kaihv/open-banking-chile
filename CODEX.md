# Open Banking Chile

## For Codex / ChatGPT / OpenAI assistants

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
