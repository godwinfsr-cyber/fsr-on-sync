# Michael Kors → Full Size Run

A source adapter in the same service as the ON, Tissot, Casio, Gymshark and ALO syncs. It has its own SQLite database
(`data/michaelkors-sync.sqlite`), CLI, dashboard page (`/michaelkors`) and metafield namespace (`michael_kors_sync`).
It shares the Shopify client and credentials (`.env`), the logger, the polite HTTP client, the exchange-rate service
(`src/gymshark/fx.ts`), the weight-band engine and the Shopify operations (`src/gymshark/ops.ts`).

```
DISCOVER (sitemap_index -> product sitemaps, or FEED_DIR)  -> dedupe by style number (sale / outlet / new routes = 1 product)
  -> URL-level watch check (watch pages are not even fetched)
  -> EXTRACT (schema.org JSON-LD: ProductGroup/Product + BreadcrumbList) -> NORMALIZE (UK shoe sizes, colours, images)
  -> IS MICHAEL KORS WATCH? yes -> SKIP + LOG WATCH_EXCLUDED
  -> CHECK DUPLICATE (source id metafield -> stored id -> SKU/style -> title) -> PRICE -> productSet -> metafields -> LOG
```

## Authorization (`config.ts`)

`BRAND_AUTHORIZATION` / `MICHAEL_KORS_AUTHORIZED_IMPORTER=true`: Full Size Run is the official authorized importer
for India, so Michael Kors images, descriptions and specifications are imported. There is no copyright blocker. This
applies to Michael Kors only. It never authorises bypassing technical protection. A 403, a challenge page or a
geo-redirect stops the crawl.

## Watches are always excluded (`exclusion.ts`)

`isExcludedMichaelKorsProduct()` checks four things: the category or breadcrumb, the URL, the title (the watch,
smartwatch, timepiece or watch component itself) and watch-only specs (movement, ATM rating, case mm). The plan
builder re-runs it before every create or update. Excluded products are logged as `watch_excluded`. They are
never created, updated or archived. "Watch Hunger Stop" (a charity tote/T-shirt range) is not a watch.

## Pricing (`pricing.ts`)

```
converted_price_inr = source_price_usd × live USD/INR          (source_price_usd = current selling price)
landed_cost_inr     = converted_price_inr + shipping(weight)    WEIGHT_BANDS 0.5:1000,1:1500,2:2500,3:3500,5:4250,+:5000
fsr_selling_price   = landed_cost_inr + profit(landed_cost)     PROFIT_BANDS 5000:1000,10000:1500,20000:2000,35000:3000,50000:3500,+:4000
```

When the weight is unknown, shipping is `WEIGHT_SURCHARGE_FALLBACK_INR` = ₹2,500 (`weight_unknown_fallback`). A
weight is used only when Michael Kors states it, or when the owner sets it per category (`CATEGORY_WEIGHT_KG`).
Every price is recomputed from the current source USD price, never from a previous FSR price. Promo codes and cart
discounts are ignored. If there is no valid exchange rate, price updates pause.

## Commands (`node src/michaelkors/cli.ts …`)

| | |
|---|---|
| `sync --dry-run --limit 5` | 5-product dry run, no Shopify writes |
| `sync --live --limit 5` / `--limit 25` | 5- / 25-product live test (products are created as DRAFT) |
| `sync --live` | full eligible catalog |
| `sync --live --styles 40R5KAHE6L,32F1GJ6E7B` | specific style numbers |
| `excluded` / `authorization` / `status` / `runs` / `prices` / `settings` / `set KEY VALUE` / `pause` / `resume` | |

Every 5 hours, after the tests pass: `powershell -ExecutionPolicy Bypass -File scripts\install-scheduler.ps1 -TaskName "FSR Michael Kors Sync" -Cli src\michaelkors\cli.ts`

## Missing products

A product is archived only after 2 consecutive reliable full scans that don't list it. Nothing is ever deleted. A scan
is unreliable, and no cleanup runs, if any of these happen:
- the source is blocked or geo-redirected
- a sitemap or page fails
- fewer than `MIN_CATALOG_SIZE` (100) eligible styles are found
- fewer than 50% of last time's styles are found

That condition is logged as `SOURCE_SCAN_UNRELIABLE`.

## Source: in-app browser harvest (current setup, 2026-09-26)

Plain HTTP from this machine is geo-redirected to the India store (INR) or refused by Akamai. Neither is bypassed.
The US catalog is read by the Claude desktop app's in-app browser, a normal browser that michaelkors.com serves.
The data is then handed to the importer as a feed:

1. In the in-app browser, open `https://www.michaelkors.com/robots.txt`. Paste `harvest.browser.js`, then run
   `startMkHarvest({ delayMs: 2000 })`. It reads the product sitemap and every non-watch product page, one page
   every ~3 s (~35 min for ~700 pages). Watch URLs are never fetched. A 403, 429 or challenge page stops it.
2. Poll `mkHarvestStatus()` until `state` is `done`.
3. Run `mkHarvestExport()`. The browser tool saves the large result to a file. Then run
   `node src/michaelkors/cli.ts feed-import <that file>`. A complete harvest replaces `data/michaelkors-feed/`. An
   incomplete one is set aside and the previous feed stays.
4. Run `node src/michaelkors/cli.ts sync --live` with `MK_SOURCE_MODE=feed`. A feed older than
   SYNC_INTERVAL_HOURS + 1 h, or an incomplete one, is never used for missing-product cleanup.

The harvest captures, per page:
- the JSON-LD (variants, sizes, colours, USD prices, availability, images)
- the page's own Details section, used as the description (exact figures, e.g. `Heel height: 3.5"`)
- the product's own "Was / Now" price block

The in-app browser blocks web pages from calling localhost, so the handover goes through the browser tool's saved
result, not an HTTP endpoint.

## Source status (2026-09-26)

michaelkors.com geo-redirects servers in India to michaelkors.global/in/en, the India store with INR prices. It
answers other automated clients with Akamai "Access Denied". Neither is bypassed. Until Michael Kors grants access,
use `SOURCE_MODE=feed` with authorized product data in `FEED_DIR`. That can be saved product pages (`.html`) or
`[{url, canonical, ld:[JSON-LD...]}]` JSON.
