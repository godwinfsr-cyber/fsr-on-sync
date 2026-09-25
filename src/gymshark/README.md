# Gymshark → Full Size Run

Source adapter in the same service as the ON, Tissot and Casio syncs. It has its own SQLite database
(`data/gymshark-sync.sqlite`), CLI, dashboard page (`/gymshark`) and metafield namespace (`gymshark_sync`),
and shares the Shopify client, logger, polite HTTP client (`src/politeHttp.ts`) and `.env` credentials.

```
gymshark.com/robots.txt -> sitemap.xml -> sitemap_products_N.xml   (whole live catalog, nothing hard-coded)
  -> product page (Next.js page data + JSON-LD). One page lists EVERY colourway of its style, so sibling
     colour pages are skipped (about half the requests)
  -> normalize: one FSR product per style code (e.g. A5A2Z), Color × Size variants, Gymshark SKUs + barcodes
  -> exchange rate (live, validated, stored) -> price per colour -> match -> productSet -> images -> report
```

## Commands (`node src/gymshark/cli.ts …`)

| Command | What it does |
|---|---|
| `sync --dry-run --limit 5` | Crawl 5 styles, price and plan them, **no Shopify writes** |
| `sync --live --handles gymshark-legacy-t-shirt-black-aw23` | Live run for specific product URLs/handles |
| `sync` | Uses `GYMSHARK_DRY_RUN` / `GYMSHARK_SYNC_LIMIT` |
| `tick` | Scheduler entry: syncs only when due, not paused and not already running |
| `fx` | Fetch and validate USD/INR now, show recent rates |
| `status` / `runs` / `prices` / `settings` | State, history, price changes, effective settings |
| `pause` / `resume` / `set KEY VALUE` | Control (settings are stored in SQLite, overriding `.env`) |

Every 5 hours: `powershell -ExecutionPolicy Bypass -File scripts\install-scheduler.ps1 -TaskName "FSR Gymshark Sync" -Cli src\gymshark\cli.ts`
(an hourly `tick`, which syncs once `SYNC_INTERVAL_HOURS` has passed). A full crawl takes roughly 1–1.5 h at the
2.5 s politeness gap.

## Pricing (all values in `.env` as `GYMSHARK_*`, editable on the dashboard)

```
converted_price_inr = gymshark_usd × usd_inr_rate
final_fsr_price     = round( converted_price_inr + weight_surcharge_inr + FSR_PROFIT_INR )
compare_at          = same formula on Gymshark's regular price, only while Gymshark shows a sale
```

- **Source price**: `SOURCE_PRICE_BASIS=CURRENT_SELLING` (what Gymshark charges now, i.e. the sale price when on
  sale), or `REGULAR`. The per-colour price is used. Gymshark's per-size price field is truncated ($14 for $14.40),
  so it is not used.
- **No percentage discount** is ever applied. Prices are always recomputed from current source data, never from
  a previous FSR price.
- **Weight surcharge**: `WEIGHT_BANDS=0.5:1000,1:1500,2:2000,3:2500,+:3000` (upper bound in kg : ₹). Gymshark does
  not publish product weights, so every product currently gets `WEIGHT_SURCHARGE_FALLBACK_INR` (₹2,000), with
  `weight_surcharge_reason = fallback_weight_unknown`. No weight is invented.
- **FSR profit**: `FSR_PROFIT_INR=1500`.
- **Rounding**: `PRICE_ROUNDING_MODE=NONE` (paise precision) | `NEAREST_10` | `NEAREST_50` | `NEAREST_100`.

### Exchange rate safety (`src/gymshark/fx.ts`)

- The provider is `open.er-api.com` (default; daily, no key needed) or `frankfurter` (ECB reference rates), or
  `manual` with `MANUAL_EXCHANGE_RATE`.
- Every fetch is stored in `fx_rates` with the provider, the provider's timestamp and when it was fetched. The rate,
  timestamp and provider used are also written to each product (`gymshark_sync.exchange_rate*`).
- A rate is rejected if it is implausible (USD/INR outside 40–250), if the provider's data is more than 96 h old,
  or if it moves more than 10% from the last good rate. A rejected rate is never applied silently.
- If the provider is down, the last valid rate is used only if it was obtained within
  `MAX_EXCHANGE_RATE_AGE_HOURS` (24). Otherwise **price updates pause**: existing prices stay as they are, new
  products and new colours are not created, and the report and dashboard show a warning. A manual rate expires
  after the same age unless it is re-saved.

## Field ownership

| Always from Gymshark | Written on create, later only if not edited in Shopify | Never touched after create |
|---|---|---|
| Color × Size variants, SKUs, barcodes, availability (inventory policy), source prices, images, specs, `gymshark_sync.*` | title, description, SEO, `custom.eta` (15–20 Days) | product type, manual tags, manual variants/media |

Selling price is FSR-controlled. A price edited by hand in Shopify is kept until Gymshark's USD price for that
colour changes.

## Duplicate protection

1. `gymshark_sync.source_product_id` (the style code) has a **unique** metafield definition, and every write is a
   `productSet(identifier: customId)` upsert.
2. Local map from style code to Shopify product id. A title change never creates a new product.
3. Variants are matched by Gymshark SKU. Colours or sizes that Gymshark drops are kept as unavailable, never deleted.
4. Images: each source photo's CDN path (without `?v=`) maps to its Shopify media id in the `images` table. When the
   image set changes, photos already uploaded are referenced by media id and only new ones are uploaded. Media added
   by hand is kept. Each variant gets its colourway's first photo.
5. A hand-made product that already uses a style's SKUs is reported as *needs review* unless
   `ADOPT_EXISTING_PRODUCTS=true`.

## Availability and removal

- A size in stock at Gymshark gets `inventoryPolicy: CONTINUE` (orderable, 0 on hand, since FSR imports to order).
  A sold-out size gets `DENY`. Gymshark's own stock counts are only used for the `low_stock` label and are never
  copied as FSR stock.
- If every size is sold out, the product goes to DRAFT with tag `auto-oos-hidden` (the store's out-of-stock
  policy), and is restored when stock returns. Products are tagged `ETA` and never `Instant Ship`.
- A style missing from a complete scan (with no failed pages) is archived after
  `PRODUCT_MISSING_CONFIRMATION_SCANS` scans. Nothing is ever deleted.

## Politeness and access

Only robots.txt-allowed, public pages are used: the sitemaps and `/products/<handle>`. `/products.json` is blocked by
Gymshark's CDN (HTTP 403), so it is not used. Requests are sequential with a 2.5 s gap and an honest User-Agent.
HTTP 403, a challenge page or repeated 429s stop the run: no stealth, proxies or CAPTCHA handling.
The e-gift card is excluded.

## Content

Full Size Run confirmed (2026-09-26) that it is authorised to import Gymshark product photos, descriptions and
specifications, so `GYMSHARK_CONTENT_REUSE_CONFIRMED=true`. Descriptions keep Gymshark's formatting, minus editor
debris and the single-colour "SKU:" line. FSR's SKU line and standard disclaimer are appended. Specifications
contain only fields Gymshark states.

## Categorisation

Product type follows the store's existing navigation (`PRODUCT_TYPE_MAP`): Apparel, Bags or Accessories. The
Gymshark category (Leggings, Sports Bras, Shorts…) is stored in tags (`Leggings`, `Gymshark Leggings`), in
`gymshark_sync.category` and in the specifications, along with the gender and range.
