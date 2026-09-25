import fs from "node:fs";
import path from "node:path";
import { LOG_DIR, hasShopifyCredentials } from "../config.ts";
import { getExchangeRate, type FxRate } from "../gymshark/fx.ts";
import { GymsharkOps, type GShopifyProduct } from "../gymshark/ops.ts";
import { Logger } from "../logger.ts";
import { calculateMkPrice, type MkPrice } from "../michaelkors/pricing.ts";
import { AccessControlledError, PoliteHttp } from "../politeHttp.ts";
import { SourceBlockedError, errMsg, hash, retry } from "../util.ts";
import { TB_SOURCE, TORY_BURCH_AUTHORIZED_IMPORTER, type TbSettings } from "./config.ts";
import { acquireTLock, allRows, getRow, getTbSettings, getTState, imagesFor, nextTbSyncId, recordPriceChange, releaseTLock, replaceImages, setTState, tdb, upsertRow, type TbRow } from "./db.ts";
import { WATCH_EXCLUDED_CODE, WATCH_LOG_MESSAGE, WATCH_SKIP_REASON } from "./exclusion.ts";
import { normalizeTb, type NormalizedStyle } from "./normalize.ts";
import { COLOR, ExcludedProduct, PlanConflict, TBNS, buildTbPlan, mapUploadedMedia } from "./plan.ts";
import { discoverTb, fetchTbProduct, readFeed, type DiscoveredUrl, type TbStyle } from "./source.ts";

export interface TbSyncOptions { dryRun?: boolean; limit?: number; trigger?: string; styles?: string[] }

export type Outcome = "created" | "updated" | "unchanged" | "failed" | "needs_review" | "gone" | "watch_excluded" | "skipped" | "planned_create" | "planned_update" | "planned_unchanged";

export interface TbProductReport {
  style: string; title: string; name: string; url: string; outcome: Outcome; at: string;
  category: string | null; collection: string | null; gender: string | null; productType: string | null; onSale: boolean;
  colours: { colour: string; availability: string; usd: number | null; regularUsd: number | null; rate: number | null; convertedInr: number | null; shipping: number | null; landed: number | null; profit: number | null; fsrPrice: number | null }[];
  variants: number; sizes: string[]; weightKg: number | null; weightReason: string | null; availability: string | null; eta: string; images: number; imagesUploaded: number;
  changes: string[]; notes: string[]; missing: string[]; exclusion?: string | null; shopifyProductId?: string | null; error?: string; planned?: Record<string, unknown>;
}

export interface TbSyncSummary {
  syncId: string; mode: "dry_run" | "live"; trigger: string; status: "success" | "partial" | "failed" | "aborted" | "disabled";
  startedAt: string; finishedAt: string; durationMs: number; limit: number; sourceMode: string; shopifyChecked: boolean;
  fx: { ok: boolean; rate: number | null; provider: string | null; fetchedAt: string | null; origin: string; reason?: string } | null;
  discovery: { styles: number; complete: boolean; duplicatesMerged: number; watchUrlsExcluded: number; departmentsExcluded: number; pagesFetched: number; requests: number } | null;
  scanReliable: boolean;
  counts: {
    discovered: number; eligible: number; processed: number; created: number; updated: number; unchanged: number; watchExcluded: number; skipped: number; needsReview: number;
    priceChanges: number; imageChanges: number; imagesUploaded: number; availabilityChanges: number; variantChanges: number; variantsWritten: number; pricesPaused: number;
    missing: number; archived: number; gone: number; failed: number; rateLimitEvents: number;
  };
  errors: { id?: string; stage: string; message: string }[];
  warnings: string[];
  products: TbProductReport[];
}

class Aborted extends Error {}

/** Tory Burch variant of the shared Shopify operations: own namespace + SKU rule, plus title / handle lookups. */
export class TbOps extends GymsharkOps {
  constructor(log: Logger) {
    super(log, { ns: TBNS, idName: "Tory Burch style number", skuMatches: (sku, style) => sku === style.toUpperCase() || sku.startsWith(`${style.toUpperCase()}-`) });
  }
  /** Priority 5: same vendor + same normalised title (products listed by hand, without our SKUs or metafield). */
  async titleMatches(title: string): Promise<{ id: string; title: string; status: string }[]> {
    const q = `vendor:"Tory Burch" AND title:"${title.replace(/["\\]/g, " ")}"`;
    const r = await this.client.graphql<{ products: { nodes: { id: string; title: string; status: string; sourceId: { value: string } | null }[] } }>(
      `query ByTitle($q: String!) { products(first: 10, query: $q) { nodes { id title status sourceId: metafield(namespace: "${TBNS}", key: "source_product_id") { value } } } }`, { q },
    );
    const norm = (x: string) => x.toLowerCase().replace(/^tory\s+burch\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
    return r.products.nodes.filter((p) => !p.sourceId && norm(p.title) === norm(title)).map(({ id, title: t, status }) => ({ id, title: t, status }));
  }
  /** Priority 4: a product already using the handle this sync would create. */
  async handleMatch(handle: string): Promise<{ id: string; title: string; status: string; ours: boolean } | null> {
    const r = await this.client.graphql<{ productByIdentifier: { id: string; title: string; status: string; sourceId: { value: string } | null } | null }>(
      `query ByHandle($handle: String!) { productByIdentifier(identifier: { handle: $handle }) { id title status sourceId: metafield(namespace: "${TBNS}", key: "source_product_id") { value } } }`, { handle },
    );
    const p = r.productByIdentifier;
    return p ? { id: p.id, title: p.title, status: p.status, ours: !!p.sourceId } : null;
  }
}

export async function runTbSync(opts: TbSyncOptions = {}): Promise<TbSyncSummary> {
  const settings = getTbSettings();
  const dryRun = opts.dryRun ?? settings.DRY_RUN;
  const limit = opts.limit ?? settings.SYNC_LIMIT;
  const trigger = opts.trigger ?? "manual";
  const syncId = nextTbSyncId();
  const log = new Logger(syncId, { db: tdb, name: "toryburch-sync" });
  const startedAt = new Date();

  if (!acquireTLock(syncId)) throw new Error("Another Tory Burch sync is already running (lock held)");
  tdb.prepare("UPDATE sync_runs SET status = 'aborted', finished_at = COALESCE(finished_at, ?) WHERE status = 'running'").run(startedAt.toISOString());
  tdb.prepare("INSERT INTO sync_runs (id, started_at, mode, trigger, status) VALUES (?,?,?,?, 'running')").run(syncId, startedAt.toISOString(), dryRun ? "dry_run" : "live", trigger);

  const s: TbSyncSummary = {
    syncId, mode: dryRun ? "dry_run" : "live", trigger, status: "success", startedAt: startedAt.toISOString(), finishedAt: "", durationMs: 0, limit,
    sourceMode: settings.SOURCE_MODE, shopifyChecked: false, fx: null, discovery: null, scanReliable: false,
    counts: {
      discovered: 0, eligible: 0, processed: 0, created: 0, updated: 0, unchanged: 0, watchExcluded: 0, skipped: 0, needsReview: 0, priceChanges: 0, imageChanges: 0,
      imagesUploaded: 0, availabilityChanges: 0, variantChanges: 0, variantsWritten: 0, pricesPaused: 0, missing: 0, archived: 0, gone: 0, failed: 0, rateLimitEvents: 0,
    },
    errors: [], warnings: [], products: [],
  };
  const http = new PoliteHttp(settings.REQUEST_DELAY_MS, log, { userAgent: TB_SOURCE.userAgent, label: "Tory Burch", acceptLanguage: "en-US,en;q=0.9", challenge: /captcha|verify you are human|px-captcha|_pxhd|access denied|request unsuccessful/i });

  try {
    if (!settings.ENABLED && trigger === "scheduler") { s.status = "disabled"; s.warnings.push("TORY_BURCH_ENABLED=false - scheduled sync skipped."); return s; }
    log.info("start", `Tory Burch sync started (${s.mode}, source=${settings.SOURCE_MODE}, limit=${limit || "none"}, trigger=${trigger}); authorized importer=${TORY_BURCH_AUTHORIZED_IMPORTER}`);
    if (!TORY_BURCH_AUTHORIZED_IMPORTER) s.warnings.push("TORY_BURCH_AUTHORIZED_IMPORTER=false: Tory Burch images and description text are not copied.");

    let shopify: TbOps | null = null;
    if (hasShopifyCredentials()) {
      shopify = new TbOps(log);
      await shopify.ensureDefinitions(dryRun);
      await shopify.resolveLocation();
      s.shopifyChecked = true;
    } else if (!dryRun) {
      throw new Aborted("Live sync requires the existing Shopify Admin API credentials in on-sync/.env.");
    } else {
      s.warnings.push("No Shopify credentials: dry run matched against the local database only.");
    }

    const fx = await getExchangeRate(settings, log, { store: { db: tdb, getState: getTState } });
    s.fx = { ok: fx.ok, rate: fx.rate, provider: fx.provider, fetchedAt: fx.fetchedAt, origin: fx.origin, reason: fx.reason };
    if (!fx.ok) s.warnings.push(`NO VALID EXCHANGE RATE (${fx.reason}). Price updates are paused; new products are not created.`);
    else if (fx.origin === "cached") s.warnings.push(`Exchange rate provider unavailable - using the last valid rate: ${fx.reason}`);

    const ctx: Ctx = { settings, dryRun, shopify, log, syncId, fx, s };
    const wanted = opts.styles?.length ? new Set(opts.styles.map((x) => x.toUpperCase())) : null;
    const seenStyles = new Set<string>();
    const excludedStyles = new Set<string>();
    let complete = false;
    let blocked: string | null = null;
    let fetchFailures = 0;

    const handle = async (st: TbStyle) => {
      if (seenStyles.has(st.styleCode) || excludedStyles.has(st.styleCode)) return; // duplicate listing: one product only
      const n = normalizeTb(st, settings);
      if (n.exclusion.excluded) { excludedStyles.add(n.styleCode); s.products.push(recordExcluded(n, ctx)); return; }
      seenStyles.add(n.styleCode);
      const rep = await processStyle(n, ctx);
      s.products.push(rep);
      tally(s, rep);
    };

    if (settings.SOURCE_MODE === "feed") {
      const feed = readFeed(settings.FEED_DIR, log, settings.IMAGE_PRESET);
      complete = feed.errors.length === 0 && feed.files > 0;
      for (const e of feed.errors) { s.errors.push({ id: e.file, stage: "feed", message: e.message }); s.counts.failed++; fetchFailures++; }
      s.discovery = { styles: feed.styles.length, complete, duplicatesMerged: 0, watchUrlsExcluded: 0, departmentsExcluded: 0, pagesFetched: feed.files, requests: 0 };
      s.counts.discovered = feed.styles.length;
      for (const st of feed.styles) {
        if (wanted && !wanted.has(st.styleCode)) continue;
        if (limit > 0 && seenStyles.size >= limit) break;
        try { await handle(st); } catch (e) { fetchFailures++; await failed(ctx, st.styleCode, st.url, e); }
        s.counts.processed++;
      }
      s.discovery.duplicatesMerged = Math.max(0, feed.styles.length - seenStyles.size - excludedStyles.size);
    } else {
      let discovery;
      const extra = settings.EXCLUDED_CATEGORIES.split(",");
      try { discovery = await discoverTb(http, log, extra); }
      catch (e) { throw e instanceof SourceBlockedError ? new Aborted(`${e.message}. Tory Burch's bot protection refused automated access; it is not bypassed. Retry later, ask Tory Burch to allowlist the importer, or supply saved pages (SOURCE_MODE=feed).`) : e; }
      complete = discovery.complete;
      const total = discovery.urls.length + discovery.watchUrls.length + discovery.excludedUrls.length;
      s.counts.discovered = total;
      s.discovery = { styles: total, complete, duplicatesMerged: discovery.duplicates, watchUrlsExcluded: discovery.watchUrls.length, departmentsExcluded: discovery.excludedUrls.length, pagesFetched: 0, requests: 0 };
      for (const w of discovery.watchUrls) {
        excludedStyles.add(w.style);
        if (!wanted || wanted.has(w.style)) s.products.push(recordExcludedUrl(w, ctx, "watch_excluded", `url: product is under the /${w.department}/ watch route (page not fetched)`));
      }
      for (const x of discovery.excludedUrls) {
        excludedStyles.add(x.style);
        if (!wanted || wanted.has(x.style)) s.products.push(recordExcludedUrl(x, ctx, "skipped", `category "${x.rule}" is in EXCLUDED_CATEGORIES (page not fetched)`));
      }
      const pool: DiscoveredUrl[] = wanted ? discovery.urls.filter((u) => wanted.has(u.style)) : discovery.urls;
      for (const u of pool) {
        if (limit > 0 && seenStyles.size >= limit) break;
        try {
          const page = await retry(() => fetchTbProduct(http, u.url, settings.IMAGE_PRESET), { attempts: 2, baseMs: 5000, onRetry: (e, a, w) => log.warn("parse", `product page retry ${a} in ${w}ms: ${errMsg(e)}`, { url: u.url }) });
          s.discovery.pagesFetched++;
          if (page.gone || !page.style) { s.counts.gone++; log.warn("parse", `listed in the sitemap but not a live product page (${page.finalUrl})`, { url: u.url }); continue; }
          await handle(page.style);
        } catch (e) {
          if (e instanceof SourceBlockedError) { blocked = e.message; log.error("source", e.message); break; }
          if (e instanceof AccessControlledError) { fetchFailures++; log.warn("source", e.message, { url: u.url }); continue; }
          fetchFailures++;
          await failed(ctx, u.style, u.url, e);
        }
        s.counts.processed++;
      }
      if (blocked) { s.status = "aborted"; s.errors.push({ stage: "source", message: `${blocked} - crawl stopped (not bypassed)` }); }
    }
    s.counts.eligible = seenStyles.size;

    if (!dryRun && shopify && !blocked) await publishPending(shopify, settings, log, s);

    // ---- missing products: ONLY after a complete, reliable, unlimited, unfiltered scan; never deleted ----
    const lastCount = Number(getTState("last_complete_count") ?? 0);
    const problems: string[] = [];
    if (blocked) problems.push("source blocked / unavailable");
    if (!complete) problems.push("catalog listing incomplete");
    if (fetchFailures) problems.push(`${fetchFailures} product page(s) failed`);
    if (seenStyles.size < settings.MIN_CATALOG_SIZE) problems.push(`only ${seenStyles.size} eligible styles (minimum ${settings.MIN_CATALOG_SIZE})`);
    if (lastCount && seenStyles.size < lastCount * 0.5) problems.push(`only ${seenStyles.size} eligible styles vs ${lastCount} last time`);
    if (limit || wanted) {
      s.warnings.push("Limited / filtered run: missing-product detection not applicable.");
    } else if (problems.length) {
      s.warnings.push(`SOURCE_SCAN_UNRELIABLE: ${problems.join("; ")} - missing-product cleanup aborted, nothing archived.`);
      log.warn("removal", `SOURCE_SCAN_UNRELIABLE: ${problems.join("; ")}`);
    } else {
      s.scanReliable = true;
      for (const row of allRows()) {
        if (seenStyles.has(row.style_code) || excludedStyles.has(row.style_code) || !row.shopify_product_id || row.import_status === "watch_excluded") continue;
        await handleMissing(row, ctx);
      }
      if (!dryRun) setTState("last_complete_count", String(seenStyles.size));
    }
  } catch (e) {
    s.status = e instanceof Aborted ? "aborted" : "failed";
    s.errors.push({ stage: "sync", message: errMsg(e) });
    log.error("sync", errMsg(e));
    if (!s.warnings.some((w) => w.startsWith("SOURCE_SCAN_UNRELIABLE"))) s.warnings.push("SOURCE_SCAN_UNRELIABLE: sync did not complete - missing-product cleanup aborted, nothing archived.");
  } finally {
    if (s.status === "success" && s.counts.failed > 0) s.status = "partial";
    s.counts.rateLimitEvents = http.rateLimitEvents;
    if (s.discovery) s.discovery.requests = http.requests;
    const finished = new Date();
    s.finishedAt = finished.toISOString();
    s.durationMs = finished.getTime() - startedAt.getTime();
    const { products: _p, ...rest } = s;
    tdb.prepare("UPDATE sync_runs SET finished_at = ?, duration_ms = ?, status = ?, summary_json = ?, errors_json = ? WHERE id = ?")
      .run(s.finishedAt, s.durationMs, s.status, JSON.stringify(rest), JSON.stringify(s.errors), syncId);
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOG_DIR, `${syncId}.report.json`), JSON.stringify(s, null, 2));
    fs.writeFileSync(path.join(LOG_DIR, `${syncId}.report.txt`), formatTbReport(s));
    log.info("complete", `TORY BURCH SYNC COMPLETE (${s.status}) in ${Math.round(s.durationMs / 1000)}s`, rest.counts as unknown as Record<string, unknown>);
    releaseTLock();
  }
  return s;
}

interface Ctx { settings: TbSettings; dryRun: boolean; shopify: TbOps | null; log: Logger; syncId: string; fx: FxRate; s: TbSyncSummary }

async function failed(ctx: Ctx, id: string, url: string, e: unknown) {
  const { s, log, settings, dryRun, shopify } = ctx;
  const msg = errMsg(e);
  log.error("product", msg, { url }, id);
  s.errors.push({ id, stage: "product", message: msg });
  s.counts.failed++;
  s.products.push({ ...emptyReport(id, url, settings), outcome: "failed", error: msg });
  const row = getRow(id);
  upsertRow({ style_code: id, source_url: url, import_status: "error", error_message: msg, last_sync_status: "failed" });
  // surface the error on an already-imported product (metafield only; nothing else is changed)
  if (!dryRun && shopify && row?.shopify_product_id && row.import_status !== "watch_excluded") {
    try { await shopify.metafieldsSet(row.shopify_product_id, [{ namespace: TBNS, key: "sync_error", type: "single_line_text_field", value: msg.slice(0, 250) }]); } catch { /* best effort */ }
  }
}

export function pricesFor(n: NormalizedStyle, fx: Pick<FxRate, "ok" | "rate" | "base">, settings: TbSettings): Map<string, MkPrice> {
  // SAME formula as the Michael Kors importer: current USD x live rate + weight shipping + profit band (current sale price, never a checkout promo)
  return new Map(n.colours.map((c) => [c.colour, calculateMkPrice({ currentUsd: c.currentUsd, regularUsd: c.regularUsd, currency: c.currency, weightKg: n.weightKg }, fx, settings)]));
}

/** SKIP + LOG: a watch (or an EXCLUDED_CATEGORIES product) is never created, updated, given images / variants, archived or deleted. */
function recordExcluded(n: NormalizedStyle, ctx: Ctx): TbProductReport {
  const { log, dryRun, s } = ctx;
  const watch = n.exclusion.status === "watch_excluded";
  const reason = watch ? WATCH_SKIP_REASON : n.exclusion.reason ?? "excluded";
  if (watch) s.counts.watchExcluded++; else s.counts.skipped++;
  if (watch) log.info("exclude", `${WATCH_EXCLUDED_CODE} ${n.styleCode} "${n.name}" [${n.exclusion.level}] ${n.exclusion.reason} - ${WATCH_LOG_MESSAGE}`, { import_status: "watch_excluded", skip_reason: reason, url: n.sourceUrl }, n.styleCode);
  else log.info("exclude", `SKIPPED ${n.styleCode} "${n.name}" [${n.exclusion.level}] ${n.exclusion.reason}`, undefined, n.styleCode);
  const rep: TbProductReport = { ...reportBase(n, ctx.settings, new Map()), outcome: watch ? "watch_excluded" : "skipped", exclusion: `${n.exclusion.level}: ${n.exclusion.reason}` };
  const prev = getRow(n.styleCode);
  if (prev?.shopify_product_id) rep.notes.push(`a Shopify product (${prev.shopify_product_id}) was linked to this style earlier - left completely untouched`);
  if (!dryRun) {
    const now = new Date().toISOString();
    upsertRow({
      style_code: n.styleCode, source_url: n.sourceUrl, canonical_url: n.canonicalUrl, title: n.title, gender: n.gender, department: n.department, category: n.category, collection: n.collection,
      first_seen_at: prev?.first_seen_at ?? now, last_seen_at: now, missing_scans: 0, import_status: n.exclusion.status, skip_reason: reason,
      exclusion_level: n.exclusion.level, last_sync_status: n.exclusion.status, error_message: null,
    });
  }
  return rep;
}

function recordExcludedUrl(u: DiscoveredUrl, ctx: Ctx, status: "watch_excluded" | "skipped", why: string): TbProductReport {
  const watch = status === "watch_excluded";
  if (watch) ctx.s.counts.watchExcluded++; else ctx.s.counts.skipped++;
  const reason = watch ? WATCH_SKIP_REASON : why;
  if (watch) ctx.log.info("exclude", `${WATCH_EXCLUDED_CODE} ${u.style} [url] ${u.url} - ${WATCH_LOG_MESSAGE}`, { import_status: "watch_excluded", skip_reason: reason }, u.style);
  if (!ctx.dryRun) {
    const now = new Date().toISOString();
    upsertRow({ style_code: u.style, source_url: u.url, department: u.department, first_seen_at: getRow(u.style)?.first_seen_at ?? now, last_seen_at: now, missing_scans: 0, import_status: status, skip_reason: reason, exclusion_level: watch ? "url" : "category", last_sync_status: status });
  }
  return { ...emptyReport(u.style, u.url, ctx.settings), outcome: status, exclusion: why };
}

async function processStyle(n: NormalizedStyle, ctx: Ctx): Promise<TbProductReport> {
  const { settings, dryRun, shopify, log, syncId, fx } = ctx;
  const now = new Date().toISOString();
  const id = n.styleCode;
  const prices = pricesFor(n, fx, settings);
  const r = getRow(id);
  const fsrPriceHash = hash([...prices.entries()].map(([c, p]) => [c, p.fsrPrice, p.compareAtPrice]));
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
  if (r?.shopify_product_id && !r.image_hash && n.images.length) changes.push("images pending");
  if (r?.last_sync_status && ["failed", "needs_review", "missing", "archived", "watch_excluded", "skipped"].includes(r.last_sync_status)) changes.push(`retry after ${r.last_sync_status}`);

  const rep: TbProductReport = { ...reportBase(n, settings, prices), outcome: "unchanged", changes, shopifyProductId: r?.shopify_product_id ?? null };

  // ---- CHECK DUPLICATE: 1 source product id (unique metafield) -> stored id -> 2 SKU / style number -> 4 handle -> 5 title ----
  // (3 canonical URL: every style is keyed by the style number in its canonical URL, so routes / ?color= links merge upstream)
  let existing: GShopifyProduct | null = null;
  let identifier: Record<string, unknown> = { customId: { namespace: TBNS, key: "source_product_id", value: id } };
  if (shopify && (changes.length || !r?.shopify_product_id)) {
    existing = await shopify.byCustomId(id);
    if (!existing && r?.shopify_product_id) {
      existing = await shopify.byId(r.shopify_product_id);
      if (existing) rep.notes.push("matched by stored Shopify product id");
    }
    if (!existing) {
      const bySku = await shopify.skuCollisions(id);
      const byHandle = bySku.length ? null : await shopify.handleMatch(n.handle);
      const byTitle = bySku.length || byHandle ? [] : await shopify.titleMatches(n.title);
      const found = [...bySku, ...(byHandle ? [byHandle] : []), ...byTitle];
      const live = found.filter((c) => c.status !== "ARCHIVED");
      if (found.length) rep.notes.push(`existing non-synced product(s) matching this style (${bySku.length ? "SKU / style number" : byHandle ? "handle" : "same title"}): ${found.map((c) => `"${c.title}" [${c.status}]`).join(", ")}`);
      if (live.length && !settings.ADOPT_EXISTING_PRODUCTS) {
        rep.outcome = "needs_review";
        rep.notes.push("not imported: a product listed by hand already matches. Set ADOPT_EXISTING_PRODUCTS=true to link it instead of creating a duplicate.");
        if (!dryRun) upsertRow({ ...baseRow(n, now), last_sync_status: "needs_review", import_status: "skipped", skip_reason: "matches an existing hand-made product", error_message: null });
        logProduct(ctx, rep);
        return rep;
      }
      if (live.length) { existing = await shopify.byId(live[0].id); rep.notes.push(`adopting existing product "${live[0].title}"`); }
    }
  }
  if (existing) identifier = { id: existing.id };

  if (r?.shopify_product_id && !changes.length) {
    rep.outcome = dryRun ? "planned_unchanged" : "unchanged";
    if (!dryRun) upsertRow({ style_code: id, last_seen_at: now, missing_scans: 0, availability: n.availability });
    logProduct(ctx, rep);
    return rep;
  }
  if (!existing && !r?.shopify_product_id && !pricesOk) {
    rep.outcome = "needs_review";
    rep.notes.push(`not created: ${[...prices.values()].find((p) => !p.ok)?.reason}`);
    logProduct(ctx, rep);
    return rep;
  }

  let plan;
  try {
    plan = buildTbPlan({ n, existing, row: r, settings, prices, fx, images: imagesFor(id), locationId: shopify?.locationId ?? null, nowIso: now });
  } catch (e) {
    if (e instanceof ExcludedProduct) {
      rep.outcome = e.status === "watch_excluded" ? "watch_excluded" : "skipped";
      rep.notes.push(e.message);
      if (e.status === "watch_excluded") log.info("exclude", `${WATCH_EXCLUDED_CODE} ${id} (final safety check) - ${WATCH_LOG_MESSAGE}`, undefined, id);
      return rep;
    }
    if (!(e instanceof PlanConflict)) throw e;
    rep.outcome = "needs_review";
    rep.notes.push(e.message);
    if (!dryRun) upsertRow({ ...baseRow(n, now), shopify_product_id: existing?.id ?? r?.shopify_product_id ?? null, last_sync_status: "needs_review", import_status: "skipped", skip_reason: e.message });
    logProduct(ctx, rep);
    return rep;
  }
  rep.notes.push(...plan.notes);
  const toUpload = plan.imagesSent ? (plan.input.files as Record<string, unknown>[]).filter((f) => f.originalSource).length : 0;

  if (dryRun) {
    rep.outcome = plan.action === "create" ? "planned_create" : "planned_update";
    rep.imagesUploaded = toUpload;
    rep.planned = plan.metafields.length ? { ...plan.input, "(metafieldsSet)": plan.metafields } : plan.input;
    logProduct(ctx, rep);
    return rep;
  }

  const result = await retry(() => shopify!.productSet(plan.input, identifier), {
    attempts: 3, baseMs: 3000, shouldRetry: (e) => (e as { retryable?: boolean }).retryable === true,
    onRetry: (e, a, wait) => log.warn("shopify", `productSet retry ${a} in ${wait}ms: ${errMsg(e)}`, undefined, id),
  });
  if (plan.metafields.length) await shopify!.metafieldsSet(result.id, plan.metafields);
  rep.outcome = plan.action === "create" ? "created" : "updated";
  rep.shopifyProductId = result.id;
  ctx.s.counts.variantsWritten += (plan.input.variants as unknown[]).length;

  let imageHash = r?.image_hash ?? null;
  if (plan.imagesSent) {
    const alts = new Map(n.images.map((i) => [i.key, i.alt]));
    const mapped = mapUploadedMedia(plan.imagesSent, result.media.nodes, alts);
    if (mapped) {
      replaceImages(id, plan.imagesSent.map((im) => ({ source_key: im.key, colour: im.colour, media_id: mapped.get(im.key) ?? null, uploaded_at: now })));
      imageHash = n.hashes.image;
      rep.imagesUploaded = toUpload;
      ctx.s.counts.imagesUploaded += toUpload;
      const firstByColour = new Map<string, string>();
      for (const im of plan.imagesSent) if (!firstByColour.has(im.colour) && mapped.get(im.key)) firstByColour.set(im.colour, mapped.get(im.key)!);
      const pairs = result.variants.nodes
        .map((v) => ({ id: v.id, mediaId: firstByColour.get(v.selectedOptions.find((o) => o.name === COLOR)?.value ?? "") }))
        .filter((x): x is { id: string; mediaId: string } => !!x.mediaId);
      if (pairs.length) await shopify!.setVariantMedia(result.id, pairs);
    } else {
      rep.notes.push(`could not map uploaded media (${result.media.nodes.length} on product, ${plan.imagesSent.length} sent) - images re-checked next sync`);
      imageHash = null;
    }
  }

  if (!plan.pricesPaused && r?.snapshot_json) {
    const prev = JSON.parse(r.snapshot_json) as { colours?: { colour: string; currentUsd: number | null; regularUsd?: number | null; fsrPrice?: number | null }[] };
    for (const c of n.colours) {
      const old = prev.colours?.find((x) => x.colour === c.colour);
      const p = prices.get(c.colour)!;
      if (old && old.currentUsd !== c.currentUsd) {
        recordPriceChange({ style: id, colour: c.colour, at: now, oldUsd: old.currentUsd, newUsd: c.currentUsd!, oldRegular: old.regularUsd ?? null, newRegular: c.regularUsd, oldFsr: old.fsrPrice ?? null, newFsr: p.fsrPrice!, rate: fx.rate!, syncId });
        log.info("price", `${c.colour}: $${old.currentUsd} -> $${c.currentUsd}; FSR ₹${old.fsrPrice ?? "?"} -> ₹${p.fsrPrice}`, undefined, id);
      }
    }
  }

  const cheapest = [...prices.values()].filter((p) => p.ok).sort((a, b) => a.fsrPrice! - b.fsrPrice!)[0];
  const cheapestColour = n.colours.find((c) => prices.get(c.colour) === cheapest);
  const w = [...prices.values()][0]?.weight;
  upsertRow({
    ...baseRow(n, now),
    shopify_product_id: result.id,
    handle: result.handle,
    shopify_status: (plan.input.status as string) ?? existing?.status ?? r?.shopify_status ?? null,
    ...(plan.pricesPaused ? {} : {
      source_price_usd: cheapest?.sourcePriceUsd ?? null, source_regular_price_usd: cheapestColour?.regularUsd ?? cheapestColour?.currentUsd ?? null,
      source_sale_price_usd: cheapestColour?.regularUsd != null ? cheapestColour.currentUsd : null, fsr_selling_price: cheapest?.fsrPrice ?? null,
      converted_price_inr: cheapest?.convertedPriceInr ?? null, landed_cost_inr: cheapest?.landedCostInr ?? null, profit_adjustment_inr: cheapest?.profitInr ?? null,
      exchange_rate: fx.rate, exchange_rate_timestamp: fx.fetchedAt, exchange_rate_provider: fx.provider, price_hash: n.hashes.price, fsr_price_hash: fsrPriceHash,
    }),
    weight_surcharge_inr: w?.surchargeInr ?? null,
    weight_surcharge_reason: w?.reason ?? null,
    last_synced_at: now,
    last_sync_status: rep.outcome,
    import_status: rep.outcome === "created" ? "imported" : "updated",
    skip_reason: null,
    exclusion_level: null,
    product_hash: n.hashes.product,
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
    snapshot_json: JSON.stringify({ ...n, colours: n.colours.map((c) => ({ ...c, fsrPrice: prices.get(c.colour)?.fsrPrice ?? null })) }),
  });
  logProduct(ctx, rep);
  return rep;
}

/** One structured log line per product: source id, title, URL, category, USD, rate, INR, shipping, landed, profit, FSR price, variants, images, action. */
function logProduct(ctx: Ctx, rep: TbProductReport) {
  const c = [...rep.colours].sort((a, b) => (a.fsrPrice ?? Infinity) - (b.fsrPrice ?? Infinity))[0];
  ctx.log.info("product", `${ACTION[rep.outcome] ?? rep.outcome} ${rep.title}`, {
    source_id: rep.style, title: rep.title, source_url: rep.url, category: rep.category, source_usd: c?.usd ?? null, regular_usd: c?.regularUsd ?? null, exchange_rate: c?.rate ?? null,
    converted_inr: c?.convertedInr ?? null, shipping_inr: c?.shipping ?? null, landed_inr: c?.landed ?? null, profit_inr: c?.profit ?? null, fsr_price: c?.fsrPrice ?? null,
    variants: rep.variants, images: rep.images, action: rep.outcome, timestamp: rep.at,
  }, rep.style);
}

function baseRow(n: NormalizedStyle, now: string): Partial<TbRow> & { style_code: string } {
  const existing = getRow(n.styleCode);
  return {
    style_code: n.styleCode, source_product_ids: JSON.stringify(Object.fromEntries(n.variants.map((v) => [v.sku, v.sourceSku]))), source_url: n.sourceUrl,
    canonical_url: n.canonicalUrl, title: n.title, gender: n.gender, department: n.department, category: n.category, collection: n.collection,
    colours: JSON.stringify(n.colours.map((c) => c.colour)), source_weight_kg: n.weightKg, availability: n.availability,
    first_seen_at: existing?.first_seen_at ?? now, last_seen_at: now, missing_scans: 0,
  };
}

function reportBase(n: NormalizedStyle, settings: TbSettings, prices: Map<string, MkPrice>): TbProductReport {
  const w = [...prices.values()][0]?.weight;
  return {
    style: n.styleCode, title: n.title, name: n.name, url: n.sourceUrl, outcome: "unchanged", at: new Date().toISOString(), category: n.category, collection: n.collection,
    gender: n.gender, productType: n.productType, onSale: n.onSale,
    colours: n.colours.map((c) => {
      const p = prices.get(c.colour);
      return { colour: c.colour, availability: c.availability, usd: p?.sourcePriceUsd ?? c.currentUsd, regularUsd: c.regularUsd, rate: p?.exchangeRate ?? null, convertedInr: p?.convertedPriceInr ?? null, shipping: p?.weight.surchargeInr ?? null, landed: p?.landedCostInr ?? null, profit: p?.profitInr ?? null, fsrPrice: p?.fsrPrice ?? null };
    }),
    variants: n.variants.length, sizes: n.sizeOrder, weightKg: n.weightKg, weightReason: w?.reason ?? null, availability: n.availability, eta: settings.DEFAULT_ETA,
    images: n.images.length, imagesUploaded: 0, changes: [], notes: [], missing: n.missing,
  };
}

function emptyReport(style: string, url: string, settings: TbSettings): TbProductReport {
  return {
    style, title: style, name: style, url, outcome: "failed", at: new Date().toISOString(), category: null, collection: null, gender: null, productType: null, onSale: false,
    colours: [], variants: 0, sizes: [], weightKg: null, weightReason: null, availability: null, eta: settings.DEFAULT_ETA, images: 0, imagesUploaded: 0, changes: [], notes: [], missing: [],
  };
}

async function handleMissing(row: TbRow, ctx: Ctx) {
  const { settings, dryRun, shopify, log, s } = ctx;
  if (row.last_sync_status === "archived") return;
  const scans = row.missing_scans + 1;
  s.counts.missing++;
  const threshold = Math.max(2, settings.PRODUCT_MISSING_CONFIRMATION_SCANS);
  if (scans < threshold) {
    log.warn("removal", `not in the Tory Burch catalog (${scans}/${threshold} consecutive reliable scans)`, undefined, row.style_code);
    if (!dryRun) upsertRow({ style_code: row.style_code, missing_scans: scans, last_sync_status: "missing" });
    return;
  }
  if (dryRun || !shopify) { log.info("removal", `[dry-run] would ${settings.MISSING_ACTION} after ${scans} missing scans`, undefined, row.style_code); return; }
  try {
    const status = settings.MISSING_ACTION === "archive" ? "ARCHIVED" : "DRAFT";
    await shopify.setStatus(row.shopify_product_id!, status); // never deleted
    await shopify.metafieldsSet(row.shopify_product_id!, [{ namespace: TBNS, key: "source_status", type: "single_line_text_field", value: "removed_from_source" }]);
    s.counts.archived++;
    upsertRow({ style_code: row.style_code, missing_scans: scans, last_sync_status: "archived", shopify_status: status });
    log.warn("removal", `${status} after ${scans} consecutive missing scans`, undefined, row.style_code);
  } catch (e) {
    s.counts.failed++;
    s.errors.push({ id: row.style_code, stage: "removal", message: errMsg(e) });
    log.error("removal", errMsg(e), undefined, row.style_code);
  }
}

async function publishPending(shopify: TbOps, settings: TbSettings, log: Logger, s: TbSyncSummary) {
  const pending = allRows().filter((r) => r.shopify_product_id && r.shopify_status === "ACTIVE" && !r.published);
  if (!pending.length) return;
  const pubs = await shopify.resolvePublications(settings.PUBLISH_CHANNELS.split(","));
  if (!pubs) { s.warnings.push(`${pending.length} ACTIVE product(s) not yet published to sales channels: the Shopify app needs read_publications + write_publications.`); return; }
  let ok = 0;
  for (const r of pending) {
    try { await shopify.publish(r.shopify_product_id!, pubs); upsertRow({ style_code: r.style_code, published: 1 }); ok++; }
    catch (e) { s.errors.push({ id: r.style_code, stage: "publish", message: errMsg(e) }); log.error("publish", errMsg(e), undefined, r.style_code); }
  }
  log.info("publish", `published ${ok}/${pending.length} product(s) to: ${settings.PUBLISH_CHANNELS}`);
}

function tally(s: TbSyncSummary, r: TbProductReport) {
  const c = s.counts;
  if (r.outcome === "created" || r.outcome === "planned_create") c.created++;
  else if (r.outcome === "updated" || r.outcome === "planned_update") c.updated++;
  else if (r.outcome === "unchanged" || r.outcome === "planned_unchanged") c.unchanged++;
  else if (r.outcome === "needs_review") c.needsReview++;
  else if (r.outcome === "watch_excluded") c.watchExcluded++;
  else if (r.outcome === "skipped") c.skipped++;
  if (r.notes.some((x) => x.startsWith("PRICE UPDATES PAUSED"))) c.pricesPaused++;
  if (!r.changes.includes("new")) {
    if (r.changes.some((x) => /price/i.test(x))) c.priceChanges++;
    if (r.changes.includes("images")) c.imageChanges++;
    if (r.changes.includes("availability")) c.availabilityChanges++;
    if (r.changes.includes("variants")) c.variantChanges++;
  }
}

const inr = (v: number | null) => (v == null ? "—" : `₹${(Math.round(v * 100) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
const usd = (v: number | null) => (v == null ? "—" : `$${v.toFixed(2)}`);
const ACTION: Partial<Record<Outcome, string>> = {
  planned_create: "CREATE", created: "CREATED", planned_update: "UPDATE", updated: "UPDATED", planned_unchanged: "NO CHANGE", unchanged: "NO CHANGE",
  needs_review: "NEEDS REVIEW", failed: "FAILED", gone: "WITHDRAWN", watch_excluded: "WATCH_EXCLUDED", skipped: "SKIP",
};

export function formatTbReport(s: TbSyncSummary): string {
  const c = s.counts;
  const L: string[] = [];
  L.push(`${s.syncId}  (${s.mode === "dry_run" ? "DRY RUN - no Shopify changes made" : "LIVE"})  source=${s.sourceMode}`);
  L.push(`Started ${s.startedAt}  Finished ${s.finishedAt}  (${Math.round(s.durationMs / 1000)}s)  Status: ${s.status}`);
  if (s.fx) L.push(`Exchange rate: ${s.fx.ok ? `1 USD = ₹${s.fx.rate} (${s.fx.provider}, ${s.fx.origin}, ${s.fx.fetchedAt})` : `NONE - ${s.fx.reason}`}`);
  if (s.discovery) L.push(`Source: ${s.discovery.styles} styles${s.discovery.complete ? "" : " (INCOMPLETE)"}; ${s.discovery.watchUrlsExcluded} watch URLs + ${s.discovery.departmentsExcluded} excluded-department URLs skipped before fetching; ${s.discovery.duplicatesMerged} duplicate listings merged; ${s.discovery.pagesFetched} pages read; ${s.discovery.requests} requests`);
  L.push(`Shopify matching: ${s.shopifyChecked ? "checked against live store" : "NOT checked - local database only"}    Missing-product scan reliable: ${s.scanReliable ? "yes" : "no"}`);
  L.push("");
  L.push(s.status === "success" || s.status === "partial" ? "TORY BURCH SYNC COMPLETE" : `TORY BURCH SYNC ${s.status.toUpperCase()}`);
  L.push("");
  const verb = s.mode === "dry_run" ? " (planned)" : "";
  L.push(`Discovered:        ${c.discovered}`);
  L.push(`Eligible:          ${c.eligible}`);
  L.push(`Watches excluded:  ${c.watchExcluded}`);
  L.push(`New${verb}:${" ".repeat(Math.max(1, 15 - verb.length))}${c.created}`);
  L.push(`Updated${verb}:${" ".repeat(Math.max(1, 11 - verb.length))}${c.updated}`);
  L.push(`Unchanged:         ${c.unchanged}`);
  L.push(`Skipped:           ${c.skipped + c.needsReview}  (${c.skipped} excluded categories, ${c.needsReview} needs review)`);
  L.push(`Failed:            ${c.failed}`);
  L.push(`Variants updated:  ${c.variantsWritten}${s.mode === "dry_run" ? " (dry run: nothing written)" : ""}   variant-set changes: ${c.variantChanges}`);
  L.push(`Images updated:    ${c.imagesUploaded} uploaded${s.mode === "dry_run" ? " (dry run: nothing uploaded)" : ""}   products with image changes: ${c.imageChanges}`);
  L.push(`Price changes:     ${c.priceChanges}   availability changes: ${c.availabilityChanges}   prices paused: ${c.pricesPaused}`);
  L.push(`Missing / archived: ${c.missing} / ${c.archived}    Rate-limit events: ${c.rateLimitEvents}`);
  for (const e of s.errors) L.push(`  - [${e.stage}] ${e.id ?? ""} ${e.message}`);
  if (s.warnings.length) { L.push(""); L.push("WARNINGS:"); for (const w of s.warnings) L.push(`  ! ${w}`); }
  L.push(""); L.push("==== PRODUCTS ====");
  for (const p of s.products) {
    L.push("");
    L.push(`${ACTION[p.outcome] ?? p.outcome}  ${p.title}  [${p.style}]${p.shopifyProductId ? `  ${p.shopifyProductId}` : ""}  ${p.at}`);
    L.push(`  Source: ${p.url}`);
    if (p.exclusion) { L.push(`  Excluded (${p.exclusion})`); if (p.outcome === "watch_excluded") L.push(`  import_status=watch_excluded  skip_reason="${WATCH_SKIP_REASON}"`); continue; }
    if (p.error) { L.push(`  Error: ${p.error}`); continue; }
    L.push(`  Category: ${p.category ?? "—"}    Type: ${p.productType ?? "—"}    Collection: ${p.collection ?? "—"}${p.onSale ? "    ON SALE" : ""}`);
    L.push(`  Variants: ${p.variants} (${p.colours.length} colour(s) × ${p.sizes.join("/")})    Images: ${p.images}${p.imagesUploaded ? ` (${p.imagesUploaded} ${s.mode === "dry_run" ? "to upload" : "uploaded"})` : ""}    ETA: ${p.eta}`);
    for (const col of p.colours) {
      L.push(`  • ${col.colour.padEnd(22)} ${col.availability.padEnd(12)} ${usd(col.usd)}${col.regularUsd ? ` (was ${usd(col.regularUsd)})` : ""} × ${col.rate ?? "—"} = ${inr(col.convertedInr)} + shipping ${inr(col.shipping)} = landed ${inr(col.landed)} + profit ${inr(col.profit)} = FSR ${inr(col.fsrPrice)}`);
    }
    if (p.changes.length) L.push(`  Changes: ${p.changes.join(", ")}`);
    for (const note of p.notes) L.push(`  - ${note}`);
    if (p.missing.length) L.push(`  Not on source page: ${p.missing.join(", ")}`);
  }
  return L.join("\n") + "\n";
}

export function nextTbScheduledAt(settings = getTbSettings()): string | null {
  if (settings.SYNC_PAUSED || !settings.ENABLED) return null;
  const last = tdb.prepare("SELECT started_at FROM sync_runs WHERE trigger = 'scheduler' AND status NOT IN ('running','disabled') ORDER BY started_at DESC LIMIT 1").get() as { started_at: string } | undefined;
  if (!last) return new Date().toISOString();
  return new Date(new Date(last.started_at).getTime() + settings.SYNC_INTERVAL_HOURS * 3600_000).toISOString();
}
