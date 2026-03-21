# Open Banking Chile

## What is this?
Open source scrapers for Chilean banks. Clean architecture with three layers: infrastructure (browser lifecycle), actions (reusable scraping operations), and banks (bank-specific orchestration). 9 banks supported.

## Project structure
```
src/
  index.ts                 — Registry of all banks, getBank(), listBanks()
  types.ts                 — BankScraper interface, BankMovement, ScrapeResult, ScraperOptions
  utils.ts                 — Shared utilities (formatRut, findChrome, parseChileanAmount, normalizeDate, etc.)
  cli.ts                   — CLI entry point (--bank, --list, --pretty, --movements)
  infrastructure/
    browser.ts             — Centralized browser launch, session management, anti-detection
    scraper-runner.ts      — Execution pipeline: validate → launch → scrape → logout → cleanup
  actions/
    login.ts               — Generic login (RUT formats, password, submit, error detection)
    navigation.ts          — DOM navigation (click by text, sidebars, banner dismissal)
    extraction.ts          — Movement extraction from HTML tables with fallbacks
    pagination.ts          — Multi-page iteration (Siguiente, Ver más)
    credit-card.ts         — Credit card movement extraction (tabs, billing periods)
    balance.ts             — Balance extraction (regex + CSS selector fallbacks)
    two-factor.ts          — 2FA detection and wait (configurable keywords/timeout)
  banks/
    falabella.ts, bchile.ts, bci.ts, bestado.ts, bice.ts,
    edwards.ts, itau.ts, santander.ts, scotiabank.ts
```

## How to help the user

### Setup
1. Node.js >= 18 + Google Chrome or Chromium
2. `npm install && npm run build`
3. Copy `.env.example` → `.env`, fill in credentials

### Running
```bash
source .env && node dist/cli.js --bank falabella --pretty
```

### Adding a new bank
1. Create `src/banks/<bank-id>.ts` implementing `BankScraper`
2. Use `runScraper()` from infrastructure and compose actions from `src/actions/`
3. Register in `src/index.ts`
4. Add env vars to `.env.example`
5. See CONTRIBUTING.md for full guide

### Common issues
- Chrome not found → install or set `CHROME_PATH`
- 2FA → can't automate, bank security feature
- 0 movements → use `--screenshots` to debug
