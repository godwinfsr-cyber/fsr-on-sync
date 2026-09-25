# Stanley 1913 → Full Size Run

`node src/stanley/cli.ts <cmd>` · dashboard `/stanley` · database `data/stanley-sync.sqlite` · metafields `stanley_sync.*`

Built on the same architecture as the ALO Yoga importer: shared Shopify client/credentials (`src/shopify/client.ts`),
`productSet` upserts keyed on a unique `stanley_sync.source_product_id` definition (`GymsharkOps`), the shared
exchange-rate service (`src/gymshark/fx.ts`), the polite HTTP client with backoff (`src/politeHttp.ts`), the logger,
the dashboard server and the Windows Task Scheduler `tick`.

## Authorisation

`STANLEY_AUTHORIZED_IMPORTER=true`: Full Size Run is the official / authorised Stanley 1913 importer for India
(stated by the store owner, 2026-09-26). Stanley product images are downloaded by Shopify from Stanley's CDN and
hosted as Shopify media; Stanley descriptions, specifications and media are used. This setting belongs to the
Stanley importer only. It is not a technical-access permission: only public endpoints that robots.txt allows are read,
one request at a time; HTTP 403, repeated 429 or a challenge page stops the run (`SOURCE_SCAN_UNRELIABLE`), with no retries around it.

## Discovery

`/products.json?limit=250&page=N` lists the complete live catalog (every collection: Quencher, IceFlow, Drinkware, Sale,
New Arrivals …), so new launches are found on every run. Nothing about the catalog is hard-coded. Per product, the sync reads
`/products/{handle}.json` (barcodes, weight, **price currency must be USD**) and the product page (Stanley's spec
list: Capacity, Material, Insulation, Weight, Dimensions, Care; breadcrumb category). Details are cached for 72 h.

Excluded by default (configurable): the "Stanley Create" personalised copies of regular products (`stanley_create`),
the Engraving Fee (`Service Fee`), free sticker packs (`$0`).

**One FSR product per Stanley product.** Stanley lists each seasonal drop of a product as its own listing
(an evergreen "Quencher ProTour 40 OZ" plus Back-to-School, Mother's Day, Picnic … listings) and shows them as colour
swatches. Listings with the same normalised title are merged into one Shopify product with **Color** variants. Capacities
are separate Stanley products (in the title), so they stay separate. When two listings share a colour, the in-stock one is used.

## Pricing (the only formula)

```
fsr_price = source_usd_selling_price × live USD/INR + STANLEY_PRICING_ADJUSTMENT_INR (₹3,000)
```
The price is always recalculated from the current Stanley USD price, so the ₹3,000 is never added twice. There is no shipping, weight band, profit band
or percentage markup. On sale, the sale price is used and the regular price is stored in `source_regular_price_usd`. It is also
shown as compare-at (regular × rate + ₹3,000), `STANLEY_COMPARE_AT_MODE=NONE` turns that off. Cart promotions are
never applied. The rate comes from open.er-api.com (validated: plausible range, no >10 % jump). It is at most 24 h old, falling back to the last
valid rate inside that window. Otherwise prices pause (existing prices kept, no new products created).

Test-only examples (₹85): $30 → ₹5,550 · $40 → ₹6,400 · $100 → ₹11,500 · $150 → ₹15,750 (`test/stanley.test.ts`).

## Duplicate protection (priority order)

1. Stanley product id (every merged listing's id is remembered), 2. variant SKU, 3. (Stanley publishes no style number),
4/5. canonical URL / handle, 6. normalised title. The chosen key never changes. It is written to the unique
`stanley_sync.source_product_id`, so Shopify itself refuses a second product. Before creating, every SKU is looked up in
Shopify: a hand-made product using them → *needs review* (unless `STANLEY_ADOPT_EXISTING_PRODUCTS=true`).

## Availability / removal

Available colour → `inventoryPolicy CONTINUE` (sold to order); sold out → `DENY`. All colours sold out → DRAFT +
`auto-oos-hidden` (store policy), restored on restock. Colours Stanley stops listing are kept as unavailable variants.
A product is archived (never deleted) only after it is missing from **2 consecutive complete, healthy, unlimited scans**.
Partial, blocked, failed or suspiciously small scans (< 50 % of the last complete one) never count.

## Commands

| | |
|---|---|
| `node src/stanley/cli.ts sync --dry-run --limit 5` | TEST 1 dry run (no Shopify writes) |
| `node src/stanley/cli.ts sync --live --limit 5` / `--limit 25` | live test batches |
| `node src/stanley/cli.ts sync --live --limit 0 --full` | whole catalog |
| `node src/stanley/cli.ts sync --products <handle|id>` | specific products |
| `node src/stanley/cli.ts tick` | scheduler entry (runs only when enabled, due, not paused) |
| `node src/stanley/cli.ts fx / status / runs / prices / pause / resume / set KEY VALUE` | |

Scheduling (survives restarts, every 5 h via an hourly tick):
`powershell -ExecutionPolicy Bypass -File scripts\install-scheduler.ps1 -TaskName "FSR Stanley Sync" -Cli src\stanley\cli.ts`

Each run writes `logs/STANLEY-SYNC-<date>-NNN.report.txt` / `.report.json` / `.jsonl`.
