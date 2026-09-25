# ALO Yoga → Full Size Run

Source adapter in the same service as the ON, Tissot, Casio and Gymshark syncs. It has its own SQLite database
(`data/alo-sync.sqlite`), CLI, dashboard page (`/alo`) and metafield namespace (`alo_sync`). It shares the Shopify
client, logger, polite HTTP client, `.env` credentials, and the Gymshark exchange-rate service (`gymshark/fx.ts`,
which records ALO rates in the ALO database) and Shopify operations (`gymshark/ops.ts`, with the `alo_sync` namespace).

```
aloyoga.com/products.json?limit=250&page=N   (whole live US catalog, USD; ~17 requests; nothing hard-coded)
  -> exclude loyalty rewards / gift cards / dummies -> group colourways by ALO StyleId (men's copies merged)
  -> details, cached for 7 days: /products/{handle}.json (barcodes + currency check), one product page per style
     (ALO's fabrication / fit attributes)
  -> exchange rate (live, validated, stored) -> price per variant -> match -> productSet -> images -> report
```

Only public endpoints listed in ALO's agents.md and allowed by robots.txt are used, sequentially, with an honest
User-Agent. HTTP 403, a challenge page or repeated 429s stop the run: no stealth, proxies or CAPTCHA handling.
`/en-in/` shows ALO's own INR prices, so the US storefront (USD) is read; every run confirms the currency is USD
and aborts with `ALO SOURCE HEALTH CHECK FAILED` if not.

## Commands (`node src/alo/cli.ts …`)

| Command | What it does |
|---|---|
| `sync --dry-run` | Plan `ALO_TEST_PRODUCT_LIMIT` styles, **no Shopify writes** |
| `sync --live --limit 25` | Live run for the first 25 styles |
| `sync --live --styles W54234R,M6154R` | Live run for specific ALO style ids (or handles) |
| `sync --live --limit 0 --full` | Whole catalog once, regardless of the test guard |
| `sync` / `tick` | Use the settings; `tick` (scheduler) syncs only when due, not paused, not running |
| `fx` / `status` / `runs` / `prices` / `settings` | Rate check, state, history, price changes, settings |
| `pause` / `resume` / `set KEY VALUE` | Control (settings stored in SQLite override `.env`) |

**Catalog guard:** a run processes at most `ALO_TEST_PRODUCT_LIMIT` styles unless `ALO_FULL_SYNC=true` **and**
`ALO_TEST_MODE=false`.

Every 5 hours **in the cloud**: GitHub Actions workflow `.github/workflows/alo-sync.yml` (cron `50 */5 * * *` UTC,
plus a run whenever `src/alo/**` changes; "Run workflow" button for manual live / dry runs). Each run commits
`data/alo-sync.sqlite` back to the repo so state (product links, image ids, cached details, FX history) carries over.
Nothing needs to run on the office PC. The first full import takes ~2-3 hours; later runs re-read details only weekly
or for new SKUs.

## Pricing

```
converted_price_inr = alo_current_usd × usd_inr_rate
fsr_selling_price   = converted_price_inr + ALO_FLAT_ADJUSTMENT_INR (₹3,000)
compare_at          = alo_regular_usd × usd_inr_rate + ₹3,000, only while ALO shows a sale
```

Always from ALO's current USD price, never from a previous FSR price, so the ₹3,000 never compounds. There are no
percentages. `PRICE_ROUNDING_MODE=NONE` keeps paise. The rate provider is open.er-api.com (or frankfurter / manual).
Rates are validated (plausible range, ≤10% jump) and stored with provider and timestamp. If there is no valid rate
younger than `MAX_EXCHANGE_RATE_AGE_HOURS` (24), price updates pause and new products are not created.
A price edited by hand in Shopify is kept until ALO's USD price changes. An exchange-rate change re-prices every variant.

## Field ownership

| Always from ALO | Written on create, later only if unedited in Shopify | Never touched after create |
|---|---|---|
| variants (Color × Size), SKUs, barcodes, availability, source prices, images, specs, `alo_sync.*` | title, description, SEO (blank SEO is filled), `custom.eta` | product type, manual tags / media / variants |

## Identity and duplicates

StyleId tag → ALO's YGroup tag → handle prefix. Unisex styles listed twice ("MensU3032RG") are merged. Each SKU is
given to exactly one style. `alo_sync.source_product_id` has a unique Shopify definition; writes are
`productSet(identifier: customId)` upserts. Variants match by SKU, and images match by CDN path, so they are never
re-uploaded. A hand-made product already using a style's SKUs is reported as *needs review*.

## Availability and removal

In stock at ALO → `inventoryPolicy CONTINUE` (0 on hand, imported to order). Sold out → `DENY`. Fully sold out → DRAFT
+ `auto-oos-hidden` (store policy), restored when back. Tagged `ETA`, never `Instant Ship`. A style missing from a
healthy, complete, unlimited scan is warned once, then `source_status = missing` and archived on the 2nd scan.
Nothing is ever deleted. If the source is unhealthy, missing-product detection is skipped.

## Sizes and types

Apparel keeps ALO's sizes. Footwear uses UK sizes (store rule): dual labels `8M/9.5W` → men's US − 0.5 = `7.5`,
women's → US − 2. Labels without a stated gender (`EU 35/US 5` sandals) are kept as-is. Product type comes from
`ALO_PRODUCT_TYPE_MAP` (Leggings, Sports Bras, Hoodies …). All footwear maps to `Sneakers`, because the store's
Sneakers tab keys on that type.

## Content

FSR confirmed (2026-09-26) that it is an authorised ALO Yoga importer for India, with permission to use ALO product
images, descriptions and specifications: `ALO_AUTHORIZATION_CONFIRMED=true`.
