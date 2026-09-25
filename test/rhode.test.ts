import "./helpers/isolated-data.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { getExchangeRate } from "../src/gymshark/fx.ts";
import type { GShopifyProduct } from "../src/gymshark/ops.ts";
import { Logger } from "../src/logger.ts";
import { rhodeEnvSettings, type RhodeSettings } from "../src/rhode/config.ts";
import { RHODE_FX_STORE, rdb } from "../src/rhode/db.ts";
import { displayValue, familyOf, groupRhodeCatalog, normalizeRhode, sizeFrom, type GroupContext } from "../src/rhode/normalize.ts";
import { OOS_TAG, PlanConflict, buildRhodePlan } from "../src/rhode/plan.ts";
import { calculateRhodePrice } from "../src/rhode/pricing.ts";
import { imageKey, normalizeImageUrl, parseProductPage, type RhodeRawProduct } from "../src/rhode/source.ts";
import { pricesFor } from "../src/rhode/sync.ts";

const settings: RhodeSettings = { ...rhodeEnvSettings(), PRICING_ADJUSTMENT_INR: 2000, PRICE_ROUNDING_MODE: "NONE", SOURCE_PRICE_BASIS: "CURRENT_SELLING", COMPARE_AT_MODE: "NONE", ETA: "15–20 Days", CONTENT_REUSE_CONFIRMED: true, NEW_PRODUCT_STATUS: "DRAFT", GROUP_SHADES: true };
const fx85 = { ok: true, rate: 85, base: "USD", quote: "INR", provider: "test", providerUpdatedAt: null, fetchedAt: "2026-09-26T00:00:00Z", origin: "live" as const };
const log = new Logger(null, { db: rdb, name: "rhode-test" });

// ---------- pricing (spec section 22: ₹85 is a TEST rate only) ----------

for (const [name, usd, expected] of [["A", 16, 3360], ["B", 20, 3700], ["C", 32, 4720]] as const) {
  test(`pricing test ${name}: $${usd} × ₹85 + ₹2,000 = ₹${expected}`, () => {
    const p = calculateRhodePrice({ currentUsd: usd, regularUsd: usd, currency: "USD" }, fx85, settings);
    assert.equal(p.ok, true);
    assert.equal(p.convertedPriceInr, usd * 85);
    assert.equal(p.pricingAdjustmentInr, 2000);
    assert.equal(p.fsrPrice, expected);
  });
}

test("pricing: no rounding by default (paise kept); rounding is configurable", () => {
  const p = calculateRhodePrice({ currentUsd: 20, regularUsd: 20, currency: "USD" }, { ...fx85, rate: 88.7654 }, settings);
  assert.equal(p.fsrPrice, 3775.31); // 1775.308 + 2000, only paise precision
  const r = calculateRhodePrice({ currentUsd: 20, regularUsd: 20, currency: "USD" }, { ...fx85, rate: 88.7654 }, { ...settings, PRICE_ROUNDING_MODE: "NEAREST_10" });
  assert.equal(r.fsrPrice, 3780);
});

test("pricing: sale price is the basis, regular kept as metadata, no compare-at by default, no extra discount", () => {
  const p = calculateRhodePrice({ currentUsd: 25, regularUsd: 32, currency: "USD" }, fx85, settings);
  assert.equal(p.sourcePriceUsd, 25);
  assert.equal(p.sourceSalePriceUsd, 25);
  assert.equal(p.sourceRegularPriceUsd, 32);
  assert.equal(p.fsrPrice, 25 * 85 + 2000);
  assert.equal(p.compareAtPrice, null);
  const withCompare = calculateRhodePrice({ currentUsd: 25, regularUsd: 32, currency: "USD" }, fx85, { ...settings, COMPARE_AT_MODE: "SOURCE_REGULAR" });
  assert.equal(withCompare.compareAtPrice, 32 * 85 + 2000);
});

test("pricing: fails (never guesses) without a valid rate, a price, or with a non-USD source", () => {
  assert.equal(calculateRhodePrice({ currentUsd: 20, regularUsd: 20, currency: "USD" }, { ok: false, rate: null, base: "USD" }, settings).ok, false);
  assert.equal(calculateRhodePrice({ currentUsd: null, regularUsd: null, currency: "USD" }, fx85, settings).ok, false);
  assert.equal(calculateRhodePrice({ currentUsd: 20, regularUsd: 20, currency: "EUR" }, fx85, settings).ok, false);
});

test("fx: live rate stored; provider down -> cached only within USD_INR_RATE_MAX_AGE_HOURS; older -> pricing fails", async () => {
  const now = new Date("2026-09-26T10:00:00Z");
  const erApi = (rate: number, unix: number) => async () => ({ result: "success", base_code: "USD", time_last_update_unix: unix, rates: { INR: rate } });
  const live = await getExchangeRate(settings, log, { fetcher: erApi(88.2, now.getTime() / 1000 - 3600), now, store: RHODE_FX_STORE });
  assert.equal(live.ok, true);
  assert.equal(live.rate, 88.2);
  const down = async () => { throw new Error("ECONNRESET"); };
  const cached = await getExchangeRate(settings, log, { fetcher: down, now: new Date("2026-09-26T20:00:00Z"), store: RHODE_FX_STORE });
  assert.equal(cached.origin, "cached");
  const stale = await getExchangeRate(settings, log, { fetcher: down, now: new Date("2026-09-27T11:00:00Z"), store: RHODE_FX_STORE });
  assert.equal(stale.ok, false);
  rdb.exec("DELETE FROM fx_rates");
});

// ---------- catalog grouping ----------

let nextId = 1000;
function product(title: string, opts: Partial<RhodeRawProduct> & { price?: string; available?: boolean; sku?: string; pdp?: string } = {}): RhodeRawProduct {
  const id = opts.id ?? nextId++;
  const handle = opts.handle ?? title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return {
    id, title, handle, body_html: opts.body_html ?? "<p>Lip care is skincare. Size: 10ml / .3 fl oz.</p>", published_at: null, updated_at: "2026-09-25T00:00:00Z", vendor: "rhode",
    product_type: opts.product_type ?? "Lip Treatment", tags: opts.tags ?? (opts.pdp ? [`pdp:${opts.pdp}`] : []),
    variants: opts.variants ?? [{ id: id * 10, title: "Default Title", option1: "Default Title", option2: null, option3: null, sku: opts.sku ?? `RHS00023-SC${id}`, available: opts.available ?? true, price: opts.price ?? "20.00", compare_at_price: null, grams: 18, featured_image: null }],
    images: opts.images ?? [{ id: id * 100, src: `https://cdn.shopify.com/s/files/1/x/files/${handle}.jpg?v=1`, position: 1, width: 1000, height: 1000, variant_ids: [] }],
    options: opts.options ?? [{ name: "Title", position: 1, values: ["Default Title"] }],
  };
}

test("grouping: shades of one line -> one FSR product; sets sharing the tag stay separate; gift wrap excluded", () => {
  const ribbon = product("peptide lip tint ribbon", { pdp: "peptide-lip-tint", id: 1 });
  const espresso = product("peptide lip tint espresso", { pdp: "peptide-lip-tint", id: 2 });
  const summer = product("peptide lip tint colada", { pdp: "summer-peptide-lip-tint", id: 3 });
  const daisy = product("spotwear daisy", { pdp: "spotwear", product_type: "Skin Care", id: 4 });
  const bubble = product("spotwear bubble", { pdp: "spotwear", product_type: "Skin Care", id: 5 });
  const set = product("the spotwear set", { pdp: "spotwear", product_type: "Skin Care", id: 6 });
  const wrap = product("rhode wrap", { handle: "diy-gift-wrap", product_type: "Merch", id: 7 });
  const g = groupRhodeCatalog([ribbon, espresso, summer, daisy, bubble, set, wrap], settings);
  const lip = g.groups.find((x) => x.key === "family:peptide-lip-tint")!;
  assert.deepEqual(lip.members.map((m) => m.id), [1, 2, 3]); // the seasonal shade joins the same product
  assert.equal(g.groups.find((x) => x.key === "family:spotwear")!.members.length, 2);
  assert.ok(g.groups.some((x) => x.key === "6"));
  assert.equal(g.groups.some((x) => x.members.some((m) => m.handle === "diy-gift-wrap")), false);
  assert.equal(g.groups.length, 3);
  // every Rhode product lands in exactly one FSR product (no duplicates across collections / families)
  assert.equal(new Set(g.groups.flatMap((x) => x.members.map((m) => m.id))).size, 6);
});

test("grouping: GROUP_SHADES=false keeps one FSR product per Rhode product; a lone title without a fit is never forced", () => {
  const a = product("pocket blush piggy", { pdp: "pocket-blush" });
  const b = product("pocket blush freckle", { pdp: "pocket-blush" });
  assert.equal(groupRhodeCatalog([a, b], { ...settings, GROUP_SHADES: false }).groups.length, 2);
  assert.equal(familyOf("pdp:x", [product("alpha"), product("beta")]).name, null);
});

test("normalize: family variants, titles, category from Rhode collections, images deduped, description sections", () => {
  const a = product("peptide lip tint ribbon", { pdp: "peptide-lip-tint", id: 11, price: "20.00" });
  const b = product("peptide lip tint pbj", { pdp: "peptide-lip-tint", id: 12, price: "20.00", available: false,
    images: [{ id: 1, src: "https://cdn.shopify.com/s/files/1/x/files/shared.jpg?v=3", position: 1, width: 900, height: 900, variant_ids: [] },
      { id: 2, src: "https://cdn.shopify.com/s/files/1/x/files/peptide-lip-tint-ribbon.jpg?v=9", position: 2, width: 900, height: 900, variant_ids: [] },
      { id: 3, src: "https://cdn.shopify.com/s/files/1/x/files/clip.mp4", position: 3, width: null, height: null, variant_ids: [] }] });
  const [g] = groupRhodeCatalog([a, b], settings).groups;
  const html = `<div class="Product-tab"><button class="js-product-tab-toggle"><span>Benefits</span></button><div class="Product-tab-content"><p><span>• Hydrates<br />• Plumps</span></p></div></div>
    <div class="Product-tab"><button class="js-product-tab-toggle"><span>Application</span></button><div class="Product-tab-content"><p>Tint lips day or night.</p></div></div>
    <div class="Highlights-ingredients-content">Shea Butter, Tocopherol</div>`;
  const details = parseProductPage(html);
  assert.deepEqual(details.tabs.Benefits, ["Hydrates", "Plumps"]);
  const ctx: GroupContext = { details: new Map([[a.handle, details], [b.handle, details]]), membership: new Map([["lip-cheek", new Set([11, 12])]]), collectionTitles: new Map([["lip-cheek", "lip + cheek"]]) };
  const n = normalizeRhode(g, ctx, settings);
  assert.equal(n.title, "Rhode Peptide Lip Tint");
  assert.deepEqual(n.optionNames, ["Shade"]);
  assert.deepEqual(n.variants.map((v) => v.label), ["Ribbon", "PBJ"]);
  assert.equal(n.category, "Makeup");
  assert.equal(n.subcategory, "Lip");
  assert.equal(n.availability, "in_stock");
  assert.equal(n.images.length, 2); // Ribbon's photo appears once; the video is not an image
  assert.equal(n.size, "10ml / .3 fl oz");
  assert.match(n.descriptionHtml, /<h3>Benefits<\/h3><ul><li>Hydrates<\/li>/);
  assert.match(n.descriptionHtml, /<h3>How to use<\/h3>/);
  assert.match(n.descriptionHtml, /Shea Butter, Tocopherol/);
  assert.doesNotMatch(n.descriptionHtml + n.title, /15–20 Days/); // ETA only as a metafield
});

test("helpers: values, size, image URLs", () => {
  assert.equal(displayValue("iphone 16 pro max"), "iPhone 16 Pro Max");
  assert.equal(displayValue("big (4.2 oz)"), "Big (4.2 oz)");
  assert.equal(sizeFrom("<p>Formula. Size: 10ml / .3 fl oz.<br>More</p>"), "10ml / .3 fl oz");
  assert.equal(normalizeImageUrl("//cdn.shopify.com/s/files/a/b_1024x1024.png?v=12&utm_source=x"), "https://cdn.shopify.com/s/files/a/b.png?v=12");
  assert.equal(imageKey("https://cdn.shopify.com/s/files/a/B.png?v=12"), "//cdn.shopify.com/s/files/a/b.png");
});

// ---------- plan: create / update, no double pricing, duplicates, availability ----------

function existing(over: Partial<GShopifyProduct> = {}): GShopifyProduct {
  return {
    id: "gid://shopify/Product/1", status: "ACTIVE", title: "Rhode Peptide Lip Tint", handle: "rhode-peptide-lip-tint", vendor: "Rhode", productType: "Makeup", descriptionHtml: "", tags: [],
    seo: { title: null, description: null }, media: { nodes: [] }, sourceId: { value: "family:peptide-lip-tint" }, eta: { value: "15–20 Days" },
    variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", sku: "RHS00023-SC21", barcode: null, price: "3700.00", compareAtPrice: null, inventoryPolicy: "CONTINUE", selectedOptions: [{ name: "Shade", value: "Ribbon" }], media: { nodes: [] } }] },
    ...over,
  };
}
const ctx0: GroupContext = { details: new Map(), membership: new Map(), collectionTitles: new Map() };

test("plan: create sets ETA metafield, rhode_sync fields, DRAFT status, price from formula", () => {
  const [g] = groupRhodeCatalog([product("peptide lip tint ribbon", { pdp: "peptide-lip-tint", id: 21, sku: "RHS00023-SC21" }), product("peptide lip tint toast", { pdp: "peptide-lip-tint", id: 22, sku: "RHS00023-SC22" })], settings).groups;
  const n = normalizeRhode(g, ctx0, settings);
  const plan = buildRhodePlan({ n, existing: null, row: undefined, settings, prices: pricesFor(n, fx85, settings), fx: fx85, images: [], locationId: null, nowIso: "2026-09-26T00:00:00Z" });
  assert.equal(plan.action, "create");
  assert.equal(plan.input.status, "DRAFT");
  assert.equal(plan.input.vendor, "Rhode");
  assert.deepEqual((plan.input.variants as { price: string }[]).map((v) => v.price), ["3700.00", "3700.00"]);
  const mfs = plan.input.metafields as { namespace: string; key: string; value: string }[];
  assert.equal(mfs.find((m) => m.namespace === "custom" && m.key === "eta")?.value, "15–20 Days");
  for (const key of ["source_product_id", "source_url", "canonical_url", "source_price_usd", "exchange_rate", "converted_price_inr", "pricing_adjustment_inr", "fsr_selling_price", "category", "product_type", "source_last_seen_at", "source_status"]) {
    assert.ok(mfs.some((m) => m.namespace === "rhode_sync" && m.key === key), `missing rhode_sync.${key}`);
  }
  assert.equal(mfs.find((m) => m.key === "fsr_selling_price")?.value, "3700.00");
});

test("plan: ₹2,000 applied exactly once - an update prices from the Rhode USD price, never from the Shopify price", () => {
  const [g] = groupRhodeCatalog([product("peptide lip tint ribbon", { pdp: "peptide-lip-tint", id: 21, sku: "RHS00023-SC21", price: "22.00" })], settings).groups;
  const n = normalizeRhode(g, ctx0, settings);
  const e = existing(); // Shopify currently holds ₹3,700 from $20
  const row = { written_prices: JSON.stringify({ "RHS00023-SC21": "3700.00" }), price_hash: "old", source_skus: JSON.stringify(["RHS00023-SC21"]) } as never;
  const plan = buildRhodePlan({ n, existing: e, row, settings, prices: pricesFor(n, fx85, settings), fx: fx85, images: [], locationId: null, nowIso: "x" });
  assert.equal((plan.input.variants as { price: string }[])[0].price, (22 * 85 + 2000).toFixed(2)); // 3870, not 3700×85+2000 or 3700+2000
  // running the same plan again yields the same price (no drift / compounding)
  const again = buildRhodePlan({ n, existing: { ...e, variants: { nodes: [{ ...e.variants.nodes[0], price: "3870.00" }] } }, row: { ...(row as object), written_prices: JSON.stringify({ "RHS00023-SC21": "3870.00" }), price_hash: n.hashes.price } as never, settings, prices: pricesFor(n, fx85, settings), fx: fx85, images: [], locationId: null, nowIso: "x" });
  assert.equal((again.input.variants as { price: string }[])[0].price, "3870.00");
});

test("plan: sold-out shade becomes unorderable; all sold out -> DRAFT + oos tag; dropped shade kept, never deleted", () => {
  const [g] = groupRhodeCatalog([product("peptide lip tint ribbon", { pdp: "peptide-lip-tint", id: 21, sku: "RHS00023-SC21", available: false })], settings).groups;
  const n = normalizeRhode(g, ctx0, settings);
  const e = existing({ variants: { nodes: [...existing().variants.nodes, { id: "gid://shopify/ProductVariant/2", sku: "RHS00023-SC99", barcode: null, price: "3700.00", compareAtPrice: null, inventoryPolicy: "CONTINUE", selectedOptions: [{ name: "Shade", value: "Old" }], media: { nodes: [] } }] } });
  const row = { source_skus: JSON.stringify(["RHS00023-SC21", "RHS00023-SC99"]) } as never;
  const plan = buildRhodePlan({ n, existing: e, row, settings, prices: pricesFor(n, fx85, settings), fx: fx85, images: [], locationId: null, nowIso: "x" });
  const vs = plan.input.variants as { sku?: string; id?: string; inventoryPolicy?: string }[];
  assert.equal(vs.length, 2);
  assert.equal(vs[0].inventoryPolicy, "DENY");
  assert.equal(vs[1].id, "gid://shopify/ProductVariant/2");
  assert.equal(vs[1].inventoryPolicy, "DENY");
  assert.equal(plan.input.status, "DRAFT");
  assert.ok((plan.input.tags as string[]).includes(OOS_TAG));
});

test("plan: manual title / ETA edits are preserved; incompatible hand-made options are left for review", () => {
  const [g] = groupRhodeCatalog([product("peptide lip tint ribbon", { pdp: "peptide-lip-tint", id: 21, sku: "RHS00023-SC21" })], settings).groups;
  const n = normalizeRhode(g, ctx0, settings);
  const e = existing({ title: "Rhode Lip Tint (FSR edit)", eta: { value: "7 Days" } });
  const row = { written_title: "Rhode Peptide Lip Tint", written_eta: "15–20 Days", written_prices: JSON.stringify({ "RHS00023-SC21": "3700.00" }), price_hash: n.hashes.price } as never;
  const plan = buildRhodePlan({ n, existing: e, row, settings, prices: pricesFor(n, fx85, settings), fx: fx85, images: [], locationId: null, nowIso: "x" });
  assert.equal(plan.input.title, undefined);
  assert.ok(plan.notes.some((x) => /title edited in Shopify/.test(x)));
  assert.ok(!plan.metafields.some((m) => m.key === "eta"));
  const bad = existing({ variants: { nodes: [{ ...existing().variants.nodes[0], selectedOptions: [{ name: "Size", value: "M" }] }] } });
  assert.throws(() => buildRhodePlan({ n, existing: bad, row: undefined, settings, prices: pricesFor(n, fx85, settings), fx: fx85, images: [], locationId: null, nowIso: "x" }), PlanConflict);
});

test("plan: no valid exchange rate -> no new variants, existing prices untouched", () => {
  const [g] = groupRhodeCatalog([product("peptide lip tint ribbon", { pdp: "peptide-lip-tint", id: 21, sku: "RHS00023-SC21" }), product("peptide lip tint new", { pdp: "peptide-lip-tint", id: 23, sku: "RHS00023-SC23" })], settings).groups;
  const n = normalizeRhode(g, ctx0, settings);
  const noFx = { ...fx85, ok: false, rate: null };
  const plan = buildRhodePlan({ n, existing: existing(), row: undefined, settings, prices: pricesFor(n, noFx, settings), fx: noFx, images: [], locationId: null, nowIso: "x" });
  assert.equal(plan.pricesPaused, true);
  assert.equal(plan.deferredVariants, 1);
  assert.equal((plan.input.variants as { price: string }[])[0].price, "3700.00");
});
