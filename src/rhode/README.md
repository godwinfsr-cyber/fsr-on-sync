# Rhode → Full Size Run

Source adapter in the same service as the ON, Tissot, Gymshark and ALO syncs. It has its own SQLite database
(`data/rhode-sync.sqlite`), CLI, dashboard page (`/rhode`) and metafield namespace (`rhode_sync`). It shares the
Shopify client/auth, the product operations (`GymsharkOps`), the validated exchange-rate service (`gymshark/fx.ts`),
the pricing formula guard (`alo/pricing.ts`), the logger, the polite HTTP client and the `.env` credentials.

```
rhodeskin.com/products.json (all pages)        whole live catalog, USD; nothing hard-coded
  + /collections.json + /collections/<h>/products.json   Rhode's own categories (Skincare, Lip + Cheek, Sets ...)
  + /products/<h>.json (currency health check) + /products/<h> (benefits, application, key + full ingredients;
    re-read only when Rhode's updated_at changes)
  -> group: Rhode lists every shade as its own product, tied by a "pdp:<line>" tag -> ONE FSR product with a
     Shade option (e.g. Peptide Lip Tint: Ribbon, Espresso, ...). Sets sharing the tag stay separate products.
  -> live USD/INR -> price -> match -> productSet -> images -> metafields -> report
```

## Commands (`node src/rhode/cli.ts …`)

| Command | What it does |
|---|---|
| `sync --dry-run --limit 5` | Discover + extract + price + plan 5 FSR products, **no Shopify writes** |
| `sync --live --limit 25` | Live run for the first 25 FSR products |
| `sync --live --handles peptide-lip-tint-ribbon` | Live run for the products containing these Rhode handles |
| `sync` | Uses `RHODE_DRY_RUN` / `RHODE_SYNC_LIMIT` |
| `tick` | Scheduler entry: syncs only when enabled, due, not paused and not already running |
| `fx` / `status` / `runs` / `prices` / `settings` | Rate check, state, history, price changes, effective settings |
| `pause` / `resume` / `set KEY VALUE` | Control (stored in SQLite, overriding `.env`) |

Every 5 hours **in the cloud**: GitHub Actions workflow `.github/workflows/rhode-sync.yml` (cron `30 */5 * * *` UTC,
`node src/rhode/cli.ts scheduled`). It runs the unit tests, syncs, and commits `data/rhode-sync.sqlite` back to the
repo so the next run is incremental; each run's report is kept as an artifact for 30 days. "Run workflow" on the
Actions tab starts a run by hand (live or dry-run). Settings for the cloud run are the `env:` block of that workflow;
Shopify credentials come from the repo secrets `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` (shared with the ON sync).
Nothing runs on the local PC (no Windows scheduled task).

## Settings (`.env`, or the `/rhode` dashboard, or `cli set`)

`RHODE_ENABLED=true`, `RHODE_SYNC_INTERVAL_HOURS=5`, `RHODE_PRICING_ADJUSTMENT_INR=2000`, `RHODE_ETA="15–20 Days"`,
`USD_INR_RATE_MAX_AGE_HOURS=24`, `RHODE_DRY_RUN=false`, plus `RHODE_PRICE_ROUNDING_MODE` (NONE), `RHODE_COMPARE_AT_MODE`
(NONE), `RHODE_NEW_PRODUCT_STATUS`, `RHODE_CONTENT_REUSE_CONFIRMED`, `RHODE_GROUP_SHADES`, `RHODE_CATEGORY_COLLECTIONS`,
`RHODE_PRODUCT_TYPE_MAP`, `RHODE_EXCLUDED_HANDLES`, `RHODE_SYNC_LIMIT`, `RHODE_MIN_CATALOG_SIZE`, `RHODE_MIN_CATALOG_RATIO`.

## Pricing

```
converted_price_inr = rhode_current_usd × live_usd_inr_rate
final_fsr_price     = converted_price_inr + RHODE_PRICING_ADJUSTMENT_INR      (₹2,000, added exactly once)
```

- Always recomputed from Rhode's **current** USD price, never from the Shopify price, so it can't compound or drift.
- Sale: the current (sale) price is the basis; regular and sale USD prices are stored separately in `rhode_sync`.
  No compare-at and no extra discount unless `RHODE_COMPARE_AT_MODE=SOURCE_REGULAR`.
- No rounding by default (paise precision); `NEAREST_10/50/100` available.
- A price edited by hand in Shopify is kept until Rhode's USD price for that variant changes.
- Exchange rate: open.er-api.com (validated: plausible range, provider data ≤ 96 h old, ≤ 10% move vs the last good
  rate), stored in `fx_rates`. If the provider fails, the last valid rate is used only if obtained within
  `USD_INR_RATE_MAX_AGE_HOURS`; otherwise pricing fails: existing prices stay, new products/variants are not created,
  and the report says so. No rate is hard-coded (₹85 appears only in the unit tests).

## Duplicate protection

`rhode_sync.source_product_id` is a unique `id` metafield definition and every write is a `productSet` upsert on it
(a family's id is `family:<line>`, a single product's id is Rhode's product id). A product in several Rhode
collections is still one Rhode product, so it's one FSR product. Before creating, products not made by this sync are
checked by 1. source product id, 2. source SKU, 3. canonical URL (stored with the id), 4. handle, 5. normalized
title. A match is reported as *needs review* unless `RHODE_ADOPT_EXISTING_PRODUCTS=true`.

## Availability and removal safety

Available variant → `inventoryPolicy: CONTINUE` (sold to order, 0 on hand); sold out → `DENY`. Every variant sold
out → DRAFT + `auto-oos-hidden` (store policy), restored automatically. A Rhode product missing from the catalog is
archived (never deleted) only after `PRODUCT_MISSING_CONFIRMATION_SCANS` (2) consecutive **successful full** scans.
An incomplete, blocked (403/CAPTCHA/challenge), non-USD, or unexpectedly small catalog (< `MIN_CATALOG_SIZE`, or <
`MIN_CATALOG_RATIO` of the last complete scan) logs `SOURCE_SCAN_UNRELIABLE` and skips all cleanup.

## Field ownership

| Always from Rhode | Written on create, later only if unedited in Shopify | Never touched after create |
|---|---|---|
| variants, SKUs, availability, source prices, images, specifications, `rhode_sync.*` | title, description, SEO, `custom.eta` | product type, manual tags, manual media/variants |

## Politeness

Only public, robots.txt-allowed storefront endpoints. Sequential requests, 2 s gap, honest User-Agent, 30 s
timeout, exponential backoff on 5xx/network errors, 429 slows the crawl, 403/challenge stops it. Nothing bypasses
bot protection, geo restrictions or rate limits. Shopify writes retry on throttling (3 attempts, backoff).
