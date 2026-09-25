import fs from "node:fs";
import path from "node:path";
import { LOG_DIR, hasShopifyCredentials } from "../config.ts";
import { getExchangeRate, type FxRate } from "../gymshark/fx.ts";
import type { GShopifyProduct } from "../gymshark/ops.ts";
import { mapUploadedMedia } from "../gymshark/plan.ts";
import { Logger } from "../logger.ts";
import { PoliteHttp } from "../politeHttp.ts";
import { SourceBlockedError, errMsg, hash, retry } from "../util.ts";
import { STANLEY_SOURCE, effectiveLimit, type StanleySettings } from "./config.ts";
import {
  STANLEY_FX_STORE, acquireSLock, allRows, getRow, getSState, getStanleySettings, imagesFor, listingDetail, nextStanleySyncId, pageDetail, recordPriceChange,
  releaseSLock, replaceImages, saveListingDetail, savePageDetail, sdb, setSState, upsertRow, type StanleyRow,
} from "./db.ts";
import { SELLABLE, groupStanleyCatalog, normalizeStanley, type NormalizedProduct, type ProductDetails, type ProductGroup } from "./normalize.ts";
import { SNS, StanleyOps } from "./ops.ts";
import { PlanConflict, buildStanleyPlan } from "./plan.ts";
import { calculateStanleyPrice, type StanleyPrice } from "./pricing.ts";
import { fetchListingDetail, fetchPageDetail, fetchStanleyCatalog, type PageDetail } from "./source.ts";

export interface SSyncOptions { dryRun?: boolean; limit?: number; trigger?: string; products?: string[] }

export type Outcome = "created" | "updated" | "unchanged" | "failed" | "needs_review" | "planned_create" | "planned_update" | "planned_unchanged";
export type FailureKind = "network" | "source_parsing" | "missing_price" | "missing_product_id" | "shopify_api" | "image_upload" | "exchange_rate" | "rate_limited" | "invalid_data";

export interface VariantPriceReport {
  colour: string; sku: string; availability: string; usd: number | null; regularUsd: number | null; saleUsd: number | null;
  convertedInr: number | null; fsrPrice: number | null; compareAt: number | null;
}

export interface SProductReport {
  key: string;
  sourceProductIds: string[];
  title: string;
  name: string;
  url: string;
  outcome: Outcome;
  category: string | null;
  productType: string | null;
  capacity: string | null;
  variants: VariantPriceReport[];
  adjustment: number;
  exchangeRate: number | null;
  availability: string | null;
  eta: string;
  images: number;
  imagesAdded: number;
  barcodes: number;
  specifications: number;
  matchedBy: string | null;
  changes: string[];
  notes: string[];
  missing: string[];
  shopifyProductId?: string | null;
  timestamp: string;
  error?: string;
  errorKind?: FailureKind;
  planned?: Record<string, unknown>;
}

export interface SSyncSummary {
  syncId: string;
  mode: "dry_run" | "live";
  trigger: string;
  status: "success" | "partial" | "failed" | "aborted";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  limit: number;
  shopifyChecked: boolean;
  sourceHealthy: boolean;
  fx: { ok: boolean; rate: number | null; provider: string | null; providerUpdatedAt: string | null; fetchedAt: string | null; origin: string; reason?: string } | null;
  discovery: { listings: number; pages: number; complete: boolean; products: number; excluded: Record<string, number>; invalid: number; detailRequests: number; requests: number } | null;
  counts: {
    discovered: number; products: number; processed: number; created: number; updated: number; unchanged: number; skipped: number; priceChanges: number; variantChanges: number;
    imagesAdded: number; imageChanges: number; specChanges: number; availabilityChanges: number; unavailable: number; pricesPaused: number; archived: number;
    missing: number; needsReview: number; failed: number; rateLimitEvents: number;
  };
  errors: { id?: string; stage: string; kind?: FailureKind; message: string }[];
  warnings: string[];
  products: SProductReport[];
}

class Aborted extends Error {}

/** Error classification for the report (Stanley / Shopify / FX failures are handled differently). */
export function classify(e: unknown): FailureKind {
  const m = errMsg(e);
  if (e instanceof SourceBlockedError || /HTTP 429|rate.?limit/i.test(m)) return "rate_limited";
  if (/network error|fetch failed|timeout|ECONN|ENOTFOUND/i.test(m)) return "network";
  if (/productSet|metafieldsSet|GraphQL|Shopify|userErrors|throttled/i.test(m)) return /media|image|file/i.test(m) ? "image_upload" : "shopify_api";
  if (/exchange rate/i.test(m)) return "exchange_rate";
  if (/missing price|no positive USD price/i.test(m)) return "missing_price";
  if (/missing product ID/i.test(m)) return "missing_product_id";
  if (/JSON|parse|Unexpected token/i.test(m)) return "source_parsing";
  return "invalid_data";
}

// ---------- identity: which FSR product is this? (duplicate protection, in the spec's priority order) ----------

export interface KeyIndex { byProductId: Map<string, string>; bySku: Map<string, string>; byHandle: Map<string, string>; byTitle: Map<string, string> }

export function buildKeyIndex(rows: StanleyRow[]): KeyIndex {
  const ix: KeyIndex = { byProductId: new Map(), bySku: new Map(), byHandle: new Map(), byTitle: new Map() };
  for (const r of rows) {
    for (const id of Object.values(r.source_product_ids ? (JSON.parse(r.source_product_ids) as Record<string, string>) : {})) ix.byProductId.set(id, r.product_key);
    ix.byProductId.set(r.product_key, r.product_key);
    for (const sku of r.source_skus ? (JSON.parse(r.source_skus) as string[]) : []) ix.bySku.set(sku.toUpperCase(), r.product_key);
    for (const h of r.source_handles ? (JSON.parse(r.source_handles) as string[]) : []) ix.byHandle.set(h, r.product_key);
    if (r.title_key) ix.byTitle.set(r.title_key, r.product_key);
  }
  return ix;
}

/**
 * 1 source product id -> 2 source SKU -> 3 (Stanley publishes no style number) -> 4/5 canonical URL / handle ->
 * 6 normalised title. A key already claimed by another product in this run is never shared.
 * New products get the Stanley product id of their primary listing, kept for good.
 */
export function resolveKey(n: Pick<NormalizedProduct, "sourceProductIds" | "skus" | "handles" | "titleKey" | "primaryProductId">, ix: KeyIndex, claimed: Set<string>): { key: string; matchedBy: string | null } {
  const tries: [string, (string | undefined)[]][] = [
    ["source product id", Object.values(n.sourceProductIds).map((id) => ix.byProductId.get(id))],
    ["source SKU", n.skus.map((k) => ix.bySku.get(k.toUpperCase()))],
    ["canonical URL / handle", n.handles.map((h) => ix.byHandle.get(h))],
    ["normalised title", [ix.byTitle.get(n.titleKey)]],
  ];
  for (const [why, keys] of tries) {
    const k = keys.find((x): x is string => !!x && !claimed.has(x));
    if (k) return { key: k, matchedBy: why };
  }
  let key = n.primaryProductId;
  for (const id of Object.values(n.sourceProductIds)) { if (!claimed.has(key)) break; key = id; }
  return { key, matchedBy: null };
}

export async function runStanleySync(opts: SSyncOptions = {}): Promise<SSyncSummary> {
  const settings = getStanleySettings();
  const dryRun = opts.dryRun ?? settings.DRY_RUN;
  const limit = opts.limit ?? effectiveLimit(settings);
  const trigger = opts.trigger ?? "manual";
  const syncId = nextStanleySyncId();
  const log = new Logger(syncId, { db: sdb, name: "stanley-sync" });
  const startedAt = new Date();

  if (!acquireSLock(syncId)) throw new Error("Another Stanley sync is already running (lock held)");
  sdb.prepare("UPDATE sync_runs SET status = 'aborted', finished_at = COALESCE(finished_at, ?) WHERE status = 'running'").run(startedAt.toISOString());
  sdb.prepare("DELETE FROM sync_events WHERE ts < ?").run(new Date(Date.now() - 14 * 86400_000).toISOString()); // keep the DB small: CI commits it every run
  sdb.prepare("INSERT INTO sync_runs (id, started_at, mode, trigger, status) VALUES (?,?,?,?, 'running')").run(syncId, startedAt.toISOString(), dryRun ? "dry_run" : "live", trigger);

  const s: SSyncSummary = {
    syncId, mode: dryRun ? "dry_run" : "live", trigger, status: "success", startedAt: startedAt.toISOString(), finishedAt: "", durationMs: 0, limit, shopifyChecked: false,
    sourceHealthy: false, fx: null, discovery: null,
    counts: {
      discovered: 0, products: 0, processed: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, priceChanges: 0, variantChanges: 0, imagesAdded: 0, imageChanges: 0, specChanges: 0,
      availabilityChanges: 0, unavailable: 0, pricesPaused: 0, archived: 0, missing: 0, needsReview: 0, failed: 0, rateLimitEvents: 0,
    },
    errors: [], warnings: [], products: [],
  };
  const http = new PoliteHttp(settings.REQUEST_DELAY_MS, log, { userAgent: STANLEY_SOURCE.userAgent, label: "Stanley 1913", acceptLanguage: "en-US,en;q=0.9", challenge: /captcha-container|g-recaptcha|verify you are human|cf-challenge/i });

  try {
    log.info("start", `STANLEY SYNC STARTED (${s.mode}, limit=${limit || "none - full catalog"}, trigger=${trigger})`);
    if (!settings.AUTHORIZED_IMPORTER) s.warnings.push("STANLEY_AUTHORIZED_IMPORTER=false: Stanley images and description text are not copied to Shopify.");
    if (limit && !opts.limit) s.warnings.push(`Test guard: at most ${limit} products per run (full catalog needs STANLEY_FULL_SYNC=true and STANLEY_TEST_MODE=false).`);

    let shopify: StanleyOps | null = null;
    if (hasShopifyCredentials()) {
      shopify = new StanleyOps(log);
      await shopify.ensureDefinitions(dryRun);
      await shopify.resolveLocation();
      s.shopifyChecked = true;
    } else if (!dryRun) {
      throw new Aborted("Live sync requires Shopify Admin API credentials (SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET). See README.");
    } else {
      s.warnings.push("No Shopify credentials: dry run matched against the local database only.");
    }

    // ---- exchange rate: fetched once per run, stored with every product it prices ----
    const fx = await getExchangeRate(settings, log, { store: STANLEY_FX_STORE });
    s.fx = { ok: fx.ok, rate: fx.rate, provider: fx.provider, providerUpdatedAt: fx.providerUpdatedAt, fetchedAt: fx.fetchedAt, origin: fx.origin, reason: fx.reason };
    if (fx.ok) log.info("fx", `Exchange rate: 1 ${fx.base} = ₹${fx.rate} (${fx.provider}, ${fx.origin})`);
    else s.warnings.push(`NO VALID EXCHANGE RATE (${fx.reason}). Price updates are paused; new products are not created until a valid rate is available.`);
    if (fx.origin === "cached") s.warnings.push(`Exchange rate provider unavailable - using the last valid rate: ${fx.reason}`);

    // ---- discovery: the whole live catalog, every run (new launches are found automatically) ----
    log.info("discover", "Discovery started");
    let catalog;
    try { catalog = await fetchStanleyCatalog(http, log); }
    catch (e) { log.error("health", `SOURCE_SCAN_UNRELIABLE: ${errMsg(e)}`); throw new Aborted(`SOURCE_SCAN_UNRELIABLE: ${errMsg(e)}`); }
    if (!catalog.products.length) {
      log.error("health", `SOURCE_SCAN_UNRELIABLE: ${catalog.reason ?? "catalog empty"}`);
      throw new Aborted(`SOURCE_SCAN_UNRELIABLE: ${catalog.reason ?? "catalog returned no products"}`);
    }
    let complete = catalog.complete;
    if (!complete) { log.error("health", `SOURCE_SCAN_UNRELIABLE: ${catalog.reason}`); s.warnings.push(`SOURCE_SCAN_UNRELIABLE: ${catalog.reason} - missing-product detection skipped this run.`); }
    const lastComplete = Number(getSState("last_complete_count") ?? 0);
    if (complete && lastComplete && catalog.products.length < lastComplete * 0.5) {
      complete = false;
      log.error("health", `SOURCE_SCAN_UNRELIABLE: ${catalog.products.length} listings vs ${lastComplete} last time`);
      s.warnings.push(`SOURCE_SCAN_UNRELIABLE: catalog lists only ${catalog.products.length} listings vs ${lastComplete} last time - treated as incomplete, missing-product detection skipped.`);
    }

    const grouping = groupStanleyCatalog(catalog.products, settings);
    for (const inv of grouping.invalid) { log.warn("parse", `${inv.handle}: ${inv.reason}`); s.errors.push({ id: inv.handle, stage: "parse", kind: "missing_product_id", message: inv.reason }); }
    let pool: ProductGroup[] = grouping.groups;
    const wanted = opts.products?.length ? new Set(opts.products.map((x) => x.trim().toLowerCase())) : null;
    if (wanted) {
      pool = pool.filter((g) => wanted.has(g.titleKey) || g.listings.some((p) => wanted.has(p.handle.toLowerCase()) || wanted.has(String(p.id))));
      s.warnings.push(`Product filter: ${pool.length} of ${wanted.size} requested product(s) found in the catalog.`);
    }
    if (limit > 0) pool = pool.slice(0, limit);
    s.counts.discovered = catalog.products.length;
    const excludedCount = Object.values(grouping.excluded).reduce((a, b) => a + b, 0);
    s.discovery = { listings: catalog.products.length, pages: catalog.pages, complete, products: grouping.groups.length, excluded: grouping.excluded, invalid: grouping.invalid.length, detailRequests: 0, requests: 0 };
    log.info("discover", `${catalog.products.length} Stanley listings -> ${grouping.groups.length} FSR products (${excludedCount} listings excluded, ${grouping.invalid.length} invalid); processing ${pool.length}`);

    // currency health check on every run: the formula is only valid for USD prices
    const probe = pool[0]?.listings[0] ?? catalog.products[0];
    try {
      const d = await fetchListingDetail(http, probe.handle);
      s.discovery.detailRequests++;
      if (!d.gone && d.currency !== settings.SOURCE_CURRENCY) throw new Aborted(`SOURCE_SCAN_UNRELIABLE: catalog is priced in ${d.currency ?? "an unknown currency"}, expected ${settings.SOURCE_CURRENCY} - no prices written`);
      log.info("health", `source currency ${d.currency ?? "(withdrawn probe)"} confirmed on ${probe.handle}`);
    } catch (e) {
      if (e instanceof Aborted) { log.error("health", e.message); throw e; }
      log.error("health", `SOURCE_SCAN_UNRELIABLE: currency probe ${errMsg(e)}`);
      throw new Aborted(`SOURCE_SCAN_UNRELIABLE: could not confirm the price currency (${errMsg(e)})`);
    }

    // ---- details (sequential, polite): barcodes / weight / currency per listing, specifications per product page.
    // Cached for DETAILS_MAX_AGE_HOURS; a listing with a SKU the cache has not seen is re-read at once. ----
    const maxAgeMs = settings.DETAILS_MAX_AGE_HOURS * 3600_000;
    const stale = (fetchedAt: string | null) => !fetchedAt || Date.now() - new Date(fetchedAt).getTime() > maxAgeMs;
    const detailsOf = new Map<string, ProductDetails>();
    let blocked: string | null = null;
    for (const g of pool) {
      const barcodes: Record<string, string> = {};
      const weights: Record<string, string> = {};
      let page: PageDetail | null = null;
      try {
        if (settings.FETCH_DETAILS) {
          for (const p of g.listings) {
            let ld = listingDetail(p.handle);
            const known = ld?.barcodes ? (JSON.parse(ld.barcodes) as Record<string, string>) : {};
            const newSku = p.variants.some((v) => v.sku && !(v.sku.trim().toUpperCase() in known));
            if (!ld || stale(ld.fetched_at) || newSku) {
              const d = await fetchListingDetail(http, p.handle);
              s.discovery.detailRequests++;
              if (!d.gone && d.currency && d.currency !== settings.SOURCE_CURRENCY) {
                throw new Aborted(`SOURCE_SCAN_UNRELIABLE: ${p.handle} is priced in ${d.currency}, expected ${settings.SOURCE_CURRENCY} - no prices written`);
              }
              ld = { handle: p.handle, currency: d.currency, barcodes: JSON.stringify(d.barcodes), weights: JSON.stringify(d.weights), fetched_at: new Date().toISOString() };
              if (!dryRun) saveListingDetail(ld);
            }
            for (const [k, v] of Object.entries(JSON.parse(ld.barcodes ?? "{}") as Record<string, string>)) if (v) barcodes[k] = v;
            Object.assign(weights, JSON.parse(ld.weights ?? "{}"));
          }
          const primary = g.listings[0];
          let pd = pageDetail(primary.handle);
          if (!pd || stale(pd.fetched_at)) {
            const d = await fetchPageDetail(http, primary.handle);
            s.discovery.detailRequests++;
            pd = { handle: primary.handle, specs: d ? JSON.stringify(d.specs) : null, care: d?.care ?? null, breadcrumb: d ? JSON.stringify(d.breadcrumb) : null, fetched_at: new Date().toISOString() };
            if (!dryRun) savePageDetail(pd);
          }
          page = pd.specs ? { specs: JSON.parse(pd.specs), care: pd.care, breadcrumb: pd.breadcrumb ? JSON.parse(pd.breadcrumb) : [] } : null;
        }
      } catch (e) {
        if (e instanceof Aborted) throw e;
        if (e instanceof SourceBlockedError) { blocked = e.message; log.error("health", `SOURCE_SCAN_UNRELIABLE: ${e.message}`); break; }
        log.warn("details", `details unavailable (${errMsg(e)}) - synced without barcodes / specifications`, undefined, g.titleKey);
      }
      detailsOf.set(g.titleKey, { barcodes, weights, page });
    }
    if (blocked) { s.status = "aborted"; s.errors.push({ stage: "source", kind: "rate_limited", message: `SOURCE_SCAN_UNRELIABLE: ${blocked}` }); pool = pool.filter((g) => detailsOf.has(g.titleKey)); }
    s.sourceHealthy = complete && !blocked;

    // ---- identity for every product of the catalog (also the ones not processed this run: keeps keys stable) ----
    const ix = buildKeyIndex(allRows());
    const claimed = new Set<string>();
    const keyOf = new Map<string, { key: string; matchedBy: string | null }>();
    const seenKeys = new Set<string>();
    for (const g of grouping.groups) {
      const primary = g.listings[0];
      const lite = {
        sourceProductIds: Object.fromEntries(g.listings.map((p) => [p.handle, String(p.id)])), primaryProductId: String(primary.id), handles: g.listings.map((p) => p.handle), titleKey: g.titleKey,
        skus: g.listings.flatMap((p) => p.variants.map((v) => (v.sku ?? "").trim().toUpperCase()).filter((k) => k && !g.foreignSkus?.has(k))),
      };
      const k = resolveKey(lite, ix, claimed);
      claimed.add(k.key);
      seenKeys.add(k.key);
      keyOf.set(g.titleKey, k);
    }

    // ---- per product: normalize -> price -> match -> plan -> write. One failure never stops the run. ----
    let failures = 0;
    const ctx: Ctx = { settings, dryRun, shopify, log, syncId, fx, claimed };
    let next = 0;
    const worker = async () => {
      while (next < pool.length) {
        const g = pool[next++];
        const { key, matchedBy } = keyOf.get(g.titleKey)!;
        let rep: SProductReport;
        try {
          const n = normalizeStanley(g, detailsOf.get(g.titleKey) ?? { barcodes: {}, weights: {}, page: null }, settings);
          rep = await processProduct(key, matchedBy, n, ctx);
        } catch (e) {
          failures++;
          const kind = classify(e);
          const msg = errMsg(e);
          log.error("product", `[${kind}] ${msg}`, undefined, key);
          s.errors.push({ id: key, stage: "product", kind, message: msg });
          rep = failedReport(key, g, msg, kind, settings);
          if (!dryRun) {
            upsertRow({ product_key: key, title_key: g.titleKey, last_sync_status: "failed", error_message: msg, last_seen_at: new Date().toISOString(), missing_scans: 0 });
            const pid = getRow(key)?.shopify_product_id;
            if (pid && shopify) await shopify.metafieldsSet(pid, [{ namespace: SNS, key: "sync_error", type: "multi_line_text_field", value: `${new Date().toISOString()} ${msg}`.slice(0, 4000) }]).catch(() => undefined);
          }
        }
        s.products.push(rep);
        tally(s, rep);
        s.counts.processed++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(settings.MAX_CONCURRENT_PRODUCTS, Math.max(pool.length, 1)) }, worker));
    s.counts.products = pool.length;
    s.counts.skipped = s.counts.needsReview + excludedCount;
    s.products.sort((a, b) => pool.findIndex((g) => keyOf.get(g.titleKey)!.key === a.key) - pool.findIndex((g) => keyOf.get(g.titleKey)!.key === b.key));

    if (!dryRun && shopify && !blocked) await publishPending(shopify, settings, log, s);

    // ---- missing products: only after a healthy, complete, unlimited, unfiltered scan with no failures; action only
    // after PRODUCT_MISSING_CONFIRMATION_SCANS (>= 2) such scans in a row ----
    if (s.sourceHealthy && !limit && !wanted && !failures) {
      for (const row of allRows()) {
        if (seenKeys.has(row.product_key) || !row.shopify_product_id) continue;
        await handleMissing(row, { settings, dryRun, shopify, log, s });
      }
      if (!dryRun) setSState("last_complete_count", String(catalog.products.length));
    } else if (!limit && !wanted) {
      s.warnings.push(`Missing-product detection skipped this run (${!s.sourceHealthy ? "SOURCE_SCAN_UNRELIABLE" : `${failures} product(s) failed`}).`);
    }
  } catch (e) {
    s.status = e instanceof Aborted ? "aborted" : "failed";
    s.errors.push({ stage: "sync", kind: classify(e), message: errMsg(e) });
    log.error("sync", errMsg(e));
  } finally {
    if (s.status === "success" && s.counts.failed > 0) s.status = "partial";
    s.counts.rateLimitEvents = http.rateLimitEvents;
    if (s.discovery) s.discovery.requests = http.requests;
    const finished = new Date();
    s.finishedAt = finished.toISOString();
    s.durationMs = finished.getTime() - startedAt.getTime();
    const { products: _p, ...rest } = s;
    sdb.prepare("UPDATE sync_runs SET finished_at = ?, duration_ms = ?, status = ?, summary_json = ?, errors_json = ? WHERE id = ?")
      .run(s.finishedAt, s.durationMs, s.status, JSON.stringify(rest), JSON.stringify(s.errors), syncId);
    fs.writeFileSync(path.join(LOG_DIR, `${syncId}.report.json`), JSON.stringify(s, null, 2));
    fs.writeFileSync(path.join(LOG_DIR, `${syncId}.report.txt`), formatStanleyReport(s));
    log.info("complete", `STANLEY SYNC COMPLETE: ${s.status} in ${Math.round(s.durationMs / 1000)}s`, rest.counts as unknown as Record<string, unknown>);
    releaseSLock();
  }
  return s;
}

interface Ctx { settings: StanleySettings; dryRun: boolean; shopify: StanleyOps | null; log: Logger; syncId: string; fx: FxRate; claimed: Set<string> }

export function pricesFor(n: NormalizedProduct, fx: FxRate, settings: StanleySettings): Map<string, StanleyPrice> {
  return new Map(n.variants.map((v) => [v.sku, calculateStanleyPrice({ currentUsd: v.currentUsd, regularUsd: v.regularUsd, currency: settings.SOURCE_CURRENCY }, fx, settings)]));
}

async function processProduct(key: string, matchedBy: string | null, n: NormalizedProduct, ctx: Ctx): Promise<SProductReport> {
  const { settings, dryRun, shopify, log, syncId, fx } = ctx;
  const now = new Date().toISOString();
  const prices = pricesFor(n, fx, settings);
  const sample = [...prices.values()].filter((p) => p.ok).sort((a, b) => a.fsrPrice! - b.fsrPrice!)[0];
  log.info("parse", `Product parsed: ${n.title} - ${n.variants.length} variant(s), ${n.images.length} images`, undefined, key);
  if (sample) log.info("price", `$${sample.sourcePriceUsd}${sample.sourceSalePriceUsd != null ? ` (sale; regular $${sample.sourceRegularPriceUsd})` : ""} x ₹${fx.rate} = ₹${sample.convertedPriceInr?.toFixed(2)} + ₹${settings.PRICING_ADJUSTMENT_INR} = FSR ₹${sample.fsrPrice}`, undefined, key);

  const r = getRow(key);
  const fsrPriceHash = hash([...prices.entries()].map(([k, p]) => [k, p.fsrPrice, p.compareAtPrice]));
  const pricesOk = [...prices.values()].every((p) => p.ok);
  const changes: string[] = [];
  if (!r?.shopify_product_id) changes.push("new");
  if (r?.price_hash && r.price_hash !== n.hashes.price) changes.push("source USD price");
  if (pricesOk && r?.fsr_price_hash && r.fsr_price_hash !== fsrPriceHash && !changes.includes("source USD price")) changes.push("FSR price (exchange rate / settings)");
  if (r?.availability_hash && r.availability_hash !== n.hashes.availability) changes.push("availability");
  if (r?.variant_hash && r.variant_hash !== n.hashes.variant) changes.push("variants");
  if (r?.image_hash && r.image_hash !== n.hashes.image) changes.push("images");
  if (r?.specification_hash && r.specification_hash !== n.hashes.specification) changes.push("specifications");
  if (r?.content_hash && r.content_hash !== n.hashes.content) changes.push("content");
  if (r?.written_eta && r.written_eta !== settings.ETA) changes.push("ETA setting");
  if (settings.AUTHORIZED_IMPORTER && r?.shopify_product_id && !r.image_hash && n.images.length) changes.push("images pending");
  if (r?.last_sync_status && ["failed", "needs_review", "missing", "archived"].includes(r.last_sync_status)) changes.push(`retry after ${r.last_sync_status}`);

  const rep: SProductReport = { ...reportBase(key, n, settings, prices, fx), outcome: "unchanged", matchedBy, changes, shopifyProductId: r?.shopify_product_id ?? null };
  if (matchedBy && matchedBy !== "source product id") rep.notes.push(`matched to existing FSR product ${key} by ${matchedBy}`);

  // ---- match in Shopify: unique stanley_sync.source_product_id -> stored product id -> exact SKU lookup ----
  let existing: GShopifyProduct | null = null;
  if (shopify && (changes.length || !r?.shopify_product_id)) {
    existing = await shopify.byCustomId(key);
    if (!existing && r?.shopify_product_id) {
      existing = await shopify.byId(r.shopify_product_id);
      if (existing) rep.notes.push("matched by stored Shopify product id");
    }
    if (!existing) {
      const owners = (await shopify.productsWithSkus(n.skus)).filter((o) => o.status !== "ARCHIVED" || o.sourceId);
      const ours = owners.filter((o) => o.sourceId);
      const manual = owners.filter((o) => !o.sourceId);
      if (ours.length) {
        const other = ours.find((o) => o.sourceId !== key && ctx.claimed.has(o.sourceId!));
        if (other || ours.length > 1) {
          rep.outcome = "needs_review";
          rep.notes.push(`these SKUs are already on Stanley product(s) ${ours.map((o) => `"${o.title}" [${o.sourceId}]`).join(", ")} - left for review, nothing created`);
          if (!dryRun) upsertRow({ ...baseRow(key, n, now), last_sync_status: "needs_review", error_message: "SKUs shared with another Stanley product" });
          return rep;
        }
        existing = await shopify.byId(ours[0].id);
        rep.notes.push(`matched by source SKU to "${ours[0].title}" (was stanley id ${ours[0].sourceId})`);
      } else if (manual.length) {
        rep.notes.push(`existing non-synced product(s) with these SKUs: ${manual.map((c) => `"${c.title}" [${c.status}]`).join(", ")}`);
        if (!settings.ADOPT_EXISTING_PRODUCTS) {
          rep.outcome = "needs_review";
          rep.notes.push("not imported: a product listed by hand already uses these SKUs. Set STANLEY_ADOPT_EXISTING_PRODUCTS=true to link it (manual title/description/price kept).");
          if (!dryRun) upsertRow({ ...baseRow(key, n, now), last_sync_status: "needs_review", error_message: "SKU collision with manual product" });
          return rep;
        }
        existing = await shopify.byId(manual[0].id);
        rep.notes.push(`adopting existing product "${manual[0].title}"`);
      }
    }
  }
  const identifier: Record<string, unknown> = existing ? { id: existing.id } : { customId: { namespace: SNS, key: "source_product_id", value: key } };

  if (r?.shopify_product_id && !changes.length) {
    rep.outcome = dryRun ? "planned_unchanged" : "unchanged";
    log.info("shopify", "Product unchanged", undefined, key);
    if (!dryRun) upsertRow({ product_key: key, last_seen_at: now, missing_scans: 0, availability: n.availability });
    return rep;
  }
  if (!existing && !r?.shopify_product_id && !pricesOk) {
    rep.outcome = "needs_review";
    rep.notes.push(`not created: ${[...prices.values()].find((p) => !p.ok)?.reason}`);
    return rep;
  }

  let plan;
  try {
    plan = buildStanleyPlan({ key, n, existing, row: r, settings, prices, fx, images: imagesFor(key), locationId: shopify?.locationId ?? null, nowIso: now, importStatus: existing ? "updated" : "created" });
  } catch (e) {
    if (!(e instanceof PlanConflict)) throw e;
    rep.outcome = "needs_review";
    rep.notes.push(e.message);
    if (!dryRun) upsertRow({ ...baseRow(key, n, now), shopify_product_id: existing?.id ?? r?.shopify_product_id ?? null, last_sync_status: "needs_review", error_message: e.message });
    return rep;
  }
  rep.notes.push(...plan.notes);
  rep.imagesAdded = ((plan.input.files as Record<string, unknown>[] | undefined) ?? []).filter((f) => "originalSource" in f).length;

  if (dryRun) {
    rep.outcome = plan.action === "create" ? "planned_create" : "planned_update";
    rep.planned = plan.metafields.length ? { ...plan.input, "(metafieldsSet)": plan.metafields } : plan.input;
    return rep;
  }

  let result = await retry(() => shopify!.productSet(plan.input, identifier), {
    attempts: 3, baseMs: 3000, shouldRetry: (e) => (e as { retryable?: boolean }).retryable === true,
    onRetry: (e, a, wait) => log.warn("shopify", `productSet retry ${a} in ${wait}ms: ${errMsg(e)}`, undefined, key),
  });
  if (plan.metafields.length) await shopify!.metafieldsSet(result.id, plan.metafields);
  if ((plan.input.variants as unknown[]).length >= 250) {
    const full = await shopify!.byId(result.id);
    if (full) result = { ...result, variants: { nodes: full.variants.nodes } };
  }
  // verify: every variant we sent is on the product
  const onProduct = new Set(result.variants.nodes.map((v) => (v.sku ?? "").toUpperCase()));
  const lost = (plan.input.variants as { sku?: string }[]).filter((v) => v.sku && !onProduct.has(v.sku.toUpperCase()));
  if (lost.length) throw new Error(`productSet verification failed: ${lost.length} variant(s) missing after the write (e.g. ${lost[0].sku})`);
  rep.outcome = plan.action === "create" ? "created" : "updated";
  rep.shopifyProductId = result.id;
  log.info("shopify", `Shopify product ${rep.outcome} ${result.id}`, { notes: plan.notes }, key);

  // ---- image bookkeeping (dedupe on the next run) + each variant's own photo ----
  let imageHash = r?.image_hash ?? null;
  if (plan.imagesSent) {
    const alts = new Map(n.images.map((i) => [i.key, i.alt]));
    const mapped = mapUploadedMedia(plan.imagesSent, result.media.nodes, alts);
    if (mapped) {
      replaceImages(key, plan.imagesSent.map((im) => ({ source_key: im.key, colour: im.colour, media_id: mapped.get(im.key) ?? null, uploaded_at: now })));
      imageHash = n.hashes.image;
      if (rep.imagesAdded) log.info("images", `Images uploaded: ${rep.imagesAdded} new`, undefined, key);
      const firstByColour = new Map<string, string>();
      for (const im of plan.imagesSent) if (im.colour && !firstByColour.has(im.colour) && mapped.get(im.key)) firstByColour.set(im.colour, mapped.get(im.key)!);
      const colourOf = new Map(n.variants.map((v) => [v.sku, v.colour]));
      const pairs = result.variants.nodes
        .map((v) => ({ id: v.id, mediaId: firstByColour.get(colourOf.get((v.sku ?? "").toUpperCase()) ?? "") }))
        .filter((x): x is { id: string; mediaId: string } => !!x.mediaId);
      if (pairs.length && n.hasColourOption) { await shopify!.setVariantMedia(result.id, pairs); log.info("shopify", `${pairs.length} variant image(s) set`, undefined, key); }
    } else {
      rep.notes.push(`could not map uploaded media (${result.media.nodes.length} on product, ${plan.imagesSent.length} sent) - images will be re-checked next sync`);
      log.warn("images", "image upload could not be matched to source images", { sent: plan.imagesSent.length, onProduct: result.media.nodes.length }, key);
      imageHash = null;
    }
  } else if (settings.AUTHORIZED_IMPORTER && existing?.media.nodes.length && !r) {
    imageHash = n.hashes.image;
  }

  // ---- price history (per colour, from the previous snapshot) ----
  if (!plan.pricesPaused && r?.snapshot_json) {
    const prev = JSON.parse(r.snapshot_json) as { variants?: { sku: string; colour: string; usd: number | null; fsrPrice: number | null }[] };
    for (const v of n.variants) {
      const old = prev.variants?.find((x) => x.colour === v.colour);
      const p = prices.get(v.sku);
      if (old && p?.ok && old.usd !== v.currentUsd) {
        recordPriceChange({ key, colour: v.colour, at: now, oldUsd: old.usd, newUsd: v.currentUsd!, newRegular: p.sourceRegularPriceUsd, oldFsr: old.fsrPrice ?? null, newFsr: p.fsrPrice!, rate: fx.rate!, syncId });
        log.info("price", `${v.colour}: $${old.usd} -> $${v.currentUsd}; FSR ₹${old.fsrPrice ?? "?"} -> ₹${p.fsrPrice}`, undefined, key);
      }
    }
  }

  const cheapest = [...prices.values()].filter((p) => p.ok).sort((a, b) => a.fsrPrice! - b.fsrPrice!)[0];
  upsertRow({
    ...baseRow(key, n, now),
    shopify_product_id: result.id,
    shopify_status: (plan.input.status as string) ?? existing?.status ?? r?.shopify_status ?? null,
    ...(plan.pricesPaused ? {} : {
      source_price_usd: cheapest?.sourcePriceUsd ?? null, source_regular_price_usd: cheapest?.sourceRegularPriceUsd ?? null, source_sale_price_usd: cheapest?.sourceSalePriceUsd ?? null,
      converted_price_inr: cheapest?.convertedPriceInr != null ? Math.round(cheapest.convertedPriceInr * 100) / 100 : null, pricing_adjustment_inr: settings.PRICING_ADJUSTMENT_INR,
      fsr_selling_price: cheapest?.fsrPrice ?? null, exchange_rate: fx.rate, exchange_rate_timestamp: fx.fetchedAt, exchange_rate_provider: fx.provider,
      price_hash: n.hashes.price, fsr_price_hash: fsrPriceHash,
    }),
    last_synced_at: now,
    last_sync_status: rep.outcome,
    content_hash: n.hashes.content,
    image_hash: imageHash,
    specification_hash: n.hashes.specification,
    variant_hash: plan.deferredVariants ? null : n.hashes.variant,
    availability_hash: n.hashes.availability,
    written_title: plan.written.title,
    written_desc_hash: "descriptionHtml" in plan.input ? hash(result.descriptionHtml) : plan.written.descHash,
    written_seo_hash: plan.written.seoHash,
    written_eta: plan.written.eta,
    written_prices: JSON.stringify(plan.written.prices),
    error_message: null,
    snapshot_json: JSON.stringify({ key, title: n.title, variants: n.variants.map((v) => ({ sku: v.sku, colour: v.colour, usd: v.currentUsd, fsrPrice: prices.get(v.sku)?.fsrPrice ?? null })) }),
  });
  return rep;
}

function baseRow(key: string, n: NormalizedProduct, now: string): Partial<StanleyRow> & { product_key: string } {
  const existing = getRow(key);
  const skus = new Set([...(existing?.source_skus ? (JSON.parse(existing.source_skus) as string[]) : []), ...n.skus]);
  return {
    product_key: key, title_key: n.titleKey, source_product_ids: JSON.stringify(n.sourceProductIds), source_handles: JSON.stringify(n.handles), source_skus: JSON.stringify([...skus]),
    source_url: n.sourceUrl, canonical_url: n.canonicalUrl, title: n.title, category: n.category, collection: n.collection, capacity: n.capacity,
    product_type: n.productType, colours: JSON.stringify(n.variants.map((v) => v.colour)), availability: n.availability, source_updated_at: n.sourceUpdatedAt,
    first_seen_at: existing?.first_seen_at ?? now, last_seen_at: now, missing_scans: 0,
  };
}

function reportBase(key: string, n: NormalizedProduct, settings: StanleySettings, prices: Map<string, StanleyPrice>, fx: FxRate): SProductReport {
  return {
    key, sourceProductIds: Object.values(n.sourceProductIds), title: n.title, name: n.name, url: n.sourceUrl, outcome: "unchanged", category: n.category, productType: n.productType, capacity: n.capacity,
    variants: n.variants.map((v) => {
      const p = prices.get(v.sku);
      return { colour: v.colour, sku: v.sku, availability: v.availability, usd: p?.sourcePriceUsd ?? v.currentUsd, regularUsd: p?.sourceRegularPriceUsd ?? null, saleUsd: p?.sourceSalePriceUsd ?? null, convertedInr: p?.convertedPriceInr ?? null, fsrPrice: p?.fsrPrice ?? null, compareAt: p?.compareAtPrice ?? null };
    }),
    adjustment: settings.PRICING_ADJUSTMENT_INR, exchangeRate: fx.rate, availability: n.availability, eta: settings.ETA,
    images: n.images.length, imagesAdded: 0, barcodes: n.variants.filter((v) => v.barcode).length, specifications: Object.keys(n.specs).length, matchedBy: null,
    changes: [], notes: [
      ...(n.handles.length > 1 ? [`${n.handles.length} Stanley listings merged into one product`] : []),
      ...(n.duplicatesSkipped ? [`${n.duplicatesSkipped} duplicate colour listing(s) merged`] : []),
      ...(n.imagesSkipped ? [`${n.imagesSkipped} photo(s) of retired colours / over the per-colour cap left out`] : []),
    ],
    missing: n.missing, timestamp: new Date().toISOString(),
  };
}

function failedReport(key: string, g: ProductGroup, msg: string, kind: FailureKind, settings: StanleySettings): SProductReport {
  return {
    key, sourceProductIds: g.listings.map((p) => String(p.id)), title: g.listings[0]?.title ?? key, name: g.listings[0]?.title ?? key, url: `${STANLEY_SOURCE.origin}/products/${g.listings[0]?.handle ?? ""}`,
    outcome: "failed", category: null, productType: null, capacity: null, variants: [], adjustment: settings.PRICING_ADJUSTMENT_INR, exchangeRate: null, availability: null,
    eta: settings.ETA, images: 0, imagesAdded: 0, barcodes: 0, specifications: 0, matchedBy: null, changes: [], notes: [], missing: [], timestamp: new Date().toISOString(), error: msg, errorKind: kind,
  };
}

async function handleMissing(row: StanleyRow, ctx: { settings: StanleySettings; dryRun: boolean; shopify: StanleyOps | null; log: Logger; s: SSyncSummary }) {
  const { settings, dryRun, shopify, log, s } = ctx;
  if (row.last_sync_status === "archived") return;
  const scans = row.missing_scans + 1;
  s.counts.missing++;
  const threshold = Math.max(2, settings.PRODUCT_MISSING_CONFIRMATION_SCANS);
  if (scans < threshold) {
    log.warn("removal", `not in the Stanley catalog - warning (${scans}/${threshold} confirmation scans)`, undefined, row.product_key);
    if (!dryRun) upsertRow({ product_key: row.product_key, missing_scans: scans, last_sync_status: "missing" });
    return;
  }
  if (dryRun || !shopify) { log.info("removal", `[dry-run] would mark missing and ${settings.MISSING_ACTION} after ${scans} missing scans`, undefined, row.product_key); return; }
  try {
    const status = settings.MISSING_ACTION === "archive" ? "ARCHIVED" : "DRAFT";
    await shopify.metafieldsSet(row.shopify_product_id!, [{ namespace: SNS, key: "source_status", type: "single_line_text_field", value: "missing" }]);
    await shopify.setStatus(row.shopify_product_id!, status); // never deleted
    s.counts.archived++;
    upsertRow({ product_key: row.product_key, missing_scans: scans, last_sync_status: "archived", shopify_status: status });
    log.warn("removal", `source_status = missing; ${status} after ${scans} consecutive complete scans without it`, undefined, row.product_key);
  } catch (e) {
    s.counts.failed++;
    s.errors.push({ id: row.product_key, stage: "removal", kind: "shopify_api", message: errMsg(e) });
    log.error("removal", errMsg(e), undefined, row.product_key);
  }
}

async function publishPending(shopify: StanleyOps, settings: StanleySettings, log: Logger, s: SSyncSummary) {
  const pending = allRows().filter((r) => r.shopify_product_id && r.shopify_status === "ACTIVE" && !r.published);
  if (!pending.length) return;
  const pubs = await shopify.resolvePublications(settings.PUBLISH_CHANNELS.split(","));
  if (!pubs) { s.warnings.push(`${pending.length} ACTIVE product(s) not yet published to sales channels: the Shopify app needs read_publications + write_publications.`); return; }
  let ok = 0;
  for (const r of pending) {
    try { await shopify.publish(r.shopify_product_id!, pubs); upsertRow({ product_key: r.product_key, published: 1 }); ok++; }
    catch (e) { s.errors.push({ id: r.product_key, stage: "publish", kind: "shopify_api", message: errMsg(e) }); log.error("publish", errMsg(e), undefined, r.product_key); }
  }
  log.info("publish", `published ${ok}/${pending.length} product(s) to: ${settings.PUBLISH_CHANNELS}`);
}

function tally(s: SSyncSummary, r: SProductReport) {
  const c = s.counts;
  if (r.outcome === "created" || r.outcome === "planned_create") c.created++;
  else if (r.outcome === "updated" || r.outcome === "planned_update") c.updated++;
  else if (r.outcome === "unchanged" || r.outcome === "planned_unchanged") c.unchanged++;
  else if (r.outcome === "needs_review") c.needsReview++;
  else if (r.outcome === "failed") c.failed++;
  if (r.availability && !SELLABLE.includes(r.availability as never)) c.unavailable++;
  c.imagesAdded += r.imagesAdded;
  if (r.notes.some((x) => x.startsWith("PRICE UPDATES PAUSED"))) c.pricesPaused++;
  if (!r.changes.includes("new")) {
    if (r.changes.some((x) => /price/i.test(x))) c.priceChanges++;
    if (r.changes.includes("images")) c.imageChanges++;
    if (r.changes.includes("specifications")) c.specChanges++;
    if (r.changes.includes("availability")) c.availabilityChanges++;
    if (r.changes.includes("variants")) c.variantChanges++;
  }
}

const inr = (v: number | null) => (v == null ? "—" : `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
const usd = (v: number | null) => (v == null ? "—" : `$${v.toFixed(2)}`);
const ACTION: Partial<Record<Outcome, string>> = { planned_create: "CREATE", created: "CREATED", planned_update: "UPDATE", updated: "UPDATED", planned_unchanged: "SKIP (unchanged)", unchanged: "SKIP (unchanged)", needs_review: "SKIP (needs review)", failed: "FAILED" };

export function formatStanleyReport(s: SSyncSummary): string {
  const c = s.counts;
  const L: string[] = [];
  L.push(`STANLEY SYNC COMPLETE — ${s.syncId}  (${s.mode === "dry_run" ? "DRY RUN - no Shopify changes made" : "LIVE"})`);
  L.push("");
  L.push(`Discovered: ${c.discovered} Stanley listings -> ${s.discovery?.products ?? 0} FSR products (${c.products} processed this run)`);
  L.push(`New: ${c.created}${s.mode === "dry_run" ? " (would be created)" : ""}`);
  L.push(`Updated: ${c.updated}`);
  L.push(`Unchanged: ${c.unchanged}`);
  L.push(`Skipped: ${c.skipped} (${c.needsReview} needs review, ${c.skipped - c.needsReview} listings excluded)`);
  L.push(`Failed: ${c.failed}`);
  L.push(`Variants updated: ${c.variantChanges}`);
  L.push(`Images updated: ${c.imagesAdded} uploaded${c.imageChanges ? `, ${c.imageChanges} product(s) with changed photos` : ""}`);
  L.push(`Price changes: ${c.priceChanges}`);
  L.push("");
  L.push(`Status:                  ${s.status}`);
  L.push(`Started / finished:      ${s.startedAt} / ${s.finishedAt} (${Math.round(s.durationMs / 1000)}s)`);
  L.push(`Exchange rate:           ${s.fx ? (s.fx.ok ? `1 USD = ₹${s.fx.rate} (${s.fx.provider}, ${s.fx.origin})` : `NONE - ${s.fx.reason}`) : "—"}`);
  L.push(`Exchange rate timestamp: ${s.fx?.fetchedAt ?? "—"} (provider time ${s.fx?.providerUpdatedAt ?? "n/a"})`);
  if (s.discovery) {
    const ex = Object.entries(s.discovery.excluded).map(([k, v]) => `${v} ${k}`).join(", ");
    L.push(`Source:                  stanley1913.com /products.json - ${s.discovery.listings} listings on ${s.discovery.pages} page(s)${s.discovery.complete ? "" : " (INCOMPLETE)"}${ex ? `; excluded: ${ex}` : ""}`);
    L.push(`Requests:                ${s.discovery.requests} (${s.discovery.detailRequests} detail)${s.limit ? `; limited to ${s.limit} products` : ""}`);
  }
  L.push(`Source health:           ${s.sourceHealthy ? "OK" : "SOURCE_SCAN_UNRELIABLE - no missing-product cleanup"}`);
  L.push(`Shopify matching:        ${s.shopifyChecked ? "checked against live store" : "NOT checked - local database only"}`);
  L.push(`Unavailable (sold out):  ${c.unavailable}    Prices paused: ${c.pricesPaused}    Missing: ${c.missing}    Archived: ${c.archived}    Rate-limit events: ${c.rateLimitEvents}`);
  L.push(`Errors:                  ${s.errors.length ? "" : "none"}`);
  for (const e of s.errors.slice(0, 50)) L.push(`  - [${e.stage}${e.kind ? `/${e.kind}` : ""}] ${e.id ?? ""} ${e.message}`);
  if (s.errors.length > 50) L.push(`  ... ${s.errors.length - 50} more (see the .report.json)`);
  if (s.warnings.length) { L.push(""); L.push("WARNINGS:"); for (const w of s.warnings) L.push(`  ! ${w}`); }
  L.push(""); L.push("==== PRODUCTS ====");
  for (const p of s.products) {
    L.push("");
    L.push(`${ACTION[p.outcome]}  ${p.title}`);
    L.push(`  Source product ID: ${p.key}${p.sourceProductIds.length > 1 ? ` (listings ${p.sourceProductIds.join(", ")})` : ""}`);
    L.push(`  Source URL:        ${p.url}`);
    L.push(`  Timestamp:         ${p.timestamp}`);
    if (p.error) { L.push(`  Error:             [${p.errorKind}] ${p.error}`); continue; }
    L.push(`  Category:          ${p.category ?? "—"}    Product type: ${p.productType ?? "—"}    Capacity: ${p.capacity ?? "—"}`);
    L.push(`  Variants:          ${p.variants.length}; barcodes ${p.barcodes}    Images: ${p.images}${p.imagesAdded ? ` (${p.imagesAdded} to upload)` : ""}    Specifications: ${p.specifications}`);
    for (const v of p.variants) {
      L.push(`    • ${v.colour.padEnd(26)} ${v.sku.padEnd(14)} ${v.availability.padEnd(12)} ${usd(v.usd)}${v.saleUsd != null ? ` (sale; regular ${usd(v.regularUsd)})` : ""} × ₹${p.exchangeRate ?? "?"} = ${inr(v.convertedInr != null ? Math.round(v.convertedInr * 100) / 100 : null)} + ${inr(p.adjustment)} = FSR ${inr(v.fsrPrice)}${v.compareAt ? `  compare-at ${inr(v.compareAt)}` : ""}`);
    }
    L.push(`  ETA:               ${p.eta}${p.shopifyProductId ? `    Shopify: ${p.shopifyProductId}` : ""}`);
    if (p.changes.length) L.push(`  Changes:           ${p.changes.join(", ")}`);
    for (const note of p.notes) L.push(`  - ${note}`);
    if (p.missing.length) L.push(`  Not on source:     ${p.missing.join(", ")}`);
  }
  return L.join("\n") + "\n";
}

export function nextStanleyScheduledAt(settings = getStanleySettings()): string | null {
  if (settings.SYNC_PAUSED || !settings.ENABLED) return null;
  const last = sdb.prepare("SELECT started_at FROM sync_runs WHERE trigger = 'scheduler' AND status != 'running' ORDER BY started_at DESC LIMIT 1").get() as { started_at: string } | undefined;
  if (!last) return new Date().toISOString();
  return new Date(new Date(last.started_at).getTime() + settings.SYNC_INTERVAL_HOURS * 3600_000).toISOString();
}
