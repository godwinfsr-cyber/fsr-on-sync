import "./helpers/isolated-data.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildProduct, NotImportable, priceVariant, productTypeOf, ukShoeSize } from "../src/coach/catalog.ts";
import { coachSettings, COACH_PRICING_DEFAULTS } from "../src/coach/config.ts";
import { dedupeListings, StoreIndex } from "../src/coach/dedupe.ts";
import { isExcludedCoachProduct, isExcludedCoachWatch, isWatchUrl } from "../src/coach/exclusion.ts";
import { galleryFor } from "../src/coach/images.ts";
import { normalizeUrl, parseEntry, parseVariantId, type FeedEntry } from "../src/coach/normalize.ts";

// real coach.com pages captured by harvest.browser.js on 2026-09-26
const PAGES = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "coach-pages.json"), "utf8")) as FeedEntry[];
const page = (style: string) => PAGES.find((p) => p.url.endsWith(`/${style}.html`))!;
const s = { ...coachSettings({}), FX_PROVIDER: "manual" as const, MANUAL_EXCHANGE_RATE: 95 };
const fx95 = { ok: true, rate: 95, base: "USD", quote: "INR", provider: "manual", providerUpdatedAt: null, fetchedAt: "2026-09-26T00:00:00.000Z", origin: "manual" as const };
const noProbe = async () => false;

// ---------- watch exclusion (hard rule) ----------
test("watches, watch straps, Apple Watch bands and watch gift sets are excluded at every level", () => {
  for (const u of [
    "https://www.coach.com/products/mini-liz-watch-24mm/C3620.html",
    "https://www.coach.com/products/apple-watch-strap-38mm-40mm-and-41mm/CAY97.html",
    "https://www.coach.com/products/ruby-watch-gift-set-32mm/CAY94.html",
    "https://www.coach.com/products/outlet/olivia-watch-34mm/CAZ01.html",
  ]) assert.equal(isWatchUrl(u), true, u);
  const hit = (x: Parameters<typeof isExcludedCoachWatch>[0]) => isExcludedCoachWatch(x);
  assert.equal(hit({ title: "Olivia Watch, 34 Mm" }).level, "title");
  assert.equal(hit({ title: "Strap For Apple Watch®, 38 Mm, 40 Mm And 41 Mm" }).excluded, true);
  assert.equal(hit({ title: "Leather Band", subcategory: "Watches" }).level, "category");
  assert.equal(hit({ title: "Band", categoryId: "women-watches" }).excluded, true);
  assert.equal(hit({ title: "Gift Set", breadcrumbs: ["Women", "Watches"] }).level, "breadcrumb");
  assert.equal(hit({ title: "Item", productType: "Watches" }).level, "product_type");
  assert.equal(hit({ title: "Item", tags: ["Smart Watches"] }).level, "tags");
  assert.equal(hit({ title: "Item", description: "Quartz movement. Water resistant to 30 m. 34 mm case." }).level, "specification");
});

test("non-watches are not excluded: jewelry in 'Jewelry & Watches', bag straps, 'Watch Hunger Stop'", () => {
  const bangle = parseEntry(page("CAD63"))[0];
  assert.equal(bangle.category, "Women > Accessories > Jewelry & Watches");
  assert.equal(isExcludedCoachWatch({ title: bangle.name, category: bangle.category, subcategory: bangle.subcategory, url: bangle.sourceUrl }).excluded, false);
  assert.equal(isExcludedCoachWatch({ title: "Short Chunky Curb Chain Strap" }).excluded, false);
  assert.equal(isExcludedCoachWatch({ title: "Watch Hunger Stop Tote" }).excluded, false);
  assert.equal(isExcludedCoachWatch({ title: "Tabby Shoulder Bag 26", url: "https://www.coach.com/products/tabby-shoulder-bag-26/CM546.html" }).excluded, false);
});

test("buildProduct refuses a watch even if it slipped through discovery (final safety check)", () => {
  const item = { ...dedupeListings(parseEntry(page("CAD63"))).items[0], name: "Mini Liz Watch, 24 Mm" };
  assert.throws(() => buildProduct(item, [], fx95, s, "2026-09-26T00:00:00Z", null), (e: unknown) => e instanceof NotImportable && e.status === "watch_excluded");
});

test("Restored (pre-owned) items are skipped by default; Remade items are not", () => {
  assert.equal(isExcludedCoachProduct({ title: "Restored Rogue Bag With Leather Sequins" }).level, "restored");
  assert.equal(isExcludedCoachProduct({ title: "Remade Colorblock Valet Tray", category: "Coach (Re)Loved" }).excluded, false);
  assert.equal(isExcludedCoachProduct({ title: "Restored Rogue Bag" }, { includeRestored: true }).excluded, false);
  assert.equal(isExcludedCoachProduct({ title: "Coach Dreams Eau De Parfum 90ml" }, { excludedCategories: s.EXCLUDED_CATEGORIES.split(",") }).level, "excluded_category");
});

// ---------- parsing ----------
test("fixed-width Coach variant ids", () => {
  assert.deepEqual(parseVariantId("CDE37 YNL  7   B"), { style: "CDE37", colour: "YNL", size: "7", width: "B" });
  assert.deepEqual(parseVariantId("CV933 IMXAQ"), { style: "CV933", colour: "IMXAQ", size: null, width: null });
  assert.deepEqual(parseVariantId("923   MPL"), { style: "923", colour: "MPL", size: null, width: null });
  assert.deepEqual(parseVariantId("CA566 BK/GE"), { style: "CA566", colour: "BK/GE", size: null, width: null });
  assert.deepEqual(parseVariantId("CAA57 BLK  M/L"), { style: "CAA57", colour: "BLK", size: "M/L", width: null });
  assert.deepEqual(parseVariantId("CDS58-B4%2FBK"), { style: "CDS58", colour: "B4/BK", size: null, width: null });
});

test("a page's other style numbers are NOT given the page's name (they are different products)", () => {
  const ls = parseEntry(page("41892"));
  const own = ls.filter((l) => l.ownPage);
  const other = ls.filter((l) => !l.ownPage);
  assert.ok(own.length >= 1 && own.every((l) => l.style === "41892"));
  assert.ok(other.length >= 1, "the alligator Rogue page also lists other styles");
  const items = dedupeListings(ls).items;
  assert.ok(items.filter((i) => i.style !== "41892").every((i) => i.orphan), "other styles wait for their own page");
});

test("UK shoe sizes (store rule): women's US-2, men's US-0.5, unknown gender is never guessed", () => {
  assert.equal(ukShoeSize("7", "Women"), "5");
  assert.equal(ukShoeSize("9.5", "Men"), "9");
  assert.equal(ukShoeSize("7", null), null);
  const slide = dedupeListings(parseEntry(page("CAF13"))).items[0];
  assert.equal(productTypeOf(slide), "Shoes");
  const b = buildProduct(slide, [], fx95, s, "2026-09-26T00:00:00Z", null);
  const sizes = (b.input.variants as { optionValues: { name: string }[]; sku: string }[]).map((v) => v.optionValues[0].name);
  assert.deepEqual(sizes, ["3", "4", "5", "6", "7", "8", "9"]);
  assert.match((b.input.variants as { sku: string }[])[0].sku, /^CAF13-BLK-3$/);
  assert.match(String(b.input.descriptionHtml), /Sizes are UK sizing/);
});

// ---------- dedupe ----------
test("the same product on mainline and Outlet URLs becomes ONE product with both URLs", () => {
  const main = page("72450");
  const outlet: FeedEntry = { ...main, url: main.url.replace("/products/", "/products/outlet/"), canonical: main.canonical?.replace("/products/", "/products/outlet/") ?? null };
  const r = dedupeListings([...parseEntry(main), ...parseEntry(outlet)]);
  const it = r.items.find((i) => i.key === "72450-B4OH1")!;
  assert.equal(r.items.filter((i) => i.key === "72450-B4OH1").length, 1);
  assert.equal(it.listings, 2);
  assert.ok(it.mainlineUrls.length && it.outletUrls.length);
  assert.ok(r.duplicates >= 1);
});

test("shared GTIN merges listings even under different references; URLs normalize across mainline/outlet/tracking", () => {
  const [a] = parseEntry(page("CAD63"));
  const b = { ...a, key: "ZZ999-SLV", style: "ZZ999", colourCode: "SLV", ownPage: false, variants: a.variants.map((v) => ({ ...v, sourceSku: "ZZ999 SLV" })) };
  const r = dedupeListings([a, b]);
  assert.equal(r.items.length, 1);
  assert.equal(r.byReason.gtin, 1);
  assert.equal(normalizeUrl("https://www.coach.com/products/outlet/teri/CV933-IMXAQ.html?utm_source=x"), normalizeUrl("/products/teri/CV933.html"));
});

test("Shopify duplicate check: source id, SKU family (US or UK size suffix), barcode, title", () => {
  const idx = new StoreIndex();
  idx.add({ id: "gid://shopify/Product/1", title: "Coach Archival Buckle Clog - Oat (Women's)", status: "ACTIVE", vendor: "Coach", sourceProductId: "CCO05-OAT", sourceUrl: null, skus: ["CCO05-OAT-5", "CCO05-OAT-6"], barcodes: ["196395990016"] });
  const v = [{ sourceSku: "x", size: null, width: null, gtin: null, priceUsd: 1, currency: "USD", inStock: true }];
  assert.equal(idx.match({ key: "CCO05-OAT", variants: v, canonicalUrl: null, colourCode: "OAT" }, "x")?.by, "source_product_id");
  const idx2 = new StoreIndex();
  idx2.add({ id: "2", title: "t", status: "ACTIVE", vendor: "Coach", sourceProductId: null, sourceUrl: null, skus: ["CCO05-OAT-5"], barcodes: ["196395990016"] });
  assert.equal(idx2.match({ key: "CCO05-OAT", variants: v, canonicalUrl: null, colourCode: "OAT" }, "x")?.by, "sku");
  assert.equal(idx2.match({ key: "NEW01-OAT", variants: [{ ...v[0], gtin: "00196395990016" }], canonicalUrl: null, colourCode: "OAT" }, "x")?.by, "gtin");
  // same title under a different Coach style number is a different product; title only matches id-less listings
  assert.equal(idx2.match({ key: "NEW01-OAT", variants: v, canonicalUrl: null, colourCode: "OAT" }, "t")?.by, undefined);
  idx2.add({ id: "3", title: "Coach Hand Listed Bag - Black", status: "ACTIVE", vendor: "Coach", sourceProductId: null, sourceUrl: null, skus: ["COACH-OS"], barcodes: [] });
  assert.equal(idx2.match({ key: "NEW02-BLK", variants: v, canonicalUrl: null, colourCode: "BLK" }, "Coach Hand Listed Bag - Black")?.by, "title_colour");
  assert.equal(idx2.match({ key: "NEW01-OAT", variants: v, canonicalUrl: null, colourCode: "OAT" }, "other")?.by, undefined);
});

// ---------- pricing ----------
test("pricing: USD x rate + weight-band shipping (fallback ₹2,500) + profit band on landed cost; compare-at = regular x rate only", () => {
  assert.equal(COACH_PRICING_DEFAULTS.WEIGHT_BANDS, "0.5:1000,1:1500,2:2500,3:3500,5:4250,+:5000");
  // Teri: $219 sale, $295 regular. 219 x 95 = 20,805 + 2,500 = 23,305 landed -> ₹3,000 band -> 26,305
  const p = priceVariant(219, 295, "USD", fx95, s);
  assert.equal(p.convertedPriceInr, 20805);
  assert.equal(p.weight.surchargeInr, 2500);
  assert.equal(p.landedCostInr, 23305);
  assert.equal(p.profitInr, 3000);
  assert.equal(p.fsrPrice, 26305);
  assert.equal(p.compareAtPrice, 28025); // 295 x 95, no shipping / profit
  assert.equal(p.sourceSalePriceUsd, 219);
  // band edges: landed exactly 5,000 -> ₹1,000; 5,001 -> ₹1,500
  assert.equal(priceVariant(2500 / 95, null, "USD", fx95, s).profitInr, 1000);
  assert.equal(priceVariant(2501 / 95, null, "USD", fx95, s).profitInr, 1500);
  // no compare-at when the converted regular price is not above the FSR price
  assert.equal(priceVariant(95, 100, "USD", fx95, s).compareAtPrice, null);
  // never guesses a rate
  assert.equal(priceVariant(100, null, "USD", { ok: false, rate: null, base: "USD" }, s).ok, false);
  assert.throws(() => buildProduct(dedupeListings(parseEntry(page("CAD63"))).items[0], [], { ...fx95, ok: false, rate: null, reason: "down" }, s, "x", null), (e: unknown) => e instanceof NotImportable && e.status === "pricing_error");
});

test("product: ETA metafield, coach_sync ids, compare-at, barcode, ACTIVE only when Coach has stock", async () => {
  const item = dedupeListings(parseEntry(page("CAD63"))).items[0];
  const imgs = await galleryFor(item, s, noProbe);
  assert.ok(imgs.length >= 1 && imgs.every((i) => /coach\.scene7\.com\/is\/image\/Coach\/cad63_slv_a\d+\?wid=2400/.test(i.url)));
  const b = buildProduct(item, imgs, fx95, s, "2026-09-26T00:00:00Z", null);
  const mf = b.input.metafields as { namespace: string; key: string; value: string }[];
  assert.equal(mf.find((m) => m.namespace === "custom" && m.key === "eta")?.value, "15–20 Days");
  assert.equal(mf.find((m) => m.key === "source_product_id")?.value, "CAD63-SLV");
  assert.equal(mf.find((m) => m.key === "source_style_number")?.value, "CAD63");
  assert.equal(b.title, "Coach Signature Pavé Hinged Bangle - Silver (Women's)");
  const v = (b.input.variants as { sku: string; barcode?: string; compareAtPrice: string | null }[])[0];
  assert.equal(v.sku, "CAD63-SLV");
  assert.ok(v.barcode && /^\d{12,14}$/.test(v.barcode));
  assert.ok(Number(v.compareAtPrice) > Number(b.cheapest!.fsrPrice));
  assert.equal(b.productType, "Jewelry");
});
