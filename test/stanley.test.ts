import "./helpers/isolated-data.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveLimit, stanleyEnvSettings, type StanleySettings } from "../src/stanley/config.ts";
import { groupStanleyCatalog, imageColour, normalizeStanley, titleKeyOf, capacityOf } from "../src/stanley/normalize.ts";
import { OOS_TAG, PlanConflict, buildStanleyPlan } from "../src/stanley/plan.ts";
import { calculateStanleyPrice } from "../src/stanley/pricing.ts";
import { parseListingDetail, parsePageDetail, type StanleyRawProduct } from "../src/stanley/source.ts";
import { buildKeyIndex, pricesFor, resolveKey } from "../src/stanley/sync.ts";
import type { GShopifyProduct } from "../src/gymshark/ops.ts";
import type { StanleyRow } from "../src/stanley/db.ts";

const settings: StanleySettings = {
  ...stanleyEnvSettings(), SOURCE_PRICE_BASIS: "CURRENT_SELLING", COMPARE_AT_MODE: "SOURCE_REGULAR", PRICING_ADJUSTMENT_INR: 3000, PRICE_ROUNDING_MODE: "NONE",
  ETA: "15–20 Days", NEW_PRODUCT_STATUS: "DRAFT", AUTHORIZED_IMPORTER: true, VENDOR: "Stanley 1913", TITLE_TEMPLATE: "Stanley 1913 {title}",
  BASE_TAGS: "Stanley,Stanley 1913,ETA,stanley-sync", SOURCE_CURRENCY: "USD", TARGET_CURRENCY: "INR",
  EXCLUDED_PRODUCT_TYPES: "Service Fee,Sticker,Gift Card,E Gift Card", EXCLUDED_TAGS: "stanley_create,engraving-fee", EXCLUDED_TITLE_PATTERNS: "Stanley Create,Engraving Fee,Gift Card",
  DEFAULT_PRODUCT_TYPE: "Drinkware",
};
const fx85 = { ok: true, rate: 85, base: "USD", quote: "INR", provider: "test", providerUpdatedAt: null, fetchedAt: "2026-09-26T00:00:00.000Z", origin: "live" as const };
const price = (usd: number, regular = usd) => calculateStanleyPrice({ currentUsd: usd, regularUsd: regular, currency: "USD" }, fx85, settings);

// ---------- fixtures (shape of stanley1913.com /products.json) ----------

let vid = 5000;
function listing(o: { id: number; handle: string; title: string; type?: string; colours: string[]; skus: string[]; price: string; compare?: string | null; available?: boolean[]; tags?: string[]; images?: string[] }): StanleyRawProduct {
  const variants = o.colours.map((c, i) => ({
    id: vid++, title: c, option1: c, option2: null, option3: null, sku: o.skus[i], available: o.available?.[i] ?? true, price: o.price, compare_at_price: o.compare ?? null, grams: 0,
    featured_image: { id: 1, src: `https://cdn.shopify.com/s/files/1/0375/3269/6635/files/Web_PNG_Square-Tumbler-${c.replace(/ /g, "_")}-Front.png?v=1` },
  }));
  const imgs = o.images ?? o.colours.map((c) => `Web_PNG_Square-Tumbler-${c.replace(/ /g, "_")}-Front.png`);
  return {
    id: o.id, title: o.title, handle: o.handle, body_html: "<p>Keeps drinks cold for hours.</p><p><em>*Not Eligible For Promotions or Resell. Multiple &amp; Large Orders Are Subject To Cancellation.</em></p>",
    published_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-20T00:00:00Z", vendor: "Stanley 1913", product_type: o.type ?? "Tumblers", tags: o.tags ?? ["Drinkware", "Tumblers"],
    variants,
    images: imgs.map((f, i) => ({ id: o.id * 100 + i, src: `https://cdn.shopify.com/s/files/1/0375/3269/6635/files/${f}?v=17`, position: i + 1, width: 1500, height: 1500, variant_ids: f.includes("-Front") ? variants.filter((v) => f.includes(v.option1!.replace(/ /g, "_"))).map((v) => v.id) : [] })),
    options: [{ name: "Color", position: 1, values: o.colours }],
  };
}
const evergreen = listing({ id: 100, handle: "quencher-40-oz", title: "The Quencher® H2.0 Flowstate™ Tumbler | 40 OZ", colours: ["Black 2.0", "Cream", "Rose Quartz"], skus: ["100000000001", "100000000002", "100000000003"], price: "45.00", available: [true, false, true],
  images: ["Web_PNG_Square-Tumbler-Black_2.0-Front.png", "Web_PNG_Square-Tumbler-Black_2.0-Back.png", "Web_PNG_Square-Tumbler-Cream-Front.png", "Web_PNG_Square-Tumbler-Rose_Quartz-Front.png", "Web_PNG_Square-Tumbler-Hydrangea-Front.png", "Lifestyle_1.jpg"] });
const seasonal = listing({ id: 200, handle: "quencher-40-oz-fall", title: "The Quencher H2.0 Flowstate™ Tumbler | 40 OZ", colours: ["Cream", "Fig Gloss"], skus: ["100000000010", "100000000011"], price: "30.00", compare: "40.00" });
const create = listing({ id: 300, handle: "quencher-40-oz-stanley-create", title: "The Quencher H2.0 Flowstate™ Tumbler | 40 OZ - Stanley Create", colours: ["Cream"], skus: ["100000000002C"], price: "45.00", tags: ["stanley_create"] });
const fee = { ...listing({ id: 400, handle: "engraving-fee", title: "Engraving Fee", type: "Service Fee", colours: ["Front"], skus: ["10214810003E"], price: "10.00" }), options: [{ name: "Engraving Type", position: 1, values: ["Front"] }] };
const sticker = listing({ id: 500, handle: "sticker-pack", title: "Stanley 1913 x USA Sticker Pack", type: "Mugs", colours: ["Default"], skus: ["100000151878"], price: "0.00" });
const mug = { ...listing({ id: 600, handle: "classic-mug", title: "The Legendary Camp Mug | 12 OZ", type: "normal", colours: ["x"], skus: ["100000000050"], price: "25.00" }), options: [{ name: "Title", position: 1, values: ["Default Title"] }] };
mug.variants[0] = { ...mug.variants[0], title: "Default Title", option1: "Default Title" };
const catalog = [evergreen, seasonal, create, fee, sticker, mug];
const grouped = groupStanleyCatalog(catalog, settings);
const details = { barcodes: { "100000000001": "041604495151" }, weights: { "100000000001": "1.4 lb" }, page: { specs: { Capacity: "40 oz", Material: "18/8 recycled stainless steel", Weight: "1.49 lbs.", Dimensions: "5.82 x 3.93 x 10.78 in." }, care: "Dishwasher safe.", breadcrumb: ["Drinkware", "Tumblers"] } };
const quencher = normalizeStanley(grouped.groups.find((g) => g.titleKey.includes("quencher"))!, details, settings);

// ---------- pricing: spec tests A-D at the TEST-ONLY rate ₹85 ----------

test("pricing tests A-D: USD x ₹85 + ₹3,000 flat, exactly", () => {
  assert.equal(price(30).fsrPrice, 5550);    // Test A
  assert.equal(price(40).fsrPrice, 6400);    // Test B
  assert.equal(price(100).fsrPrice, 11500);  // Test C
  assert.equal(price(150).fsrPrice, 15750);  // Test D
  const a = price(30);
  assert.equal(a.convertedPriceInr, 2550);
  assert.equal(a.pricingAdjustmentInr, 3000);
});

test("pricing: sale uses the current selling price, regular stored separately, compare-at from regular", () => {
  const p = price(30, 40);
  assert.equal(p.fsrPrice, 5550);
  assert.equal(p.sourceRegularPriceUsd, 40);
  assert.equal(p.sourceSalePriceUsd, 30);
  assert.equal(p.compareAtPrice, 6400);
  // compare-at below the price is not a sale
  const odd = price(31, 30);
  assert.equal(odd.sourceSalePriceUsd, null);
  assert.equal(odd.compareAtPrice, null);
});

test("pricing: ₹3,000 applied exactly once, recalculated from the source price (no drift)", () => {
  const first = price(45).fsrPrice!;
  const again = price(45).fsrPrice!;
  assert.equal(first, again);
  assert.equal(first, 45 * 85 + 3000);
  // the adjustment is one central setting
  const p = calculateStanleyPrice({ currentUsd: 30, regularUsd: 30, currency: "USD" }, fx85, { ...settings, PRICING_ADJUSTMENT_INR: 2500 });
  assert.equal(p.fsrPrice, 5050);
});

test("pricing: no valid rate / wrong currency / $0 -> no price (never guessed)", () => {
  assert.equal(calculateStanleyPrice({ currentUsd: 30, regularUsd: 30, currency: "USD" }, { ok: false, rate: null, base: "USD" }, settings).ok, false);
  assert.equal(calculateStanleyPrice({ currentUsd: 30, regularUsd: 30, currency: "INR" }, fx85, settings).ok, false);
  assert.equal(price(0).ok, false);
});

// ---------- discovery / grouping ----------

test("grouping: seasonal listings of the same product merge; Create copies, fees and $0 items are excluded", () => {
  assert.equal(grouped.groups.length, 2);
  const q = grouped.groups.find((g) => g.titleKey.includes("quencher"))!;
  assert.deepEqual(q.listings.map((l) => l.id), [100, 200]); // evergreen (most colours) first
  assert.equal(grouped.excluded['tag "stanley_create"'], 1);
  assert.equal(grouped.excluded['product type "Service Fee"'], 1);
  assert.equal(grouped.excluded["free / promotional item (price $0)"], 1);
  assert.equal(titleKeyOf("The Quencher® ProTour Flip Straw Tumbler | 30 OZ - Stanley Create"), titleKeyOf("The Quencher ProTour Flip Straw Tumbler | 30 OZ"));
  assert.notEqual(titleKeyOf("The Quencher | 30 OZ"), titleKeyOf("The Quencher | 40 OZ"));
});

test("normalize: one product, one variant per colour; the in-stock listing wins a shared colour", () => {
  assert.deepEqual(quencher.variants.map((v) => v.colour), ["Black 2.0", "Cream", "Rose Quartz", "Fig Gloss"]);
  const cream = quencher.variants.find((v) => v.colour === "Cream")!;
  assert.equal(cream.sku, "100000000010");       // evergreen Cream is sold out, the fall listing has it
  assert.equal(cream.availability, "in_stock");
  assert.equal(cream.currentUsd, 30);
  assert.equal(cream.regularUsd, 40);
  assert.equal(quencher.duplicatesSkipped, 1);
  assert.equal(quencher.title, "Stanley 1913 The Quencher® H2.0 Flowstate™ Tumbler | 40 OZ");
  assert.equal(quencher.capacity, "40 oz");
  assert.equal(quencher.category, "Tumblers");
  assert.equal(quencher.collection, "Drinkware");
  assert.equal(quencher.variants[0].barcode, "041604495151");
  assert.equal(quencher.specs.Material, "18/8 recycled stainless steel");
  assert.match(quencher.descriptionHtml, /Keeps drinks cold/);
  assert.doesNotMatch(quencher.descriptionHtml, /Resell/i);   // Stanley store policy line removed
  assert.match(quencher.descriptionHtml, /<strong>Capacity:<\/strong> 40 oz/);
});

test("normalize: images - colour photos grouped, retired colours skipped, general shots kept, no duplicates", () => {
  const keys = quencher.images.map((i) => i.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(!keys.some((k) => k.includes("hydrangea")));      // colour no longer sold
  assert.ok(keys.some((k) => k.includes("lifestyle_1")));     // general shot
  assert.equal(quencher.images[0].colour, "Black 2.0");
  assert.ok(quencher.images.every((i) => !i.url.includes("?")));
  assert.equal(imageColour("x/Web_PNG_Square-Quencher40OZ-Black2.0Fade-Front.png", null, ["Black 2.0"]), "retired");
  assert.equal(imageColour("x/2025_Quencher_40OZ_-_Blue_Sky_-_Front.png", null, ["Blue Sky"]), "Blue Sky");
});

test("normalize: single default variant keeps Shopify's Title option", () => {
  const m = normalizeStanley(grouped.groups.find((g) => g.titleKey.includes("camp mug"))!, { barcodes: {}, weights: {}, page: null }, settings);
  assert.equal(m.hasColourOption, false);
  assert.equal(m.variants.length, 1);
  assert.equal(m.capacity, "12 OZ");
  assert.equal(capacityOf("The All Day Julienne Mini Cooler | 10 Can | 7.4 QT | 7.0 L", {}), "10 Can / 7.4 QT / 7.0 L");
});

// ---------- source parsers ----------

test("source: product page specification list, care text, breadcrumb", () => {
  const html = `<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[{"position":1,"name":"home"},{"position":2,"name":"Drinkware"},{"position":3,"name":"Tumblers"},{"position":4,"name":"The Quencher"}]}</script>
  <ul class="c-details__list"><li><strong>Capacity:</strong> 40 oz</li><li><strong>Material:</strong> 18/8 recycled stainless steel</li></ul>
  <p><strong>Care:</strong> Dishwasher safe. Not for use with hot liquids.</p>
  <div class="c-details__specs"><div class="c-details__spec"><h3 class="c-details__label"> Weight: </h3><div class="c-details__detail">1.49 lbs.</div></div>
  <div class="c-details__spec"><h3 class="c-details__label"> Dimensions: </h3><div class="c-details__detail"> 5.82 x 3.93 x 10.78 in. </div></div></div>`;
  const d = parsePageDetail(html);
  assert.deepEqual(d.specs, { Capacity: "40 oz", Material: "18/8 recycled stainless steel", Weight: "1.49 lbs.", Dimensions: "5.82 x 3.93 x 10.78 in." });
  assert.equal(d.care, "Dishwasher safe. Not for use with hot liquids.");
  assert.deepEqual(d.breadcrumb, ["Drinkware", "Tumblers"]);
  const l = parseListingDetail(JSON.stringify({ product: { variants: [{ sku: "100000147719", barcode: "041604495151", price_currency: "USD", weight: 1.4, weight_unit: "lb" }] } }));
  assert.equal(l.currency, "USD");
  assert.equal(l.barcodes["100000147719"], "041604495151");
  assert.equal(l.weights["100000147719"], "1.4 lb");
});

// ---------- duplicate protection ----------

test("identity: source product id, then SKU, then handle, then title; never shared within a run", () => {
  const row = { product_key: "100", source_product_ids: JSON.stringify({ "quencher-40-oz": "100" }), source_skus: JSON.stringify(["100000000001"]), source_handles: JSON.stringify(["old-handle"]), title_key: "old title" } as StanleyRow;
  const ix = buildKeyIndex([row]);
  const base = { sourceProductIds: { x: "999" }, skus: ["1"], handles: ["h"], titleKey: "t", primaryProductId: "999" };
  assert.deepEqual(resolveKey({ ...base, sourceProductIds: { a: "100" } }, ix, new Set()), { key: "100", matchedBy: "source product id" });
  assert.deepEqual(resolveKey({ ...base, skus: ["100000000001"] }, ix, new Set()), { key: "100", matchedBy: "source SKU" });
  assert.deepEqual(resolveKey({ ...base, handles: ["old-handle"] }, ix, new Set()), { key: "100", matchedBy: "canonical URL / handle" });
  assert.deepEqual(resolveKey({ ...base, titleKey: "old title" }, ix, new Set()), { key: "100", matchedBy: "normalised title" });
  assert.deepEqual(resolveKey({ ...base, sourceProductIds: { a: "100" } }, ix, new Set(["100"])), { key: "999", matchedBy: null });
  assert.deepEqual(resolveKey(base, ix, new Set()), { key: "999", matchedBy: null });
});

// ---------- Shopify plan ----------

const planArgs = (existing: GShopifyProduct | null, row?: StanleyRow) => ({
  key: "100", n: quencher, existing, row, settings, prices: pricesFor(quencher, fx85, settings), fx: fx85, images: [], locationId: "gid://shopify/Location/1", nowIso: "2026-09-26T00:00:00.000Z",
  importStatus: existing ? "updated" as const : "created" as const,
});

test("plan (create): one product, colour variants, ₹ prices, ETA + stanley_sync metafields, images, DRAFT", () => {
  const p = buildStanleyPlan(planArgs(null));
  assert.equal(p.action, "create");
  const vs = p.input.variants as { sku: string; price: string; compareAtPrice: string | null; inventoryPolicy: string }[];
  assert.equal(vs.length, 4);
  assert.equal(vs[0].price, (45 * 85 + 3000).toFixed(2));
  const cream = vs.find((v) => v.sku === "100000000010")!;
  assert.equal(cream.price, "5550.00");
  assert.equal(cream.compareAtPrice, "6400.00");
  assert.equal(p.input.status, "DRAFT");
  const mf = p.input.metafields as { namespace: string; key: string; value: string }[];
  const get = (ns: string, k: string) => mf.find((m) => m.namespace === ns && m.key === k)?.value;
  assert.equal(get("custom", "eta"), "15–20 Days");
  assert.equal(get("stanley_sync", "source_product_id"), "100");
  assert.equal(get("stanley_sync", "pricing_adjustment_inr"), "3000");
  assert.equal(get("stanley_sync", "exchange_rate"), "85");
  assert.equal(get("stanley_sync", "fsr_selling_price"), "5550.00");
  assert.equal(get("stanley_sync", "source_sale_price_usd"), "30.00");
  assert.ok(get("stanley_sync", "exchange_rate_timestamp"));
  assert.ok((p.input.files as unknown[]).length > 0);
  assert.ok(!(p.input.title as string).includes("15–20")); // ETA never in the title
});

test("plan: authorisation off -> no images, facts-only description", () => {
  const p = buildStanleyPlan({ ...planArgs(null), settings: { ...settings, AUTHORIZED_IMPORTER: false } });
  assert.equal(p.input.files, undefined);
  assert.doesNotMatch(p.input.descriptionHtml as string, /Keeps drinks cold/);
});

const existingProduct = (over: Partial<GShopifyProduct> = {}): GShopifyProduct => ({
  id: "gid://shopify/Product/1", status: "ACTIVE", title: quencher.title, handle: "q", vendor: "Stanley 1913", productType: "Drinkware", descriptionHtml: quencher.descriptionHtml, tags: ["Stanley"],
  seo: { title: quencher.seoTitle, description: quencher.seoDescription }, media: { nodes: [] }, sourceId: { value: "100" }, eta: { value: "15–20 Days" },
  variants: { nodes: [
    { id: "v1", sku: "100000000001", barcode: null, price: "6825.00", compareAtPrice: null, inventoryPolicy: "CONTINUE", selectedOptions: [{ name: "Color", value: "Black 2.0" }], media: { nodes: [] } },
    { id: "v2", sku: "100000000002", barcode: null, price: "6825.00", compareAtPrice: null, inventoryPolicy: "CONTINUE", selectedOptions: [{ name: "Color", value: "Cream" }], media: { nodes: [] } },
    { id: "v9", sku: "100000000099", barcode: null, price: "6000.00", compareAtPrice: null, inventoryPolicy: "CONTINUE", selectedOptions: [{ name: "Color", value: "Old Colour" }], media: { nodes: [] } },
  ] },
  ...over,
});

test("plan (update): re-SKUed colour reuses its variant; dropped colours kept but unorderable; nothing deleted", () => {
  const row = { written_prices: JSON.stringify({ "100000000001": "6825.00", "100000000002": "6825.00", "100000000099": "6000.00" }), source_skus: JSON.stringify(["100000000001", "100000000002", "100000000099"]), price_hash: "x", written_title: quencher.title, written_eta: "15–20 Days" } as StanleyRow;
  const p = buildStanleyPlan(planArgs(existingProduct(), row));
  const vs = p.input.variants as { id?: string; sku?: string; inventoryPolicy?: string; optionValues: { name: string }[] }[];
  const cream = vs.find((v) => v.optionValues[0].name === "Cream")!;
  assert.equal(cream.id, "v2");                  // same Shopify variant...
  assert.equal(cream.sku, "100000000010");       // ...now carrying the in-stock SKU
  const old = vs.find((v) => v.id === "v9")!;
  assert.equal(old.inventoryPolicy, "DENY");
  assert.equal(vs.length, 5);
  assert.ok(p.notes.some((n) => /moved to a new Stanley SKU/.test(n)));
});

test("plan (update): all colours sold out -> DRAFT + oos tag; manual edits preserved", () => {
  const soldOut = { ...quencher, availability: "out_of_stock" as const, variants: quencher.variants.map((v) => ({ ...v, availability: "out_of_stock" as const })) };
  const row = { written_title: "something else", written_prices: "{}", source_skus: "[]" } as StanleyRow;
  const p = buildStanleyPlan({ ...planArgs(existingProduct({ title: "My custom title" }), row), n: soldOut });
  assert.equal(p.input.status, "DRAFT");
  assert.ok((p.input.tags as string[]).includes(OOS_TAG));
  assert.equal(p.input.title, undefined);
  assert.ok(p.notes.includes("title edited in Shopify - preserved"));
});

test("plan: hand-made product with other options is left for review", () => {
  const e = existingProduct({ variants: { nodes: [{ id: "v1", sku: "100000000001", barcode: null, price: "1", compareAtPrice: null, inventoryPolicy: "DENY", selectedOptions: [{ name: "Size", value: "L" }], media: { nodes: [] } }] } });
  assert.throws(() => buildStanleyPlan(planArgs(e)), PlanConflict);
});

test("settings: test guard and spec defaults", () => {
  assert.equal(effectiveLimit({ TEST_MODE: true, TEST_PRODUCT_LIMIT: 5, FULL_SYNC: true }), 5);
  assert.equal(effectiveLimit({ TEST_MODE: false, TEST_PRODUCT_LIMIT: 5, FULL_SYNC: true }), 0);
  const d = stanleyEnvSettings();
  assert.equal(d.PRICING_ADJUSTMENT_INR, 3000);
  assert.equal(d.SYNC_INTERVAL_HOURS, 5);
  assert.equal(d.MAX_EXCHANGE_RATE_AGE_HOURS, 24);
  assert.equal(d.ETA, "15–20 Days");
});
