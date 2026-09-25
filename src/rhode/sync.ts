import fs from "node:fs";
import path from "node:path";
import { LOG_DIR, hasShopifyCredentials } from "../config.ts";
import { getExchangeRate, type FxRate } from "../gymshark/fx.ts";
import type { GShopifyProduct } from "../gymshark/ops.ts";
import { mapUploadedMedia } from "../gymshark/plan.ts";
import { Logger } from "../logger.ts";
import { PoliteHttp } from "../politeHttp.ts";
import { SourceBlockedError, errMsg, hash, retry } from "../util.ts";
import { RHODE_SOURCE, categoryCollections, list, type RhodeSettings } from "./config.ts";
import {
  RHODE_FX_STORE, acquireRLock, allRows, findRowBySourceHandle, getRState, getRhodeSettings, getRow, imagesFor, nextRhodeSyncId, pageDetail, rdb, recordPriceChange,
  releaseRLock, renameGroup, replaceImages, savePageDetail, setRState, upsertRow, type RhodeRow,
} from "./db.ts";
import { groupRhodeCatalog, normalizeRhode, type GroupContext, type NormalizedGroup, type RGroup } from "./normalize.ts";
import { RNS, RhodeOps } from "./ops.ts";
import { PlanConflict, buildRhodePlan } from "./plan.ts";
import { calculateRhodePrice, type RhodePrice } from "./pricing.ts";
import { fetchCollectionMembers, fetchCurrency, fetchPageDetails, fetchRhodeCatalog, fetchRhodeCollections, type PageDetails } from "./source.ts";

export interface RSyncOptions { dryRun?: boolean; limit?: number; trigger?: string; handles?: string[] }

export type Outcome = "created" | "updated" | "unchanged" | "failed" | "needs_review" | "planned_create" | "planned_update" | "planned_unchanged";
export type FailureKind = "network" | "source_parsing" | "missing_price" | "shopify_api" | "image_upload" | "exchange_rate" | "rate_limited" | "invalid_data";

export interface VariantPriceReport {
  variant: string; sku: string; sourceVariantId: string; availability: string; usd: number | null; regularUsd: number | null; saleUsd: number | null;
  convertedInr: number | null; adjustment: number; fsrPrice: number | null; compareAt: number | null;
}

export interface RProductReport {
  key: string;
  sourceProductIds: string;
  title: string;
  name: string;
  url: string;
  outcome: Outcome;
  category: string | null;
  subcategory: string | null;
  productType: string | null;
  collections: string[];
  variants: VariantPriceReport[];
  exchangeRate: number | null;
  availability: string | null;
  eta: string;
  images: number;
  imagesAdded: number;
  specifications: number;
  changes: string[];
  notes: string[];
  missing: string[];
  syncedAt: string;
  shopifyProductId?: string | null;
  error?: string;
  errorKind?: FailureKind;
  planned?: Record<string, unknown>;
}

export interface RSyncSummary {
  syncId: string;
  mode: "dry_run" | "live";
  trigger: string;
  status: "success" | "partial" | "failed" | "aborted";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  limit: number;
  shopifyChecked: boolean;
  sourceReliable: boolean;
  fx: { ok: boolean; rate: number | null; provider: string | null; providerUpdatedAt: string | null; fetchedAt: string | null; origin: string; reason?: string } | null;
  discovery: { products: number; pages: number; complete: boolean; groups: number; families: number; excluded: Record<string, number>; collections: string[]; pageRequests: number; requests: number } | null;
  counts: {
    discovered: number; groups: number; processed: number; created: number; updated: number; unchanged: number; skipped: number; failed: number; needsReview: number;
    variantsUpdated: number; imagesUpdated: number; priceChanges: number; availabilityChanges: number; pricesPaused: number; missing: number; archived: number; rateLimitEvents: number;
  };
  errors: { id?: string; stage: string; kind?: FailureKind; message: string }[];
  warnings: string[];
  products: RProductReport[];
}

class Aborted extends Error {}
const UNRELIABLE = "SOURCE_SCAN_UNRELIABLE";

export function classify(e: unknown): FailureKind {
  const m = errMsg(e);
  if (e instanceof SourceBlockedError || /HTTP 429|rate.?limit/i.test(m)) return "rate_limited";
  if (/network error|fetch failed|timeout|ECONN|ENOTFOUND/i.test(m)) return "network";
  if (/productSet|metafieldsSet|GraphQL|Shopify|userErrors|throttled/i.test(m)) return /media|image|file/i.test(m) ? "image_upload" : "shopify_api";
  if (/exchange rate/i.test(m)) return "exchange_rate";
  if (/missing price|no positive USD price/i.test(m)) return "missing_price";
  if (/JSON|parse|Unexpected token/i.test(m)) return "source_parsing";
  return "invalid_data";
}

export async function runRhodeSync(opts: RSyncOptions = {}): Promise<RSyncSummary> {
  const settings = getRhodeSettings();
  const dryRun = opts.dryRun ?? settings.DRY_RUN;
  const limit = opts.limit ?? settings.SYNC_LIMIT;
  const trigger = opts.trigger ?? "manual";
  const syncId = nextRhodeSyncId();
  const log = new Logger(syncId, { db: rdb, name: "rhode-sync" });
  const startedAt = new Date();

  if (!acquireRLock(syncId)) throw new Error("Another Rhode sync is already running (lock held)");
  rdb.prepare("UPDATE sync_runs SET status = 'aborted', finished_at = COALESCE(finished_at, ?) WHERE status = 'running'").run(startedAt.toISOString());
  rdb.prepare("INSERT INTO sync_runs (id, started_at, mode, trigger, status) VALUES (?,?,?,?, 'running')").run(syncId, startedAt.toISOString(), dryRun ? "dry_run" : "live", trigger);

  const s: RSyncSummary = {
    syncId, mode: dryRun ? "dry_run" : "live", trigger, status: "success", startedAt: startedAt.toISOString(), finishedAt: "", durationMs: 0, limit, shopifyChecked: false,
    sourceReliable: false, fx: null, discovery: null,
    counts: {
      discovered: 0, groups: 0, processed: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, needsReview: 0, variantsUpdated: 0, imagesUpdated: 0,
      priceChanges: 0, availabilityChanges: 0, pricesPaused: 0, missing: 0, archived: 0, rateLimitEvents: 0,
    },
    errors: [], warnings: [], products: [],
  };
  const http = new PoliteHttp(settings.REQUEST_DELAY_MS, log, {
    userAgent: RHODE_SOURCE.userAgent, label: "Rhode", acceptLanguage: "en-US,en;q=0.9",
    challenge: /captcha-container|g-recaptcha|h-captcha|verify you are human|cf-challenge|challenge-platform|access denied/i,
  });

  try {
    log.info("start", `RHODE SYNC STARTED (${s.mode}, limit=${limit || "none - full catalog"}, trigger=${trigger})`);
    if (!settings.ENABLED) s.warnings.push("RHODE_ENABLED=false: the scheduler skips Rhode; this run was started by hand.");
    if (!settings.CONTENT_REUSE_CONFIRMED) s.warnings.push("CONTENT_REUSE_CONFIRMED=false: Rhode images and description text are not copied to Shopify (facts/spec table only).");

    let shopify: RhodeOps | null = null;
    if (hasShopifyCredentials()) {
      shopify = new RhodeOps(log);
      await shopify.ensureDefinitions(dryRun);
      await shopify.resolveLocation();
      s.shopifyChecked = true;
    } else if (!dryRun) {
      throw new Aborted("Live sync requires Shopify Admin API credentials (SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET). See README.");
    } else {
      s.warnings.push("No Shopify credentials: dry run matched against the local database only.");
    }

    // ---- exchange rate: fetched once per run, validated, stored with every product it prices ----
    const fx = await getExchangeRate(settings, log, { store: RHODE_FX_STORE });
    s.fx = { ok: fx.ok, rate: fx.rate, provider: fx.provider, providerUpdatedAt: fx.providerUpdatedAt, fetchedAt: fx.fetchedAt, origin: fx.origin, reason: fx.reason };
    if (fx.ok) log.info("fx", `Exchange rate: 1 ${fx.base} = ₹${fx.rate} (${fx.provider}, ${fx.origin}, obtained ${fx.fetchedAt})`);
    else { log.error("fx", `PRICING FAILED - ${fx.reason}`); s.warnings.push(`NO VALID EXCHANGE RATE (${fx.reason}). Pricing failed: price updates are paused and new products are not created until a valid rate is available.`); }
    if (fx.origin === "cached") s.warnings.push(`Exchange rate provider unavailable - using the last valid rate: ${fx.reason}`);

    // ---- discovery: the whole live catalog, every run ----
    let catalog;
    try { catalog = await fetchRhodeCatalog(http, log); }
    catch (e) { log.error("health", `${UNRELIABLE}: ${errMsg(e)}`); throw new Aborted(`${UNRELIABLE}: ${errMsg(e)} - nothing changed in Shopify`); }
    if (!catalog.products.length) {
      log.error("health", `${UNRELIABLE}: ${catalog.reason ?? "catalog empty"}`);
      throw new Aborted(`${UNRELIABLE}: ${catalog.reason ?? "catalog returned no products"} - nothing changed in Shopify`);
    }
    let reliable = catalog.complete;
    const unreliable = (why: string) => { reliable = false; log.error("health", `${UNRELIABLE}: ${why}`); s.warnings.push(`${UNRELIABLE}: ${why} - missing-product cleanup aborted this run.`); };
    if (!catalog.complete) unreliable(catalog.reason ?? "catalog incomplete");
    const lastComplete = Number(getRState("last_complete_count") ?? 0);
    if (catalog.products.length < settings.MIN_CATALOG_SIZE) unreliable(`only ${catalog.products.length} products listed (minimum ${settings.MIN_CATALOG_SIZE})`);
    else if (lastComplete && catalog.products.length < lastComplete * settings.MIN_CATALOG_RATIO) unreliable(`only ${catalog.products.length} products vs ${lastComplete} on the last complete scan`);

    // currency health check: the formula is only valid for USD source prices
    try {
      const cur = await fetchCurrency(http, catalog.products[0].handle);
      if (cur && cur !== settings.SOURCE_CURRENCY) throw new Aborted(`${UNRELIABLE}: Rhode is serving ${cur} prices, expected ${settings.SOURCE_CURRENCY} - no prices written`);
      log.info("health", `source currency ${cur ?? "(not stated - storefront default)"} on ${catalog.products[0].handle}`);
    } catch (e) {
      if (e instanceof Aborted) { log.error("health", e.message); throw e; }
      if (e instanceof SourceBlockedError) throw new Aborted(`${UNRELIABLE}: ${e.message}`);
      unreliable(`currency probe failed (${errMsg(e)})`);
    }

    // ---- categories: Rhode's own collections (discovered, not hard-coded) ----
    const ctx: GroupContext = { details: new Map(), membership: new Map(), collectionTitles: new Map() };
    let collectionsOk = true;
    try {
      const cols = await fetchRhodeCollections(http);
      for (const c of cols) ctx.collectionTitles.set(c.handle, c.title);
      const needed = [...new Set([...categoryCollections(settings).map(([h]) => h), ...list(settings.NAV_COLLECTIONS).map((x) => x.toLowerCase())])];
      for (const h of needed) {
        if (!ctx.collectionTitles.has(h)) { collectionsOk = false; s.warnings.push(`Rhode collection "${h}" is not listed by Rhode this run`); continue; }
        const members = await fetchCollectionMembers(http, log, h);
        if (members) ctx.membership.set(h, members);
        else { collectionsOk = false; s.warnings.push(`could not read Rhode collection "${h}"`); }
      }
      log.info("discover", `Rhode collections: ${cols.length} (${[...ctx.membership.entries()].map(([h, m]) => `${h}: ${m.size}`).join(", ")})`);
    } catch (e) {
      if (e instanceof SourceBlockedError) throw new Aborted(`${UNRELIABLE}: ${e.message}`);
      collectionsOk = false;
      s.warnings.push(`Rhode collections unavailable (${errMsg(e)})`);
    }
    // a collection that can't be read this run falls back to the last good snapshot, so a Rhode hiccup never
    // re-categorises (re-tags) the catalog; products not in the snapshot are categorised by product type
    const snapshot = JSON.parse(getRState("collections_snapshot") ?? "null") as { titles: Record<string, string>; members: Record<string, number[]> } | null;
    if (collectionsOk) {
      if (!dryRun) setRState("collections_snapshot", JSON.stringify({ titles: Object.fromEntries(ctx.collectionTitles), members: Object.fromEntries([...ctx.membership].map(([h, m]) => [h, [...m]])) }));
    } else if (snapshot) {
      const used: string[] = [];
      for (const [h, ids] of Object.entries(snapshot.members)) {
        if (ctx.membership.has(h)) continue;
        ctx.membership.set(h, new Set(ids));
        if (!ctx.collectionTitles.has(h) && snapshot.titles[h]) ctx.collectionTitles.set(h, snapshot.titles[h]);
        used.push(h);
      }
      if (used.length) s.warnings.push(`using the last good snapshot for Rhode collection(s): ${used.join(", ")}`);
    }

    const grouping = groupRhodeCatalog(catalog.products, settings);
    let pool: RGroup[] = grouping.groups;
    const wanted = opts.handles?.length ? new Set(opts.handles.map((h) => h.replace(/^.*\/products\//, "").replace(/[/?#].*$/, "").toLowerCase())) : null;
    if (wanted) {
      pool = pool.filter((g) => g.members.some((m) => wanted.has(m.handle.toLowerCase())) || wanted.has(g.key.toLowerCase()));
      s.warnings.push(`Handle filter: ${pool.length} FSR product(s) match ${wanted.size} requested handle(s).`);
    }
    if (limit > 0) pool = pool.slice(0, limit);
    s.counts.discovered = catalog.products.length;
    s.counts.skipped += Object.values(grouping.excluded).reduce((a, b) => a + b, 0);
    s.discovery = {
      products: catalog.products.length, pages: catalog.pages, complete: catalog.complete, groups: grouping.groups.length, families: grouping.groups.filter((g) => g.family).length,
      excluded: grouping.excluded, collections: [...ctx.membership.keys()], pageRequests: 0, requests: 0,
    };
    log.info("discover", `${catalog.products.length} Rhode products -> ${grouping.groups.length} FSR products (${s.discovery.families} shade families, ${grouping.excludedHandles.length} excluded: ${grouping.excludedHandles.join(", ") || "none"}); processing ${pool.length}`);

    // ---- product pages (benefits / application / ingredients), cached by Rhode's updated_at ----
    let blocked: string | null = null;
    if (settings.FETCH_DETAILS) {
      outer: for (const g of pool) {
        for (const m of g.members) {
          // Rhode's updated_at moves every few minutes (stock), so the cache key is the description text itself,
          // plus a maximum age for the page-only tabs (benefits / application / ingredients)
          const cached = pageDetail(m.handle);
          const key = hash([m.title, m.body_html ?? ""]);
          const fresh = cached?.fetched_at && Date.now() - new Date(cached.fetched_at).getTime() < settings.DETAILS_MAX_AGE_HOURS * 3600_000;
          if (cached && cached.source_updated_at === key && fresh) { ctx.details.set(m.handle, cached.details ? JSON.parse(cached.details) as PageDetails : null); continue; }
          try {
            const d = await fetchPageDetails(http, m.handle);
            s.discovery.pageRequests++;
            if (d?.currency && d.currency !== settings.SOURCE_CURRENCY) throw new Aborted(`${UNRELIABLE}: ${m.handle} is priced in ${d.currency}, expected ${settings.SOURCE_CURRENCY} - no prices written`);
            ctx.details.set(m.handle, d);
            if (!dryRun) savePageDetail({ handle: m.handle, source_updated_at: key, details: d ? JSON.stringify(d) : null, fetched_at: new Date().toISOString() });
          } catch (e) {
            if (e instanceof Aborted) throw e;
            if (e instanceof SourceBlockedError) { blocked = e.message; unreliable(e.message); break outer; }
            log.warn("details", `product page unavailable (${errMsg(e)}) - synced without page details`, undefined, m.handle);
            if (cached?.details) ctx.details.set(m.handle, JSON.parse(cached.details) as PageDetails);
          }
        }
      }
    }
    if (blocked) { s.status = "aborted"; s.errors.push({ stage: "source", kind: "rate_limited", message: blocked }); }
    s.sourceReliable = reliable && !blocked;

    // ---- per product: normalize -> price -> match -> plan -> write. One failure never stops the run. ----
    const seen = new Set(grouping.groups.map((g) => g.key));
    let failures = 0;
    const pctx: Ctx = { settings, dryRun, shopify, log, syncId, fx };
    for (const g of blocked ? [] : pool) {
      let rep: RProductReport;
      try {
        const n = normalizeRhode(g, ctx, settings);
        rep = await processGroup(n, pctx);
      } catch (e) {
        failures++;
        const kind = classify(e);
        const msg = errMsg(e);
        log.error("product", `[${kind}] ${msg}`, undefined, g.key);
        s.errors.push({ id: g.key, stage: "product", kind, message: msg });
        rep = failedReport(g, msg, kind, settings);
        if (!dryRun) {
          upsertRow({ group_key: g.key, last_sync_status: "failed", error_message: msg, last_seen_at: new Date().toISOString(), missing_scans: 0 });
          const pid = getRow(g.key)?.shopify_product_id;
          if (pid && shopify) await shopify.metafieldsSet(pid, [{ namespace: RNS, key: "sync_error", type: "single_line_text_field", value: msg.slice(0, 250) }, { namespace: RNS, key: "import_status", type: "single_line_text_field", value: "failed" }]).catch(() => undefined);
        }
      }
      s.products.push(rep);
      tally(s, rep);
      s.counts.processed++;
      logProduct(log, rep);
    }
    s.counts.groups = pool.length;

    if (!dryRun && shopify && !blocked) await publishPending(shopify, settings, log, s);

    // ---- missing products: only after a reliable, complete, unlimited, unfiltered scan with no failures ----
    if (s.sourceReliable && collectionsOk && !limit && !wanted && !failures) {
      for (const row of allRows()) {
        if (seen.has(row.group_key) || !row.shopify_product_id) continue;
        await handleMissing(row, { settings, dryRun, shopify, log, s });
      }
      if (!dryRun) setRState("last_complete_count", String(catalog.products.length));
    } else if (!limit && !wanted) {
      const why = !s.sourceReliable ? UNRELIABLE : !collectionsOk ? "Rhode collections could not be read" : `${failures} product(s) failed`;
      log.warn("removal", `missing-product cleanup skipped: ${why}`);
      s.warnings.push(`Missing-product cleanup skipped this run (${why}).`);
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
    rdb.prepare("UPDATE sync_runs SET finished_at = ?, duration_ms = ?, status = ?, summary_json = ?, errors_json = ? WHERE id = ?")
      .run(s.finishedAt, s.durationMs, s.status, JSON.stringify(rest), JSON.stringify(s.errors), syncId);
    if (s.mode === "live" && (s.status === "success" || s.status === "partial")) setRState("last_sync_at", s.finishedAt);
    fs.writeFileSync(path.join(LOG_DIR, `${syncId}.report.json`), JSON.stringify(s, null, 2));
    fs.writeFileSync(path.join(LOG_DIR, `${syncId}.report.txt`), formatRhodeReport(s));
    log.info("complete", summaryBlock(s).join(" | "), rest.counts as unknown as Record<string, unknown>);
    releaseRLock();
  }
  return s;
}

interface Ctx { settings: RhodeSettings; dryRun: boolean; shopify: RhodeOps | null; log: Logger; syncId: string; fx: FxRate }

export function pricesFor(n: NormalizedGroup, fx: FxRate, settings: RhodeSettings): Map<string, RhodePrice> {
  return new Map(n.variants.map((v) => [v.sku, calculateRhodePrice({ currentUsd: v.currentUsd, regularUsd: v.regularUsd, currency: settings.SOURCE_CURRENCY }, fx, settings)]));
}

async function processGroup(n: NormalizedGroup, ctx: Ctx): Promise<RProductReport> {
  const { settings, dryRun, shopify, log, syncId, fx } = ctx;
  const now = new Date().toISOString();
  const id = n.key;
  const prices = pricesFor(n, fx, settings);

  // identity change (a single product became a shade of a family, or a family split): keep the same Shopify product
  let r = getRow(id);
  let renamedFrom: string | null = null;
  if (!r) {
    const old = n.handles.map((h) => findRowBySourceHandle(h)).find((x) => x && x.group_key !== id && x.shopify_product_id);
    if (old) { renamedFrom = old.group_key; r = old; }
  }

  const fsrPriceHash = hash([...prices.entries()].map(([k, p]) => [k, p.fsrPrice, p.compareAtPrice]));
  const pricesOk = [...prices.values()].every((p) => p.ok);
  const changes: string[] = [];
  if (!r?.shopify_product_id) changes.push("new");
  if (renamedFrom) changes.push(`identity ${renamedFrom} -> ${id}`);
  if (r?.price_hash && r.price_hash !== n.hashes.price) changes.push("source USD price");
  if (pricesOk && r?.fsr_price_hash && r.fsr_price_hash !== fsrPriceHash && !changes.includes("source USD price")) changes.push("FSR price (exchange rate / settings)");
  if (r?.availability_hash && r.availability_hash !== n.hashes.availability) changes.push("availability");
  if (r?.variant_hash && r.variant_hash !== n.hashes.variant) changes.push("variants");
  if (r?.image_hash && r.image_hash !== n.hashes.image) changes.push("images");
  if (r?.specification_hash && r.specification_hash !== n.hashes.specification) changes.push("specifications");
  if (r?.content_hash && r.content_hash !== n.hashes.content) changes.push("content");
  if (r?.written_eta && r.written_eta !== settings.ETA) changes.push("ETA setting");
  if (settings.CONTENT_REUSE_CONFIRMED && r?.shopify_product_id && !r.image_hash && n.images.length) changes.push("images pending");
  if (r?.last_sync_status && ["failed", "needs_review", "missing", "archived"].includes(r.last_sync_status)) changes.push(`retry after ${r.last_sync_status}`);

  const rep: RProductReport = { ...reportBase(n, settings, prices, fx, now), outcome: "unchanged", changes, shopifyProductId: r?.shopify_product_id ?? null };

  // ---- duplicate protection. 1 source product id (unique metafield) -> stored Shopify id -> 2 source SKU ->
  // 3 canonical URL (lives in the same metafield record) -> 4 handle -> 5 normalized title. ----
  let existing: GShopifyProduct | null = null;
  let identifier: Record<string, unknown> = { customId: { namespace: RNS, key: "source_product_id", value: id } };
  if (shopify && (changes.length || !r?.shopify_product_id)) {
    existing = await shopify.byCustomId(id);
    if (!existing && r?.shopify_product_id) {
      existing = await shopify.byId(r.shopify_product_id);
      if (existing) rep.notes.push(renamedFrom ? `matched by stored Shopify product id (was ${renamedFrom})` : "matched by stored Shopify product id");
    }
    if (!existing) {
      const handle = n.title.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const found = await shopify.findUnsynced({ skus: n.variants.map((v) => v.sku).filter((x) => !x.startsWith("RHODE-")), handle, title: n.title });
      const live = found.filter((c) => c.status !== "ARCHIVED");
      if (found.length) rep.notes.push(`existing non-synced product(s): ${found.map((c) => `"${c.title}" [${c.status}, matched by ${c.via}]`).join(", ")}`);
      if (live.length && !settings.ADOPT_EXISTING_PRODUCTS) {
        rep.outcome = "needs_review";
        rep.notes.push("not imported: a product listed by hand already matches. Set ADOPT_EXISTING_PRODUCTS=true to link it (manual title/description/price kept).");
        if (!dryRun) upsertRow({ ...baseRow(n, now), last_sync_status: "needs_review", error_message: "matches a manual product" });
        return rep;
      }
      if (live.length) { existing = await shopify.byId(live[0].id); rep.notes.push(`adopting existing product "${live[0].title}"`); }
    }
  }
  if (existing) identifier = { id: existing.id };

  if (r?.shopify_product_id && !changes.length) {
    rep.outcome = dryRun ? "planned_unchanged" : "unchanged";
    if (!dryRun) upsertRow({ group_key: id, last_seen_at: now, missing_scans: 0, availability: n.availability });
    return rep;
  }
  if (!existing && !r?.shopify_product_id && !pricesOk) {
    rep.outcome = "needs_review";
    rep.notes.push(`not created: ${[...prices.values()].find((p) => !p.ok)?.reason}`);
    return rep;
  }

  let plan;
  try {
    plan = buildRhodePlan({ n, existing, row: r, settings, prices, fx, images: imagesFor(r?.group_key ?? id), locationId: shopify?.locationId ?? null, nowIso: now });
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

  const result = await retry(() => shopify!.productSet(plan.input, identifier), {
    attempts: 3, baseMs: 3000, shouldRetry: (e) => (e as { retryable?: boolean }).retryable === true,
    onRetry: (e, a, wait) => log.warn("shopify", `productSet retry ${a} in ${wait}ms: ${errMsg(e)}`, undefined, id),
  });
  if (plan.metafields.length) await shopify!.metafieldsSet(result.id, [...plan.metafields, { namespace: RNS, key: "sync_error", type: "single_line_text_field", value: "none" }]);
  const onProduct = new Set(result.variants.nodes.map((v) => (v.sku ?? "").toUpperCase()));
  const lost = (plan.input.variants as { sku?: string }[]).filter((v) => v.sku && !onProduct.has(v.sku.toUpperCase()));
  if (lost.length) throw new Error(`productSet verification failed: ${lost.length} variant(s) missing after the write (e.g. ${lost[0].sku})`);
  if (renamedFrom) renameGroup(renamedFrom, id);
  rep.outcome = plan.action === "create" ? "created" : "updated";
  rep.shopifyProductId = result.id;

  // ---- image bookkeeping (dedupe on the next run) + each variant's own photo ----
  let imageHash = r?.image_hash ?? null;
  if (plan.imagesSent) {
    const alts = new Map(n.images.map((i) => [i.key, i.alt]));
    const mapped = mapUploadedMedia(plan.imagesSent, result.media.nodes, alts);
    if (mapped) {
      replaceImages(id, plan.imagesSent.map((im) => ({ source_key: im.key, colour: im.colour, media_id: mapped.get(im.key) ?? null, uploaded_at: now })));
      imageHash = n.hashes.image;
      const keyOf = new Map(n.variants.map((v) => [v.sku, v.imageKey]));
      const pairs = n.variants.length > 1 ? result.variants.nodes
        .map((v) => ({ id: v.id, mediaId: mapped.get(keyOf.get((v.sku ?? "").toUpperCase()) ?? "") }))
        .filter((x): x is { id: string; mediaId: string } => !!x.mediaId) : [];
      if (pairs.length) await shopify!.setVariantMedia(result.id, pairs);
    } else {
      rep.notes.push(`could not map uploaded media (${result.media.nodes.length} on product, ${plan.imagesSent.length} sent) - images will be re-checked next sync`);
      log.warn("images", "image upload could not be matched to source images", { sent: plan.imagesSent.length, onProduct: result.media.nodes.length }, id);
      imageHash = null;
    }
  } else if (settings.CONTENT_REUSE_CONFIRMED && existing?.media.nodes.length && !r) {
    imageHash = n.hashes.image;
  }

  // ---- price history (per variant, from the previous snapshot) ----
  if (!plan.pricesPaused && r?.snapshot_json) {
    const prev = JSON.parse(r.snapshot_json) as { variants?: { sku: string; usd: number | null; fsr: number | null }[] };
    for (const v of n.variants) {
      const old = prev.variants?.find((x) => x.sku === v.sku);
      const p = prices.get(v.sku)!;
      if (old && old.usd !== v.currentUsd && p.ok) {
        recordPriceChange({ key: id, sku: v.sku, at: now, oldUsd: old.usd, newUsd: v.currentUsd!, oldFsr: old.fsr, newFsr: p.fsrPrice!, rate: fx.rate!, syncId });
        log.info("price", `${v.label}: $${old.usd} -> $${v.currentUsd}; FSR ₹${old.fsr ?? "?"} -> ₹${p.fsrPrice}`, undefined, id);
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
    snapshot_json: JSON.stringify({ key: id, title: n.title, variants: n.variants.map((v) => ({ sku: v.sku, usd: v.currentUsd, fsr: prices.get(v.sku)?.fsrPrice ?? null })) }),
  });
  return rep;
}

function baseRow(n: NormalizedGroup, now: string): Partial<RhodeRow> & { group_key: string } {
  const existing = getRow(n.key);
  return {
    group_key: n.key, source_product_ids: JSON.stringify(n.sourceProductIds), source_handles: JSON.stringify(n.handles), source_skus: JSON.stringify(n.variants.map((v) => v.sku)),
    source_url: n.sourceUrl, canonical_url: n.canonicalUrl, title: n.title, category: n.category, subcategory: n.subcategory, collection: n.collections.join(", "),
    product_type: n.sourceProductType, fsr_product_type: n.productType, shades: JSON.stringify(n.variants.map((v) => v.label)), availability: n.availability,
    source_updated_at: n.sourceUpdatedAt, first_seen_at: existing?.first_seen_at ?? now, last_seen_at: now, missing_scans: 0,
  };
}

function reportBase(n: NormalizedGroup, settings: RhodeSettings, prices: Map<string, RhodePrice>, fx: FxRate, now: string): RProductReport {
  return {
    key: n.key, sourceProductIds: Object.values(n.sourceProductIds).join(", "), title: n.title, name: n.name, url: n.sourceUrl, outcome: "unchanged",
    category: n.category, subcategory: n.subcategory, productType: n.productType, collections: n.collections,
    variants: n.variants.map((v) => {
      const p = prices.get(v.sku);
      return {
        variant: v.label, sku: v.sku, sourceVariantId: v.sourceVariantId, availability: v.availability, usd: p?.sourcePriceUsd ?? v.currentUsd, regularUsd: p?.sourceRegularPriceUsd ?? v.regularUsd,
        saleUsd: p?.sourceSalePriceUsd ?? null, convertedInr: p?.convertedPriceInr ?? null, adjustment: settings.PRICING_ADJUSTMENT_INR, fsrPrice: p?.fsrPrice ?? null, compareAt: p?.compareAtPrice ?? null,
      };
    }),
    exchangeRate: fx.rate, availability: n.availability, eta: settings.ETA, images: n.images.length, imagesAdded: 0, specifications: Object.keys(n.specs).length,
    changes: [], notes: [...(n.family ? [`${n.variants.length} Rhode shade listing(s) grouped into one product`] : [])], missing: n.missing, syncedAt: now,
  };
}

function failedReport(g: RGroup, msg: string, kind: FailureKind, settings: RhodeSettings): RProductReport {
  const p = g.members[0];
  return {
    key: g.key, sourceProductIds: g.members.map((m) => m.id).join(", "), title: g.family ?? p?.title ?? g.key, name: g.family ?? p?.title ?? g.key,
    url: `${RHODE_SOURCE.origin}/products/${p?.handle ?? ""}`, outcome: "failed", category: null, subcategory: null, productType: null, collections: [], variants: [],
    exchangeRate: null, availability: null, eta: settings.ETA, images: 0, imagesAdded: 0, specifications: 0, changes: [], notes: [], missing: [], syncedAt: new Date().toISOString(),
    error: msg, errorKind: kind,
  };
}

/** One structured log line per product with every field the importer spec asks for. */
function logProduct(log: Logger, r: RProductReport) {
  const v = r.variants[0];
  const range = r.variants.length > 1 ? ` (${r.variants.length} variants)` : "";
  log.info("product", `${r.title}: ${ACTION[r.outcome]}${r.error ? ` - ${r.error}` : ""}`, {
    sourceProductId: r.sourceProductIds, productName: r.name, sourceUrl: r.url, sourceUsdPrice: v?.usd ?? null, exchangeRate: r.exchangeRate,
    convertedInr: v?.convertedInr != null ? Math.round(v.convertedInr * 100) / 100 : null, adjustmentInr: v?.adjustment ?? null, finalFsrPrice: v?.fsrPrice ?? null,
    variantCount: r.variants.length, imageCount: r.images, status: r.outcome, error: r.error ?? null, syncTimestamp: r.syncedAt, note: range || undefined,
  }, r.key);
}

async function handleMissing(row: RhodeRow, ctx: { settings: RhodeSettings; dryRun: boolean; shopify: RhodeOps | null; log: Logger; s: RSyncSummary }) {
  const { settings, dryRun, shopify, log, s } = ctx;
  if (row.last_sync_status === "archived") return;
  const scans = row.missing_scans + 1;
  s.counts.missing++;
  const threshold = settings.PRODUCT_MISSING_CONFIRMATION_SCANS;
  if (scans < threshold) {
    log.warn("removal", `not in the Rhode catalog - warning only (${scans}/${threshold} consecutive successful full scans)`, undefined, row.group_key);
    if (!dryRun) upsertRow({ group_key: row.group_key, missing_scans: scans, last_sync_status: "missing" });
    return;
  }
  if (dryRun || !shopify) { log.info("removal", `[dry-run] would ${settings.MISSING_ACTION} after ${scans} missing scans`, undefined, row.group_key); return; }
  try {
    const status = settings.MISSING_ACTION === "archive" ? "ARCHIVED" : "DRAFT";
    await shopify.metafieldsSet(row.shopify_product_id!, [{ namespace: RNS, key: "source_status", type: "single_line_text_field", value: "missing" }]);
    await shopify.setStatus(row.shopify_product_id!, status); // never deleted
    s.counts.archived++;
    upsertRow({ group_key: row.group_key, missing_scans: scans, last_sync_status: "archived", shopify_status: status });
    log.warn("removal", `source_status = missing; ${status} after ${scans} consecutive missed scans`, undefined, row.group_key);
  } catch (e) {
    s.counts.failed++;
    s.errors.push({ id: row.group_key, stage: "removal", kind: "shopify_api", message: errMsg(e) });
    log.error("removal", errMsg(e), undefined, row.group_key);
  }
}

async function publishPending(shopify: RhodeOps, settings: RhodeSettings, log: Logger, s: RSyncSummary) {
  const pending = allRows().filter((r) => r.shopify_product_id && r.shopify_status === "ACTIVE" && !r.published);
  if (!pending.length) return;
  const pubs = await shopify.resolvePublications(settings.PUBLISH_CHANNELS.split(","));
  if (!pubs) { s.warnings.push(`${pending.length} ACTIVE product(s) not yet published to sales channels: the Shopify app needs read_publications + write_publications.`); return; }
  let ok = 0;
  for (const r of pending) {
    try { await shopify.publish(r.shopify_product_id!, pubs); upsertRow({ group_key: r.group_key, published: 1 }); ok++; }
    catch (e) { s.errors.push({ id: r.group_key, stage: "publish", kind: "shopify_api", message: errMsg(e) }); log.error("publish", errMsg(e), undefined, r.group_key); }
  }
  log.info("publish", `published ${ok}/${pending.length} product(s) to: ${settings.PUBLISH_CHANNELS}`);
}

function tally(s: RSyncSummary, r: RProductReport) {
  const c = s.counts;
  const wrote = r.outcome === "created" || r.outcome === "planned_create" || r.outcome === "updated" || r.outcome === "planned_update";
  if (r.outcome === "created" || r.outcome === "planned_create") c.created++;
  else if (r.outcome === "updated" || r.outcome === "planned_update") c.updated++;
  else if (r.outcome === "unchanged" || r.outcome === "planned_unchanged") c.unchanged++;
  else if (r.outcome === "needs_review") { c.needsReview++; c.skipped++; }
  else if (r.outcome === "failed") c.failed++;
  if (wrote) c.variantsUpdated += r.variants.length;
  c.imagesUpdated += r.imagesAdded;
  if (r.notes.some((x) => x.startsWith("PRICE UPDATES PAUSED"))) c.pricesPaused++;
  if (!r.changes.includes("new")) {
    if (r.changes.some((x) => /price/i.test(x))) c.priceChanges++;
    if (r.changes.includes("availability")) c.availabilityChanges++;
  }
}

const inr = (v: number | null) => (v == null ? "—" : `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
const usd = (v: number | null) => (v == null ? "—" : `$${v.toFixed(2)}`);
const ACTION: Record<Outcome, string> = { planned_create: "WOULD CREATE", created: "CREATED", planned_update: "WOULD UPDATE", updated: "UPDATED", planned_unchanged: "NO CHANGE", unchanged: "NO CHANGE", needs_review: "SKIPPED (needs review)", failed: "FAILED" };

function summaryBlock(s: RSyncSummary): string[] {
  const c = s.counts;
  return [
    `Discovered: ${c.discovered}`, `New: ${c.created}`, `Updated: ${c.updated}`, `Unchanged: ${c.unchanged}`, `Skipped: ${c.skipped}`, `Failed: ${c.failed}`,
    `Variants updated: ${c.variantsUpdated}`, `Images updated: ${c.imagesUpdated}`, `Price changes: ${c.priceChanges}`,
  ];
}

export function formatRhodeReport(s: RSyncSummary): string {
  const c = s.counts;
  const L: string[] = [];
  const done = s.status === "success" || s.status === "partial";
  L.push(done ? "RHODE SYNC COMPLETE" : `RHODE SYNC ${s.status.toUpperCase()}`);
  L.push("");
  L.push(...summaryBlock(s));
  L.push("");
  L.push(`Sync id:                 ${s.syncId}  (${s.mode === "dry_run" ? "DRY RUN - no Shopify changes made; New/Updated = would create/update" : "LIVE"})`);
  L.push(`Started / finished:      ${s.startedAt} / ${s.finishedAt} (${Math.round(s.durationMs / 1000)}s)`);
  L.push(`Status:                  ${s.status}`);
  L.push(`Exchange rate:           ${s.fx ? (s.fx.ok ? `1 USD = ₹${s.fx.rate} (${s.fx.provider}, ${s.fx.origin}; obtained ${s.fx.fetchedAt}, provider time ${s.fx.providerUpdatedAt ?? "n/a"})` : `NONE - ${s.fx.reason}`) : "—"}`);
  if (s.discovery) {
    const ex = Object.entries(s.discovery.excluded).map(([k, v]) => `${v} ${k}`).join(", ");
    L.push(`Source:                  rhodeskin.com /products.json - ${s.discovery.products} Rhode products${s.discovery.complete ? "" : " (INCOMPLETE)"} -> ${s.discovery.groups} FSR products (${s.discovery.families} shade families)${ex ? `; excluded: ${ex}` : ""}`);
    L.push(`Categories from:         Rhode collections ${s.discovery.collections.join(", ") || "(none read)"}`);
    L.push(`Requests:                ${s.discovery.requests} (${s.discovery.pageRequests} product pages)${s.limit ? `; limited to ${s.limit} products` : ""}`);
  }
  L.push(`Source scan:             ${s.sourceReliable ? "reliable" : `${UNRELIABLE} - no missing-product cleanup`}`);
  L.push(`Shopify matching:        ${s.shopifyChecked ? "checked against live store" : "NOT checked - local database only"}`);
  L.push(`Needs review:            ${c.needsReview}    Price updates paused: ${c.pricesPaused}    Availability changes: ${c.availabilityChanges}`);
  L.push(`Missing from source:     ${c.missing}    Archived: ${c.archived}    Rate-limit events: ${c.rateLimitEvents}`);
  L.push(`Errors:                  ${s.errors.length ? "" : "none"}`);
  for (const e of s.errors.slice(0, 50)) L.push(`  - [${e.stage}${e.kind ? `/${e.kind}` : ""}] ${e.id ?? ""} ${e.message}`);
  if (s.warnings.length) { L.push(""); L.push("WARNINGS:"); for (const w of s.warnings) L.push(`  ! ${w}`); }
  L.push(""); L.push("==== PRODUCTS ====");
  for (const p of s.products) {
    L.push("");
    L.push(`${p.title}`);
    L.push(`  Source product id: ${p.sourceProductIds}    FSR key: ${p.key}`);
    L.push(`  Source URL:     ${p.url}`);
    if (p.error) { L.push(`  Action:         ${ACTION[p.outcome]}  [${p.errorKind}] ${p.error}`); continue; }
    L.push(`  Category:       ${p.category}${p.subcategory ? ` / ${p.subcategory}` : ""}    Rhode collections: ${p.collections.join(", ") || "—"}`);
    L.push(`  Variants:       ${p.variants.length}    Images: ${p.images}${p.imagesAdded ? ` (${p.imagesAdded} to upload)` : ""}    ETA: ${p.eta}`);
    for (const v of p.variants) {
      L.push(`  • ${v.variant.padEnd(26)} ${v.sku.padEnd(16)} ${v.availability.padEnd(12)} ${usd(v.usd)}${v.saleUsd != null ? ` (sale; regular ${usd(v.regularUsd)})` : ""} × ${p.exchangeRate ?? "?"} = ${inr(v.convertedInr != null ? Math.round(v.convertedInr * 100) / 100 : null)} + ${inr(v.adjustment)} = FSR ${inr(v.fsrPrice)}${v.compareAt ? `  compare-at ${inr(v.compareAt)}` : ""}`);
    }
    L.push(`  Action:         ${ACTION[p.outcome]}${p.shopifyProductId ? `  ${p.shopifyProductId}` : ""}`);
    if (p.changes.length) L.push(`  Changes:        ${p.changes.join(", ")}`);
    for (const note of p.notes) L.push(`  - ${note}`);
    if (p.missing.length) L.push(`  Not on source:  ${p.missing.join(", ")}`);
  }
  return L.join("\n") + "\n";
}

export function nextRhodeScheduledAt(settings = getRhodeSettings()): string | null {
  if (settings.SYNC_PAUSED || !settings.ENABLED) return null;
  const last = rdb.prepare("SELECT started_at FROM sync_runs WHERE trigger = 'scheduler' AND status != 'running' ORDER BY started_at DESC LIMIT 1").get() as { started_at: string } | undefined;
  if (!last) return new Date().toISOString();
  return new Date(new Date(last.started_at).getTime() + settings.SYNC_INTERVAL_HOURS * 3600_000).toISOString();
}
