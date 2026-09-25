import "./helpers/isolated-data.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { shopifyEnv } from "../src/config.ts";
import { BRAND_AUTHORIZATION, TB_PRICING_DEFAULTS, TORY_BURCH_AUTHORIZED_IMPORTER, tbEnvSettings, type TbSettings } from "../src/toryburch/config.ts";
import { setTbSetting } from "../src/toryburch/db.ts";
import { WATCH_EXCLUDED_CODE, WATCH_SKIP_REASON, isExcludedToryBurchProduct, isExcludedToryBurchWatch, isWatchUrl } from "../src/toryburch/exclusion.ts";
import { normalizeTb } from "../src/toryburch/normalize.ts";
import { ExcludedProduct, TBNS, buildTbPlan } from "../src/toryburch/plan.ts";
import { calculateMkPrice, profitFor } from "../src/michaelkors/pricing.ts";
import { parseProductSitemap, parseSitemapIndex, parseTbPage, styleFromUrl, upscaleImage } from "../src/toryburch/source.ts";
import { pricesFor, runTbSync } from "../src/toryburch/sync.ts";

const settings: TbSettings = { ...tbEnvSettings({}), FX_PROVIDER: "manual", MANUAL_EXCHANGE_RATE: 85, CATEGORY_WEIGHT_KG: "" };
const fx85 = { ok: true, rate: 85, base: "USD", quote: "INR", provider: "manual", providerUpdatedAt: null, fetchedAt: "2026-09-26T00:00:00.000Z", origin: "manual" as const };
type Fixture = { _note: string; url: string; canonical: string; ld: Record<string, unknown>[]; flight: string };
const FIXTURES = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "toryburch-pages.json"), "utf8")) as Fixture[];
const fixture = (style: string) => {
  const f = FIXTURES.find((x) => styleFromUrl(x.url) === style);
  if (!f) throw new Error(`fixture ${style} missing`);
  return f;
};
const page = (style: string) => { const f = fixture(style); return normalizeTb(parseTbPage(f.ld, f.flight, f.url, f.canonical), settings); };
const offline = () => { shopifyEnv.accessToken = ""; shopifyEnv.clientId = ""; shopifyEnv.clientSecret = ""; }; // tests never touch the live store

// ---------- 6. critical acceptance: watch exclusion ----------

test("watch exclusion: spec examples by title", () => {
  const cases: [string, boolean][] = [
    ["Tory Burch Watch", true],
    ["Tory Burch Kira Watch", true],
    ["Tory Burch Miller Watch", true],
    ["Tory Burch Small Miller Watch", true],
    ["Tory Burch Apple Watch Band", true],
    ["T Double Wrap Band for Apple Watch", true],
    ["Tory Burch Watch Strap", true],
    ["Eleanor Smartwatch", true],
    ["Kira Timepiece Gift Set", true],
    ["Tory Burch Kira Handbag", false],
    ["Tory Burch Miller Sandal", false],
    ["Tory Burch Wallet", false],
    ["Tory Burch Dress", false],
    ["Tory Burch Sunglasses", false],
    ["Mellow T-Strap Sandal", false],      // a strap sandal is not a watch strap
    ["Studded Headband", false],           // a headband is not a watch band
    ["Ines Single Band Slide", false],
    ["Bandage Skirt", false],
  ];
  for (const [title, excluded] of cases) {
    const r = isExcludedToryBurchWatch({ title });
    assert.equal(r.excluded, excluded, title);
    if (excluded) assert.equal(r.status, "watch_excluded", title);
  }
});

test("watch exclusion: every level on its own (category, breadcrumb, collection, URL, structured data, specs)", () => {
  const neutral = "Eleanor"; // a model name that is also used for bags
  assert.equal(isExcludedToryBurchWatch({ title: neutral, department: "Watches" }).level, "category");
  assert.equal(isExcludedToryBurchWatch({ title: neutral, productClass: "Smart Watches" }).level, "category");
  assert.equal(isExcludedToryBurchWatch({ title: neutral, productClass: "Apple Watch Bands" }).level, "category");
  assert.equal(isExcludedToryBurchWatch({ title: neutral, subclass: "Watch Straps" }).level, "category");
  assert.equal(isExcludedToryBurchWatch({ title: neutral, productType: "Timepieces" }).level, "category");
  assert.equal(isExcludedToryBurchWatch({ title: neutral, breadcrumbs: ["Watches"] }).level, "breadcrumb");
  assert.equal(isExcludedToryBurchWatch({ title: neutral, collection: "watches-smart-watches" }).level, "breadcrumb");
  assert.equal(isExcludedToryBurchWatch({ title: neutral, category: "Accessories > Watch Accessories" }).level, "structured_data");
  assert.equal(isExcludedToryBurchWatch({ title: neutral, url: "https://www.toryburch.com/en-us/watches/strap-watches/eleanor/TBW1066.html" }).level, "url");
  assert.equal(isExcludedToryBurchWatch({ title: neutral, canonicalUrl: "https://www.toryburch.com/en-us/accessories/tech-accessories/kira-watch-band/X1.html" }).level, "url");
  assert.equal(isExcludedToryBurchWatch({ title: neutral, staticUrl: "watches/smart-watches/eleanor" }).level, "url");
  assert.equal(isExcludedToryBurchWatch({ title: neutral, variantNames: ["Eleanor Band for Apple Watch in brown, size OS"] }).level, "structured_data");
  assert.equal(isExcludedToryBurchWatch({ title: neutral, description: "Quartz movement. Water-resistant to 3 ATM. 36mm case." }).level, "specification");
  // marketing mentions are not enough
  assert.equal(isExcludedToryBurchWatch({ title: "Kira Tote", description: "Fits a laptop, water resistant coating" }).excluded, false);
  assert.ok(isWatchUrl("https://www.toryburch.com/en-us/watches/smart-watches/braided-band-for-apple-watch/TBS0046.html"));
  assert.ok(!isWatchUrl("https://www.toryburch.com/en-us/shoes/sandals/mellow-t-strap-sandal/150910.html"));
  assert.ok(!isWatchUrl("https://www.toryburch.com/en-us/accessories/hair-pins/studded-headband/141123.html"));
});

test("watch exclusion: real toryburch.com pages (handbag/shoe/clothing/wallet/jewelry/accessory IMPORT, watch + Apple Watch band EXCLUDE)", () => {
  const expect: [string, boolean][] = [
    ["135634", false], // handbag
    ["141183", false], // shoe
    ["148236", false], // clothing (dress)
    ["144856", false], // clothing (sweater)
    ["142826", false], // wallet
    ["11165518", false], // jewelry
    ["TY1090", false], // accessory (eyewear)
    ["TBW1066", true], // watch
    ["TBS0077", true], // Apple Watch band - its breadcrumb only says "Sale"; department + URL catch it
  ];
  for (const [style, excluded] of expect) {
    const n = page(style);
    assert.equal(n.exclusion.excluded, excluded, `${style} ${n.title}`);
    if (excluded) assert.equal(n.exclusion.status, "watch_excluded", style);
  }
  // the Apple Watch band is caught even if the URL were hidden: department "Watches" + the title
  const f = fixture("TBS0077");
  const st = parseTbPage(f.ld, f.flight, "https://www.toryburch.com/en-us/x/y/z/TBS0077.html", null);
  assert.equal(isExcludedToryBurchWatch({ title: st.name, department: st.department }).excluded, true);
});

test("watch exclusion: final safety check - the plan builder refuses to create, update or import images/variants for a watch", () => {
  for (const style of ["TBW1066", "TBS0077"]) {
    const n = page(style);
    assert.throws(() => buildTbPlan({ n, existing: null, row: undefined, settings, prices: pricesFor(n, fx85, settings), fx: fx85, images: [], locationId: null, nowIso: "2026-09-26T00:00:00Z" }), (e) => e instanceof ExcludedProduct && e.status === "watch_excluded" && e.message.startsWith(WATCH_SKIP_REASON));
    // even if an earlier step had (wrongly) cleared the flag, the final check re-derives it from the product data
    const cleared = { ...n, exclusion: { excluded: false, status: null, level: null, reason: null } };
    assert.throws(() => buildTbPlan({ n: cleared, existing: null, row: undefined, settings, prices: pricesFor(n, fx85, settings), fx: fx85, images: [], locationId: null, nowIso: "2026-09-26T00:00:00Z" }), ExcludedProduct);
  }
  assert.equal(WATCH_EXCLUDED_CODE, "TORY_BURCH_WATCH_EXCLUDED");
  assert.equal(WATCH_SKIP_REASON, "Tory Burch watches and watch-related products are excluded from Full Size Run import.");
});

test("watch exclusion cannot be switched off by configuration", () => {
  const s = { ...settings, EXCLUDED_CATEGORIES: "" };
  const n = normalizeTb(parseTbPage(fixture("TBW1066").ld, fixture("TBW1066").flight, fixture("TBW1066").url, fixture("TBW1066").canonical), s);
  assert.equal(n.exclusion.status, "watch_excluded");
  // other EXCLUDED_CATEGORIES are a separate, configurable "skipped" rule
  assert.equal(isExcludedToryBurchProduct({ title: "Spring Meadow Wine Glass", url: "https://www.toryburch.com/en-us/home/tabletop-drinkware/x/11147305.html" }, ["home"]).status, "skipped");
  assert.equal(isExcludedToryBurchProduct({ title: "Tory Eau de Parfum", department: "Fragrance & Beauty" }, ["fragrance"]).status, "skipped");
});

// ---------- 3. authorization ----------

test("authorization: Tory Burch authorized-importer config is on, image download authorized, scoped to Tory Burch", () => {
  assert.equal(TORY_BURCH_AUTHORIZED_IMPORTER, true);
  assert.deepEqual({ ...BRAND_AUTHORIZATION }, {
    brand: "Tory Burch", authorized_importer: true, importer: "Full Size Run", territory: "India", image_download_authorized: true,
    product_content_usage_authorized: true, product_description_usage_authorized: true, product_specification_usage_authorized: true,
  });
  // authorized images go into productSet as downloadable sources (no copyright blocker); description is the source text
  const n = page("11165518");
  const plan = buildTbPlan({ n, existing: null, row: undefined, settings, prices: pricesFor(n, fx85, settings), fx: fx85, images: [], locationId: null, nowIso: "2026-09-26T00:00:00Z" });
  const files = plan.input.files as { originalSource: string; contentType: string; alt: string }[];
  assert.equal(files.length, n.images.length);
  assert.ok(files.length >= 4, "both colours' galleries");
  assert.ok(files.every((f) => f.contentType === "IMAGE" && /^https:\/\/s7\.toryburch\.com\/is\/image\/ToryBurch\/.+\.pdp-2000x2000\.jpg$/.test(f.originalSource)));
  assert.ok(!plan.notes.some((x) => /copyright|not uploaded/i.test(x)));
  assert.ok((plan.input.descriptionHtml as string).includes(escapeText(n.details[0])));
  // the authorization is not shared with any other brand's importer
  const other = fs.readdirSync(path.join(import.meta.dirname, "..", "src")).filter((d) => d !== "toryburch").flatMap((d) => {
    const p = path.join(import.meta.dirname, "..", "src", d);
    return fs.statSync(p).isDirectory() ? fs.readdirSync(p).map((f) => path.join(p, f)) : [p];
  }).filter((f) => f.endsWith(".ts"));
  for (const f of other) assert.ok(!fs.readFileSync(f, "utf8").includes("TORY_BURCH_AUTHORIZED_IMPORTER"), f);
});
const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- extraction / normalization ----------

test("extract: JSON-LD + embedded product data (department, swatch names, sale vs original, stock, 2000px images)", () => {
  const bag = page("135634");
  assert.equal(bag.title, "Tory Burch McGraw Canvas Wedge");
  assert.equal(bag.category, "Handbags > Shoulder Bags");
  assert.equal(bag.productType, "Bags");
  assert.equal(bag.colours[0].colour, "Natural / Classic Cuoio");
  assert.equal(bag.colours[0].currentUsd, 209);
  assert.equal(bag.colours[0].regularUsd, 328);
  assert.equal(bag.onSale, true);
  assert.equal(bag.collection, "Sale");
  assert.equal(bag.variants[0].sku, "135634-928");
  assert.equal(bag.variants[0].sourceSku, "196133250297");
  assert.equal(bag.availability, "out_of_stock");
  assert.ok(bag.specs.Dimensions?.includes("Length"));
  assert.ok(bag.images.every((i) => i.url.endsWith(".pdp-2000x2000.jpg")));
  assert.equal(upscaleImage("https://s7.toryburch.com/is/image/ToryBurch/style/x.TB_1_SLANG.pdp-1200x1200.jpg", "pdp-2000x2000"), "https://s7.toryburch.com/is/image/ToryBurch/style/x.TB_1_SLANG.pdp-2000x2000.jpg");
});

test("normalize: shoe US women's -> UK (US - 2), one product per style, per-size stock; clothing sizes kept", () => {
  const shoe = page("141183");
  assert.equal(shoe.productType, "Sneakers");
  assert.ok(shoe.sizeOrder.includes("2") && shoe.sizeOrder.includes("10"), shoe.sizeOrder.join(","));   // US 4 -> UK 2, US 12 -> UK 10
  assert.equal(shoe.variants.find((v) => v.sourceSize === "12")?.sku, "141183-201-10");
  assert.equal(shoe.variants.find((v) => v.sourceSize === "12")?.availability, "in_stock");
  assert.equal(shoe.variants.find((v) => v.sourceSize === "4")?.availability, "out_of_stock");
  assert.equal(shoe.specs["Size system"], "UK (women's)");
  const dress = page("148236");
  assert.equal(dress.productType, "Apparel");
  assert.deepEqual(dress.sizeOrder, ["00", "0", "2", "4", "6", "8", "10", "12", "14", "16"]);
  assert.equal(dress.variants.length, 10, "every source size kept (no 00/0 merge)");
  assert.deepEqual(page("144856").sizeOrder, ["XXS", "XS", "S", "M", "L", "XL"]);
  assert.equal(page("142826").productType, "Wallets");
  assert.equal(page("11165518").productType, "Accessories");
  assert.equal(page("11165518").colours.length, 2, "two colours = one product with two Color variants");
  assert.equal(page("TY1090").productType, "Accessories");
});

test("discovery: en-us product sitemap only; ?color= links and duplicate routes merge into one style", () => {
  const idx = `<sitemapindex><sitemap><loc>https://www.toryburch.com/en-us/sitemap-product.xml</loc></sitemap><sitemap><loc>https://www.toryburch.com/en-ca/sitemap-product.xml</loc></sitemap><sitemap><loc>https://www.toryburch.com/en-us/sitemap-image_sitemap.xml</loc></sitemap></sitemapindex>`;
  assert.deepEqual(parseSitemapIndex(idx), ["https://www.toryburch.com/en-us/sitemap-product.xml"]);
  const xml = `<urlset>
    <url><loc>https://www.toryburch.com/en-us/handbags/shoulder-bags/mcgraw-canvas-wedge/135634.html</loc></url>
    <url><loc>https://www.toryburch.com/en-us/handbags/shoulder-bags/mcgraw-canvas-wedge/135634.html?color=928</loc></url>
    <url><loc>https://www.toryburch.com/en-us/sale/handbags/mcgraw-canvas-wedge/135634.html</loc></url>
    <url><loc>https://www.toryburch.com/en-us/watches/smart-watches/miller-band-for-apple-watch/TBS0077.html</loc></url>
    <url><loc>https://www.toryburch.com/en-ca/handbags/x/y/999.html</loc></url>
  </urlset>`;
  const r = parseProductSitemap(xml);
  assert.deepEqual(r.urls.map((u) => u.style), ["135634", "TBS0077"]);
  assert.equal(r.duplicates, 2);
  assert.equal(r.urls[1].department, "watches");
});

// ---------- 27. pricing (same engine + bands as Michael Kors) ----------

const price = (usd: number, kg: number | null, rate = 85, regular: number | null = null) => calculateMkPrice({ currentUsd: usd, regularUsd: regular, currency: "USD", weightKg: kg }, { ok: true, rate, base: "USD" }, settings);

test("pricing: spec tests 1-4 at the TEST rate ₹85", () => {
  const cases: [number, number, number, number, number, number, number][] = [
    // usd, kg, converted, shipping, landed, profit, final
    [100, 0.5, 8500, 1000, 9500, 1500, 11000],
    [200, 1.5, 17000, 2500, 19500, 2000, 21500],
    [500, 3.5, 42500, 4250, 46750, 3500, 50250],
    [700, 5.5, 59500, 5000, 64500, 4000, 68500],
  ];
  for (const [usd, kg, conv, ship, landed, profit, final] of cases) {
    const p = price(usd, kg);
    assert.deepEqual([p.convertedPriceInr, p.weight.surchargeInr, p.landedCostInr, p.profitInr, p.fsrPrice], [conv, ship, landed, profit, final], `$${usd}`);
  }
});

test("pricing: centralized, configurable bands (defaults = Michael Kors) and ₹2,500 unknown-weight fallback", () => {
  assert.equal(settings.WEIGHT_BANDS, TB_PRICING_DEFAULTS.WEIGHT_BANDS);
  assert.equal(settings.PROFIT_BANDS, TB_PRICING_DEFAULTS.PROFIT_BANDS);
  for (const [kg, inr] of [[0.5, 1000], [0.501, 1500], [1, 1500], [1.001, 2500], [2, 2500], [2.001, 3500], [3, 3500], [3.001, 4250], [5, 4250], [5.001, 5000]] as const) assert.equal(price(100, kg).weight.surchargeInr, inr, `${kg} kg`);
  assert.equal(price(100, null).weight.surchargeInr, 2500);
  for (const [landed, profit] of [[5000, 1000], [5001, 1500], [10000, 1500], [10001, 2000], [20000, 2000], [20001, 3000], [35000, 3000], [35001, 3500], [50000, 3500], [50001, 4000]] as const) assert.equal(profitFor(landed, settings.PROFIT_BANDS).profitInr, profit, `₹${landed}`);
  const env = tbEnvSettings({ TORY_BURCH_WEIGHT_BANDS: "1:900,+:1800", TORY_BURCH_PROFIT_BANDS: "+:777", TORY_BURCH_ETA: "10 Days", USD_INR_RATE_MAX_AGE_HOURS: "12", TORY_BURCH_DRY_RUN: "true", TORY_BURCH_SYNC_INTERVAL_HOURS: "5", TORY_BURCH_ENABLED: "true" });
  assert.deepEqual([env.WEIGHT_BANDS, env.PROFIT_BANDS, env.DEFAULT_ETA, env.MAX_EXCHANGE_RATE_AGE_HOURS, env.DRY_RUN, env.SYNC_INTERVAL_HOURS, env.ENABLED], ["1:900,+:1800", "+:777", "10 Days", 12, true, 5, true]);
  const d = tbEnvSettings({});
  assert.deepEqual([d.DEFAULT_ETA, d.SYNC_INTERVAL_HOURS, d.MAX_EXCHANGE_RATE_AGE_HOURS, d.ENABLED, d.DRY_RUN], ["15–20 Days", 5, 24, true, false]);
});

test("pricing: sale uses the current selling price ($419 not $595); original kept separately; no checkout promo; no compounding", () => {
  const p = price(419, 1, 85, 595);
  assert.equal(p.sourcePriceUsd, 419);
  assert.equal(p.sourceRegularPriceUsd, 595);
  assert.equal(p.convertedPriceInr, 419 * 85);
  assert.equal(p.fsrPrice, 419 * 85 + 1500 + 3500); // landed ₹37,115 -> ₹35,001–50,000 band
  // real sale page: $209 (was $328) -> priced from $209 with unknown weight -> ₹2,500 shipping
  const bag = page("135634");
  const bp = pricesFor(bag, fx85, settings).get(bag.colours[0].colour)!;
  assert.equal(bp.sourcePriceUsd, 209);
  assert.equal(bp.fsrPrice, 209 * 85 + 2500 + 3000); // landed ₹20,265 -> ₹20,001–35,000 band
  // same inputs twice -> same price (never priced from a previous Shopify price)
  assert.equal(price(200, 1.5).fsrPrice, price(200, 1.5).fsrPrice);
  assert.equal(calculateMkPrice.length, 3);
  assert.equal(calculateMkPrice({ currentUsd: 100, regularUsd: null, currency: "USD", weightKg: null }, { ok: false, rate: null, base: "USD" }, settings).ok, false, "no rate -> paused, never guessed");
});

// ---------- plan: metafields, ETA, variants ----------

test("plan: create -> ETA 15–20 Days, tory_burch_sync metafields, one product with Color x Size variants, UPC barcodes", () => {
  const n = page("141183");
  const plan = buildTbPlan({ n, existing: null, row: undefined, settings, prices: pricesFor(n, fx85, settings), fx: fx85, images: [], locationId: null, nowIso: "2026-09-26T00:00:00Z" });
  const mf = new Map((plan.input.metafields as { namespace: string; key: string; value: string }[]).map((m) => [`${m.namespace}.${m.key}`, m.value]));
  assert.equal(TBNS, "tory_burch_sync");
  assert.equal(mf.get("custom.eta"), "15–20 Days");
  assert.ok(!(plan.input.title as string).includes("Days"), "ETA not in title");
  for (const k of ["source_product_id", "source_variant_id", "source_url", "canonical_url", "source_sku", "source_style_number", "source_price_usd", "source_regular_price_usd", "exchange_rate", "exchange_rate_timestamp",
    "converted_price_inr", "shipping_adjustment_inr", "landed_cost_inr", "profit_adjustment_inr", "fsr_selling_price", "category", "gender", "source_last_seen_at", "source_last_synced_at", "source_status", "import_status", "skip_reason", "sync_error"]) {
    assert.ok(mf.has(`tory_burch_sync.${k}`), k);
  }
  assert.equal(mf.get("tory_burch_sync.fsr_selling_price"), (300 * 85 + 2500 + 3000).toFixed(2));
  assert.equal(mf.get("tory_burch_sync.import_status"), "imported");
  assert.equal(plan.input.vendor, "Tory Burch");
  assert.equal(plan.input.status, "DRAFT");
  const vars = plan.input.variants as { sku: string; barcode?: string; inventoryPolicy: string; optionValues: { optionName: string }[] }[];
  assert.equal(vars.length, n.variants.length);
  assert.ok(vars.every((v) => v.optionValues.map((o) => o.optionName).join() === "Color,Size"));
  assert.ok(vars.every((v) => /^\d{12,14}$/.test(v.barcode ?? "")));
  assert.equal(vars.find((v) => v.sku === "141183-201-2")?.inventoryPolicy, "DENY");    // sold-out size is not orderable
  assert.equal(vars.find((v) => v.sku === "141183-201-10")?.inventoryPolicy, "CONTINUE");
  assert.ok(!(plan.input.tags as string[]).includes("Instant Ship"));
});

// ---------- TEST 1/2/3 (offline) + duplicates + removal safety: full pipeline in feed mode, dry run ----------

function feedDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-feed-"));
  for (const [name, html] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), html);
  return dir;
}
/** Rebuild a minimal product page (canonical + JSON-LD + flight payload) from a fixture. */
function html(f: Fixture, canonical = f.canonical): string {
  const ld = f.ld.map((x) => `<script type="application/ld+json">${JSON.stringify(x)}</script>`).join("");
  return `<html><head><link rel="canonical" href="${canonical}"/>${ld}</head><body><script>self.__next_f.push([1,${JSON.stringify(f.flight)}])</script></body></html>`;
}

test("pipeline (dry run, feed): 5 / all eligible planned once, watches WATCH_EXCLUDED, duplicate listings = ONE product, unreliable scan aborts cleanup", async () => {
  offline();
  const bag = fixture("135634");
  const files: Record<string, string> = {};
  FIXTURES.forEach((f, i) => { files[`${String(i).padStart(2, "0")}.html`] = html(f); });
  files["99-sale-copy.html"] = html(bag); // the same style saved again (e.g. from the Sale listing)
  setTbSetting("SOURCE_MODE", "feed");
  setTbSetting("FEED_DIR", feedDir(files));
  setTbSetting("FX_PROVIDER", "manual");
  setTbSetting("MANUAL_EXCHANGE_RATE", 85);

  const five = await runTbSync({ dryRun: true, limit: 5 });
  assert.equal(five.counts.created, 5, "TEST 1: 5 eligible products");
  assert.equal(five.mode, "dry_run");

  const s = await runTbSync({ dryRun: true });
  assert.equal(s.status, "success");
  assert.equal(s.counts.created, 7, "7 eligible styles");
  assert.equal(s.counts.watchExcluded, 2, "watch + Apple Watch band excluded");
  assert.equal(s.products.filter((p) => p.style === "135634").length, 1, "duplicate listing -> ONE product");
  assert.ok(s.products.filter((p) => p.outcome === "watch_excluded").every((p) => !p.planned), "nothing planned for watches");
  assert.ok(s.products.filter((p) => p.outcome === "planned_create").every((p) => p.imagesUploaded > 0), "images planned for every eligible product");
  assert.ok(s.warnings.some((w) => w.startsWith("SOURCE_SCAN_UNRELIABLE")), "7 styles < MIN_CATALOG_SIZE -> cleanup aborted");
  assert.equal(s.counts.archived, 0);
  const report = fs.readFileSync(path.join(import.meta.dirname, "..", "logs", `${s.syncId}.report.txt`), "utf8");
  assert.ok(report.includes("TORY BURCH SYNC COMPLETE"));
  for (const label of ["Discovered:", "Eligible:", "Watches excluded:", "New", "Updated", "Unchanged:", "Skipped:", "Failed:", "Variants updated:", "Images updated:", "Price changes:"]) assert.ok(report.includes(label), label);
  fs.rmSync(path.join(import.meta.dirname, "..", "logs", `${s.syncId}.report.txt`));
  fs.rmSync(path.join(import.meta.dirname, "..", "logs", `${s.syncId}.report.json`));
  fs.rmSync(path.join(import.meta.dirname, "..", "logs", `${five.syncId}.report.txt`));
  fs.rmSync(path.join(import.meta.dirname, "..", "logs", `${five.syncId}.report.json`));
});
