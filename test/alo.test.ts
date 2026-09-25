import "./helpers/isolated-data.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { aloEnvSettings, effectiveLimit, type AloSettings } from "../src/alo/config.ts";
import { ALO_FX_STORE, adb } from "../src/alo/db.ts";
import { apparelSize, genderOf, groupAloCatalog, normalizeAlo, productTypeOf, shoeSizeUk, styleIdOf } from "../src/alo/normalize.ts";
import { aloSkuMatches } from "../src/alo/ops.ts";
import { OOS_TAG, PlanConflict, buildAloPlan } from "../src/alo/plan.ts";
import { calculateAloPrice } from "../src/alo/pricing.ts";
import { fetchAloCatalog, parseColourDetail, parseStyleAttribs, type AloRawProduct } from "../src/alo/source.ts";
import { classify, pricesFor } from "../src/alo/sync.ts";
import { getExchangeRate } from "../src/gymshark/fx.ts";
import type { GShopifyProduct } from "../src/gymshark/ops.ts";
import { Logger } from "../src/logger.ts";
import type { PoliteHttp } from "../src/politeHttp.ts";

const settings: AloSettings = {
  ...aloEnvSettings(), SOURCE_PRICE_BASIS: "CURRENT_SELLING", COMPARE_AT_MODE: "SOURCE_REGULAR", FLAT_ADJUSTMENT_INR: 3000, PRICE_ROUNDING_MODE: "NONE",
  DEFAULT_ETA: "15–20 Days", NEW_PRODUCT_STATUS: "DRAFT", OUT_OF_STOCK_STATUS: "DRAFT", AUTHORIZATION_CONFIRMED: true, VENDOR: "ALO Yoga", TITLE_TEMPLATE: "ALO Yoga {title}",
  BASE_TAGS: "ALO Yoga,alo,alo-yoga,ETA,alo-sync", SIZE_SYSTEM: "UK", MEN_US_TO_UK_OFFSET: 0.5, WOMEN_US_TO_UK_OFFSET: 2, MAX_IMAGES_PER_COLOUR: 0,
  FX_PROVIDER: "open.er-api.com", MAX_EXCHANGE_RATE_AGE_HOURS: 24, SOURCE_CURRENCY: "USD", TARGET_CURRENCY: "INR", FETCH_DETAILS: true, IMPORT_CATEGORIES: "",
  EXCLUDED_PRODUCT_TYPES: "Internal,DNU,E Gift Card,Gift Card,Accessories:Ultimate Gift Sets", EXCLUDED_VENDORS: "Fake,Alo Moves", EXCLUDED_TAGS: "LoyaltyPointsRedemption",
};
const fx85 = { ok: true, rate: 85, base: "USD", quote: "INR", provider: "test", providerUpdatedAt: null, fetchedAt: "2026-09-26T00:00:00.000Z", origin: "live" as const };
const log = new Logger(null, { db: adb, name: "alo-test" });
const price = (usd: number, regular = usd) => calculateAloPrice({ currentUsd: usd, regularUsd: regular, currency: "USD" }, fx85, settings);

// ---------- fixtures (shape of aloyoga.com /products.json) ----------

let vid = 1000;
function listing(o: { id: number; handle: string; title: string; type: string; style: string; colour: string; code: string; sizes: string[]; price: string; compare?: string | null; available?: boolean[]; tags?: string[]; length?: string; images?: number }): AloRawProduct {
  const opts = [{ name: "Color", position: 1, values: [o.colour] }, { name: "Size", position: 2, values: o.sizes }, ...(o.length ? [{ name: "Length", position: 3, values: [o.length] }] : [])];
  return {
    id: o.id, title: o.title, handle: o.handle, body_html: "<p>Made for all-day wear.</p><p></p>", published_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-20T00:00:00Z",
    vendor: "Alo Yoga", product_type: o.type, tags: [`StyleId:${o.style}`, "Fabric:ALO Softsculpt", "Women:Activity:Yoga", "Women:Activity:Run", ...(o.tags ?? [])],
    variants: o.sizes.map((sz, i) => ({ id: vid++, title: `${o.colour} / ${sz}`, option1: o.colour, option2: sz, option3: o.length ?? null, sku: `${o.style.replace(/^(Mens|Womens)/, "")}${o.code}${i}`, available: o.available?.[i] ?? true, price: o.price, compare_at_price: o.compare ?? null, grams: 180, featured_image: null })),
    images: Array.from({ length: o.images ?? 2 }, (_, i) => ({ id: o.id * 10 + i, src: `https://cdn.shopify.com/s/files/1/2185/2813/files/${o.style}_${o.code}_a${i + 1}.jpg?v=17${i}`, position: i + 1, width: 1000, height: 1250, variant_ids: [] })),
    options: opts,
  };
}
const leggingBlack = listing({ id: 1, handle: "w54234r-alo-softsculpt-high-waist-legging-black", title: "ALO Softsculpt High-Waist Legging - Black", type: "Women:Bottoms:Leggings", style: "W54234R", colour: "Black", code: "0100", sizes: ["XXS", "XS", "S"], price: "134.00", length: 'Full 29"', tags: ["Waist:High Waist", "Computed:UnderInventoryThreshold:5:for:XXS"] });
const leggingNavy = listing({ id: 2, handle: "w54234r-alo-softsculpt-high-waist-legging-navy", title: "ALO Softsculpt High-Waist Legging - Navy", type: "Women:Bottoms:Leggings", style: "W54234R", colour: "Navy", code: "0420", sizes: ["XXS", "XS", "S"], price: "100.00", compare: "150.00" });
const hoodie = listing({ id: 3, handle: "u3032rg-accolade-hoodie-bright-red", title: "Accolade Hoodie - Bright Red", type: "Women:Outerwear:Coverups:Hoodies", style: "U3032RG", colour: "Bright Red", code: "06662", sizes: ["XS", "S"], price: "128.00" });
const hoodieMens = { ...listing({ id: 4, handle: "u3032rg-accolade-hoodie-bright-red-mens", title: "Accolade Hoodie - Bright Red", type: "Men:Outerwear:Coverups:Hoodies", style: "MensU3032RG", colour: "Bright Red", code: "06662", sizes: ["XS", "S"], price: "128.00" }) };
const shoe = listing({ id: 5, handle: "a0590u-alo-runner-navy", title: "ALO Runner (Unisex) - Navy", type: "Accessories:Shoes:Sneakers", style: "A0590U", colour: "Navy", code: "0420", sizes: ["7M/8.5W", "7.5M/9W", "8M/9.5W"], price: "185.00", tags: ["Unisex:Shoes"] });
const loyalty = { ...listing({ id: 6, handle: "a0084u-uplifting-yoga-block-black-loyalty", title: "Uplifting Yoga Block - Black", type: "Internal", style: "A0084U", colour: "Black", code: "01", sizes: ["One Size"], price: "34.00" }), tags: ["LoyaltyPointsRedemption"] };
const noId = { ...listing({ id: 7, handle: "mystery-thing-black", title: "Mystery - Black", type: "Accessories:Mats", style: "ZZ", colour: "Black", code: "01", sizes: ["One Size"], price: "10.00" }), tags: [] };

const catalog = [leggingBlack, leggingNavy, hoodie, hoodieMens, shoe, loyalty, noId];
const grouped = groupAloCatalog(catalog, settings);
const style = (id: string) => grouped.styles.find((g) => g.styleId === id)!;
const details = { barcodes: { W54234R01000: "191677975866" }, attribs: { fabrication: "Naturally-breathable signature ALO Softsculpt fabric with medium compression\n78% Nylon, 22% Elastane", fit: "True to size\nInseam by size: XXS, XS & S – 28 1/2\"" } };

// ---------- pricing (spec examples at ₹85) ----------

test("pricing: USD x rate + ₹3,000 flat, exactly (spec examples)", () => {
  assert.equal(price(100).fsrPrice, 11500);
  assert.equal(price(50).fsrPrice, 7250);
  assert.equal(price(148).fsrPrice, 15580);
  assert.equal(price(285).fsrPrice, 27225);
  const p = price(148);
  assert.equal(p.convertedPriceInr, 12580);
  assert.equal(p.flatAdjustmentInr, 3000);
  assert.equal(p.exchangeRate, 85);
  assert.equal(p.compareAtPrice, null);
});

test("pricing: repeated syncs never compound the ₹3,000 (always from the USD price)", () => {
  const first = price(100);
  const second = calculateAloPrice({ currentUsd: 100, regularUsd: 100, currency: "USD" }, fx85, settings);
  assert.equal(first.fsrPrice, 11500);
  assert.equal(second.fsrPrice, 11500); // not 14,500
  // exchange rate change: recalculated from USD, not from the previous FSR price
  assert.equal(calculateAloPrice({ currentUsd: 100, regularUsd: 100, currency: "USD" }, { ...fx85, rate: 86 }, settings).fsrPrice, 11600);
  // source price change: $100 -> $120 at ₹85
  assert.equal(price(120).fsrPrice, 13200);
});

test("pricing: sale uses ALO's current price; compare-at = regular through the same formula", () => {
  const p = price(100, 150);
  assert.equal(p.sourcePriceUsd, 100);
  assert.equal(p.sourceSalePriceUsd, 100);
  assert.equal(p.sourceRegularPriceUsd, 150);
  assert.equal(p.fsrPrice, 11500);        // never 150-based
  assert.equal(p.compareAtPrice, 15750);  // 150 x 85 + 3000
  assert.equal(calculateAloPrice({ currentUsd: 100, regularUsd: 150, currency: "USD" }, fx85, { ...settings, SOURCE_PRICE_BASIS: "REGULAR" }).fsrPrice, 15750);
  assert.equal(calculateAloPrice({ currentUsd: 100, regularUsd: 150, currency: "USD" }, fx85, { ...settings, COMPARE_AT_MODE: "NONE" }).compareAtPrice, null);
});

test("pricing: no percentage anywhere; flat amount is configurable; failures never guess", () => {
  assert.equal(calculateAloPrice({ currentUsd: 100, regularUsd: 100, currency: "USD" }, fx85, { ...settings, FLAT_ADJUSTMENT_INR: 0 }).fsrPrice, 8500);
  assert.equal(calculateAloPrice({ currentUsd: null, regularUsd: null, currency: "USD" }, fx85, settings).ok, false);
  assert.match(calculateAloPrice({ currentUsd: 100, regularUsd: 100, currency: "INR" }, fx85, settings).reason!, /currency/);
  const noFx = calculateAloPrice({ currentUsd: 100, regularUsd: 100, currency: "USD" }, { ok: false, rate: null, base: "USD" }, settings);
  assert.equal(noFx.ok, false);
  assert.equal(noFx.fsrPrice, null);
  assert.equal(calculateAloPrice({ currentUsd: 99.99, regularUsd: 99.99, currency: "USD" }, { ...fx85, rate: 88.6512 }, settings).fsrPrice, 11864.23);
});

// ---------- catalog grouping ----------

test("grouping: one FSR product per ALO style; men's copies merge; loyalty + id-less listings are excluded", () => {
  assert.deepEqual(grouped.styles.map((g) => g.styleId).sort(), ["A0590U", "U3032RG", "W54234R"]);
  assert.equal(grouped.excluded['product type "Internal"'], 1);
  assert.equal(grouped.invalid.length, 1);
  assert.match(grouped.invalid[0].reason, /missing product ID/);
  assert.equal(styleIdOf(hoodieMens), "U3032RG");
  assert.equal(style("U3032RG").listings[0].handle, "u3032rg-accolade-hoodie-bright-red"); // original before the -mens copy
  assert.ok(aloSkuMatches("U3032RG066620", "U3032RG"));
  assert.ok(!aloSkuMatches("U3032RG066620", "U3032R"));  // a longer style id is a different product
});

test("grouping: successor-code SKUs stay with their listing; a SKU is never given to two styles", () => {
  const mixed = listing({ id: 20, handle: "w5561r-high-waist-airlift-legging-anthracite", title: "High-Waist Airlift Legging - Anthracite", type: "Women:Bottoms:Leggings", style: "W5561R", colour: "Anthracite", code: "02125", sizes: ["XS", "S"], price: "128.00" });
  mixed.variants[1].sku = "W51312R021251"; // ALO lists the successor style's SKU for this size
  const copy = { ...listing({ id: 21, handle: "w3550rg-accolade-hoodie-bright-red", title: "Accolade Hoodie - Bright Red", type: "Women:Outerwear:Coverups:Hoodies", style: "W3550RG", colour: "Bright Red", code: "06662", sizes: ["XS", "S"], price: "128.00" }) };
  copy.variants.forEach((v, i) => { v.sku = `U3032RG06662${i}`; }); // same SKUs as the U3032RG style
  const g = groupAloCatalog([mixed, hoodie, copy], settings);
  assert.deepEqual(g.styles.map((x) => x.styleId).sort(), ["U3032RG", "W5561R"]);
  assert.equal(g.excluded["every SKU already listed under another style"], 1);
  assert.deepEqual(normalizeAlo(g.styles.find((x) => x.styleId === "W5561R")!, { barcodes: {}, attribs: null }, settings).variants.map((v) => v.sku), ["W5561R021250", "W51312R021251"]);
  assert.equal(styleIdOf({ ...mixed, tags: ["YGroup_W51312R"] }), "W51312R"); // ALO's group tag when StyleId is absent
});

test("normalize: Color x Size variants, ALO SKUs kept, Length as a spec, sale + low stock mapped", () => {
  const n = normalizeAlo(style("W54234R"), details, settings);
  assert.equal(n.title, "ALO Yoga Softsculpt High-Waist Legging");
  assert.deepEqual(n.optionNames, ["Color", "Size"]);
  assert.deepEqual(n.colours.map((c) => c.colour), ["Black", "Navy"]);
  assert.equal(n.variants.length, 6);
  assert.deepEqual(n.sizeOrder, ["XXS", "XS", "S"]);
  assert.equal(n.variants[0].sku, "W54234R01000");
  assert.equal(n.variants[0].barcode, "191677975866");
  assert.equal(n.variants[0].availability, "low_stock");
  assert.equal(n.variants[1].availability, "in_stock");
  const navy = n.variants.find((v) => v.colour === "Navy")!;
  assert.equal(navy.currentUsd, 100);
  assert.equal(navy.regularUsd, 150);
  assert.equal(n.productType, "Leggings");
  assert.equal(n.gender, "Women");
  assert.equal(n.category, "Leggings");
  assert.equal(n.subcategory, "Bottoms");
  assert.equal(n.collection, "ALO Softsculpt");
  assert.equal(n.specs.Composition, "78% Nylon, 22% Elastane");
  assert.equal(n.specs.Length, 'Full 29"');
  assert.equal(n.specs.Waist, "High Waist");
  assert.equal(n.specs.Activity, "Yoga, Run");
  assert.match(n.descriptionHtml, /Made for all-day wear/);
  assert.match(n.descriptionHtml, /78% Nylon, 22% Elastane/);
  assert.match(n.descriptionHtml, /SKU - W54234R/);
  assert.equal(n.images.length, 4);
  assert.ok(n.tags.includes("leggings") && n.tags.includes("womens") && n.tags.includes("alo-yoga") && n.tags.includes("running") && n.tags.includes("ETA"));
  assert.ok(!n.tags.includes("Instant Ship"));
});

test("normalize: unisex duplicate listings add no fake variants", () => {
  const n = normalizeAlo(style("U3032RG"), { barcodes: {}, attribs: null }, settings);
  assert.equal(n.variants.length, 2);
  assert.equal(n.duplicatesSkipped, 2);
  assert.equal(n.gender, "Unisex");
  assert.equal(n.productType, "Hoodies");
  assert.deepEqual(n.handles, ["u3032rg-accolade-hoodie-bright-red", "u3032rg-accolade-hoodie-bright-red-mens"]);
});

test("sizes: shoes use UK sizes (men/unisex US-0.5, women US-2); apparel unchanged", () => {
  const n = normalizeAlo(style("A0590U"), { barcodes: {}, attribs: null }, settings);
  assert.equal(n.productType, "Sneakers");
  assert.deepEqual(n.variants.map((v) => v.size), ["6.5", "7", "7.5"]);
  assert.deepEqual(n.variants.map((v) => v.sourceSize), ["7M/8.5W", "7.5M/9W", "8M/9.5W"]);
  assert.equal(n.sizeConversion!["8M/9.5W"], "7.5");
  assert.equal(shoeSizeUk("9W", null, settings), "7");
  assert.equal(shoeSizeUk("EU 38/US 8", "Women", settings), "6");
  assert.equal(shoeSizeUk("EU 38/US 8", null, settings), null); // unknown gender: not guessed
  assert.equal(apparelSize("2xl"), "2XL");
  assert.equal(apparelSize("One Size"), "One Size");
  assert.equal(normalizeAlo(style("A0590U"), { barcodes: {}, attribs: null }, { ...settings, SIZE_SYSTEM: "US" }).variants[0].size, "7M/8.5W");
});

test("product types follow the most specific ALO segment", () => {
  assert.equal(productTypeOf("Women:Bras", settings), "Sports Bras");
  assert.equal(productTypeOf("Women:Tops:Short Sleeves", settings), "T-Shirts");
  assert.equal(productTypeOf("Accessories:Luxury:Bag:Duffle", settings), "Bags");
  assert.equal(productTypeOf("Accessories:Cold Weather:Hats", settings), "Hats");
  assert.equal(productTypeOf("Women:One Piece:Jumpsuits", settings), "Apparel");
  assert.equal(productTypeOf("Accessories:Luxury:Crystal", settings), "Accessories");
  assert.equal(genderOf([leggingBlack]), "Women");
});

// ---------- plan ----------

function asShopify(input: Record<string, unknown>, id = "gid://shopify/Product/1"): GShopifyProduct {
  const mfs = (input.metafields as { namespace: string; key: string; value: string }[]) ?? [];
  return {
    id, status: input.status as "DRAFT", title: input.title as string, handle: "alo-yoga-softsculpt-high-waist-legging", vendor: input.vendor as string, productType: input.productType as string,
    descriptionHtml: input.descriptionHtml as string, tags: input.tags as string[], seo: input.seo as { title: string; description: string },
    media: { nodes: ((input.files as unknown[]) ?? []).map((_, i) => ({ id: `gid://shopify/MediaImage/${i + 1}`, alt: null, mediaContentType: "IMAGE" })) },
    variants: { nodes: (input.variants as Record<string, unknown>[]).map((v, i) => ({ id: `gid://shopify/ProductVariant/${i + 1}`, sku: v.sku as string, barcode: v.barcode as string, price: v.price as string, compareAtPrice: v.compareAtPrice as string | null, inventoryPolicy: v.inventoryPolicy as "CONTINUE", selectedOptions: (v.optionValues as { optionName: string; name: string }[]).map((o) => ({ name: o.optionName, value: o.name })), media: { nodes: [] } })) },
    sourceId: { value: mfs.find((m) => m.key === "source_product_id")!.value }, eta: { value: mfs.find((m) => m.key === "eta")!.value },
  };
}

test("plan create: DRAFT, ₹ prices from the formula, compare-at on sale, ETA + alo_sync metafields", () => {
  const n = normalizeAlo(style("W54234R"), details, settings);
  const prices = pricesFor(n, fx85, settings);
  const plan = buildAloPlan({ n, existing: null, row: undefined, settings, prices, fx: fx85, images: [], locationId: "gid://shopify/Location/1", nowIso: "2026-09-26T00:00:00Z" });
  assert.equal(plan.action, "create");
  const input = plan.input;
  assert.equal(input.status, "DRAFT");
  assert.equal(input.vendor, "ALO Yoga");
  assert.equal(input.productType, "Leggings");
  const vs = input.variants as Record<string, unknown>[];
  assert.equal(vs.length, 6);
  assert.equal(vs[0].price, (134 * 85 + 3000).toFixed(2));  // 14390.00
  assert.equal(vs[0].compareAtPrice, null);
  const navy = vs.find((v) => (v.optionValues as { name: string }[])[0].name === "Navy")!;
  assert.equal(navy.price, "11500.00");
  assert.equal(navy.compareAtPrice, "15750.00");
  assert.equal(vs[0].inventoryPolicy, "CONTINUE");
  assert.equal((input.files as unknown[]).length, 4);
  const mf = Object.fromEntries((input.metafields as { namespace: string; key: string; value: string }[]).map((m) => [`${m.namespace}.${m.key}`, m.value]));
  assert.equal(mf["custom.eta"], "15–20 Days");
  assert.equal(mf["alo_sync.source_product_id"], "W54234R");
  assert.equal(mf["alo_sync.source_price_usd"], "100.00");
  assert.equal(mf["alo_sync.source_regular_price_usd"], "150.00");
  assert.equal(mf["alo_sync.source_sale_price_usd"], "100.00");
  assert.equal(mf["alo_sync.exchange_rate"], "85");
  assert.equal(mf["alo_sync.converted_price_inr"], "8500.00");
  assert.equal(mf["alo_sync.flat_adjustment_inr"], "3000");
  assert.equal(mf["alo_sync.fsr_selling_price"], "11500.00");
  assert.ok(mf["alo_sync.exchange_rate_timestamp"]);
});

test("plan repeat: same prices (no compounding), variants matched by SKU, no re-upload, manual edits kept", () => {
  const n = normalizeAlo(style("W54234R"), details, settings);
  const prices = pricesFor(n, fx85, settings);
  const first = buildAloPlan({ n, existing: null, row: undefined, settings, prices, fx: fx85, images: [], locationId: null, nowIso: "2026-09-26T00:00:00Z" });
  const existing = asShopify(first.input);
  const images = n.images.map((im, i) => ({ style_id: n.styleId, source_key: im.key, colour: im.colour, media_id: `gid://shopify/MediaImage/${i + 1}`, uploaded_at: "x" }));
  const row = { written_title: n.title, written_desc_hash: null, written_seo_hash: null, written_eta: "15–20 Days", written_prices: JSON.stringify(first.written.prices), price_hash: n.hashes.price, image_hash: n.hashes.image, last_sync_status: "created" } as never;
  const again = buildAloPlan({ n, existing, row, settings, prices, fx: fx85, images, locationId: null, nowIso: "2026-09-26T05:00:00Z" });
  assert.equal(again.action, "update");
  const vs = again.input.variants as Record<string, unknown>[];
  assert.equal(vs.length, 6);                                  // no duplicate variants
  assert.ok(vs.every((v) => String(v.id).startsWith("gid://shopify/ProductVariant/")));
  assert.equal(vs.find((v) => v.sku === "W54234R04200")!.price, "11500.00"); // still ₹11,500 - not ₹14,500
  assert.equal(again.priceMoves, 0);
  assert.equal(again.input.files, undefined);                  // images untouched
  assert.equal(again.input.title, undefined);

  // a price edited by hand is kept until ALO's USD price changes
  existing.variants.nodes[0].price = "13999.00";
  const manual = buildAloPlan({ n, existing, row, settings, prices, fx: fx85, images, locationId: null, nowIso: "x" });
  assert.equal((manual.input.variants as Record<string, unknown>[])[0].price, "13999.00");
  assert.ok(manual.notes.some((x) => /edited in Shopify - preserved/.test(x)));

  // exchange-rate change recalculates every price from USD
  const fx86 = { ...fx85, rate: 86 };
  existing.variants.nodes[0].price = first.written.prices[existing.variants.nodes[0].sku!];
  const moved = buildAloPlan({ n, existing, row, settings, prices: pricesFor(n, fx86, settings), fx: fx86, images, locationId: null, nowIso: "x" });
  assert.equal((moved.input.variants as Record<string, unknown>[]).find((v) => v.sku === "W54234R04200")!.price, "11600.00");
  assert.equal(moved.priceMoves, 6);
});

test("plan: title/description/ETA edited in Shopify are preserved; blank SEO gets defaults", () => {
  const n = normalizeAlo(style("W54234R"), details, settings);
  const prices = pricesFor(n, fx85, settings);
  const first = buildAloPlan({ n, existing: null, row: undefined, settings, prices, fx: fx85, images: [], locationId: null, nowIso: "x" });
  const existing = { ...asShopify(first.input), title: "My custom title", descriptionHtml: "<p>mine</p>", seo: { title: null, description: null }, eta: { value: "Ships in 10 days" } };
  const row = { written_title: n.title, written_desc_hash: "old", written_seo_hash: "old", written_eta: "15–20 Days", written_prices: JSON.stringify(first.written.prices), price_hash: n.hashes.price, image_hash: n.hashes.image } as never;
  const plan = buildAloPlan({ n, existing, row, settings, prices, fx: fx85, images: [], locationId: null, nowIso: "x" });
  assert.equal(plan.input.title, undefined);
  assert.equal(plan.input.descriptionHtml, undefined);
  assert.ok(plan.input.seo);
  assert.ok(!plan.metafields.some((m) => m.key === "eta"));
  assert.ok(plan.notes.some((x) => /ETA "Ships in 10 days" set manually/.test(x)));
});

test("plan: sold out everywhere -> DRAFT + oos tag; unauthorised content withholds images and ALO text", () => {
  const soldOut = groupAloCatalog([listing({ id: 9, handle: "w1111r-x-black", title: "X - Black", type: "Women:Bras", style: "W1111R", colour: "Black", code: "010", sizes: ["S", "M"], price: "78.00", available: [false, false] })], settings).styles[0];
  const n = normalizeAlo(soldOut, { barcodes: {}, attribs: null }, settings);
  const plan = buildAloPlan({ n, existing: null, row: undefined, settings: { ...settings, NEW_PRODUCT_STATUS: "ACTIVE" }, prices: pricesFor(n, fx85, settings), fx: fx85, images: [], locationId: null, nowIso: "x" });
  assert.equal(plan.input.status, "DRAFT");
  assert.ok((plan.input.tags as string[]).includes(OOS_TAG));
  assert.ok((plan.input.variants as Record<string, unknown>[]).every((v) => v.inventoryPolicy === "DENY"));
  const gated = buildAloPlan({ n, existing: null, row: undefined, settings: { ...settings, AUTHORIZATION_CONFIRMED: false }, prices: pricesFor(n, fx85, settings), fx: fx85, images: [], locationId: null, nowIso: "x" });
  assert.equal(gated.input.files, undefined);
  assert.doesNotMatch(gated.input.descriptionHtml as string, /Made for all-day wear/);
});

test("plan: OUT_OF_STOCK_STATUS=ARCHIVED archives sold-out styles and restores only those it archived", () => {
  const arch = { ...settings, NEW_PRODUCT_STATUS: "ACTIVE" as const, OUT_OF_STOCK_STATUS: "ARCHIVED" as const };
  const mk = (avail: boolean[]) => normalizeAlo(groupAloCatalog([listing({ id: 30, handle: "w2222r-y-black", title: "Y - Black", type: "Women:Bras", style: "W2222R", colour: "Black", code: "010", sizes: ["S", "M"], price: "78.00", available: avail })], settings).styles[0], { barcodes: {}, attribs: null }, settings);
  const out = mk([false, false]);
  const created = buildAloPlan({ n: out, existing: null, row: undefined, settings: arch, prices: pricesFor(out, fx85, arch), fx: fx85, images: [], locationId: null, nowIso: "x" });
  assert.equal(created.input.status, "ARCHIVED");
  const back = mk([true, false]);
  const existing = { ...asShopify(created.input), status: "ARCHIVED" as never };
  const row = { written_prices: JSON.stringify(created.written.prices), shopify_status: "ARCHIVED" } as never;
  assert.equal(buildAloPlan({ n: back, existing, row, settings: arch, prices: pricesFor(back, fx85, arch), fx: fx85, images: [], locationId: null, nowIso: "x" }).input.status, "ACTIVE");
  const manual = { ...existing, tags: existing.tags.filter((t) => t !== OOS_TAG) }; // archived by hand: left alone
  assert.equal(buildAloPlan({ n: back, existing: manual, row, settings: arch, prices: pricesFor(back, fx85, arch), fx: fx85, images: [], locationId: null, nowIso: "x" }).input.status, undefined);
  const live = { ...asShopify(buildAloPlan({ n: back, existing: null, row: undefined, settings: arch, prices: pricesFor(back, fx85, arch), fx: fx85, images: [], locationId: null, nowIso: "x" }).input), status: "ACTIVE" as never };
  assert.equal(buildAloPlan({ n: out, existing: live, row: { shopify_status: "ACTIVE" } as never, settings: arch, prices: pricesFor(out, fx85, arch), fx: fx85, images: [], locationId: null, nowIso: "x" }).input.status, "ARCHIVED");
  // test products created as DRAFT go live once NEW_PRODUCT_STATUS=ACTIVE
  const draft = { ...live, status: "DRAFT" as never };
  assert.equal(buildAloPlan({ n: back, existing: draft, row: { shopify_status: "DRAFT" } as never, settings: arch, prices: pricesFor(back, fx85, arch), fx: fx85, images: [], locationId: null, nowIso: "x" }).input.status, "ACTIVE");
});

test("plan: ALO re-codes a size (new SKU, same colour/size) -> existing variant takes the new SKU, no duplicate", () => {
  const n = normalizeAlo(style("W54234R"), details, settings);
  const prices = pricesFor(n, fx85, settings);
  const existing = asShopify(buildAloPlan({ n, existing: null, row: undefined, settings, prices, fx: fx85, images: [], locationId: null, nowIso: "x" }).input);
  existing.variants.nodes[0].sku = "W54234R99990"; // what ALO used to call Black / XXS
  const plan = buildAloPlan({ n, existing, row: { written_prices: "{}" } as never, settings, prices, fx: fx85, images: [], locationId: null, nowIso: "x" });
  const vs = plan.input.variants as Record<string, unknown>[];
  assert.equal(vs.length, 6);
  assert.equal(vs.find((v) => v.id === existing.variants.nodes[0].id)!.sku, "W54234R01000");
  assert.ok(plan.notes.some((x) => /re-coded/.test(x)));
});

test("normalize: colourways sharing a name get stable colour-code suffixes, whatever ALO's order", () => {
  const a = listing({ id: 40, handle: "w6491r-skirt-ahg-white", title: "Skirt - Athletic Heather Grey/White", type: "Women:Bottoms:Skirts", style: "W6491R", colour: "Athletic Heather Grey/White", code: "05203", sizes: ["XS", "S"], price: "98.00" });
  const b = listing({ id: 41, handle: "w6491r-skirt-ahg-white-2", title: "Skirt - Athletic Heather Grey/White", type: "Women:Bottoms:Skirts", style: "W6491R", colour: "Athletic Heather Grey/White", code: "08811", sizes: ["XS", "S"], price: "98.00" });
  const names = (ls: AloRawProduct[]) => Object.fromEntries(normalizeAlo(groupAloCatalog(ls, settings).styles[0], { barcodes: {}, attribs: null }, settings).variants.map((v) => [v.sku, v.colour]));
  const ab = names([a, b]);
  assert.deepEqual(ab, names([b, a]));
  assert.equal(ab.W6491R052030, "Athletic Heather Grey/White (05203)");
  assert.equal(ab.W6491R088110, "Athletic Heather Grey/White (08811)");
});

test("plan: a discontinued colourway sharing the current colour name is suffixed, never duplicated", () => {
  const cur = listing({ id: 50, handle: "w6491r-skirt-ahg-white", title: "Skirt - AHG/White", type: "Women:Bottoms:Skirts", style: "W6491R", colour: "AHG/White", code: "06509", sizes: ["XS", "S"], price: "98.00" });
  const n = normalizeAlo(groupAloCatalog([cur], settings).styles[0], { barcodes: {}, attribs: null }, settings);
  const prices = pricesFor(n, fx85, settings);
  const existing = asShopify(buildAloPlan({ n, existing: null, row: undefined, settings, prices, fx: fx85, images: [], locationId: null, nowIso: "x" }).input);
  existing.variants.nodes.forEach((v) => { v.selectedOptions = v.selectedOptions.map((o) => (o.name === "Color" ? { ...o, value: "AHG/White (06509)" } : o)); });
  existing.variants.nodes.push(...["XS", "S"].map((sz, i) => ({ id: `gid://shopify/ProductVariant/9${i}`, sku: `W6491R05203${i}`, barcode: null, price: "11000.00", compareAtPrice: null, inventoryPolicy: "DENY" as const, selectedOptions: [{ name: "Color", value: "AHG/White" }, { name: "Size", value: sz }], media: { nodes: [] } })));
  const plan = buildAloPlan({ n, existing, row: { written_prices: "{}" } as never, settings, prices, fx: fx85, images: [], locationId: null, nowIso: "x" });
  const combos = (plan.input.variants as { optionValues: { name: string }[] }[]).map((v) => v.optionValues.map((o) => o.name).join(" / "));
  assert.equal(new Set(combos).size, combos.length);
  assert.ok(combos.includes("AHG/White / XS") && combos.includes("AHG/White (05203) / XS"));
});

test("plan: no valid exchange rate -> no new variants priced, existing prices untouched", () => {
  const n = normalizeAlo(style("W54234R"), details, settings);
  const none = { ok: false, rate: null, base: "USD", quote: "INR", provider: null, providerUpdatedAt: null, fetchedAt: null, origin: "none" as const };
  const plan = buildAloPlan({ n, existing: null, row: undefined, settings, prices: pricesFor(n, none, settings), fx: none, images: [], locationId: null, nowIso: "x" });
  assert.equal((plan.input.variants as unknown[]).length, 0);
  assert.equal(plan.deferredVariants, 6);
  assert.ok(plan.pricesPaused);
  assert.ok(!(plan.input.metafields as { key: string }[]).some((m) => m.key === "fsr_selling_price"));
});

test("plan: foreign option names are left for review, never merged", () => {
  const n = normalizeAlo(style("W54234R"), details, settings);
  const prices = pricesFor(n, fx85, settings);
  const existing = asShopify(buildAloPlan({ n, existing: null, row: undefined, settings, prices, fx: fx85, images: [], locationId: null, nowIso: "x" }).input);
  existing.variants.nodes[0].selectedOptions = [{ name: "Material", value: "Cotton" }];
  assert.throws(() => buildAloPlan({ n, existing, row: undefined, settings, prices, fx: fx85, images: [], locationId: null, nowIso: "x" }), PlanConflict);
});

// ---------- source parsing + health ----------

test("source: page attributes, colour detail barcodes + currency", () => {
  const html = `<script>\n      metaFields: {\n        attribs: {"fabrication":"Soft fabric\\n78% Nylon, 22% Elastane","fit":"True to size","getTheLook":"9092956127591,9092948230503","quickFit":"True to size"},\n        sets: {},\n</script>`;
  assert.deepEqual(parseStyleAttribs(html), { fabrication: "Soft fabric\n78% Nylon, 22% Elastane", fit: "True to size" });
  assert.deepEqual(parseStyleAttribs("<html>nothing</html>"), {});
  const d = parseColourDetail(JSON.stringify({ product: { variants: [{ sku: "w9972r010", barcode: "191677899551", price_currency: "USD" }, { sku: "W9972R011", barcode: "", price_currency: "USD" }] } }));
  assert.equal(d.currency, "USD");
  assert.deepEqual(d.barcodes, { W9972R010: "191677899551", W9972R011: "" }); // "" = SKU seen without a barcode
});

function fakeHttp(pages: (string | number)[]): PoliteHttp {
  let i = 0;
  return { get: async () => { const p = pages[i++]; return typeof p === "number" ? { status: p, url: "x", body: "" } : { status: 200, url: "x", body: p }; } } as unknown as PoliteHttp;
}

test("source health: catalog paginates to an empty page; a failed page marks the scan incomplete", async () => {
  const page = (ids: number[]) => JSON.stringify({ products: ids.map((id) => ({ ...leggingBlack, id })) });
  const ok = await fetchAloCatalog(fakeHttp([page([1, 2]), page([3]), page([])]), log);
  assert.equal(ok.complete, true);
  assert.equal(ok.products.length, 3);
  const broken = await fetchAloCatalog(fakeHttp([page([1, 2]), 500]), log);
  assert.equal(broken.complete, false);
  assert.match(broken.reason!, /HTTP 500/);
  const loop = await fetchAloCatalog(fakeHttp([page([1, 2]), page([1, 2])]), log);
  assert.equal(loop.complete, false);
  const junk = await fetchAloCatalog(fakeHttp(["<html>challenge</html>"]), log);
  assert.equal(junk.complete, false);
});

test("exchange rate: stored in the ALO database; stale cached rates are never used", async () => {
  const now = new Date("2026-09-26T10:00:00Z");
  const good = await getExchangeRate(settings, log, { store: ALO_FX_STORE, now, fetcher: async () => ({ result: "success", base_code: "USD", time_last_update_unix: now.getTime() / 1000 - 3600, rates: { INR: 88.5 } }) });
  assert.equal(good.ok, true);
  assert.equal(good.rate, 88.5);
  assert.ok((adb.prepare("SELECT COUNT(*) AS n FROM fx_rates WHERE ok = 1").get() as { n: number }).n >= 1);
  const down = async () => { throw new Error("offline"); };
  const cached = await getExchangeRate(settings, log, { store: ALO_FX_STORE, now: new Date(now.getTime() + 3600_000), fetcher: down });
  assert.equal(cached.origin, "cached");
  assert.equal(cached.rate, 88.5);
  const stale = await getExchangeRate(settings, log, { store: ALO_FX_STORE, now: new Date(now.getTime() + 30 * 3600_000), fetcher: down });
  assert.equal(stale.ok, false);
  assert.match(stale.reason!, /paused/);
});

test("config: full catalog only with FULL_SYNC=true and TEST_MODE=false; errors are classified", () => {
  assert.equal(effectiveLimit({ TEST_MODE: true, TEST_PRODUCT_LIMIT: 5, FULL_SYNC: true }), 5);
  assert.equal(effectiveLimit({ TEST_MODE: false, TEST_PRODUCT_LIMIT: 25, FULL_SYNC: false }), 25);
  assert.equal(effectiveLimit({ TEST_MODE: false, TEST_PRODUCT_LIMIT: 25, FULL_SYNC: true }), 0);
  assert.equal(classify(new Error("productSet: variants.0 price is invalid")), "shopify_api");
  assert.equal(classify(new Error("network error for https://x: fetch failed")), "network");
  assert.equal(classify(new Error("missing price: no positive USD price on the ALO product")), "missing_price");
});
