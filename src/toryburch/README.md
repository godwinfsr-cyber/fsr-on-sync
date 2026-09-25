# Tory Burch → Full Size Run

A source adapter in the same service as the ON, Tissot, Casio, Gymshark, ALO and Michael Kors syncs. Like Michael Kors
it has its own SQLite database (`data/toryburch-sync.sqlite`), CLI and metafield namespace (`tory_burch_sync`). It
reuses the Shopify client and credentials (`.env`), the logger, the polite HTTP client, the exchange-rate service
(`src/gymshark/fx.ts`), the Shopify operations (`src/gymshark/ops.ts`), the **Michael Kors pricing engine**
(`src/michaelkors/pricing.ts`: `calculateMkPrice`, `profitFor`), MK's size / media helpers, and the Windows scheduler script.

```
DISCOVER  sitemap_index.xml -> en-us/sitemap-product.xml (robots-allowed; ~3,500 styles, ?color= links merged)
  -> URL pre-check: /watches/... = WATCH_EXCLUDED, EXCLUDED_CATEGORIES departments = SKIP (pages not fetched)
EXTRACT   product page: schema.org JSON-LD (ProductGroup + variants, BreadcrumbList)
          + the storefront's embedded product object (department / class, swatch names, sale vs original price, per-size stock)
NORMALIZE colours x sizes (US women's shoe sizes -> UK = US - 2), 2000x2000 images, details / dimensions / care
IS IT A WATCH?  yes -> SKIP ENTIRE PRODUCT, log TORY_BURCH_WATCH_EXCLUDED (never created, updated, imaged)
CHECK DUPLICATE  source id metafield -> stored id -> SKU / style number -> handle -> title
PRICE     current USD x live USD/INR + weight shipping + profit band   (same engine as Michael Kors)
productSet (DRAFT) + authorized images + tory_burch_sync metafields + custom.eta "15–20 Days" -> LOG
```

## Authorization (`config.ts`)

`BRAND_AUTHORIZATION` / `TORY_BURCH_AUTHORIZED_IMPORTER=true`: Full Size Run is an official / authorized Tory Burch
importer for India, including permission to download product images from toryburch.com and upload them to Shopify.
There is no copyright blocker. It applies to Tory Burch only (a test checks no other importer reads it). It never
authorises bypassing technical protection: one sequential request every 2 s with an honest User-Agent; a 403,
CAPTCHA or challenge page stops the crawl (`SourceBlockedError`) and the scan is marked `SOURCE_SCAN_UNRELIABLE`.

## Watches are always excluded (`exclusion.ts`)

`isExcludedToryBurchWatch()` is hard-coded (no setting can enable watches) and checks: department / class / subclass,
breadcrumbs, classification ids, JSON-LD category and variant names, source + canonical URL + embedded catalog path
(`/watches/...`), the title (watch, smartwatch, timepiece, watch band / strap, "Band for Apple Watch"), and watch-only
specifications. `buildTbPlan()` re-runs it on the final data before any create / update, so a watch can never reach
Shopify. Logged as `TORY_BURCH_WATCH_EXCLUDED`, `import_status=watch_excluded`,
`skip_reason="Tory Burch watches and watch-related products are excluded from Full Size Run import."`.
"T-Strap Sandal", "Headband", "Bandage Skirt" are not watch products.

`EXCLUDED_CATEGORIES` (default `gift card,fragrance,home`) is a separate, configurable rule: fragrance is flammable
air cargo (same as Michael Kors), home = glassware / linens / candles. Those are logged as `skipped`.

## Pricing (reuses `../michaelkors/pricing.ts`; bands in `TB_PRICING_DEFAULTS`)

```
converted_price_inr = source_price_usd × live USD/INR            source_price_usd = CURRENT selling price (the sale price when on sale)
landed_cost_inr     = converted_price_inr + shipping(weight)      0.5:1000,1:1500,2:2500,3:3500,5:4250,+:5000 (unknown weight ₹2,500)
fsr_selling_price   = landed_cost_inr + profit(landed_cost)       5000:1000,10000:1500,20000:2000,35000:3000,50000:3500,+:4000
```

The original ("was") price is stored separately (`source_regular_price_usd`). Checkout-only promotions ("extra 30% off
at checkout") are never applied; only the displayed product price is used. Every sync prices from the current source
USD price, never from a previous Shopify price. The USD/INR rate comes from open.er-api.com (no key), is at most 24 h
old (`USD_INR_RATE_MAX_AGE_HOURS`), and is never guessed: with no valid rate, price updates pause and nothing new is created.

## Commands (`node src/toryburch/cli.ts …`)

| | |
|---|---|
| `sync --dry-run --limit 5` / `--limit 25` / `sync --dry-run` | dry runs: discover, exclude, price, plan CREATE/UPDATE/SKIP, no Shopify writes |
| `sync --live --limit 5` / `--limit 25` | live tests (products are created as DRAFT) |
| `sync --live` | full eligible catalog |
| `sync --live --styles 135634,141183` | specific style numbers |
| `excluded` / `authorization` / `pricing` / `status` / `runs` / `prices` / `settings` / `set KEY VALUE` / `pause` / `resume` / `fx` | |
| `node scripts/toryburch-verify.ts` | read-only check of the linked Shopify products (media, variants, prices, ETA, metafields) |

Every 5 hours (Windows Task Scheduler; survives restarts; `tick` runs only when due, enabled and not already running):
`powershell -ExecutionPolicy Bypass -File scripts\install-scheduler.ps1 -TaskName "FSR Tory Burch Sync" -Cli src\toryburch\cli.ts`

## Missing products / safety

A product is archived only after 2 consecutive reliable full scans without it; nothing is ever deleted. A scan is
unreliable (`SOURCE_SCAN_UNRELIABLE`, no cleanup) when the source is blocked, a sitemap is missing or truncated, any page
fails, fewer than `MIN_CATALOG_SIZE` (500) eligible styles are found, or fewer than half of the last full scan.
Sold-out products stay in Shopify (DRAFT + `auto-oos-hidden`, restored when back in stock); sold-out sizes are `DENY`.

## Field ownership

Source-controlled: variants (Color × Size), SKUs (`<style>-<colour code>[-<UK size>]`), UPC barcodes, availability,
source prices, source images, specifications, `tory_burch_sync.*`. FSR-controlled: the price formula, ETA, tags added by
hand, merchandising, SEO / title / description once edited in Shopify (kept until reset), manually added media and variants.
