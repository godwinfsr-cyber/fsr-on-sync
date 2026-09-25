import "./helpers/isolated-data.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { shopifyEnv } from "../src/config.ts";
import { BRAND_AUTHORIZATION, MICHAEL_KORS_AUTHORIZED_IMPORTER, mkEnvSettings, parseProfitBands, type MkSettings } from "../src/michaelkors/config.ts";
import { setMkSetting } from "../src/michaelkors/db.ts";
import { WATCH_SKIP_REASON, isExcludedMichaelKorsProduct, isWatchUrl } from "../src/michaelkors/exclusion.ts";
import { normalizeMk, sizeLabel, weightFromText } from "../src/michaelkors/normalize.ts";
import { ExcludedProduct, buildMkPlan } from "../src/michaelkors/plan.ts";
import { calculateMkPrice, profitFor } from "../src/michaelkors/pricing.ts";
import { parseMkLd, parseProductSitemap, parseSitemapIndex, styleFromUrl, type FeedEntry } from "../src/michaelkors/source.ts";
import { pricesFor, runMkSync } from "../src/michaelkors/sync.ts";

const settings: MkSettings = { ...mkEnvSettings(), FX_PROVIDER: "manual", MANUAL_EXCHANGE_RATE: 85, CATEGORY_WEIGHT_KG: "" }; // spec default bands
const fx85 = { ok: true, rate: 85, base: "USD", quote: "INR", provider: "manual", providerUpdatedAt: null, fetchedAt: "2026-09-26T00:00:00.000Z", origin: "manual" as const };
const FIXTURES = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "michaelkors-pages.json"), "utf8")) as (FeedEntry & { _note: string })[];
const page = (style: string) => {
  const f = FIXTURES.find((x) => styleFromUrl(x.url) === style);
  if (!f) throw new Error(`fixture ${style} missing`);
  return normalizeMk(parseMkLd(f.ld, f.url, f.canonical ?? null), settings);
};

// ---------- TEST 4: watch exclusion ----------

test("watch exclusion: spec examples by title", () => {
  const cases: [string, boolean][] = [
    ["Michael Kors Jet Set Medium Logo Shoulder Bag", false],
    ["Michael Kors Bradshaw Watch", true],
    ["Michael Kors Watch Charm", true],
    ["Michael Kors Wallet", false],
    ["Michael Kors Sneaker", false],
    ["Michael Kors Sunglasses", false],
    ["MK Watch", true],
    ["Lexington Chronograph Watch", true],
    ["Parker Pavé Watch", true],
    ["Access Gen 6 Smartwatch", true],
    ["Petite Timepiece Gift Set", true],
    ["Watch Hunger Stop Cotton Canvas Tote Bag", false], // charity campaign name, not a watch
    ["Watch Hunger Stop Organic Cotton T-Shirt", false],
    ["Parker Medium Leather Satchel", false],              // model names alone are not watches
  ];
  for (const [title, excluded] of cases) {
    const r = isExcludedMichaelKorsProduct({ title });
    assert.equal(r.excluded, excluded, title);
    if (excluded) assert.equal(r.status, "watch_excluded", title);
  }
});

test("watch exclusion: category level", () => {
  for (const category of ["Men > Watches", "Women > Watches > Smartwatches", "Women's Watches", "Timepieces", "Outlet > Watch Accessories"]) {
    const r = isExcludedMichaelKorsProduct({ title: "Runway Silver-Tone", category });
    assert.equal(r.level, "category", category);
  }
  assert.equal(isExcludedMichaelKorsProduct({ title: "Logo Tote", breadcrumbs: ["Women", "Watches", "Logo Tote"] }).level, "category");
  // a campaign category is not a watch category
  assert.equal(isExcludedMichaelKorsProduct({ title: "Logo Tote", breadcrumbs: ["Women", "Featured Shops", "Watch Hunger Stop", "Logo Tote"] }).excluded, false);
});

test("watch exclusion: URL level", () => {
  assert.equal(isWatchUrl("https://www.michaelkors.com/slim-runway-silver-tone-watch/MK3178.html"), true);
  assert.equal(isWatchUrl("https://www.michaelkors.com/gen-6-bradshaw-smartwatch/MKT5136.html"), true);
  assert.equal(isWatchUrl("https://www.michaelkors.com/women/watches/smartwatches/"), true);
  assert.equal(isWatchUrl("https://www.michaelkors.com/outlet/men/mens-watches/"), true);
  assert.equal(isWatchUrl("https://www.michaelkors.com/watch-hunger-stop-cotton-canvas-tote-bag/30H3GTVT7C.html"), false);
  assert.equal(isWatchUrl("https://www.michaelkors.com/kona-sunglasses/MK-1089.html"), false);
  assert.equal(isWatchUrl("https://www.michaelkors.com/women/featured-shops/watch-hunger-stop/"), false);
});

test("watch exclusion: data level uses watch-only specifications, not marketing mentions", () => {
  const spec = isExcludedMichaelKorsProduct({ title: "Runway Silver-Tone", description: "Stainless steel 42mm case Quartz 3-hand movement Water resistant up to 5 ATM" });
  assert.equal(spec.level, "specification");
  assert.equal(isExcludedMichaelKorsProduct({ title: "Jet Set Tote", description: "Pair it with your favourite watch. Water resistant canvas." }).excluded, false);
});

test("watch exclusion: real michaelkors.com pages", () => {
  assert.equal(page("MK3178").exclusion.status, "watch_excluded");       // Men > Watches
  assert.equal(page("MKO9016SET").exclusion.status, "watch_excluded");   // watch strap set under Outlet > Accessories
  assert.equal(page("MKT5136").exclusion.status, "watch_excluded");      // smartwatch under Accessories
  assert.equal(page("MKC1234").exclusion.status, "watch_excluded");      // watch charm
  for (const s of ["40R5KAHE6L", "32F1GJ6E7B", "MK-1089", "30H3GTVT7C", "30T0GTTS6B", "42F9KEFS1L", "MC57748"]) assert.equal(page(s).exclusion.excluded, false, s);
});

test("final safety check: the plan builder refuses to create or update a watch", () => {
  const n = page("MK3178");
  assert.throws(() => buildMkPlan({ n, existing: null, row: undefined, settings, prices: pricesFor(n, fx85, settings), fx: fx85, images: [], locationId: null, nowIso: "2026-09-26T00:00:00Z" }), (e) => e instanceof ExcludedProduct && e.status === "watch_excluded" && e.message.startsWith(WATCH_SKIP_REASON));
  // even if an upstream step missed it (exclusion field cleared), the plan's own re-check catches it
  const sneaky = { ...n, exclusion: { excluded: false, status: null, level: null, reason: null } };
  assert.throws(() => buildMkPlan({ n: sneaky, existing: null, row: undefined, settings, prices: pricesFor(n, fx85, settings), fx: fx85, images: [], locationId: null, nowIso: "x" }), ExcludedProduct);
});

test("other excluded categories are skipped (not watches)", () => {
  const r = isExcludedMichaelKorsProduct({ title: "Pour Femme Eau de Parfum", category: "Women > Fragrance" }, ["gift card", "fragrance"]);
  assert.equal(r.status, "skipped");
});

// ---------- authorization ----------

test("authorization: Michael Kors authorized importer config is on and scoped to Michael Kors", () => {
  assert.equal(MICHAEL_KORS_AUTHORIZED_IMPORTER, true);
  assert.equal(BRAND_AUTHORIZATION.brand, "Michael Kors");
  assert.equal(BRAND_AUTHORIZATION.importer, "Full Size Run");
  assert.equal(BRAND_AUTHORIZATION.territory, "India");
  assert.ok(BRAND_AUTHORIZATION.image_usage_authorized && BRAND_AUTHORIZATION.description_usage_authorized && BRAND_AUTHORIZATION.specification_usage_authorized);
  const n = page("32F1GJ6E7B");
  const plan = buildMkPlan({ n, existing: null, row: undefined, settings, prices: pricesFor(n, fx85, settings), fx: fx85, images: [], locationId: null, nowIso: "2026-09-26T00:00:00Z" });
  const files = plan.input.files as { originalSource?: string }[];
  assert.ok(files.length >= 2 && files.every((f) => f.originalSource?.startsWith("https://assets.michaelkors.com/")), "authorized images are imported");
  assert.ok(files.every((f) => f.originalSource?.includes("/ECOM_Image_Zoom/")), "highest-resolution rendition");
  assert.match(String(plan.input.descriptionHtml), /Logoprint canvas/, "authorized description is imported");
  assert.ok(!plan.notes.some((x) => /copyright|NOT uploaded/i.test(x)), "no copyright blocker");
});

// ---------- parsing + normalisation ----------

test("normalize: women's boot US sizes -> UK (US - 2), SKUs, type, availability", () => {
  const n = page("40R5KAHE6L");
  assert.equal(n.title, "Michael Kors Kasia Leather Boot");
  assert.equal(n.productType, "Sneakers");
  assert.equal(n.gender, "Women");
  assert.deepEqual(n.sizeOrder, ["3", "3.5", "4", "5"]);
  assert.deepEqual(n.variants.map((v) => v.sku), ["40R5KAHE6L-001-3", "40R5KAHE6L-001-3.5", "40R5KAHE6L-001-4", "40R5KAHE6L-001-5"]);
  assert.equal(n.variants[0].availability, "out_of_stock");
  assert.equal(n.availability, "in_stock");
  assert.equal(n.colours[0].currentUsd, 169);
});

test("normalize: men's sneaker US -> UK (US - 0.5); wallet colours; clothing; sunglasses type", () => {
  assert.deepEqual(page("42F9KEFS1L").sizeOrder, ["8.5", "10"]);
  const w = page("32F1GJ6E7B");
  assert.equal(w.productType, "Wallets");
  assert.deepEqual(w.colours.map((c) => c.colour), ["Vanilla", "Brown"]);
  assert.deepEqual(w.variants.map((v) => v.sku), ["32F1GJ6E7B-150", "32F1GJ6E7B-200"]);
  const j = page("MC57748");
  assert.equal(j.productType, "Apparel");
  assert.equal(j.channel, "Outlet");
  assert.deepEqual(j.colours.map((c) => [c.colour, c.currentUsd]), [["Black", 299], ["Midnight", 279]]);
  assert.equal(page("MK-1089").productType, "Accessories");
  assert.equal(page("30H3GTVT7C").productType, "Bags");
  assert.equal(sizeLabel("NS", false, null).size, "One Size");
  assert.equal(sizeLabel("3_dot_0", true, "Kids").size, "US 3");
  assert.equal(sizeLabel("L_fslash_XL", false, "Women").size, "L/XL");
  assert.equal(sizeLabel("L fslash XL", false, "Women").size, "L/XL");
  assert.equal(sizeLabel("10_dot_5", true, "Women").size, "8.5");
});

test("discovery: sitemap parsing drops language mirrors and merges duplicate listings of one style", () => {
  const idx = `<sitemapindex><sitemap><loc>https://www.michaelkors.com/sitemap_0-product.xml</loc></sitemap><sitemap><loc>https://www.michaelkors.com/sitemap_1-image.xml</loc></sitemap></sitemapindex>`;
  assert.deepEqual(parseSitemapIndex(idx), ["https://www.michaelkors.com/sitemap_0-product.xml"]);
  const sm = ["https://www.michaelkors.com/kasia-leather-boot/40R5KAHE6L.html", "https://www.michaelkors.com/us/es/bota-kasia/40R5KAHE6L.html",
    "https://www.michaelkors.com/kasia-leather-boot-sale/40R5KAHE6L.html", "https://www.michaelkors.com/kona-sunglasses/MK-1089.html"].map((u) => `<url><loc>${u}</loc></url>`).join("");
  const r = parseProductSitemap(`<urlset>${sm}</urlset>`);
  assert.deepEqual(r.urls.map((u) => u.style), ["40R5KAHE6L", "MK-1089"]);
  assert.equal(r.duplicates, 1);
});

// ---------- pricing (unchanged rules) ----------

const price = (usd: number, kg: number | null, rate = 85, st: MkSettings = settings) => calculateMkPrice({ currentUsd: usd, regularUsd: null, currency: "USD", weightKg: kg }, { ok: true, rate, base: "USD" }, st);

test("pricing: spec products A-D at ₹85", () => {
  const cases: [string, number, number, number, number, number, number, number][] = [
    // name, usd, kg, converted, shipping, landed, profit, final
    ["A", 100, 0.5, 8500, 1000, 9500, 1500, 11000],
    ["B", 200, 1.5, 17000, 2500, 19500, 2000, 21500],
    ["C", 500, 3.5, 42500, 4250, 46750, 3500, 50250],
    ["D", 700, 5.5, 59500, 5000, 64500, 4000, 68500],
  ];
  for (const [name, usd, kg, conv, ship, landed, profit, final] of cases) {
    const p = price(usd, kg);
    assert.equal(p.sourcePriceUsd, usd, name);
    assert.equal(p.convertedPriceInr, conv, name);
    assert.equal(p.weight.surchargeInr, ship, name);
    assert.equal(p.landedCostInr, landed, name);
    assert.equal(p.profitInr, profit, name);
    assert.equal(p.fsrPrice, final, name);
  }
});

test("pricing: shipping band boundaries (₹1,000–₹5,000) and unknown-weight fallback ₹2,500", () => {
  const b: [number, number][] = [[0.5, 1000], [0.51, 1500], [1.0, 1500], [1.01, 2500], [2.0, 2500], [2.01, 3500], [3.0, 3500], [3.01, 4250], [5.0, 4250], [5.01, 5000], [40, 5000]];
  for (const [kg, inr] of b) assert.equal(price(100, kg).weight.surchargeInr, inr, `${kg} kg`);
  const u = price(100, null);
  assert.equal(u.weight.weightKg, null);
  assert.equal(u.weight.surchargeInr, 2500);
  assert.equal(u.weight.reason, "weight_unknown_fallback");
});

test("pricing: profit band boundaries on landed cost (₹1,000–₹4,000)", () => {
  const b: [number, number][] = [[1, 1000], [5000, 1000], [5001, 1500], [10000, 1500], [10001, 2000], [20000, 2000], [20001, 3000], [35000, 3000], [35001, 3500], [50000, 3500], [50001, 4000], [900000, 4000]];
  for (const [landed, profit] of b) assert.equal(profitFor(landed, settings.PROFIT_BANDS).profitInr, profit, `₹${landed}`);
  assert.throws(() => parseProfitBands("5000:1000"), /open-ended/);
});

test("pricing: final price rounded to the nearest rupee (converted / landed values stay exact)", () => {
  const p = calculateMkPrice({ currentUsd: 138, regularUsd: null, currency: "USD", weightKg: null }, { ok: true, rate: 96.015075, base: "USD" }, settings);
  assert.equal(settings.PRICE_ROUNDING_MODE, "NEAREST_1");
  assert.equal(p.convertedPriceInr!.toFixed(2), "13250.08");
  assert.equal(p.fsrPrice, 17750); // 13,250.08 + 2,500 + 2,000 = 17,750.08 -> ₹17,750
  assert.equal(calculateMkPrice({ currentUsd: 179, regularUsd: null, currency: "USD", weightKg: null }, { ok: true, rate: 96.015075, base: "USD" }, settings).fsrPrice, 21687); // 21,686.70 -> 21,687
});

test("pricing: no double shipping / profit - repeated runs give the same price", () => {
  const first = price(200, 1.5).fsrPrice;
  const second = price(200, 1.5).fsrPrice;
  assert.equal(first, 21500);
  assert.equal(second, 21500);
  // the engine only ever takes the SOURCE USD price as input; there is no previous-FSR-price input to compound
  assert.equal(calculateMkPrice.length, 3);
});

test("pricing: exchange-rate and source-price changes recalculate from source", () => {
  const p86 = price(200, 1.5, 86);
  assert.deepEqual([p86.convertedPriceInr, p86.landedCostInr, p86.profitInr, p86.fsrPrice], [17200, 19700, 2000, 21700]);
  const p250 = price(250, 1.5);
  assert.deepEqual([p250.convertedPriceInr, p250.landedCostInr, p250.profitInr, p250.fsrPrice], [21250, 23750, 3000, 26750]);
  assert.equal(calculateMkPrice({ currentUsd: 100, regularUsd: null, currency: "USD", weightKg: null }, { ok: false, rate: null, base: "USD" }, settings).ok, false, "no rate -> paused, never guessed");
});

test("pricing: sale - current selling price is the source price, regular price preserved, no extra promo discount", () => {
  const p = calculateMkPrice({ currentUsd: 329, regularUsd: 399.5, currency: "USD", weightKg: 1 }, fx85, settings);
  assert.equal(p.sourcePriceUsd, 329);
  assert.equal(p.sourceRegularPriceUsd, 399.5);
  assert.equal(p.sourceSalePriceUsd, 329);
  assert.equal(p.fsrPrice, 329 * 85 + 1500 + 3000);
  const ld = [{ "@type": "Product", "@id": "https://www.michaelkors.com/x-bag/ABC123.html", name: "X Bag", category: "Women > Sale > Handbags", color: "BLACK", size: "NS",
    offers: [{ price: 329, priceCurrency: "USD", availability: "https://schema.org/InStock", priceSpecification: [{ "@type": "UnitPriceSpecification", priceType: "https://schema.org/StrikethroughPrice", price: 399.5 }] }] }];
  const n = normalizeMk(parseMkLd(ld, "https://www.michaelkors.com/x-bag/ABC123.html", null), settings);
  assert.equal(n.colours[0].currentUsd, 329);
  assert.equal(n.colours[0].regularUsd, 399.5);
  assert.equal(n.sourceChannel, "sale");
  assert.equal(n.variants[0].sourceAvailability, "InStock");
});

test("weight: only an explicitly stated weight is used", () => {
  assert.equal(weightFromText("Leather Weight: 1.2 kg Imported"), 1.2);
  assert.equal(weightFromText("Weight 540g"), 0.54);
  assert.equal(weightFromText("Weight: 2 lbs"), 0.907);
  assert.equal(weightFromText("15W X 145H X 45D Handle drop 95"), null);
  assert.equal(page("40R5KAHE6L").weightKg, null);
});

test("plan: create writes ETA 15–20 Days, michael_kors_sync pricing metafields and import_status=imported", () => {
  const n = page("40R5KAHE6L");
  const plan = buildMkPlan({ n, existing: null, row: undefined, settings, prices: pricesFor(n, fx85, settings), fx: fx85, images: [], locationId: null, nowIso: "2026-09-26T00:00:00Z" });
  const mf = new Map((plan.input.metafields as { namespace: string; key: string; value: string }[]).map((m) => [`${m.namespace}.${m.key}`, m.value]));
  assert.equal(mf.get("custom.eta"), "15–20 Days");
  assert.equal(mf.get("michael_kors_sync.import_status"), "imported");
  assert.equal(mf.get("michael_kors_sync.source_product_id"), "40R5KAHE6L");
  for (const k of ["source_price_usd", "source_regular_price_usd", "exchange_rate", "exchange_rate_timestamp", "converted_price_inr", "shipping_adjustment_inr", "landed_cost_inr", "profit_adjustment_inr", "fsr_selling_price"]) assert.ok(mf.has(`michael_kors_sync.${k}`), k);
  assert.equal(mf.get("michael_kors_sync.fsr_selling_price"), (169 * 85 + 2500 + 2000).toFixed(2)); // ₹14,365 + ₹2,500 (weight unknown) + ₹2,000
  assert.equal(mf.get("michael_kors_sync.shipping_adjustment_reason"), "weight_unknown_fallback");
  assert.equal(mf.get("michael_kors_sync.source_channel"), "regular");
  assert.equal(plan.input.vendor, "Michael Kors");
  assert.ok(!(plan.input.tags as string[]).includes("Instant Ship"));
  assert.equal((plan.input.variants as { inventoryPolicy: string }[])[0].inventoryPolicy, "DENY"); // sold-out size is not orderable
});

// ---------- TEST 1/2/3 (offline) + duplicate + removal safety: full pipeline in feed mode, dry run ----------

function feedDir(entries: FeedEntry[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk-feed-"));
  fs.writeFileSync(path.join(dir, "feed.json"), JSON.stringify(entries));
  return dir;
}

test("pipeline (dry run, feed): eligible products planned once, watches logged WATCH_EXCLUDED, sale+regular = ONE product, unreliable scan aborts cleanup", async () => {
  shopifyEnv.accessToken = ""; shopifyEnv.clientId = ""; shopifyEnv.clientSecret = ""; // offline: never touch the live store from tests
  const boot = FIXTURES.find((f) => f.url.includes("40R5KAHE6L"))!;
  const saleCopy = { ...boot, url: "https://www.michaelkors.com/kasia-leather-boot-sale/40R5KAHE6L.html" }; // same style listed on a sale route
  setMkSetting("SOURCE_MODE", "feed");
  setMkSetting("FEED_DIR", feedDir([...FIXTURES, saleCopy]));
  setMkSetting("FX_PROVIDER", "manual");
  setMkSetting("MANUAL_EXCHANGE_RATE", 85);

  const five = await runMkSync({ dryRun: true, limit: 5 });
  assert.equal(five.counts.created, 5, "TEST 1: 5 eligible products");

  const s = await runMkSync({ dryRun: true });
  assert.equal(s.status, "success");
  assert.equal(s.counts.created, 7, "7 eligible styles");
  assert.equal(s.counts.watchExcluded, 4, "4 watch products excluded");
  assert.equal(s.products.filter((p) => p.style === "40R5KAHE6L").length, 1, "sale + regular listing -> ONE product");
  assert.ok(s.products.filter((p) => p.outcome === "watch_excluded").every((p) => !p.planned), "nothing planned for watches");
  assert.ok(s.warnings.some((w) => w.startsWith("SOURCE_SCAN_UNRELIABLE")), "7 styles < MIN_CATALOG_SIZE -> cleanup aborted");
  assert.equal(s.counts.archived, 0);
});

// ---------- in-app browser harvest: page extras + feed import ----------

test("page extras: Details section becomes the description (exact figures), Was/Now price applies to the colour selling at Now", async () => {
  const boot = FIXTURES.find((f) => f.url.includes("40R5KAHE6L"))!;
  const details = `<div class="product-details-tabs__item"><p>No other boot balances texture and shine quite like the Kasia.</p></div><div class="product-details-tabs__item"><p> • Boot <br>• Leather <br>• Heel height: 3.5" <br>• Weight: 0.9 kg <br>• Imported <br> • Style # 40R5KAHE6L </p></div>`;
  const n = normalizeMk(parseMkLd(boot.ld, boot.url, boot.canonical ?? null, { detailsHtml: details, listPrice: 338, salePrice: 169 }), settings);
  assert.match(n.descriptionHtml, /Heel height: 3\.5"/);
  assert.doesNotMatch(n.descriptionHtml, /Style #/);
  assert.equal(n.weightKg, 0.9);
  assert.equal(n.weightSource, "specification");
  assert.equal(n.colours[0].regularUsd, 338);
  assert.equal(n.sourceChannel, "sale");
  const p = pricesFor(n, fx85, settings).get(n.colours[0].colour)!;
  assert.equal(p.sourcePriceUsd, 169);
  assert.equal(p.sourceRegularPriceUsd, 338);
  assert.equal(p.weight.surchargeInr, 1500); // 0.9 kg band
});

test("feed import: a complete harvest replaces the feed; an incomplete one is kept aside", async () => {
  const { importBrowserHarvest } = await import("../src/michaelkors/feed-import.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk-feed-import-"));
  const saved = (manifest: object) => {
    const f = path.join(dir, `result-${Math.random().toString(36).slice(2)}.txt`);
    const payload = JSON.stringify({ manifest, entries: FIXTURES.slice(0, 3) });
    fs.writeFileSync(f, JSON.stringify([{ type: "text", text: `${JSON.stringify(payload)}\n\n(captured at origin https://michaelkors.com)` }, { type: "text", text: "\n\nTab Context: ..." }]));
    return f;
  };
  const feed = path.join(dir, "feed");
  const ok = importBrowserHarvest(saved({ run: "H1", harvestedAt: new Date().toISOString(), complete: true, listed: 3, fetched: 3, failed: 0, watchUrls: 0, entries: 3 }), feed);
  assert.equal(ok.applied, true);
  assert.ok(fs.existsSync(path.join(feed, "manifest.json")) && fs.existsSync(path.join(feed, "part-00000.json")));
  const partial = importBrowserHarvest(saved({ run: "H2", harvestedAt: new Date().toISOString(), complete: false, listed: 3, fetched: 1, failed: 2, watchUrls: 0, entries: 1 }), feed);
  assert.equal(partial.applied, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(feed, "manifest.json"), "utf8")).run, "H1", "previous complete feed kept");
});

test("sold-out sizes with priceCurrency N/A do not block pricing", () => {
  const ld = [{ "@type": "ProductGroup", "@id": "https://www.michaelkors.com/fulton-moccasin/49T8FUFR1L.html", name: "Fulton Moccasin", category: "Women > Shoes > Flats", image: [],
    hasVariant: [
      { "@type": "Product", sku: "1", color: "BLACK", size: "5_dot_0", offers: { priceCurrency: "N/A", availability: "https://schema.org/OutOfStock" } },
      { "@type": "Product", sku: "2", color: "BLACK", size: "6_dot_0", offers: { priceCurrency: "USD", price: 128, availability: "https://schema.org/InStock" } },
    ] }];
  const n = normalizeMk(parseMkLd(ld, "https://www.michaelkors.com/fulton-moccasin/49T8FUFR1L.html", null), settings);
  assert.equal(n.colours[0].currency, "USD");
  assert.equal(pricesFor(n, fx85, settings).get("Black")!.ok, true);
});
