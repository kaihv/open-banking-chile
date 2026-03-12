# Agent Instructions

## Scraper development workflow

When extending bank scrapers (e.g. Banco Edwards/Banco Chile), follow this procedure:

1. **Get to a point** — Run the scraper and reach the target page (e.g. post-login dashboard).
2. **Scrape page** — Save HTML with `--screenshots` (writes to `debug/*.html` when enabled).
3. **Analyze scraped HTML** — Inspect the DOM to identify selectors, menu labels, and structure.
4. **Implement** — Add or adjust navigation/extraction logic based on findings.
5. **Start again** — Run scraper, verify, then repeat for the next step (e.g. movements page).

Do not skip step 2–3. Do not implement without inspecting the scraped HTML first.

---

## Banco Chile / Edwards — Post-login (from debug/02-after-login.html)

### Accesos Directos (direct access buttons)

- **SALDOS Y MOV. CUENTAS** — Click to navigate to account movements.
- **SALDOS Y MOV.TARJETAS CRÉDITO** — Click to navigate to credit card movements.

These are inside `.contenedorLinkAccesoDirecto`, within `bch-button` elements. Text is in `.btn-text`.

### Accounts widget (`fenix-widgets-cuentas`)

- Carousel: `bch-carousel.widget-home.widget-cuenta` with `ngu-carousel` (not swiper).
- Each account: `ngu-tile.item` > `.bch-card.card-cuentas`.
- Account link: `a#btn-home_CuentaCorrienteMonedaLocal` (or `btn-home_LineaDeCreditoPersonas`).
- Balance: `span.monto-cuenta` (e.g. `$ 124.409`).

### Credit cards (`fenix-widgets-tarjetas`)

- "Ver saldos" button: `#btn-home_actualizar-saldos`.
- Cards in carousel: `bch-card-products` > `.link-card`.
