import fs from "node:fs";
import path from "node:path";
import { LOG_DIR, hasShopifyCredentials } from "../config.ts";
import { getExchangeRate, type FxRate } from "../gymshark/fx.ts";
import type { GShopifyProduct } from "../gymshark/ops.ts";
import { mapUploadedMedia } from "../gymshark/plan.ts";
import { Logger } from "../logger.ts";
import { PoliteHttp } from "../politeHttp.ts";
import { SourceBlockedError, errMsg, hash, retry } from "../util.ts";
import { ALO_SOURCE, effectiveLimit, type AloSettings } from "./config.ts";
import {
  ALO_FX_STORE, acquireALock, adb, allRows, colourDetail, getAloSettings, getAState, getRow, imagesFor, nextAloSyncId, recordPriceChange, releaseALock,
  replaceImages, saveColourDetail, saveStyleDetail, setAState, styleDetail, upsertRow, type AloRow,
} from "./db.ts";
import { SELLABLE, groupAloCatalog, normalizeAlo, type NormalizedStyle, type StyleGroup } from "./normalize.ts";
import { ANS, AloOps } from "./ops.ts";
import { PlanConflict, buildAloPlan } from "./plan.ts";
import { calculateAloPrice, type AloPrice } from "./pricing.ts";
import { fetchAloCatalog, fetchColourDetail, fetchStyleAttribs } from "./source.ts";

export interface ASyncOptions { dryRun?: boolean; limit?: number; trigger?: string; styles?: string[] }

export type Outcome = "created" | "updated" | "unchanged" | "failed" | "needs_review" | "planned_create" | "planned_update" | "planned_unchanged";
export type FailureKind = "network" | "source_parsing" | "missing_price" | "missing_product_id" | "shopify_api" | "image_upload" | "exchange_rate" | "rate_limited" | "invalid_data";

export interface ColourPriceReport {
  colour: string; availability: string; usd: number | null; regularUsd: number | null; saleUsd: number | null;
  convertedInr: number | null; fsrPrice: number | null; compareAt: number | null;
}

export interface AProductReport {
  style: string;
  title: string;
  name: string;
  url: string;
  outcome: Outcome;
  category: string | null;
  gender: string | null;
  productType: string | null;
  colours: ColourPriceReport[];
  variants: number;
  sizes: string[];
  flat: number;
  availability: string | null;
  eta: string;
  images: number;
  imagesAdded: number;
  barcodes: number;
  specifications: number;
  changes: string[];
  notes: string[];
  missing: string[];
  shopifyProductId?: string | null;
  error?: string;
  errorKind?: FailureKind;
  planned?: Record<string, unknown>;
}

export interface ASyncSummary {
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
  discovery: { products: number; pages: number; complete: boolean; styles: number; excluded: Record<string, number>; invalid: number; detailRequests: number; requests: number } | null;
  counts: {
    discovered: number; styles: number; processed: number; created: number; updated: number; unchanged: number; priceChanges: number; variantChanges: number;
    imagesAdded: number; imageChanges: number; specChanges: number; availabilityChanges: number; unavailable: number; pricesPaused: number; archived: number;
    missing: number; needsReview: number; failed: number; rateLimitEvents: number;
  };
  errors: { id?: string; stage: string; kind?: FailureKind; message: string }[];
  warnings: string[];
  products: AProductReport[];
}

class Aborted extends Error {}

/** Error classification for the report (ALO / Shopify / FX failures are handled differently). */
export function classify(e: unknown): FailureKind {
  const m = errMsg(e);
  if (e instanceof SourceBlockedError || /HTTP 429|rate.?limit/i.test(m)) return "rate_limited";
  if (/network error|fetch failed|timeout|ECONN|ENOTFOUND/i.test(m)) return "network";
  if (/productSet|metafieldsSet|GraphQL|Shopify|userErrors|throttled/i.test(m)) return /media|image|file/i.test(m) ? "image_upload" : "shopify_api";
  if (/exchange rate/i.test(m)) return "exchange_rate";
  if (/missing price|no positive USD price/i.test(m)) return "missing_price";
  if (/missing product ID|StyleId/i.test(m)) return "missing_product_id";
  if (/JSON|parse|Unexpected token/i.test(m)) return "source_parsing";
  return "invalid_data";
}

export async function runAloSync(opts: ASyncOptions = {}): Promise<ASyncSummary> {
  const settings = getAloSettings();
  const dryRun = opts.dryRun ?? settings.DRY_RUN;
  const limit = opts.limit ?? effectiveLimit(settings);
  const trigger = opts.trigger ?? "manual";
  const syncId = nextAloSyncId();
  const log = new Logger(syncId, { db: adb, name: "alo-sync" });
  const startedAt = new Date();

  if (!acquireALock(syncId)) throw new Error("Another ALO sync is already running (lock held)");
  adb.prepare("UPDATE sync_runs SET status = 'aborted', finished_at = COALESCE(finished_at, ?) WHERE status = 'running'").run(startedAt.toISOString());
  adb.prepare("INSERT INTO sync_runs (id, started_at, mode, trigger, status) VALUES (?,?,?,?, 'running')").run(syncId, startedAt.toISOString(), dryRun ? "dry_run" : "live", trigger);

  const s: ASyncSummary = {
    syncId, mode: dryRun ? "dry_run" : "live", trigger, status: "success", startedAt: startedAt.toISOString(), finishedAt: "", durationMs: 0, limit, shopifyChecked: false,
    sourceHealthy: false, fx: null, discovery: null,
    counts: {
      discovered: 0, styles: 0, processed: 0, created: 0, updated: 0, unchanged: 0, priceChanges: 0, variantChanges: 0, imagesAdded: 0, imageChanges: 0, specChanges: 0,
      availabilityChanges: 0, unavailable: 0, pricesPaused: 0, archived: 0, missing: 0, needsReview: 0, failed: 0, rateLimitEvents: 0,
    },
    errors: [], warnings: [], products: [],
  };
  const http = new PoliteHttp(settings.REQUEST_DELAY_MS, log, { userAgent: ALO_SOURCE.userAgent, label: "ALO Yoga", acceptLanguage: "en-US,en;q=0.9", challenge: /captcha-container|g-recaptcha|verify you are human|cf-challenge/i });

  try {
    log.info("start", `ALO SYNC STARTED (${s.mode}, limit=${limit || "none - full catalog"}, trigger=${trigger})`);
    if (!settings.AUTHORIZATION_CONFIRMED) s.warnings.push("AUTHORIZATION_CONFIRMED=false: ALO images and description text are not copied to Shopify.");
    if (limit && !opts.limit) s.warnings.push(`Test guard: at most ${limit} styles per run (full catalog needs ALO_FULL_SYNC=true and ALO_TEST_MODE=false).`);

    let shopify: AloOps | null = null;
    if (hasShopifyCredentials()) {
      shopify = new AloOps(log);
      await shopify.ensureDefinitions(dryRun);
      await shopify.resolveLocation();
      s.shopifyChecked = true;
    } else if (!dryRun) {
      throw new Aborted("Live sync requires Shopify Admin API credentials (SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET). See README.");
    } else {
      s.warnings.push("No Shopify credentials: dry run matched against the local database only.");
    }

    // ---- exchange rate: fetched once per run, stored with every product it prices ----
    const fx = await getExchangeRate(settings, log, { store: ALO_FX_STORE });
    s.fx = { ok: fx.ok, rate: fx.rate, provider: fx.provider, providerUpdatedAt: fx.providerUpdatedAt, fetchedAt: fx.fetchedAt, origin: fx.origin, reason: fx.reason };
    if (fx.ok) log.info("fx", `Exchange rate retrieved: 1 ${fx.base} = ₹${fx.rate} (${fx.provider}, ${fx.origin})`);
    else s.warnings.push(`NO VALID EXCHANGE RATE (${fx.reason}). Price updates are paused; new products are not created until a valid rate is available.`);
    if (fx.origin === "cached") s.warnings.push(`Exchange rate provider unavailable - using the last valid rate: ${fx.reason}`);

    // ---- discovery: the whole live catalog, every run ----
    log.info("discover", "Discovery started");
    let catalog;
    try { catalog = await fetchAloCatalog(http, log); }
    catch (e) { log.error("health", `ALO SOURCE HEALTH CHECK FAILED: ${errMsg(e)}`); throw new Aborted(`ALO SOURCE HEALTH CHECK FAILED: ${errMsg(e)}`); }
    if (!catalog.products.length) {
      log.error("health", `ALO SOURCE HEALTH CHECK FAILED: ${catalog.reason ?? "catalog empty"}`);
      throw new Aborted(`ALO SOURCE HEALTH CHECK FAILED: ${catalog.reason ?? "catalog returned no products"}`);
    }
    let complete = catalog.complete;
    if (!complete) { log.error("health", `ALO SOURCE HEALTH CHECK FAILED: ${catalog.reason}`); s.warnings.push(`ALO SOURCE HEALTH CHECK FAILED: ${catalog.reason} - missing-product detection skipped this run.`); }
    const lastComplete = Number(getAState("last_complete_count") ?? 0);
    if (complete && lastComplete && catalog.products.length < lastComplete * 0.5) {
      complete = false;
      log.error("health", `ALO SOURCE HEALTH CHECK FAILED: ${catalog.products.length} products vs ${lastComplete} last time`);
      s.warnings.push(`ALO SOURCE HEALTH CHECK FAILED: catalog lists only ${catalog.products.length} products vs ${lastComplete} last time - treated as incomplete, missing-product detection skipped.`);
    }

    const grouping = groupAloCatalog(catalog.products, settings);
    for (const inv of grouping.invalid) { log.warn("parse", `${inv.handle}: ${inv.reason}`); s.errors.push({ id: inv.handle, stage: "parse", kind: "missing_product_id", message: inv.reason }); }
    let pool: StyleGroup[] = grouping.styles;
    const wanted = opts.styles?.length ? new Set(opts.styles.map((x) => x.trim().toUpperCase())) : null;
    if (wanted) {
      pool = pool.filter((g) => wanted.has(g.styleId) || g.listings.some((p) => wanted.has(p.handle.toUpperCase())));
      s.warnings.push(`Style filter: ${pool.length}/${wanted.size} requested styles found in the catalog.`);
    }
    if (limit > 0) pool = pool.slice(0, limit);
    s.counts.discovered = catalog.products.length;
    s.discovery = { products: catalog.products.length, pages: catalog.pages, complete, styles: grouping.styles.length, excluded: grouping.excluded, invalid: grouping.invalid.length, detailRequests: 0, requests: 0 };
    log.info("discover", `${catalog.products.length} ALO products -> ${grouping.styles.length} styles (${Object.values(grouping.excluded).reduce((a, b) => a + b, 0)} excluded, ${grouping.invalid.length} without an id); processing ${pool.length}`);

    // currency health check on every run (even when details are cached): the formula is only valid for USD prices
    const probe = pool[0]?.listings[0] ?? catalog.products[0];
    try {
      const d = await fetchColourDetail(http, probe.handle);
      s.discovery.detailRequests++;
      if (!d.gone && d.currency !== settings.SOURCE_CURRENCY) throw new Aborted(`ALO SOURCE HEALTH CHECK FAILED: catalog is priced in ${d.currency ?? "an unknown currency"}, expected ${settings.SOURCE_CURRENCY} - no prices written`);
      log.info("health", `source currency ${d.currency ?? "(withdrawn probe)"} confirmed on ${probe.handle}`);
    } catch (e) {
      if (e instanceof Aborted) { log.error("health", e.message); throw e; }
      log.error("health", `ALO SOURCE HEALTH CHECK FAILED: currency probe ${errMsg(e)}`);
      throw new Aborted(`ALO SOURCE HEALTH CHECK FAILED: could not confirm the price currency (${errMsg(e)})`);
    }

    // ---- details (sequential, polite): barcodes + price currency per colourway, fabric / fit per style.
    // Cached for DETAILS_MAX_AGE_HOURS (ALO's updated_at ticks with every stock movement, so it is no cache key);
    // a colourway listing a SKU the cache has not seen is re-read at once. ----
    const maxAgeMs = settings.DETAILS_MAX_AGE_HOURS * 3600_000;
    const stale = (fetchedAt: string | null) => !fetchedAt || Date.now() - new Date(fetchedAt).getTime() > maxAgeMs;
    const detailsOf = new Map<string, { barcodes: Record<string, string>; attribs: Record<string, string> | null }>();
    let blocked: string | null = null;
    for (const g of pool) {
      const barcodes: Record<string, string> = {};
      let attribs: Record<string, string> | null = null;
      try {
        if (settings.FETCH_DETAILS) {
          for (const p of g.listings) {
            let cd = colourDetail(p.handle);
            const known = cd?.barcodes ? (JSON.parse(cd.barcodes) as Record<string, string>) : {};
            const newSku = p.variants.some((v) => v.sku && !(v.sku.trim().toUpperCase() in known));
            if (!cd || stale(cd.fetched_at) || newSku) {
              const d = await fetchColourDetail(http, p.handle);
              s.discovery.detailRequests++;
              if (!d.gone && d.currency && d.currency !== settings.SOURCE_CURRENCY) {
                throw new Aborted(`ALO SOURCE HEALTH CHECK FAILED: ${p.handle} is priced in ${d.currency}, expected ${settings.SOURCE_CURRENCY} - no prices written`);
              }
              cd = { handle: p.handle, source_updated_at: p.updated_at, currency: d.currency, barcodes: JSON.stringify(d.barcodes), fetched_at: new Date().toISOString() };
              if (!dryRun) saveColourDetail(cd);
            }
            for (const [k, v] of Object.entries(JSON.parse(cd.barcodes ?? "{}") as Record<string, string>)) if (v) barcodes[k] = v;
          }
          const primary = g.listings[0];
          let sd = styleDetail(g.styleId);
          if (!sd || stale(sd.fetched_at)) {
            const a = await fetchStyleAttribs(http, primary.handle);
            s.discovery.detailRequests++;
            sd = { style_id: g.styleId, source_updated_at: primary.updated_at, attribs: a ? JSON.stringify(a) : null, fetched_at: new Date().toISOString() };
            if (!dryRun) saveStyleDetail(sd);
          }
          attribs = sd.attribs ? JSON.parse(sd.attribs) : null;
        }
      } catch (e) {
        if (e instanceof Aborted) throw e;
        if (e instanceof SourceBlockedError) { blocked = e.message; log.error("health", `ALO SOURCE HEALTH CHECK FAILED: ${e.message}`); break; }
        log.warn("details", `details unavailable (${errMsg(e)}) - synced without barcodes / page attributes`, undefined, g.styleId);
      }
      detailsOf.set(g.styleId, { barcodes, attribs });
    }
    if (blocked) { s.status = "aborted"; s.errors.push({ stage: "source", kind: "rate_limited", message: blocked }); pool = pool.filter((g) => detailsOf.has(g.styleId)); }
    s.sourceHealthy = complete && !blocked;

    // ---- per style: normalize -> price -> match -> plan -> write. One failure never stops the run. ----
    const seenStyles = new Set(grouping.styles.map((g) => g.styleId));
    let failures = 0;
    const ctx: Ctx = { settings, dryRun, shopify, log, syncId, fx };
    let next = 0;
    const worker = async () => {
      while (next < pool.length) {
        const g = pool[next++];
        let rep: AProductReport;
        try {
          const n = normalizeAlo(g, detailsOf.get(g.styleId) ?? { barcodes: {}, attribs: null }, settings);
          rep = await processStyle(n, ctx);
        } catch (e) {
          failures++;
          const kind = classify(e);
          const msg = errMsg(e);
          log.error("product", `[${kind}] ${msg}`, undefined, g.styleId);
          s.errors.push({ id: g.styleId, stage: "product", kind, message: msg });
          rep = failedReport(g, msg, kind, settings);
          if (!dryRun) upsertRow({ style_id: g.styleId, last_sync_status: "failed", error_message: msg, last_seen_at: new Date().toISOString(), missing_scans: 0 });
        }
        s.products.push(rep);
        tally(s, rep);
        s.counts.processed++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(settings.MAX_CONCURRENT_PRODUCTS, Math.max(pool.length, 1)) }, worker));
    s.counts.styles = pool.length;
    s.products.sort((a, b) => pool.findIndex((g) => g.styleId === a.style) - pool.findIndex((g) => g.styleId === b.style));

    if (!dryRun && shopify && !blocked) await publishPending(shopify, settings, log, s);

    // ---- missing products: only after a healthy, complete, unlimited, unfiltered scan with no failures ----
    if (s.sourceHealthy && !limit && !wanted && !failures) {
      for (const row of allRows()) {
        if (seenStyles.has(row.style_id) || !row.shopify_product_id) continue;
        await handleMissing(row, { settings, dryRun, shopify, log, s });
      }
      if (!dryRun) setAState("last_complete_count", String(catalog.products.length));
    } else if (!limit && !wanted) {
      s.warnings.push(`Missing-product detection skipped this run (${!s.sourceHealthy ? "source health check failed" : `${failures} style(s) failed`}).`);
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
    adb.prepare("UPDATE sync_runs SET finished_at = ?, duration_ms = ?, status = ?, summary_json = ?, errors_json = ? WHERE id = ?")
      .run(s.finishedAt, s.durationMs, s.status, JSON.stringify(rest), JSON.stringify(s.errors), syncId);
    fs.writeFileSync(path.join(LOG_DIR, `${syncId}.report.json`), JSON.stringify(s, null, 2));
    fs.writeFileSync(path.join(LOG_DIR, `${syncId}.report.txt`), formatAloReport(s));
    log.info("complete", `Sync completed: ${s.status} in ${Math.round(s.durationMs / 1000)}s`, rest.counts as unknown as Record<string, unknown>);
    releaseALock();
  }
  return s;
}

interface Ctx { settings: AloSettings; dryRun: boolean; shopify: AloOps | null; log: Logger; syncId: string; fx: FxRate }

export function pricesFor(n: NormalizedStyle, fx: FxRate, settings: AloSettings): Map<string, AloPrice> {
  return new Map(n.variants.map((v) => [v.sku, calculateAloPrice({ currentUsd: v.currentUsd, regularUsd: v.regularUsd, currency: settings.SOURCE_CURRENCY }, fx, settings)]));
}

async function processStyle(n: NormalizedStyle, ctx: Ctx): Promise<AProductReport> {
  const { settings, dryRun, shopify, log, syncId, fx } = ctx;
  const now = new Date().toISOString();
  const id = n.styleId;
  const prices = pricesFor(n, fx, settings);
  const sample = prices.get(n.variants[0]?.sku ?? "");
  log.info("parse", `Product parsed: ${n.title} - ${n.colours.length} colour(s), ${n.variants.length} variants, ${n.images.length} images`, undefined, id);
  if (sample?.ok) log.info("price", `USD price detected $${sample.sourcePriceUsd}${sample.sourceSalePriceUsd != null ? ` (sale; regular $${sample.sourceRegularPriceUsd})` : ""} -> INR ₹${sample.convertedPriceInr?.toFixed(2)} -> ₹${settings.FLAT_ADJUSTMENT_INR} adjustment applied -> FSR ₹${sample.fsrPrice}`, undefined, id);

  const r = getRow(id);
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
  if (r?.written_eta && r.written_eta !== settings.DEFAULT_ETA) changes.push("ETA setting");
  if (settings.AUTHORIZATION_CONFIRMED && r?.shopify_product_id && !r.image_hash && n.images.length) changes.push("images pending");
  if (r?.last_sync_status && ["failed", "needs_review", "missing", "archived"].includes(r.last_sync_status)) changes.push(`retry after ${r.last_sync_status}`);
  if (r?.shopify_status === "DRAFT" && settings.NEW_PRODUCT_STATUS === "ACTIVE" && SELLABLE.includes(n.availability)) changes.push("status (go live)");

  const rep: AProductReport = { ...reportBase(n, settings, prices), outcome: "unchanged", changes, shopifyProductId: r?.shopify_product_id ?? null };

  // ---- match: unique alo_sync.source_product_id -> stored product id -> SKU collision check ----
  let existing: GShopifyProduct | null = null;
  let identifier: Record<string, unknown> = { customId: { namespace: ANS, key: "source_product_id", value: id } };
  if (shopify && (changes.length || !r?.shopify_product_id)) {
    existing = await shopify.byCustomId(id);
    if (!existing && r?.shopify_product_id) {
      existing = await shopify.byId(r.shopify_product_id);
      if (existing) rep.notes.push("matched by stored Shopify product id");
    }
    if (!existing) {
      const collisions = await shopify.skuCollisions(id);
      const live = collisions.filter((c) => c.status !== "ARCHIVED");
      if (collisions.length) rep.notes.push(`existing non-synced product(s) with this style's SKUs: ${collisions.map((c) => `"${c.title}" [${c.status}]`).join(", ")}`);
      if (live.length && !settings.ADOPT_EXISTING_PRODUCTS) {
        rep.outcome = "needs_review";
        rep.notes.push("not imported: a product listed by hand already uses these SKUs. Set ADOPT_EXISTING_PRODUCTS=true to link it (manual title/description/price kept).");
        if (!dryRun) upsertRow({ ...baseRow(n, now), last_sync_status: "needs_review", error_message: "SKU collision with manual product" });
        return rep;
      }
      if (live.length) { existing = await shopify.byId(live[0].id); rep.notes.push(`adopting existing product "${live[0].title}"`); }
    }
  }
  if (existing) identifier = { id: existing.id };

  if (r?.shopify_product_id && !changes.length) {
    rep.outcome = dryRun ? "planned_unchanged" : "unchanged";
    log.info("shopify", "Product unchanged", undefined, id);
    if (!dryRun) upsertRow({ style_id: id, last_seen_at: now, missing_scans: 0, availability: n.availability });
    return rep;
  }
  if (!existing && !r?.shopify_product_id && !pricesOk) {
    rep.outcome = "needs_review";
    rep.notes.push(`not created: ${[...prices.values()].find((p) => !p.ok)?.reason}`);
    return rep;
  }

  let plan;
  try {
    plan = buildAloPlan({ n, existing, row: r, settings, prices, fx, images: imagesFor(id), locationId: shopify?.locationId ?? null, nowIso: now });
  } catch (e) {
    if (!(e instanceof PlanConflict)) throw e;
    rep.outcome = "needs_review";
    rep.notes.push(e.message);
    if (!dryRun) upsertRow({ ...baseRow(n, now), shopify_product_id: existing?.id ?? r?.shopify_product_id ?? null, last_sync_status: "needs_review", error_message: e.message });
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
    onRetry: (e, a, wait) => log.warn("shopify", `productSet retry ${a} in ${wait}ms: ${errMsg(e)}`, undefined, id),
  });
  if (plan.metafields.length) await shopify!.metafieldsSet(result.id, plan.metafields);
  // verify: every variant we sent is on the product (the mutation response only lists the first 250)
  if ((plan.input.variants as unknown[]).length >= 250) {
    const full = await shopify!.byId(result.id);
    if (full) result = { ...result, variants: { nodes: full.variants.nodes } };
  }
  const onProduct = new Set(result.variants.nodes.map((v) => (v.sku ?? "").toUpperCase()));
  const lost = (plan.input.variants as { sku?: string }[]).filter((v) => v.sku && !onProduct.has(v.sku.toUpperCase()));
  if (lost.length) throw new Error(`productSet verification failed: ${lost.length} variant(s) missing after the write (e.g. ${lost[0].sku})`);
  rep.outcome = plan.action === "create" ? "created" : "updated";
  rep.shopifyProductId = result.id;
  log.info("shopify", `Shopify product ${rep.outcome} ${result.id}`, { notes: plan.notes }, id);

  // ---- image bookkeeping (dedupe on the next run) + one photo per variant from its colourway ----
  let imageHash = r?.image_hash ?? null;
  if (plan.imagesSent) {
    const alts = new Map(n.images.map((i) => [i.key, i.alt]));
    const mapped = mapUploadedMedia(plan.imagesSent, result.media.nodes, alts);
    if (mapped) {
      replaceImages(id, plan.imagesSent.map((im) => ({ source_key: im.key, colour: im.colour, media_id: mapped.get(im.key) ?? null, uploaded_at: now })));
      imageHash = n.hashes.image;
      if (rep.imagesAdded) log.info("images", `Image uploaded: ${rep.imagesAdded} new`, undefined, id);
      const firstByColour = new Map<string, string>();
      for (const im of plan.imagesSent) if (!firstByColour.has(im.colour) && mapped.get(im.key)) firstByColour.set(im.colour, mapped.get(im.key)!);
      const colourOf = new Map(n.variants.map((v) => [v.sku, v.colour]));
      const pairs = result.variants.nodes
        .map((v) => ({ id: v.id, mediaId: firstByColour.get(colourOf.get((v.sku ?? "").toUpperCase()) ?? "") }))
        .filter((x): x is { id: string; mediaId: string } => !!x.mediaId);
      if (pairs.length) { await shopify!.setVariantMedia(result.id, pairs); log.info("shopify", `Variant updated: ${pairs.length} variant image(s)`, undefined, id); }
    } else {
      rep.notes.push(`could not map uploaded media (${result.media.nodes.length} on product, ${plan.imagesSent.length} sent) - images will be re-checked next sync`);
      log.warn("images", "image upload could not be matched to source images", { sent: plan.imagesSent.length, onProduct: result.media.nodes.length }, id);
      imageHash = null;
    }
  } else if (settings.AUTHORIZATION_CONFIRMED && existing?.media.nodes.length && !r) {
    imageHash = n.hashes.image;
  }

  // ---- price history (per colour, from the previous snapshot) ----
  if (!plan.pricesPaused && r?.snapshot_json) {
    const prev = JSON.parse(r.snapshot_json) as { colours?: { colour: string; minUsd: number | null; fsrPrice?: number | null }[] };
    for (const c of n.colours) {
      const old = prev.colours?.find((x) => x.colour === c.colour);
      const p = cheapestFor(n, c.colour, prices);
      if (old && p && old.minUsd !== c.minUsd) {
        recordPriceChange({ style: id, colour: c.colour, at: now, oldUsd: old.minUsd, newUsd: c.minUsd!, oldRegular: null, newRegular: p.sourceRegularPriceUsd, oldFsr: old.fsrPrice ?? null, newFsr: p.fsrPrice!, rate: fx.rate!, syncId });
        log.info("price", `${c.colour}: $${old.minUsd} -> $${c.minUsd}; FSR ₹${old.fsrPrice ?? "?"} -> ₹${p.fsrPrice}`, undefined, id);
      }
    }
  }

  const cheapest = [...prices.values()].filter((p) => p.ok).sort((a, b) => a.fsrPrice! - b.fsrPrice!)[0];
  upsertRow({
    ...baseRow(n, now),
    shopify_product_id: result.id,
    shopify_status: (plan.input.status as string) ?? existing?.status ?? r?.shopify_status ?? null,
    ...(plan.pricesPaused ? {} : {
      source_price_usd: cheapest?.sourcePriceUsd ?? null, source_regular_price_usd: cheapest?.sourceRegularPriceUsd ?? null, source_sale_price_usd: cheapest?.sourceSalePriceUsd ?? null,
      converted_price_inr: cheapest?.convertedPriceInr != null ? Math.round(cheapest.convertedPriceInr * 100) / 100 : null, flat_adjustment_inr: settings.FLAT_ADJUSTMENT_INR,
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
    snapshot_json: JSON.stringify({ styleId: n.styleId, title: n.title, colours: n.colours.map((c) => ({ ...c, fsrPrice: cheapestFor(n, c.colour, prices)?.fsrPrice ?? null })) }),
  });
  return rep;
}

function cheapestFor(n: NormalizedStyle, colour: string, prices: Map<string, AloPrice>): AloPrice | undefined {
  return n.variants.filter((v) => v.colour === colour).map((v) => prices.get(v.sku)).filter((x): x is AloPrice => !!x?.ok).sort((a, b) => a.fsrPrice! - b.fsrPrice!)[0];
}

function baseRow(n: NormalizedStyle, now: string): Partial<AloRow> & { style_id: string } {
  const existing = getRow(n.styleId);
  return {
    style_id: n.styleId, source_product_ids: JSON.stringify(Object.fromEntries(n.colours.map((c) => [c.colour, c.sourceProductId]))), source_handles: JSON.stringify(n.handles),
    source_url: n.sourceUrl, canonical_url: n.canonicalUrl, title: n.title, gender: n.gender, category: n.category, subcategory: n.subcategory, collection: n.collection,
    product_type: n.productType, colours: JSON.stringify(n.colours.map((c) => c.colour)), availability: n.availability, source_updated_at: n.sourceUpdatedAt,
    first_seen_at: existing?.first_seen_at ?? now, last_seen_at: now, missing_scans: 0,
  };
}

function reportBase(n: NormalizedStyle, settings: AloSettings, prices: Map<string, AloPrice>): AProductReport {
  return {
    style: n.styleId, title: n.title, name: n.name, url: n.sourceUrl, outcome: "unchanged", category: n.category, gender: n.gender, productType: n.productType,
    colours: n.colours.map((c) => {
      const p = cheapestFor(n, c.colour, prices);
      return { colour: c.colour, availability: c.availability, usd: p?.sourcePriceUsd ?? c.minUsd, regularUsd: p?.sourceRegularPriceUsd ?? null, saleUsd: p?.sourceSalePriceUsd ?? null, convertedInr: p?.convertedPriceInr ?? null, fsrPrice: p?.fsrPrice ?? null, compareAt: p?.compareAtPrice ?? null };
    }),
    variants: n.variants.length, sizes: n.sizeOrder, flat: settings.FLAT_ADJUSTMENT_INR, availability: n.availability, eta: settings.DEFAULT_ETA,
    images: n.images.length, imagesAdded: 0, barcodes: n.variants.filter((v) => v.barcode).length, specifications: Object.keys(n.specs).length,
    changes: [], notes: [...(n.duplicatesSkipped ? [`${n.duplicatesSkipped} duplicate variant listing(s) (men's/women's copies) merged`] : []), ...(n.imagesCapped ? [`${n.imagesCapped} image(s) over the cap left out`] : []), ...(n.sizeConversion ? ["shoe sizes converted to UK"] : [])],
    missing: n.missing,
  };
}

function failedReport(g: StyleGroup, msg: string, kind: FailureKind, settings: AloSettings): AProductReport {
  return {
    style: g.styleId, title: g.listings[0]?.title ?? g.styleId, name: g.listings[0]?.title ?? g.styleId, url: `${ALO_SOURCE.origin}/products/${g.listings[0]?.handle ?? ""}`,
    outcome: "failed", category: null, gender: null, productType: null, colours: [], variants: 0, sizes: [], flat: settings.FLAT_ADJUSTMENT_INR, availability: null,
    eta: settings.DEFAULT_ETA, images: 0, imagesAdded: 0, barcodes: 0, specifications: 0, changes: [], notes: [], missing: [], error: msg, errorKind: kind,
  };
}

async function handleMissing(row: AloRow, ctx: { settings: AloSettings; dryRun: boolean; shopify: AloOps | null; log: Logger; s: ASyncSummary }) {
  const { settings, dryRun, shopify, log, s } = ctx;
  if (row.last_sync_status === "archived") return;
  const scans = row.missing_scans + 1;
  s.counts.missing++;
  const threshold = settings.PRODUCT_MISSING_CONFIRMATION_SCANS;
  if (scans < threshold) {
    log.warn("removal", `not in the ALO catalog - warning (${scans}/${threshold} confirmation scans)`, undefined, row.style_id);
    if (!dryRun) upsertRow({ style_id: row.style_id, missing_scans: scans, last_sync_status: "missing" });
    return;
  }
  if (dryRun || !shopify) { log.info("removal", `[dry-run] would mark missing and ${settings.MISSING_ACTION} after ${scans} missing scans`, undefined, row.style_id); return; }
  try {
    const status = settings.MISSING_ACTION === "archive" ? "ARCHIVED" : "DRAFT";
    await shopify.metafieldsSet(row.shopify_product_id!, [{ namespace: ANS, key: "source_status", type: "single_line_text_field", value: "missing" }]);
    await shopify.setStatus(row.shopify_product_id!, status); // never deleted
    s.counts.archived++;
    upsertRow({ style_id: row.style_id, missing_scans: scans, last_sync_status: "archived", shopify_status: status });
    log.warn("removal", `source_status = missing; ${status} after ${scans} consecutive missed scans`, undefined, row.style_id);
  } catch (e) {
    s.counts.failed++;
    s.errors.push({ id: row.style_id, stage: "removal", kind: "shopify_api", message: errMsg(e) });
    log.error("removal", errMsg(e), undefined, row.style_id);
  }
}

async function publishPending(shopify: AloOps, settings: AloSettings, log: Logger, s: ASyncSummary) {
  const pending = allRows().filter((r) => r.shopify_product_id && r.shopify_status === "ACTIVE" && !r.published);
  if (!pending.length) return;
  const pubs = await shopify.resolvePublications(settings.PUBLISH_CHANNELS.split(","));
  if (!pubs) { s.warnings.push(`${pending.length} ACTIVE product(s) not yet published to sales channels: the Shopify app needs read_publications + write_publications.`); return; }
  let ok = 0;
  for (const r of pending) {
    try { await shopify.publish(r.shopify_product_id!, pubs); upsertRow({ style_id: r.style_id, published: 1 }); ok++; }
    catch (e) { s.errors.push({ id: r.style_id, stage: "publish", kind: "shopify_api", message: errMsg(e) }); log.error("publish", errMsg(e), undefined, r.style_id); }
  }
  log.info("publish", `published ${ok}/${pending.length} product(s) to: ${settings.PUBLISH_CHANNELS}`);
}

function tally(s: ASyncSummary, r: AProductReport) {
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
const ACTION: Partial<Record<Outcome, string>> = { planned_create: "CREATE", created: "CREATED", planned_update: "UPDATE", updated: "UPDATED", planned_unchanged: "NO CHANGE", unchanged: "NO CHANGE", needs_review: "NEEDS REVIEW", failed: "FAILED" };

export function formatAloReport(s: ASyncSummary): string {
  const c = s.counts;
  const L: string[] = [];
  L.push(`ALO SYNC ${s.syncId}  (${s.mode === "dry_run" ? "DRY RUN - no Shopify changes made" : "LIVE"})`);
  L.push(`Sync started:            ${s.startedAt}`);
  L.push(`Sync finished:           ${s.finishedAt}`);
  L.push(`Duration:                ${Math.round(s.durationMs / 1000)}s`);
  L.push(`Status:                  ${s.status}`);
  L.push(`Exchange rate:           ${s.fx ? (s.fx.ok ? `1 USD = ₹${s.fx.rate} (${s.fx.provider}, ${s.fx.origin})` : `NONE - ${s.fx.reason}`) : "—"}`);
  L.push(`Exchange rate timestamp: ${s.fx?.fetchedAt ?? "—"} (provider time ${s.fx?.providerUpdatedAt ?? "n/a"})`);
  if (s.discovery) {
    const ex = Object.entries(s.discovery.excluded).map(([k, v]) => `${v} ${k}`).join(", ");
    L.push(`Source:                  aloyoga.com /products.json - ${s.discovery.products} ALO listings on ${s.discovery.pages} pages${s.discovery.complete ? "" : " (INCOMPLETE)"} -> ${s.discovery.styles} styles${ex ? `; excluded: ${ex}` : ""}${s.discovery.invalid ? `; ${s.discovery.invalid} without id` : ""}`);
    L.push(`Requests:                ${s.discovery.requests} (${s.discovery.detailRequests} detail)${s.limit ? `; limited to ${s.limit} styles` : ""}`);
  }
  L.push(`Source health:           ${s.sourceHealthy ? "OK" : "FAILED / incomplete - no missing-product detection"}`);
  L.push(`Shopify matching:        ${s.shopifyChecked ? "checked against live store" : "NOT checked - local database only"}`);
  L.push("");
  const verb = s.mode === "dry_run" ? "would be " : "";
  L.push(`Products discovered:     ${c.discovered} ALO listings`);
  L.push(`Products processed:      ${c.processed} styles`);
  L.push(`Created:                 ${c.created}${verb ? ` (${verb}created)` : ""}`);
  L.push(`Updated:                 ${c.updated}${verb ? ` (${verb}updated)` : ""}`);
  L.push(`Unchanged:               ${c.unchanged}`);
  L.push(`Needs review:            ${c.needsReview}`);
  L.push(`Price changes:           ${c.priceChanges}`);
  L.push(`Price updates paused:    ${c.pricesPaused}`);
  L.push(`Variant changes:         ${c.variantChanges}`);
  L.push(`Images added:            ${c.imagesAdded}`);
  L.push(`Unavailable:             ${c.unavailable}`);
  L.push(`Missing from source:     ${c.missing}`);
  L.push(`Archived:                ${c.archived}`);
  L.push(`Failed:                  ${c.failed}`);
  L.push(`Rate-limit events:       ${c.rateLimitEvents}`);
  L.push(`Errors:                  ${s.errors.length ? "" : "none"}`);
  for (const e of s.errors.slice(0, 50)) L.push(`  - [${e.stage}${e.kind ? `/${e.kind}` : ""}] ${e.id ?? ""} ${e.message}`);
  if (s.errors.length > 50) L.push(`  ... ${s.errors.length - 50} more (see the .report.json)`);
  if (s.warnings.length) { L.push(""); L.push("WARNINGS:"); for (const w of s.warnings) L.push(`  ! ${w}`); }
  L.push(""); L.push("==== PRODUCTS ====");
  for (const p of s.products) {
    L.push("");
    L.push(`ALO STYLE ${p.style}`);
    L.push(`  Name:           ${p.name}`);
    L.push(`  Shopify title:  ${p.title}`);
    L.push(`  Source:         ${p.url}`);
    if (p.error) { L.push(`  Action:         ${ACTION[p.outcome]}  [${p.errorKind}] ${p.error}`); continue; }
    L.push(`  Category:       ${p.category ?? "—"}    Gender: ${p.gender ?? "—"}    Product type: ${p.productType ?? "—"}`);
    L.push(`  Variants:       ${p.variants} (${p.colours.length} colour(s) × sizes ${p.sizes.join("/")}); barcodes ${p.barcodes}`);
    for (const col of p.colours) {
      L.push(`  • ${col.colour.padEnd(24)} ${col.availability.padEnd(12)} ALO ${usd(col.usd)}${col.saleUsd != null ? ` (sale; regular ${usd(col.regularUsd)})` : ""} -> ${inr(col.convertedInr != null ? Math.round(col.convertedInr * 100) / 100 : null)} + ${inr(p.flat)} = FSR ${inr(col.fsrPrice)}${col.compareAt ? `  compare-at ${inr(col.compareAt)}` : ""}`);
    }
    L.push(`  ETA:            ${p.eta}`);
    L.push(`  Action:         ${ACTION[p.outcome]}${p.shopifyProductId ? `  ${p.shopifyProductId}` : ""}`);
    L.push(`  Images:         ${p.images}${p.imagesAdded ? ` (${p.imagesAdded} to upload)` : ""}    Specifications: ${p.specifications}`);
    if (p.changes.length) L.push(`  Changes:        ${p.changes.join(", ")}`);
    for (const note of p.notes) L.push(`  - ${note}`);
    if (p.missing.length) L.push(`  Not on source:  ${p.missing.join(", ")}`);
  }
  return L.join("\n") + "\n";
}

export function nextAloScheduledAt(settings = getAloSettings()): string | null {
  if (settings.SYNC_PAUSED) return null;
  const last = adb.prepare("SELECT started_at FROM sync_runs WHERE trigger = 'scheduler' AND status != 'running' ORDER BY started_at DESC LIMIT 1").get() as { started_at: string } | undefined;
  if (!last) return new Date().toISOString();
  return new Date(new Date(last.started_at).getTime() + settings.SYNC_INTERVAL_HOURS * 3600_000).toISOString();
}
