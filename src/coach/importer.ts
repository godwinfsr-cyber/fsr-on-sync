// COACH + COACH OUTLET one-time import pipeline (runs in the cloud: GitHub Actions, manual trigger only):
//   feed (browser-harvested pages) -> normalize -> watch / category exclusion -> cross-source dedupe -> validation
//   -> live USD/INR -> pricing -> Shopify duplicate check -> create (productSet) -> images -> metafields -> publish -> report
// It only CREATES missing products. It never updates, archives or deletes anything, and a source problem never turns
// into "Coach has no products".
import fs from "node:fs";
import path from "node:path";
import { LOG_DIR, ROOT } from "../config.ts";
import { getExchangeRate, type FxRate } from "../gymshark/fx.ts";
import { Logger } from "../logger.ts";
import { errMsg, retry } from "../util.ts";
import { buildProduct, exclusionOf, NotImportable, titleOf } from "./catalog.ts";
import { COACH_SOURCE, coachSettings, type CoachSettings } from "./config.ts";
import { cdb, getItem, getState, setState, upsertItem } from "./db.ts";
import { dedupeListings, type CoachItem, type StoreIndex } from "./dedupe.ts";
import { isRestoredUrl, isWatchUrl, WATCH_LOG_MESSAGE } from "./exclusion.ts";
import { readFeed, type FeedManifest } from "./feed.ts";
import { galleryFor, scene7Exists, type ExistsFn } from "./images.ts";
import { isOutletPath, parseEntry, type Listing } from "./normalize.ts";
import { CoachShopify } from "./shopify.ts";

export type Mode = "dry-run" | "test" | "full";

export interface ImportOptions {
  mode: Mode;
  limit?: number;                 // test mode: number of NEW products to create (5 / 25); dry-run: products to evaluate
  keys?: string[];                // only these Coach product references (e.g. a mainline+outlet pair for the dedupe test)
  status?: "ACTIVE" | "DRAFT";    // override NEW_PRODUCT_STATUS (test runs are created as DRAFT)
  trigger?: string;
  exists?: ExistsFn;              // injectable for tests
  settings?: CoachSettings;
}

export interface FailedProduct { name: string; sourceUrl: string; sourceId: string; error: string; stage: string }

export interface ImportReport {
  runId: string; mode: Mode; limit: number | null; trigger: string; startedAt: string; finishedAt: string | null; status: "success" | "partial" | "failed" | "aborted";
  abortReason: string | null;
  feed: { run: string | null; harvestedAt: string | null; complete: boolean; pages: number; productPages: number; gonePages: number; harvestErrors: number };
  sitemap: { available: boolean; styles: number; mainlineUrls: number; outletUrls: number; watchUrls: number; restoredUrls: number; error: string | null };
  mainlineDiscovered: number; outletDiscovered: number; combinedSourceProducts: number; duplicatesDetected: number; duplicatesByRule: Record<string, number>;
  uniqueProducts: number; uniqueEligible: number; watchExcluded: number; watchUrlsExcludedAtDiscovery: number; skipped: number; skippedByReason: Record<string, number>;
  needsReview: number; imported: number; alreadyExisting: number; alreadyExistingByRule: Record<string, number>; failed: number; notReached: number;
  variantsCreated: number; imagesUploaded: number; imagesFailed: number; sourceUrlsProcessed: number; pricingErrors: number; shopifyApiErrors: number;
  exchangeRate: { rate: number | null; provider: string | null; fetchedAt: string | null; origin: string | null; reason: string | null };
  created: { key: string; title: string; shopifyId: string; status: string; price: number | null; compareAt: number | null; variants: number; images: number }[];
  watchExcludedList: { key: string; name: string; reason: string }[];
  failedProducts: FailedProduct[];
  needsReviewList: { key: string; name: string; reason: string }[];
  needsOwnPage: { key: string; url: string }[];   // seen only on another style's page and not in Shopify: read its own page first
  dryRunSample: { key: string; title: string; type: string; sourceUsd: number | null; regularUsd: number | null; fsr: number | null; compareAt: number | null; variants: number; sizes: string; images: number; existing: string | null }[];
  warnings: string[];
}

const nowIso = () => new Date().toISOString();
const inc = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };

async function sitemapStats(log: Logger): Promise<ImportReport["sitemap"]> {
  try {
    const r = await fetch(COACH_SOURCE.productSitemap, { headers: { "User-Agent": COACH_SOURCE.userAgent, Accept: "application/xml" }, signal: AbortSignal.timeout(60_000) });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const xml = await r.text();
    if (!/<\/urlset>\s*$/.test(xml.trim())) throw new Error("sitemap looks truncated");
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    return { available: true, styles: locs.length, mainlineUrls: locs.filter((u) => !isOutletPath(u)).length, outletUrls: locs.filter(isOutletPath).length, watchUrls: locs.filter(isWatchUrl).length, restoredUrls: locs.filter(isRestoredUrl).length, error: null };
  } catch (e) {
    log.warn("discover", `coach.com product sitemap not readable (${errMsg(e)}) - counts come from the feed only`);
    return { available: false, styles: 0, mainlineUrls: 0, outletUrls: 0, watchUrls: 0, restoredUrls: 0, error: errMsg(e) };
  }
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>, stop: () => boolean) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
    while (i < items.length && !stop()) await fn(items[i++]);
  }));
}

export async function runCoachImport(o: ImportOptions): Promise<ImportReport> {
  const s = o.settings ?? coachSettings();
  const startedAt = nowIso();
  const runId = `COACH-IMPORT-${startedAt.slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}-${o.mode}`;
  const log = new Logger(runId, { db: cdb, name: runId });
  const dry = o.mode === "dry-run";
  const status = o.status ?? s.NEW_PRODUCT_STATUS;
  const limit = o.limit ?? null;
  const exists = o.exists ?? scene7Exists;
  const R: ImportReport = {
    runId, mode: o.mode, limit, trigger: o.trigger ?? "manual", startedAt, finishedAt: null, status: "success", abortReason: null,
    feed: { run: null, harvestedAt: null, complete: false, pages: 0, productPages: 0, gonePages: 0, harvestErrors: 0 },
    sitemap: { available: false, styles: 0, mainlineUrls: 0, outletUrls: 0, watchUrls: 0, restoredUrls: 0, error: null },
    mainlineDiscovered: 0, outletDiscovered: 0, combinedSourceProducts: 0, duplicatesDetected: 0, duplicatesByRule: {}, uniqueProducts: 0, uniqueEligible: 0,
    watchExcluded: 0, watchUrlsExcludedAtDiscovery: 0, skipped: 0, skippedByReason: {}, needsReview: 0, imported: 0, alreadyExisting: 0, alreadyExistingByRule: {},
    failed: 0, notReached: 0, variantsCreated: 0, imagesUploaded: 0, imagesFailed: 0, sourceUrlsProcessed: 0, pricingErrors: 0, shopifyApiErrors: 0,
    exchangeRate: { rate: null, provider: null, fetchedAt: null, origin: null, reason: null },
    created: [], watchExcludedList: [], failedProducts: [], needsReviewList: [], needsOwnPage: [], dryRunSample: [], warnings: [],
  };
  const lock = getState("lock");
  if (lock && !dry && Date.now() - new Date(JSON.parse(lock).at).getTime() < 6 * 3600_000) {
    return finish(R, log, "aborted", `another Coach import is running (${lock}); run \`node src/coach/cli.ts unlock\` if it crashed`);
  }
  if (!dry) setState("lock", JSON.stringify({ id: runId, at: startedAt }));
  cdb.prepare("INSERT OR REPLACE INTO runs (id, mode, started_at, status) VALUES (?,?,?,?)").run(runId, o.mode, startedAt, "running");
  try {
    log.info("run", `Coach import ${runId}: mode=${o.mode}${limit ? ` limit=${limit}` : ""} status=${status} (one-time import - no scheduler)`);

    // ---------- 1. discovery ----------
    R.sitemap = await sitemapStats(log);
    let manifest: FeedManifest;
    let entries;
    try { ({ manifest, entries } = readFeed(s.FEED_DIR)); } catch (e) { return finish(R, log, "aborted", `SOURCE UNAVAILABLE: ${errMsg(e)}. Nothing was changed in Shopify.`); }
    R.feed = { run: manifest.run, harvestedAt: manifest.harvestedAt, complete: manifest.complete, pages: entries.length, productPages: entries.filter((e) => !e.gone).length, gonePages: entries.filter((e) => e.gone).length, harvestErrors: manifest.failed };
    if (!R.feed.productPages) return finish(R, log, "aborted", "SOURCE EMPTY: the feed holds no product pages - treated as a source failure, not as \"Coach has zero products\". Nothing was changed.");
    if (!manifest.complete) R.warnings.push(`feed harvest ${manifest.run} is incomplete (${manifest.failed} failed page(s), stopped: ${manifest.stoppedReason ?? "-"}) - only harvested products are imported; nothing is removed`);
    R.sourceUrlsProcessed = entries.length;
    R.watchUrlsExcludedAtDiscovery = R.sitemap.watchUrls;
    log.info("discover", `feed ${manifest.run}: ${R.feed.productPages} product pages (${R.feed.gonePages} withdrawn); sitemap ${R.sitemap.styles} styles (${R.sitemap.mainlineUrls} mainline URLs, ${R.sitemap.outletUrls} Outlet URLs, ${R.sitemap.watchUrls} watch URLs never read)`);

    // ---------- 2. normalize ----------
    const listings: Listing[] = [];
    for (const e of entries) {
      try { listings.push(...parseEntry(e)); } catch (err) { R.failedProducts.push({ name: e.title ?? "", sourceUrl: e.url, sourceId: "", error: errMsg(err), stage: "normalize" }); }
    }
    R.combinedSourceProducts = listings.length;
    R.mainlineDiscovered = new Set(listings.filter((l) => !l.isOutlet || l.reach !== "outlet").map((l) => l.key)).size;
    R.outletDiscovered = new Set(listings.filter((l) => l.isOutlet || l.reach === "multi").map((l) => l.key)).size;

    // ---------- 3. dedupe ----------
    const { items, duplicates, byReason } = dedupeListings(listings);
    R.duplicatesDetected = duplicates;
    R.duplicatesByRule = byReason;
    R.uniqueProducts = items.length;
    log.info("dedupe", `${listings.length} source listings -> ${items.length} unique products (${duplicates} duplicates merged: ${JSON.stringify(byReason)})`);

    // ---------- 4. exclusion + validation ----------
    const eligible: CoachItem[] = [];
    for (const it of items) {
      if (o.keys?.length && !o.keys.map((k) => k.toUpperCase()).includes(it.key)) continue;
      const ex = exclusionOf(it, s);
      if (ex.excluded && ex.status === "watch_excluded") {
        R.watchExcluded++;
        R.watchExcludedList.push({ key: it.key, name: it.name, reason: ex.reason! });
        log.info("exclude", WATCH_LOG_MESSAGE, { status: "WATCH_EXCLUDED", reason: ex.reason, level: ex.level, url: it.sourceUrls[0] }, it.key);
        if (!dry) upsertItem({ source_product_id: it.key, status: "WATCH_EXCLUDED", stage: "exclusion", title: it.name, error: ex.reason, run_id: runId, source_url: it.sourceUrls[0] });
        continue;
      }
      if (ex.excluded) {
        R.skipped++; inc(R.skippedByReason, ex.level ?? "other");
        log.info("exclude", `skipped: ${ex.reason}`, { status: "SKIPPED" }, it.key);
        continue;
      }
      if (it.listings > 1) log.debug("dedupe", `merged ${it.listings} listings (${it.mergeReasons.join(", ")})`, { status: "DUPLICATE", urls: it.sourceUrls }, it.key);
      eligible.push(it);
    }
    R.uniqueEligible = eligible.length;

    // ---------- 5. exchange rate (never guessed) ----------
    const fx: FxRate = await getExchangeRate(s, log, { store: { db: cdb, getState } });
    R.exchangeRate = { rate: fx.rate, provider: fx.provider, fetchedAt: fx.fetchedAt, origin: fx.origin, reason: fx.reason ?? null };
    if (!fx.ok) return finish(R, log, "aborted", `NO VALID USD/INR RATE (${fx.reason}) - pricing and import stopped; nothing was created`);

    // ---------- 6. Shopify duplicate index ----------
    const shop = new CoachShopify(log);
    let index: StoreIndex;
    try { index = await shop.loadIndex(); } catch (e) { R.shopifyApiErrors++; return finish(R, log, "aborted", `Shopify not reachable (${errMsg(e)}) - nothing was created`); }
    log.info("shopify", `duplicate index: ${index.size} Coach products already in Shopify`);
    const locationId = dry ? null : await shop.resolveLocation();
    const pubs = !dry && status === "ACTIVE" ? await shop.resolvePublications(s.PUBLISH_CHANNELS.split(",")) : null;

    // ---------- 7. per product ----------
    let createdCount = 0;
    const stop = () => (o.mode === "test" && limit != null && createdCount >= limit) || (dry && limit != null && R.dryRunSample.length >= limit);
    const inFlight = new Set<string>();
    await pool(eligible, dry ? s.IMAGE_PROBE_CONCURRENCY : s.SHOPIFY_CONCURRENCY, async (it) => {
      if (stop()) return;
      const title = it.colourName ? titleOf(it) : it.name;
      const url = it.canonicalUrl ?? it.sourceUrls[0];
      // Shopify-side duplicate protection (index built at start + updated after each create)
      const m = index.match(it, title);
      if (m) {
        R.alreadyExisting++; inc(R.alreadyExistingByRule, m.by);
        log.info("dedupe", `already in Shopify (${m.by}): ${m.product.title}`, { status: "ALREADY_EXISTS", shopifyProductId: m.product.id }, it.key);
        if (!dry) upsertItem({ source_product_id: it.key, status: "ALREADY_EXISTS", matched_by: m.by, shopify_product_id: m.product.id, title, run_id: runId, source_url: url });
        return;
      }
      if (it.orphan) {
        // only a variant row on ANOTHER style's page: its name / description / price data there belong to that other style
        R.needsOwnPage.push({ key: it.key, url: `${COACH_SOURCE.origin}/products/p/${encodeURIComponent(it.key).replace(/%2F/gi, "%2F")}.html` });
        return;
      }
      const prior = getItem(it.key);
      if (prior?.status === "IMPORTED" && prior.shopify_product_id) { R.alreadyExisting++; inc(R.alreadyExistingByRule, "checkpoint"); return; }
      if (inFlight.has(it.key)) return;
      inFlight.add(it.key);
      let stage = "images";
      try {
        const images = await galleryFor(it, s, exists);
        stage = "price";
        const built = buildProduct(it, images, fx, s, nowIso(), locationId);
        built.input.status = built.status === "ACTIVE" ? status : "DRAFT";
        const c = built.cheapest;
        const logData = {
          status: "PRICED", sku: it.key, style: it.style, source: it.onMainline && it.onOutlet ? "mainline+outlet" : it.onOutlet ? "outlet" : "mainline",
          sourcePriceUsd: c?.sourcePriceUsd, regularUsd: c?.sourceRegularPriceUsd, exchangeRate: fx.rate, shippingInr: c?.weight.surchargeInr, landedCostInr: c?.landedCostInr,
          profitInr: c?.profitInr, fsrPrice: c?.fsrPrice, compareAt: c?.compareAtPrice, imageCount: built.imageCount, variantCount: built.variantCount,
        };
        if (dry) {
          R.dryRunSample.push({ key: it.key, title: built.title, type: built.productType, sourceUsd: c?.sourcePriceUsd ?? null, regularUsd: it.regularUsd, fsr: c?.fsrPrice ?? null, compareAt: c?.compareAtPrice ?? null, variants: built.variantCount, sizes: (built.input.variants as { optionValues: { name: string }[] }[]).map((v) => v.optionValues[0].name).join(" "), images: built.imageCount, existing: null });
          log.info("product", `[dry-run] would create "${built.title}" ₹${c?.fsrPrice}`, logData, it.key);
          return;
        }
        // live store-wide check right before creating (other vendors, hand-made listings, same handle)
        stage = "shopify_duplicate_check";
        const gtins = it.variants.map((v) => v.gtin).filter(Boolean) as string[];
        const live = await shop.liveDuplicate(it.key, gtins, built.handle);
        if (live) {
          if (prior?.status === "CREATING" && live.by !== "gtin") {
            // a previous run created it but stopped before recording it: recover the checkpoint, do not create again
            upsertItem({ source_product_id: it.key, status: "IMPORTED", shopify_product_id: live.id, run_id: runId, stage: "recovered" });
            R.alreadyExisting++; inc(R.alreadyExistingByRule, "checkpoint_recovered");
            return;
          }
          R.alreadyExisting++; inc(R.alreadyExistingByRule, live.by);
          upsertItem({ source_product_id: it.key, status: "ALREADY_EXISTS", matched_by: live.by, shopify_product_id: live.id, title, run_id: runId, source_url: url });
          log.info("dedupe", `already in Shopify (${live.by}, live check): ${live.title}`, { status: "ALREADY_EXISTS" }, it.key);
          return;
        }
        if (stop()) return;
        stage = "create";
        upsertItem({ source_product_id: it.key, status: "CREATING", stage, style: it.style, colour: it.colourName, title: built.title, handle: built.handle, run_id: runId, source_url: url, source_mainline_url: it.mainlineUrls[0] ?? null, source_outlet_url: it.outletUrls[0] ?? null });
        // identifier = handle: a retry after a network drop updates the product it just created instead of creating a second one
        const product = await retry(() => shop.productSet(built.input, { handle: built.handle }), { attempts: 3, baseMs: 5000, shouldRetry: (e) => !/productSet:/.test(errMsg(e)) });
        createdCount++;
        index.add({ id: product.id, title: built.title, status: String(built.input.status), vendor: s.VENDOR, sourceProductId: it.key, sourceUrl: url, skus: product.variants.nodes.map((v) => v.sku ?? "").filter(Boolean), barcodes: gtins });
        stage = "publish";
        if (pubs && built.input.status === "ACTIVE") {
          try { await shop.publish(product.id, pubs); } catch (e) { R.shopifyApiErrors++; R.warnings.push(`${it.key}: created but not published (${errMsg(e)})`); }
        }
        R.imported++;
        R.variantsCreated += built.variantCount;
        R.imagesUploaded += built.imageCount;
        R.created.push({ key: it.key, title: built.title, shopifyId: product.id, status: String(built.input.status), price: c?.fsrPrice ?? null, compareAt: c?.compareAtPrice ?? null, variants: built.variantCount, images: built.imageCount });
        upsertItem({
          source_product_id: it.key, status: "IMPORTED", stage: "done", shopify_product_id: product.id, sku: it.key, source_price_usd: c?.sourcePriceUsd ?? null, exchange_rate: fx.rate,
          shipping_inr: c?.weight.surchargeInr ?? null, landed_cost_inr: c?.landedCostInr ?? null, profit_inr: c?.profitInr ?? null, fsr_price: c?.fsrPrice ?? null, compare_at: c?.compareAtPrice ?? null,
          image_count: built.imageCount, variant_count: built.variantCount, error: null, run_id: runId,
        });
        log.info("product", `IMPORTED ${built.title}`, { ...logData, status: "IMPORTED", shopifyProductId: product.id }, it.key);
      } catch (e) {
        if (e instanceof NotImportable) {
          if (e.status === "watch_excluded") { R.watchExcluded++; R.watchExcludedList.push({ key: it.key, name: it.name, reason: e.message }); return; }
          if (e.status === "pricing_error") R.pricingErrors++;
          if (e.status === "needs_review" || e.status === "skipped") {
            R.needsReview++; R.needsReviewList.push({ key: it.key, name: it.name, reason: e.message });
            if (!dry) upsertItem({ source_product_id: it.key, status: "SKIPPED", stage, error: e.message, run_id: runId, title: it.name, source_url: url });
            log.warn("product", `not created: ${e.message}`, { status: "SKIPPED" }, it.key);
            return;
          }
        } else if (stage !== "images") R.shopifyApiErrors++;
        R.failed++;
        R.failedProducts.push({ name: it.colourName ? titleOf(it) : it.name, sourceUrl: url, sourceId: it.key, error: errMsg(e), stage });
        if (!dry) upsertItem({ source_product_id: it.key, status: prior?.status === "IMPORTED" ? "IMPORTED" : "FAILED", stage, error: errMsg(e), run_id: runId, title, source_url: url });
        log.error("product", `FAILED at ${stage}: ${errMsg(e)}`, { status: "FAILED" }, it.key);
      } finally {
        inFlight.delete(it.key);
      }
    }, stop);
    R.notReached = Math.max(0, R.uniqueEligible - R.imported - R.alreadyExisting - R.failed - R.needsReview - R.needsOwnPage.length - (dry ? R.dryRunSample.length : 0));
    if (R.needsOwnPage.length) {
      fs.writeFileSync(path.join(ROOT, "data", "coach-reports", "needs-own-page.json"), JSON.stringify(R.needsOwnPage.map((x) => x.url)));
      R.warnings.push(`${R.needsOwnPage.length} product(s) were seen only as variants on another style's page - not created; their own pages are listed in data/coach-reports/needs-own-page.json for the next harvest pass`);
    }

    // images are fetched by Shopify asynchronously: check the products of a test run
    if (!dry && R.created.length && R.created.length <= 30) {
      await new Promise((r) => setTimeout(r, 20_000));
      for (const c of R.created) {
        try { const m = await shop.mediaStatus(c.shopifyId); R.imagesFailed += m.failed; if (m.failed) R.warnings.push(`${c.key}: ${m.failed}/${m.total} images failed to process in Shopify`); } catch { /* informational */ }
      }
    }
    return finish(R, log, R.failed ? "partial" : "success", null);
  } catch (e) {
    return finish(R, log, "failed", errMsg(e));
  } finally {
    if (!dry) setState("lock", null);
  }
}

function finish(R: ImportReport, log: Logger, status: ImportReport["status"], reason: string | null): ImportReport {
  R.status = status;
  R.abortReason = reason;
  R.finishedAt = nowIso();
  if (reason) log.error("run", reason);
  cdb.prepare("UPDATE runs SET finished_at = ?, status = ?, report_json = ? WHERE id = ?").run(R.finishedAt, status, JSON.stringify(R), R.runId);
  const md = formatReport(R);
  fs.writeFileSync(path.join(LOG_DIR, `${R.runId}.report.md`), md);
  fs.writeFileSync(path.join(LOG_DIR, `${R.runId}.report.json`), JSON.stringify(R, null, 2));
  const repDir = path.join(ROOT, "data", "coach-reports");
  fs.mkdirSync(repDir, { recursive: true });
  fs.writeFileSync(path.join(repDir, `${R.runId}.md`), md);
  fs.writeFileSync(path.join(repDir, "latest.md"), md);
  log.info("run", `finished ${status}: imported ${R.imported}, already existing ${R.alreadyExisting}, failed ${R.failed}`);
  return R;
}

export function formatReport(R: ImportReport): string {
  const c = (v: unknown) => String(v ?? "").replace(/\|/g, "/");
  const rows: [string, string | number][] = [
    ["Mainline products discovered", R.mainlineDiscovered], ["Outlet products discovered", R.outletDiscovered], ["Combined source products", R.combinedSourceProducts],
    ["Duplicates detected", `${R.duplicatesDetected} ${Object.keys(R.duplicatesByRule).length ? JSON.stringify(R.duplicatesByRule) : ""}`], ["Unique products", R.uniqueProducts],
    ["Unique eligible products", R.uniqueEligible], ["Watch products excluded", `${R.watchExcluded} (+ ${R.watchUrlsExcludedAtDiscovery} watch URLs in the sitemap never read)`],
    ["Other exclusions (Restored / fragrance / care)", `${R.skipped} ${JSON.stringify(R.skippedByReason)}`], ["Products imported", R.imported],
    ["Products already existing", `${R.alreadyExisting} ${JSON.stringify(R.alreadyExistingByRule)}`], ["Products failed", R.failed], ["Not created (needs review)", R.needsReview], ["Awaiting own-page read (seen only on another style's page)", R.needsOwnPage.length],
    ["Not reached (limit / test mode)", R.notReached], ["Variants created", R.variantsCreated], ["Images uploaded", R.imagesUploaded], ["Images failed in Shopify", R.imagesFailed],
    ["Total source URLs processed", R.sourceUrlsProcessed], ["Pricing errors", R.pricingErrors], ["Shopify API errors", R.shopifyApiErrors],
  ];
  const out = [
    `# COACH IMPORT REPORT`, "",
    `Run \`${R.runId}\` · mode **${R.mode}**${R.limit ? ` (limit ${R.limit})` : ""} · trigger ${R.trigger} · **${R.status}**${R.abortReason ? ` — ${R.abortReason}` : ""}`,
    `Started ${R.startedAt} · finished ${R.finishedAt}`, "",
    `Source: browser-harvested feed \`${R.feed.run}\` (${R.feed.harvestedAt}, ${R.feed.productPages} product pages, ${R.feed.gonePages} withdrawn, complete=${R.feed.complete}); coach.com sitemap ${R.sitemap.available ? `${R.sitemap.styles} styles (${R.sitemap.mainlineUrls} mainline + ${R.sitemap.outletUrls} Outlet URLs)` : `unavailable: ${R.sitemap.error}`}`,
    `USD/INR: ${R.exchangeRate.rate ?? "none"} (${R.exchangeRate.provider ?? "-"}, ${R.exchangeRate.fetchedAt ?? "-"}, ${R.exchangeRate.origin ?? "-"})`, "",
    "| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v} |`), "",
  ];
  if (R.warnings.length) out.push("## Warnings", ...R.warnings.map((w) => `- ${w}`), "");
  if (R.failedProducts.length) out.push("## Failed products", "| Product | Source URL | Source ID | Error | Stage |", "|---|---|---|---|---|", ...R.failedProducts.map((f) => `| ${c(f.name)} | ${f.sourceUrl} | ${f.sourceId} | ${f.error.replace(/\|/g, "/")} | ${f.stage} |`), "");
  if (R.needsReviewList.length) out.push(`## Not created — needs review (${R.needsReviewList.length})`, ...R.needsReviewList.slice(0, 200).map((f) => `- ${f.key} ${f.name}: ${f.reason}`), "");
  if (R.watchExcludedList.length) out.push(`## Watch exclusions (${R.watchExcludedList.length})`, ...R.watchExcludedList.map((w) => `- ${w.key} ${w.name}: ${w.reason}`), "");
  if (R.created.length) out.push(`## Created (${R.created.length})`, "| Key | Title | Status | Price ₹ | Compare-at ₹ | Variants | Images | Shopify id |", "|---|---|---|---|---|---|---|---|", ...R.created.map((x) => `| ${x.key} | ${c(x.title)} | ${x.status} | ${x.price} | ${x.compareAt ?? ""} | ${x.variants} | ${x.images} | ${x.shopifyId.split("/").pop()} |`), "");
  if (R.dryRunSample.length) out.push(`## Dry run: would create (${R.dryRunSample.length})`, "| Key | Title | Type | USD now | USD regular | FSR ₹ | Compare-at ₹ | Sizes | Images |", "|---|---|---|---|---|---|---|---|---|", ...R.dryRunSample.map((d) => `| ${d.key} | ${c(d.title)} | ${d.type} | ${d.sourceUsd} | ${d.regularUsd ?? ""} | ${d.fsr} | ${d.compareAt ?? ""} | ${d.sizes} | ${d.images} |`), "");
  return out.join("\n");
}
