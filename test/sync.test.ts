import assert from "node:assert/strict";
import { test } from "node:test";
import { envSettings, type Settings } from "../src/config.ts";
import type { ProductRow } from "../src/db.ts";
import { displayColor, genderOf, normalize, storefrontSize } from "../src/normalize.ts";
import { applyRounding, calculatePrice } from "../src/pricing.ts";
import type { ShopifyProduct } from "../src/shopify/ops.ts";
import { OOS_TAG, buildPlan } from "../src/shopify/plan.ts";
import type { ListingItem, ProductDetail } from "../src/source/types.ts";
import { hash } from "../src/util.ts";

const settings: Settings = { ...envSettings(), EXCHANGE_RATE: 96, MARKUP_TYPE: "percentage", MARKUP_VALUE: 20, ROUNDING_RULE: "end_99", MIN_PROFIT: 0, EXCHANGE_RATE_BUFFER_PCT: 0, COMPARE_AT_MODE: "source_list", DEFAULT_ETA: "7–14 Days", NEW_PRODUCT_STATUS: "DRAFT", SIZE_OPTION_NAME: "Size", TITLE_TEMPLATE: "On Running {model} - {color} ({gender})", BASE_TAGS: "On,ETA" };

const listing: ListingItem = {
  sku: "3MF30742143", styleCode: "3MF3074", groupName: "Men's Cloudmonster 1", groupSummary: "Men – All-day comfort", variantName: "Men's Cloudmonster 1 Pearl | Ivory",
  color: "Pearl | Ivory", url: "https://www.on.com/en-us/products/cloudmonster-1-m-3mf3074/mens/pearl-ivory-shoes-3MF30742143", image: null, price: 125, currency: "USD", availability: "InStock", position: 1,
};
const detail: ProductDetail = {
  url: listing.url, sku: listing.sku, styleCode: "3MF3074", groupName: "Men's Cloudmonster 1", modelName: "Cloudmonster 1", summary: null, description: "Everyday comfort.",
  color: "Pearl | Ivory", colorDisplay: null, price: 125, listPrice: 180, currency: "USD", availability: "InStock", lastSeason: true,
  sizes: [{ label: "7", available: false, stockHint: "Sold out" }, { label: "7.5", available: true, stockHint: null }, { label: "8", available: true, stockHint: "Only 3 left" }],
  sizeChartUS: [], images: ["https://images.ctfassets.net/a/1.png?w=4000&h=4000", "https://images.ctfassets.net/a/2.png?w=4000&h=4000"], highlights: [], materials: "Polyester",
  countryOfOrigin: "Vietnam", fit: null, breadcrumbs: [], missing: [],
};

test("pricing: conversion, percentage markup, rounding, compare-at", () => {
  const r = calculatePrice(125, 180, settings);
  assert.equal(r.converted, 12000);
  assert.equal(r.price, 14499);            // 12000 * 1.2 = 14400 -> smallest value >= 14400 ending in 99
  assert.ok(r.compareAtPrice! > r.price!);
});

test("pricing: fixed markup, min profit, not configured", () => {
  const s = { ...settings, MARKUP_TYPE: "fixed" as const, MARKUP_VALUE: 1000, ROUNDING_RULE: "none" as const, MIN_PROFIT: 3000 };
  assert.equal(calculatePrice(100, null, s).price, 9600 + 3000);
  assert.equal(calculatePrice(100, null, { ...s, EXCHANGE_RATE: 0 }).ok, false);
  assert.equal(calculatePrice(null, null, s).ok, false);
  assert.equal(applyRounding(12340, "ceil_500"), 12500);
  assert.equal(applyRounding(12340, "end_999"), 12999);
  assert.equal(applyRounding(12340, "nearest_100"), 12300);
});

test("normalize: title, gender, exact size labels, variant SKUs, kept sizes", () => {
  const n = normalize(listing, detail, settings, ["6.5"]);
  assert.equal(n.title, "On Running Cloudmonster 1 - Pearl & Ivory (Men's)");
  assert.equal(n.gender, "Men");
  // men's UK = US - 0.5; source labels kept alongside
  assert.deepEqual(n.sizes.map((z) => z.label), ["6", "6.5", "7", "7.5"]);
  assert.deepEqual(n.sizes.map((z) => z.sourceLabel), ["6.5", "7", "7.5", "8"]);
  assert.equal(n.sizes[0].available, false);      // previously known size no longer listed -> unavailable, not deleted
  assert.equal(n.sizes[2].variantSku, "3MF30742143-7");
  assert.match(n.descriptionHtml, /<strong>SKU - 3MF30742143<\/strong>/);
  assert.equal(n.countryCode, "VN");
  assert.equal(displayColor("Iceberg | Iceberg"), "Iceberg");
  assert.equal(genderOf("Women's Cloud 6", "/womens/"), "Women");
  assert.equal(storefrontSize("9", "Women", settings), "7");     // women's UK = US - 2
  assert.equal(storefrontSize("10.5", "Men", settings), "10");
  assert.equal(storefrontSize("5", "Kids", settings), "5");      // kids untouched
  assert.equal(storefrontSize("9", "Men", { ...settings, SIZE_SYSTEM: "US" }), "9");
});

test("plan migrates US-labelled variants to UK in place (no duplicates, nothing kept as 'manual')", () => {
  const first = base();
  const created = buildPlan(first);
  const existing = shopifyFrom(created);
  // pretend the product was created before the switch: US labels + US SKUs
  existing.variants.nodes = existing.variants.nodes.map((v, i) => ({ ...v, sku: `3MF30742143-${["7", "7.5", "8"][i]}`, selectedOptions: [{ name: "Size", value: ["7", "7.5", "8"][i] }] }));
  const p = buildPlan({ ...first, existing, row: rowFrom(created, first.n) });
  const i = p.input as any;
  assert.equal(i.variants.length, 3);
  assert.deepEqual(i.variants.map((v: any) => v.id), existing.variants.nodes.map((v) => v.id));
  assert.deepEqual(i.variants.map((v: any) => v.optionValues[0].name), ["6.5", "7", "7.5"]);
  assert.deepEqual(i.variants.map((v: any) => v.sku), ["3MF30742143-6.5", "3MF30742143-7", "3MF30742143-7.5"]);
  assert.ok(p.notes.some((x) => /relabelled/.test(x)));
});

function shopifyFrom(plan: ReturnType<typeof buildPlan>, overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  const input = plan.input as any;
  return {
    id: "gid://shopify/Product/1", status: input.status ?? "DRAFT", title: input.title, handle: "h", vendor: input.vendor, productType: input.productType, descriptionHtml: input.descriptionHtml, tags: input.tags,
    seo: input.seo, media: { nodes: (input.files ?? []).map((_: unknown, i: number) => ({ id: `m${i}`, mediaContentType: "IMAGE" })) },
    variants: { nodes: input.variants.map((v: any, i: number) => ({ id: `gid://shopify/ProductVariant/${i}`, sku: v.sku, price: v.price, compareAtPrice: v.compareAtPrice, inventoryPolicy: v.inventoryPolicy, selectedOptions: [{ name: "Size", value: v.optionValues[0].name }] })) },
    sourceId: { value: listing.sku }, eta: { value: settings.DEFAULT_ETA },
    ...overrides,
  };
}

function rowFrom(plan: ReturnType<typeof buildPlan>, n: ReturnType<typeof normalize>): ProductRow {
  return {
    source_product_id: n.sourceProductId, shopify_product_id: "gid://shopify/Product/1", written_title: plan.written.title, written_desc_hash: plan.written.descHash,
    written_seo_hash: plan.written.seoHash, written_eta: plan.written.eta, written_price: plan.written.price, image_hash: plan.written.imagesWritten ? n.hashes.image : null,
    last_sync_status: "created", missing_scans: 0,
  } as ProductRow;
}

const base = (extra: Partial<Parameters<typeof buildPlan>[0]> = {}) => {
  const n = normalize(listing, detail, settings);
  return { n, existing: null, row: undefined, settings, price: calculatePrice(n.price, n.listPrice, settings), locationId: "gid://shopify/Location/1", contentAllowed: true, nowIso: "2026-09-25T00:00:00Z", ...extra };
};

test("plan create: full product with variants, ETA, metafields, images", () => {
  const p = buildPlan(base());
  const i = p.input as any;
  assert.equal(p.action, "create");
  assert.equal(i.status, "DRAFT");
  assert.equal(i.variants.length, 3);
  assert.equal(i.variants[0].inventoryPolicy, "DENY");
  assert.equal(i.variants[1].inventoryPolicy, "CONTINUE");
  assert.deepEqual(i.variants[1].inventoryQuantities, [{ locationId: "gid://shopify/Location/1", name: "available", quantity: 0 }]);
  assert.equal(i.files.length, 2);
  assert.ok(i.metafields.some((m: any) => m.namespace === "custom" && m.key === "eta" && m.value === "7–14 Days"));
  assert.ok(i.metafields.some((m: any) => m.key === "source_product_id" && m.value === "3MF30742143"));
  assert.ok(!i.tags.includes("Instant Ship"));
});

test("plan repeat sync: reuses variant ids, no duplicate images/metafields, nothing overwritten", () => {
  const first = base();
  const created = buildPlan(first);
  const existing = shopifyFrom(created);
  const again = buildPlan({ ...first, existing, row: rowFrom(created, first.n) });
  const i = again.input as any;
  assert.equal(again.action, "update");
  assert.equal(i.variants.length, 3);
  assert.ok(i.variants.every((v: any) => v.id && !v.inventoryQuantities));    // same variants updated, none created
  assert.equal(i.files, undefined);                                           // images unchanged -> media untouched
  assert.equal(i.title, undefined);
  assert.equal(i.descriptionHtml, undefined);
  assert.equal(i.metafields, undefined);                                      // productSet would REPLACE metafields; updates use metafieldsSet
  assert.equal(new Set(again.metafields.map((m) => `${m.namespace}.${m.key}`)).size, again.metafields.length);
  assert.ok(!again.metafields.some((m) => m.key === "eta"));                  // ETA already correct -> not rewritten
});

test("plan preserves manual edits: title, description, price, ETA, tags, extra variant", () => {
  const first = base();
  const created = buildPlan(first);
  const existing = shopifyFrom(created, { title: "My custom title", descriptionHtml: "<p>hand written</p>", eta: { value: "Ships in 3 days" }, tags: [...(created.input as any).tags, "Hype"] });
  existing.variants.nodes[1].price = "19999.00";
  existing.variants.nodes.push({ id: "gid://shopify/ProductVariant/99", sku: "custom", price: "1", compareAtPrice: null, inventoryPolicy: "DENY", selectedOptions: [{ name: "Size", value: "15" }] });
  const changedDetail = { ...detail, description: "New ON copy." };
  const n = normalize(listing, changedDetail, settings);
  const p = buildPlan({ ...first, n, existing, row: rowFrom(created, first.n), settings: { ...settings, DEFAULT_ETA: "10–20 Days" } });
  const i = p.input as any;
  assert.equal(i.title, undefined);
  assert.equal(i.descriptionHtml, undefined);
  assert.ok(!p.metafields.some((m) => m.key === "eta"));
  assert.equal(i.variants.find((v: any) => v.id === "gid://shopify/ProductVariant/1").price, "19999.00");
  assert.ok(i.variants.some((v: any) => v.id === "gid://shopify/ProductVariant/99"));   // manual variant kept, not deleted
  assert.equal(i.tags, undefined);                                                       // manual "Hype" tag kept (no tag write needed)
});

test("plan: all sizes sold out hides product; restock restores it", () => {
  const first = base();
  const created = buildPlan(first);
  const soldOut = normalize(listing, { ...detail, sizes: detail.sizes.map((z) => ({ ...z, available: false })) }, settings);
  const hide = buildPlan({ ...first, n: soldOut, existing: shopifyFrom(created, { status: "ACTIVE" }), row: rowFrom(created, first.n) });
  assert.equal((hide.input as any).status, "DRAFT");
  assert.ok((hide.input as any).tags.includes(OOS_TAG));
  const restock = buildPlan({ ...first, existing: shopifyFrom(created, { status: "DRAFT", tags: [...(created.input as any).tags, OOS_TAG] }), row: rowFrom(created, first.n) });
  assert.equal((restock.input as any).status, "ACTIVE");
  assert.ok(!(restock.input as any).tags.includes(OOS_TAG));
});

test("plan: content gate withholds ON images and description text", () => {
  const p = buildPlan(base({ contentAllowed: false }));
  const i = p.input as any;
  assert.equal(i.files, undefined);
  assert.ok(!i.descriptionHtml.includes("Everyday comfort."));
  assert.ok(!i.seo.description.includes("Everyday comfort."));
  assert.match(i.descriptionHtml, /SKU - 3MF30742143/);
  assert.equal(p.written.imagesWritten, false);
});

test("hash is stable regardless of key order", () => {
  assert.equal(hash({ a: 1, b: [1, 2] }), hash({ b: [1, 2], a: 1 }));
});
