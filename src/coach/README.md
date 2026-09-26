# COACH + COACH Outlet → Full Size Run (one-time import)

A **one-time** catalog import, run **in the cloud** (GitHub Actions). It has no schedule, no recurring sync and no
source monitoring. Running it again only adds products that are still missing, and it never changes existing ones.

Full Size Run is an authorized COACH importer for India, with permission to use COACH product images and product
information (store owner, 2026-09-26).

## How it works

```
coach.com sitemap (2,467 styles: mainline + /products/outlet/)
        │  coach.com product pages answer scripted requests (PC and cloud runner) with an Akamai 403 →
        │  they are read ONCE in an ordinary browser session (harvest.browser.js), never with stealth tooling
        ▼
data/coach-feed/runs/<harvest>/part-*.json   (committed to the repo)
        ▼  GitHub Actions: .github/workflows/coach-import.yml (manual trigger only)
normalize → watch / Restored / fragrance exclusion → cross-source dedupe → validation
        → live USD/INR (open.er-api.com, ≤ 24 h, never guessed) → pricing → Shopify duplicate check
        → productSet (variants, images, metafields, custom.eta) → publish → report (data/coach-reports/latest.md)
```

* **One Shopify product = one Coach style + colour** (`coach_sync.source_product_id`, e.g. `CV933-IMXAQ`). This is the
  same model as the 2,495 Coach products the store already had, so they are recognised and never duplicated.
* A style page also lists **other style numbers** as variants. Those are different products (for example "Restored Rogue
  Bag With Leather Sequins" appears on the alligator Rogue page). They are only created from **their own** page
  (`/products/p/<STYLE-COLOUR>.html`). Products seen only on another style's page are listed in
  `data/coach-reports/needs-own-page.json`, and the next harvest pass reads exactly those pages.
* **Dedupe** follows this order: style + colour → SKU → UPC/GTIN → canonical URL (mainline and `/outlet/` forms normalized) →
  title + colour + material + price. Before each create, a live store-wide check (SKU family, barcode, handle) runs.
  `productSet` uses the handle as its identifier, so a retry after a network drop cannot create a second product.
* **Watches are never imported.** `isExcludedCoachWatch` checks category, classification, filter category, category id,
  breadcrumbs, product type, title, URL, tags and specifications. It runs again inside `buildProduct` right before
  anything is sent to Shopify. The 151 watch URLs in the sitemap are never read.
* **Pricing** uses the Michael Kors engine: USD current selling price × live USD/INR, plus weight-band shipping (Coach
  publishes no weights, so the ₹2,500 fallback applies), which gives the landed cost. The profit band on the landed cost
  is added to get the FSR price, rounded to the rupee. Compare-at is Coach's regular price × the same rate only (no
  shipping or profit), and only when it is above the FSR price.
* Shoes are listed in **UK sizes** (store rule: women's US − 2, men's US − 0.5). A shoe with no stated gender is not
  converted by guesswork; it is reported as "needs review".
* Status is ACTIVE and published to Online Store, POS and Inbox. A product where every size is sold out at Coach is
  created as DRAFT with `auto-oos-hidden` (the store's out-of-stock rule). Test runs create products as DRAFT.

## Running it (cloud)

GitHub → Actions → **COACH → Full Size Run one-time import** → Run workflow → pick a mode:

| mode | what it does |
|---|---|
| `dry-run` | evaluates everything and writes nothing (report lists what would be created) |
| `test-5` / `test-25` | creates the first 5 / 25 missing products as DRAFT |
| `full` | creates every missing eligible product |

The same modes can be requested by committing `data/coach-feed/run-request.json`, e.g.
`{"mode":"test","limit":5,"status":"DRAFT"}` or `{"mode":"full"}`.

Secrets used: the repo's existing `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` (the same Shopify app as the other
importers). There are no other credentials; the exchange-rate provider needs no key.

The checkpoint database `data/coach-import.sqlite` and `data/coach-reports/` are committed back after every run, so an
interrupted run continues safely.

## CLI

```
node src/coach/cli.ts import --dry-run [--limit N]
node src/coach/cli.ts import --limit 5 | --limit 25 [--status ACTIVE]
node src/coach/cli.ts import --full [--keys CV933-IMXAQ,...]
node src/coach/cli.ts feed-import <browser-export-chunk.json ...>
node src/coach/cli.ts report | status | runs | unlock
```

## Refreshing the source data (only if you want a newer catalog)

In the in-app browser, open any coach.com page, paste `harvest.browser.js`, then call
`startCoachHarvest({ urls, delayMs: 2500 })`. When it finishes, save `coachHarvestExport(from, to)` chunks and run
`feed-import` on them, commit the feed, then run the workflow.
