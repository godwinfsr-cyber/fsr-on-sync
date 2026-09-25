# on-sync — ON.com US Last Season Shoes → Full Size Run (Shopify)

Standalone Node 24 + TypeScript service (no build step — Node runs the `.ts` files directly).
Storage: built-in `node:sqlite` (`data/on-sync.sqlite`). Source rendering: Playwright/Chromium.
Shopify: official Admin GraphQL API (`productSet` with a unique-metafield identifier).

```
ON /en-us/shop/classics/shoes  ──►  discover (schema.org ItemList JSON-LD, follows "Show more" ?page=N)
   ──►  each colorway page (JSON-LD ProductGroup + rendered size picker / gallery / materials)
   ──►  normalize ──► change detection (hashes vs. SQLite) ──► pricing engine (USD→INR, markup, rounding)
   ──►  match (on_sync.source_product_id unique metafield → stored id → SKU-collision check)
   ──►  productSet create/update (variants per size, media, metafields, ETA) ──► logs + report
```

## Commands

| Command | What it does |
|---|---|
| `npm run sync:dry -- --limit 5` | Dry run: crawl, parse, price, plan — **no Shopify writes** |
| `npm run sync -- --live --limit 5` | Live run on the first 5 colorways |
| `npm run sync` | Run using the `DRY_RUN` / `SYNC_LIMIT` settings |
| `npm run tick` | Scheduler entry: syncs only if due, not paused, not already running |
| `npm run status` / `node src/cli.ts runs` | State, last/next sync, recent runs |
| `node src/cli.ts pause` / `resume` | Stop / restart scheduled syncs |
| `node src/cli.ts set MARKUP_VALUE 25` | Change a setting (stored in SQLite, overrides `.env`) |
| `npm run dashboard` | Admin dashboard at http://127.0.0.1:3100 (localhost only) |
| `npm test` / `npm run typecheck` | Unit tests / TypeScript check |

Every run gets an id like `SYNC-2026-09-25-001` and writes `logs/<id>.jsonl` (structured log),
`logs/<id>.report.txt` (human summary) and `logs/<id>.report.json`. Runs and events are also in SQLite.

## Scheduling (persistent, survives restarts)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-scheduler.ps1
```
Registers the Windows Task Scheduler job **"FSR ON.com Sync"**, which runs `tick` every hour; `tick`
starts a sync only when `SYNC_INTERVAL_HOURS` (default 5) has elapsed. Changing the interval in the
dashboard takes effect without re-registering. Remove with `scripts\uninstall-scheduler.ps1`.
The PC must be on (Task Scheduler runs a missed tick as soon as it can: `StartWhenAvailable`).

## Shopify authorization (required before live syncs)

There is no Admin API credential in this workspace — earlier store work used Claude's Shopify connector,
which a background job cannot use. Create one yourself (the service never asks for your password):

1. Shopify **Dev Dashboard** (dev.shopify.com) → *Create app* → name it e.g. "FSR ON Sync".
2. Create a version with Admin API scopes: `read_products, write_products, read_inventory, write_inventory, read_locations`.
   (Images are attached by `productSet` from their URLs; if Shopify reports a missing files scope, add `write_files`.)
3. Install the app on **va9wah-fx.myshopify.com** (fullsizerun.in).
4. Copy the app's **Client ID** and **Client secret** into `on-sync/.env`:
   `SHOPIFY_CLIENT_ID=...` and `SHOPIFY_CLIENT_SECRET=...`
   The service exchanges them for a short-lived token each run (client-credentials grant); the token
   is kept in memory only. An existing offline `shpat_` token in `SHOPIFY_ADMIN_ACCESS_TOKEN` also works.

`.env` is git-ignored; logs are scrubbed of tokens/secrets.

## Settings (`.env` defaults; editable in the dashboard)

Pricing: `EXCHANGE_RATE` (₹ per $1 — live sync refuses to run while 0), `EXCHANGE_RATE_BUFFER_PCT`,
`MARKUP_TYPE` (`percentage`|`fixed`), `MARKUP_VALUE`, `MIN_PROFIT` (₹), `ROUNDING_RULE`
(`none`, `nearest_10`, `nearest_100`, `ceil_100`, `ceil_500`, `ceil_1000`, `end_99`, `end_999`),
`COMPARE_AT_MODE` (`source_list` converts ON's original price the same way; `none`).
Formula: `price = round( markup( source × rate × (1+buffer) ), min profit applied first )`.

Other: `SYNC_INTERVAL_HOURS`, `DEFAULT_ETA`, `PRODUCT_MISSING_CONFIRMATION_SCANS`, `MISSING_ACTION`
(`archive`|`draft`|`unavailable`), `NEW_PRODUCT_STATUS` (`DRAFT` until you have reviewed the first import),
`DRY_RUN`, `SYNC_LIMIT`, `CONTENT_REUSE_CONFIRMED`, `ADOPT_EXISTING_PRODUCTS`, `VENDOR`, `PRODUCT_TYPE`,
`BASE_TAGS`, `TITLE_TEMPLATE`, `REQUEST_DELAY_MS` (≥1000), `SOURCE_CONCURRENCY` (1–2).

## Source-controlled vs. Full-Size-Run-controlled fields

| Always synced from ON | Written on create, then only if never edited in Shopify | Never touched after create |
|---|---|---|
| sizes/variants, variant SKU `<ONSKU>-<size>`, availability (inventory policy), `on_sync.*` metafields, images (when changed) | title, description, SEO, `custom.eta`, selling price / compare-at | vendor, product type, manual tags, manually added variants |

"Edited in Shopify" is detected by comparing the current Shopify value with what this service last wrote.

## Duplicate protection

1. `on_sync.source_product_id` has a **unique-values** metafield definition; every write is a
   `productSet(identifier: { customId })` upsert, so Shopify itself refuses a second product with the same ON SKU.
2. Local SQLite map ON SKU → Shopify product id.
3. Variants are matched by size and updated by id (no new variants on repeat syncs); media is only
   replaced when the source image set changes.
4. Pre-existing manual products that already carry the ON SKU (e.g. Instant Ship listings) are **not**
   overwritten: they are reported as *needs review* unless `ADOPT_EXISTING_PRODUCTS=true`
   (adoption keeps their manual title/description/price).

## Availability, stock policy, removal

- Available sizes → `inventoryPolicy: CONTINUE` (orderable, 0 on hand — FSR sources to order);
  sold-out sizes → `DENY`. Sizes ON stops listing are kept as unavailable variants, not deleted.
- All sizes sold out → product set to DRAFT + tag `auto-oos-hidden` (the store's existing
  out-of-stock policy and the tag the `fullsizerun-oos-hider` task already understands); restored on restock.
- Products tagged `ETA` (never `Instant Ship`); the theme badge shows `custom.eta`.
- A product missing from a *complete* scan is marked `missing`; after
  `PRODUCT_MISSING_CONFIRMATION_SCANS` consecutive complete scans `MISSING_ACTION` is applied
  (default archive). Nothing is ever deleted. Partial/limited/blocked scans never count.

## Politeness and legal guardrails

- robots.txt disallows `/api` and `/pdp`: the service never calls them; it renders public listing and
  product pages (`/en-us/shop/...`, `/en-us/products/...`), one at a time with `REQUEST_DELAY_MS` between
  loads, and does not download images/fonts/media while crawling.
- HTTP 403/429/503 or a challenge/CAPTCHA page stops the crawl for that run — no retries around it,
  no stealth, no proxies.
- **`CONTENT_REUSE_CONFIRMED=false` (default)**: ON's product photos and description text are not
  copied to Shopify. Set it to `true` only after confirming you have ON's permission (e.g. as an authorised
  retailer / written consent) to reuse their images and copy commercially.

## Known source limitations

- GTIN/barcode is not published by on.com → variant barcodes stay empty.
- Exact stock counts are not published; only "Only N left" hints (kept in the run report).
- The size-guide table is only rendered on interaction, so sizes ON does not list for a colorway are not reported.
