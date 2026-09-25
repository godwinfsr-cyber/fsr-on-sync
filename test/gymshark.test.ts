import "./helpers/isolated-data.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { gymsharkEnvSettings, parseWeightBands, type GymsharkSettings } from "../src/gymshark/config.ts";
import { gdb } from "../src/gymshark/db.ts";
import { getExchangeRate, validateRate } from "../src/gymshark/fx.ts";
import { cleanDescription, normalizeGymshark, sizeLabel, specSectionsFrom } from "../src/gymshark/normalize.ts";
import type { GShopifyProduct } from "../src/gymshark/ops.ts";
import { OOS_TAG, PlanConflict, buildGymsharkPlan, mapUploadedMedia } from "../src/gymshark/plan.ts";
import { calculateGymsharkPrice, roundPrice, weightSurcharge } from "../src/gymshark/pricing.ts";
import { imageKey, parseProductPage, parseProductSitemap, parseSitemapIndex } from "../src/gymshark/source.ts";
import { pricesFor } from "../src/gymshark/sync.ts";
import { Logger } from "../src/logger.ts";

const settings: GymsharkSettings = {
  ...gymsharkEnvSettings(), SOURCE_PRICE_BASIS: "CURRENT_SELLING", COMPARE_AT_MODE: "SOURCE_REGULAR", WEIGHT_SURCHARGE_ENABLED: true, WEIGHT_SURCHARGE_FALLBACK_INR: 2000,
  WEIGHT_BANDS: "0.5:1000,1:1500,2:2000,3:2500,+:3000", FSR_PROFIT_INR: 1500, PRICE_ROUNDING_MODE: "NONE", DEFAULT_ETA: "15–20 Days", NEW_PRODUCT_STATUS: "DRAFT",
  CONTENT_REUSE_CONFIRMED: true, TITLE_TEMPLATE: "Gymshark {title} ({gender})", BASE_TAGS: "Gymshark,ETA", PRODUCT_TYPE_MAP: "bags:Bags,apparel:Apparel,accessories:Accessories",
  DEFAULT_PRODUCT_TYPE: "Apparel", VENDOR: "Gymshark", FX_PROVIDER: "open.er-api.com", MAX_EXCHANGE_RATE_AGE_HOURS: 24, SOURCE_CURRENCY: "USD", TARGET_CURRENCY: "INR",
};
const fx85 = { ok: true, rate: 85, base: "USD" };
const log = new Logger(null, { db: gdb, name: "gymshark-test" });

// ---------- pricing ----------

test("pricing: USD x rate + weight surcharge + FSR profit, no percentage discount", () => {
  // spec example: $40 at ₹85, 0.8 kg -> 3400 + 1500 surcharge, plus the ₹1,500 FSR profit
  const p = calculateGymsharkPrice({ currentUsd: 40, regularUsd: 40, currency: "USD", weightKg: 0.8 }, fx85, settings);
  assert.equal(p.convertedPriceInr, 3400);
  assert.equal(p.weight.surchargeInr, 1500);
  assert.equal(p.fsrPrice, 3400 + 1500 + 1500);
  assert.equal(p.compareAtPrice, null);
  assert.equal(calculateGymsharkPrice({ currentUsd: 40, regularUsd: 40, currency: "USD", weightKg: 0.8 }, fx85, { ...settings, FSR_PROFIT_INR: 0 }).fsrPrice, 4900);
});

test("pricing: sale uses Gymshark's current price; compare-at = regular through the same formula", () => {
  const p = calculateGymsharkPrice({ currentUsd: 40, regularUsd: 60, currency: "USD", weightKg: 0.8 }, fx85, { ...settings, FSR_PROFIT_INR: 0 });
  assert.equal(p.sourcePriceUsd, 40);
  assert.equal(p.sourceSalePriceUsd, 40);
  assert.equal(p.sourceRegularPriceUsd, 60);
  assert.equal(p.fsrPrice, 4900);       // 3400 + 1500
  assert.equal(p.compareAtPrice, 6600); // 5100 + 1500
  const reg = calculateGymsharkPrice({ currentUsd: 40, regularUsd: 60, currency: "USD", weightKg: 0.8 }, fx85, { ...settings, FSR_PROFIT_INR: 0, SOURCE_PRICE_BASIS: "REGULAR" });
  assert.equal(reg.fsrPrice, 6600);
  assert.equal(reg.compareAtPrice, null);
  assert.equal(calculateGymsharkPrice({ currentUsd: 40, regularUsd: 60, currency: "USD", weightKg: 0.8 }, fx85, { ...settings, COMPARE_AT_MODE: "NONE" }).compareAtPrice, null);
});

test("pricing: weight bands are deterministic; unknown weight uses the fallback", () => {
  assert.equal(weightSurcharge(0.5, settings).surchargeInr, 1000);
  assert.equal(weightSurcharge(0.501, settings).surchargeInr, 1500);
  assert.equal(weightSurcharge(1.0, settings).surchargeInr, 1500);
  assert.equal(weightSurcharge(1.5, settings).surchargeInr, 2000);
  assert.equal(weightSurcharge(3.0, settings).surchargeInr, 2500);
  assert.equal(weightSurcharge(7, settings).surchargeInr, 3000);
  assert.deepEqual(weightSurcharge(null, settings), { weightKg: null, surchargeInr: 2000, reason: "fallback_weight_unknown" });
  assert.equal(weightSurcharge(0.8, { ...settings, WEIGHT_SURCHARGE_ENABLED: false }).surchargeInr, 0);
  assert.throws(() => parseWeightBands("0.5:1000,1:1500"), /open-ended/);
  assert.throws(() => parseWeightBands("1:1000,0.5:1500,+:3000"), /increase/);
});

test("pricing: rounding is configurable and NONE does not round business values", () => {
  assert.equal(roundPrice(4940.234, "NONE"), 4940.23);
  assert.equal(roundPrice(4944, "NEAREST_10"), 4940);
  assert.equal(roundPrice(4926, "NEAREST_50"), 4950);
  assert.equal(roundPrice(4951, "NEAREST_100"), 5000);
});

test("pricing: refuses to price without a valid rate or with a currency mismatch", () => {
  assert.equal(calculateGymsharkPrice({ currentUsd: 40, regularUsd: 40, currency: "USD", weightKg: null }, { ok: false, rate: null, base: "USD" }, settings).ok, false);
  assert.equal(calculateGymsharkPrice({ currentUsd: 40, regularUsd: 40, currency: "GBP", weightKg: null }, fx85, settings).ok, false);
  assert.equal(calculateGymsharkPrice({ currentUsd: null, regularUsd: null, currency: "USD", weightKg: null }, fx85, settings).ok, false);
});

// ---------- exchange rate ----------

const erApi = (rate: number, unix = Math.floor(Date.now() / 1000)) => async () => ({ result: "success", base_code: "USD", time_last_update_unix: unix, rates: { INR: rate } });

test("fx: live rate recorded; provider down -> last valid rate only within max age; else paused", async () => {
  gdb.exec("DELETE FROM fx_rates");
  const now = new Date("2026-09-26T10:00:00Z");
  const live = await getExchangeRate(settings, log, { fetcher: erApi(95.8, now.getTime() / 1000 - 3600), now });
  assert.equal(live.ok, true);
  assert.equal(live.rate, 95.8);
  assert.equal(live.origin, "live");
  const down = async () => { throw new Error("ECONNRESET"); };
  const cached = await getExchangeRate(settings, log, { fetcher: down, now: new Date("2026-09-26T20:00:00Z") });
  assert.equal(cached.ok, true);
  assert.equal(cached.origin, "cached");
  assert.equal(cached.rate, 95.8);
  const stale = await getExchangeRate(settings, log, { fetcher: down, now: new Date("2026-09-27T11:00:00Z") });
  assert.equal(stale.ok, false);
  assert.match(stale.reason!, /price updates paused/);
  gdb.exec("DELETE FROM fx_rates");
});

test("fx: implausible values and big jumps are never applied silently", async () => {
  assert.match(validateRate("USD/INR", 9.58, null)!, /plausible/);
  assert.match(validateRate("USD/INR", 120, 95)!, /held for review/);
  assert.equal(validateRate("USD/INR", 96.2, 95.8), null);
  gdb.exec("DELETE FROM fx_rates");
  const bad = await getExchangeRate(settings, log, { fetcher: erApi(0.0104), persist: false });
  assert.equal(bad.ok, false);
  const manual = await getExchangeRate({ ...settings, FX_PROVIDER: "manual", MANUAL_EXCHANGE_RATE: 0 }, log, { persist: false });
  assert.equal(manual.ok, false);
  const manualOk = await getExchangeRate({ ...settings, FX_PROVIDER: "manual", MANUAL_EXCHANGE_RATE: 96 }, log, { persist: false });
  assert.equal(manualOk.rate, 96);
});

// ---------- source parsing ----------

const colour = (o: { id: number; colour: string; handle: string; price: number; compare: number; code: string; stock?: boolean[] }) => ({
  id: o.id, sku: "A5A2Z", title: "Legacy Drop Arm Tank", colour: o.colour, handle: o.handle, inStock: true, price: o.price, compareAtPrice: o.compare, currencyCode: "USD",
  availableSizes: ["xs", "s", "m"].map((z, i) => ({ id: o.id * 10 + i, inStock: o.stock?.[i] ?? true, inventoryQuantity: o.stock?.[i] === false ? 0 : 40, price: Math.trunc(o.price), size: z, sku: `A5A2Z-${o.code}-${z.toUpperCase()}`, barcode: `50631${o.id}${i}` })),
  media: [1, 2].map((n) => ({ url: `https://cdn.shopify.com/s/files/1/0156/6146/files/A5A2Z_${o.code}_${n}.jpg?v=17787`, width: 1692, height: 2018, altText: null })),
});
const PAGE = (o: { whiteStock?: boolean[] } = {}) => {
  const black = colour({ id: 6805227536586, colour: "Black", handle: "gymshark-legacy-drop-arm-tank-black-aw23", price: 12, compare: 24, code: "BB2J" });
  const white = colour({ id: 6805228126410, colour: "White", handle: "gymshark-legacy-drop-arm-tank-white-aw23", price: 14.4, compare: 24, code: "WB57", stock: o.whiteStock });
  const product = {
    ...black, description: "<p><strong>BUILD YOUR LEGACY</strong></p><p><br data-mce-fragment=\"1\">• Classic drop arm cut</p><p><strong>MATERIALS &amp; CARE</strong><br>• 95% Cotton, 5% Elastane</p><p><br><meta charset=\"utf-8\"><span>SKU: A5A2Z-BB2J</span></p>",
    gender: ["m"], category: "sleeveless tops", subcategory: "drop-arm", division: "apparel", range: "legacy", fit: "slim fit", activities: ["Lifting"], features: [], season: "aw23", labels: ["sale"],
  };
  const next = { props: { pageProps: { productData: { product, variants: [{ ...black, price: 12 }, { ...white, price: 14.4 }] } } } };
  return `<html><head><link rel="canonical" href="https://www.gymshark.com/products/gymshark-legacy-drop-arm-tank-black-aw23" data-next-head=""/>
<script type="application/ld+json">{"@type":"ProductGroup","name":"Legacy Drop Arm Tank","hasVariant":[{"offers":{"priceCurrency":"USD","price":12}}]}</script></head>
<body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></body></html>`;
};
const URL0 = "https://www.gymshark.com/products/gymshark-legacy-drop-arm-tank-black-aw23";

test("source: sitemap index + products sitemap (en-US only, no image-only entries)", () => {
  assert.deepEqual(parseSitemapIndex(`<sitemapindex><sitemap><loc>https://www.gymshark.com/sitemap_products_1.xml</loc></sitemap><sitemap><loc>https://www.gymshark.com/es-US/sitemap_products_1.xml</loc></sitemap><sitemap><loc>https://www.gymshark.com/sitemap_pages_1.xml</loc></sitemap></sitemapindex>`), ["https://www.gymshark.com/sitemap_products_1.xml"]);
  const urls = parseProductSitemap(`<urlset><url><loc>https://www.gymshark.com/products/gift-card</loc><image:image><image:loc>https://cdn.shopify.com/x.png</image:loc></image:image></url><url><loc>https://www.gymshark.com/products/gymshark-legacy-t-shirt-black-aw23</loc></url></urlset>`);
  assert.deepEqual(urls.map((u) => u.handle), ["gift-card", "gymshark-legacy-t-shirt-black-aw23"]);
});

test("source: one page yields every colourway of the style with sizes, barcodes and untruncated prices", () => {
  const st = parseProductPage(PAGE(), URL0);
  assert.equal(st.styleCode, "A5A2Z");
  assert.equal(st.colours.length, 2);
  const white = st.colours.find((c) => c.colour === "White")!;
  assert.equal(white.price, 14.4);             // colour price, not the truncated per-size 14
  assert.equal(white.compareAtPrice, 24);
  assert.equal(white.sizes[0].sku, "A5A2Z-WB57-XS");
  assert.ok(white.sizes[0].barcode);
  assert.equal(st.canonicalUrl, URL0);
  assert.equal(st.weightKg, null);
  assert.equal(imageKey("https://cdn.shopify.com/s/files/1/A.jpg?v=1"), imageKey("https://cdn.shopify.com/s/files/1/A.jpg?v=2"));
});

test("normalize: Colour x Size variants, clean description, source-only specs", () => {
  const n = normalizeGymshark(parseProductPage(PAGE(), URL0), settings);
  assert.equal(n.title, "Gymshark Legacy Drop Arm Tank (Men)");
  assert.equal(n.productType, "Apparel");
  assert.equal(n.variants.length, 6);
  assert.deepEqual(n.sizeOrder, ["XS", "S", "M"]);
  assert.deepEqual(n.colours.map((c) => c.colour), ["Black", "White"]);
  assert.equal(n.specs.Material, "95% Cotton, 5% Elastane");
  assert.equal(n.specs.Fit, "Slim Fit");
  assert.ok(!/SKU: A5A2Z-BB2J|meta|data-mce|<span/.test(n.descriptionHtml));
  assert.match(n.descriptionHtml, /<strong>SKU - A5A2Z<\/strong>/);
  assert.equal(n.images.length, 4);
  assert.equal(sizeLabel("default title"), "One Size");
  assert.equal(sizeLabel("3xl"), "3XL");
  assert.deepEqual(specSectionsFrom(cleanDescription("<p><b>SIZE &amp; FIT</b></p><ul><li>Ankle height</li></ul>")), [{ heading: "Size & Fit", items: ["Ankle height"] }]);
});

// ---------- Shopify plan ----------

const nowIso = "2026-09-26T10:00:00.000Z";
const fx = { ok: true, rate: 96, base: "USD", quote: "INR", provider: "open.er-api.com", providerUpdatedAt: nowIso, fetchedAt: nowIso, origin: "live" as const };

function existingFrom(n: ReturnType<typeof normalizeGymshark>, over: Partial<GShopifyProduct> = {}, prices: Record<string, string> = {}): GShopifyProduct {
  return {
    id: "gid://shopify/Product/1", status: "ACTIVE", title: n.title, handle: "h", vendor: "Gymshark", productType: "Apparel", descriptionHtml: n.descriptionHtml, tags: n.tags,
    seo: { title: n.seoTitle, description: n.seoDescription }, media: { nodes: [] }, sourceId: { value: n.styleCode }, eta: { value: "15–20 Days" },
    variants: { nodes: n.variants.map((v, i) => ({ id: `gid://shopify/ProductVariant/${i + 1}`, sku: v.sku, barcode: v.barcode, price: prices[v.sku] ?? "0.00", compareAtPrice: null, inventoryPolicy: "CONTINUE" as const, selectedOptions: [{ name: "Color", value: v.colour }, { name: "Size", value: v.size }], media: { nodes: [] } })) },
    ...over,
  };
}

test("plan: create -> DRAFT, Color/Size options, per-colour prices, ETA + gymshark_sync metafields", () => {
  const n = normalizeGymshark(parseProductPage(PAGE(), URL0), settings);
  const plan = buildGymsharkPlan({ n, existing: null, row: undefined, settings, prices: pricesFor(n, fx, settings), fx, images: [], locationId: "gid://shopify/Location/1", nowIso });
  assert.equal(plan.action, "create");
  assert.equal(plan.input.status, "DRAFT");
  const opts = plan.input.productOptions as { name: string; values: { name: string }[] }[];
  assert.deepEqual(opts.map((o) => o.name), ["Color", "Size"]);
  const vs = plan.input.variants as { sku: string; price: string; compareAtPrice: string | null }[];
  assert.equal(vs.find((v) => v.sku === "A5A2Z-BB2J-XS")!.price, (12 * 96 + 3500).toFixed(2));
  assert.equal(vs.find((v) => v.sku === "A5A2Z-WB57-XS")!.price, (14.4 * 96 + 3500).toFixed(2));
  assert.equal(vs.find((v) => v.sku === "A5A2Z-WB57-XS")!.compareAtPrice, (24 * 96 + 3500).toFixed(2));
  const mfs = plan.input.metafields as { namespace: string; key: string; value: string }[];
  assert.equal(mfs.find((m) => m.key === "eta")!.value, "15–20 Days");
  assert.equal(mfs.find((m) => m.key === "source_product_id")!.value, "A5A2Z");
  assert.equal(mfs.find((m) => m.key === "weight_surcharge_reason")!.value, "fallback_weight_unknown");
  assert.equal(mfs.find((m) => m.key === "exchange_rate")!.value, "96");
  assert.equal((plan.input.files as unknown[]).length, 4);
  assert.ok(!(plan.input.title as string).includes("Days"));
});

test("plan: a price edited in Shopify is kept until Gymshark's USD price changes", () => {
  const n = normalizeGymshark(parseProductPage(PAGE(), URL0), settings);
  const prices = pricesFor(n, fx, settings);
  const target = (12 * 96 + 3500).toFixed(2);
  const written = Object.fromEntries(n.variants.map((v) => [v.sku, v.colour === "Black" ? target : (14.4 * 96 + 3500).toFixed(2)]));
  const e = existingFrom(n, {}, { ...written, "A5A2Z-BB2J-XS": "4999.00" });
  const row = { written_prices: JSON.stringify(written), price_hash: n.hashes.price, image_hash: n.hashes.image, written_title: n.title } as never;
  const plan = buildGymsharkPlan({ n, existing: e, row, settings, prices, fx, images: [], locationId: null, nowIso });
  assert.equal((plan.input.variants as { sku: string; price: string }[]).find((v) => v.sku === "A5A2Z-BB2J-XS")!.price, "4999.00");
  const moved = buildGymsharkPlan({ n, existing: e, row: { ...(row as object), price_hash: "old" } as never, settings, prices, fx, images: [], locationId: null, nowIso });
  assert.equal((moved.input.variants as { sku: string; price: string }[]).find((v) => v.sku === "A5A2Z-BB2J-XS")!.price, target);
});

test("plan: no valid rate -> existing prices untouched, new variants deferred, never invented", () => {
  const n = normalizeGymshark(parseProductPage(PAGE(), URL0), settings);
  const noFx = { ...fx, ok: false, rate: null };
  const e = existingFrom(n, { variants: { nodes: existingFrom(n, {}, {}).variants.nodes.filter((v) => v.sku!.includes("BB2J")).map((v) => ({ ...v, price: "5000.00" })) } });
  const plan = buildGymsharkPlan({ n, existing: e, row: undefined, settings, prices: pricesFor(n, noFx, settings), fx: noFx, images: [], locationId: null, nowIso });
  const vs = plan.input.variants as { sku: string; price: string }[];
  assert.ok(vs.every((v) => v.price === "5000.00"));
  assert.equal(plan.deferredVariants, 3); // the White sizes
  assert.ok(plan.pricesPaused);
  assert.ok(!plan.metafields.some((m) => m.key === "exchange_rate"));
});

test("plan: sold out everywhere -> DRAFT + oos tag; colour dropped by Gymshark kept as unavailable", () => {
  const n = normalizeGymshark(parseProductPage(PAGE(), URL0), settings);
  const e = existingFrom(n);
  e.variants.nodes.push({ id: "gid://shopify/ProductVariant/99", sku: "A5A2Z-OLD1-M", barcode: null, price: "1.00", compareAtPrice: null, inventoryPolicy: "CONTINUE", selectedOptions: [{ name: "Color", value: "Old" }, { name: "Size", value: "M" }], media: { nodes: [] } });
  const plan = buildGymsharkPlan({ n, existing: e, row: undefined, settings, prices: pricesFor(n, fx, settings), fx, images: [], locationId: null, nowIso });
  const kept = (plan.input.variants as { id?: string; inventoryPolicy?: string }[]).find((v) => v.id === "gid://shopify/ProductVariant/99")!;
  assert.equal(kept.inventoryPolicy, "DENY");

  const soldOut = parseProductPage(PAGE({ whiteStock: [false, false, false] }), URL0);
  for (const c of soldOut.colours) for (const z of c.sizes) z.inStock = false;
  const n2 = normalizeGymshark(soldOut, settings);
  const p2 = buildGymsharkPlan({ n: n2, existing: existingFrom(n2), row: undefined, settings, prices: pricesFor(n2, fx, settings), fx, images: [], locationId: null, nowIso });
  assert.equal(p2.input.status, "DRAFT");
  assert.ok((p2.input.tags as string[]).includes(OOS_TAG));
});

test("plan: images already uploaded are referenced by media id, not uploaded again", () => {
  const n = normalizeGymshark(parseProductPage(PAGE(), URL0), settings);
  const e = existingFrom(n, { media: { nodes: [0, 1, 2].map((i) => ({ id: `gid://shopify/MediaImage/${i}`, alt: null as string | null, mediaContentType: "IMAGE" })).concat([{ id: "gid://shopify/MediaImage/manual", alt: "mine", mediaContentType: "IMAGE" }]) } });
  const images = n.images.slice(0, 3).map((im, i) => ({ style_code: n.styleCode, source_key: im.key, colour: im.colour, media_id: `gid://shopify/MediaImage/${i}`, uploaded_at: nowIso }));
  const plan = buildGymsharkPlan({ n, existing: e, row: { image_hash: "old" } as never, settings, prices: pricesFor(n, fx, settings), fx, images, locationId: null, nowIso });
  const files = plan.input.files as { id?: string; originalSource?: string }[];
  assert.equal(files.filter((f) => f.id).length, 4);            // 3 reused + 1 manual kept
  assert.equal(files.filter((f) => f.originalSource).length, 1); // only the new photo is uploaded
  const map = mapUploadedMedia(plan.imagesSent!, [{ id: "a", alt: null }, { id: "b", alt: null }, { id: "c", alt: null }, { id: "d", alt: null }, { id: "m", alt: "mine" }], new Map());
  assert.equal(map?.get(n.images[3].key), "d");
});

test("plan: hand-made product with different options is left for review", () => {
  const n = normalizeGymshark(parseProductPage(PAGE(), URL0), settings);
  const e = existingFrom(n);
  e.variants.nodes = [{ ...e.variants.nodes[0], selectedOptions: [{ name: "Waist", value: "30" }] }];
  assert.throws(() => buildGymsharkPlan({ n, existing: e, row: undefined, settings, prices: pricesFor(n, fx, settings), fx, images: [], locationId: null, nowIso }), PlanConflict);
});
