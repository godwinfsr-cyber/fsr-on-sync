import fs from "node:fs";
import path from "node:path";
import { LOG_DIR, hasShopifyCredentials } from "../config.ts";
import { getExchangeRate, type FxRate } from "../gymshark/fx.ts";
import { GymsharkOps, type GShopifyProduct } from "../gymshark/ops.ts";
import { Logger } from "../logger.ts";
import { AccessControlledError, PoliteHttp } from "../politeHttp.ts";
import { SourceBlockedError, errMsg, hash, retry } from "../util.ts";
import { MICHAEL_KORS_AUTHORIZED_IMPORTER, MK_SOURCE, type MkSettings } from "./config.ts";
import { acquireMLock, allRows, getMkSettings, getMState, getRow, imagesFor, mdb, nextMkSyncId, recordPriceChange, releaseMLock, replaceImages, setMState, upsertRow, type MkRow } from "./db.ts";
import { WATCH_SKIP_REASON } from "./exclusion.ts";
import { normalizeMk, type NormalizedStyle } from "./normalize.ts";
import { COLOR, ExcludedProduct, MKNS, PlanConflict, buildMkPlan, mapUploadedMedia } from "./plan.ts";
import { calculateMkPrice, type MkPrice } from "./pricing.ts";
import { discoverMk, fetchMkProduct, readFeed, type DiscoveredUrl, type MkStyle } from "./source.ts";

export interface MkSyncOptions { dryRun?: boolean; limit?: number; trigger?: string; styles?: string[] }

export type Outcome = "created" | "updated" | "unchanged" | "failed" | "needs_review" | "gone" | "watch_excluded" | "skipped" | "planned_create" | "planned_update" | "planned_unchanged";

export interface MkProductReport {
  style: string; title: string; name: string; url: string; outcome: Outcome;
  sourceCategory: string | null; gender: string | null; productType: string | null; channel: string | null;
  colours: { colour: string; availability: string; usd: number | null; regularUsd: number | null; convertedInr: number | null; shipping: number | null; landed: number | null; profit: number | null; fsrPrice: number | null }[];
  variants: number; sizes: string[]; weightKg: number | null; weightReason: string | null; availability: string | null; eta: string; images: number;
  changes: string[]; notes: string[]; missing: string[]; exclusion?: string | null; shopifyProductId?: string | null; error?: string; planned?: Record<string, unknown>;
}

export interface MkSyncSummary {
  syncId: string; mode: "dry_run" | "live"; trigger: string; status: "success" | "partial" | "failed" | "aborted";
  startedAt: string; finishedAt: string; durationMs: number; limit: number; sourceMode: string; shopifyChecked: boolean;
  fx: { ok: boolean; rate: number | null; provider: string | null; fetchedAt: string | null; origin: string; reason?: string } | null;
  discovery: { styles: number; complete: boolean; duplicatesMerged: number; watchUrlsExcluded: number; pagesFetched: number; requests: number } | null;
  scanReliable: boolean;
  counts: {
    eligible: number; unknownWeight: number; processed: number; created: number; updated: number; unchanged: number; watchExcluded: number; skipped: number; needsReview: number;
    priceChanges: number; imageChanges: number; availabilityChanges: number; variantChanges: number; pricesPaused: number; missing: number; archived: number;
    gone: number; failed: number; rateLimitEvents: number;
  };
  errors: { id?: string; stage: string; message: string }[];
  warnings: string[];
  products: MkProductReport[];
}

class Aborted extends Error {}

/** Michael Kors variant of the shared Shopify operations: own namespace + SKU rule, plus a title/vendor lookup. */
class MkOps extends GymsharkOps {
  constructor(log: Logger) {
    super(log, { ns: MKNS, idName: "Michael Kors style number", skuMatches: (sku, style) => sku === style.toUpperCase() || sku.startsWith(`${style.toUpperCase()}-`) });
  }
  /** Priority 5: same vendor + same normalised title (products listed by hand, without our SKUs or metafield). */
  async titleMatches(title: string): Promise<{ id: string; title: string; status: string }[]> {
    const q = `vendor:"Michael Kors" AND title:"${title.replace(/["\\]/g, " ")}"`;
    const r = await this.client.graphql<{ products: { nodes: { id: string; title: string; status: string; sourceId: { value: string } | null }[] } }>(
      `query ByTitle($q: String!) { products(first: 10, query: $q) { nodes { id title status sourceId: metafield(namespace: "${MKNS}", key: "source_product_id") { value } } } }`, { q },
    );
    const norm = (x: string) => x.toLowerCase().replace(/^michael\s+kors\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
    return r.products.nodes.filter((p) => !p.sourceId && norm(p.title) === norm(title)).map(({ id, title: t, status }) => ({ id, title: t, status }));
  }
}

export async function runMkSync(opts: MkSyncOptions = {}): Promise<MkSyncSummary> {
  const settings = getMkSettings();
  const dryRun = opts.dryRun ?? settings.DRY_RUN;
  const limit = opts.limit ?? settings.SYNC_LIMIT;
  const trigger = opts.trigger ?? "manual";
  const syncId = nextMkSyncId();
  const log = new Logger(syncId, { db: mdb, name: "michaelkors-sync" });
  const startedAt = new Date();

  if (!acquireMLock(syncId)) throw new Error("Another Michael Kors sync is already running (lock held)");
  mdb.prepare("UPDATE sync_runs SET status = 'aborted', finished_at = COALESCE(finished_at, ?) WHERE status = 'running'").run(startedAt.toISOString());
  mdb.prepare("INSERT INTO sync_runs (id, started_at, mode, trigger, status) VALUES (?,?,?,?, 'running')").run(syncId, startedAt.toISOString(), dryRun ? "dry_run" : "live", trigger);

  const s: MkSyncSummary = {
    syncId, mode: dryRun ? "dry_run" : "live", trigger, status: "success", startedAt: startedAt.toISOString(), finishedAt: "", durationMs: 0, limit,
    sourceMode: settings.SOURCE_MODE, shopifyChecked: false, fx: null, discovery: null, scanReliable: false,
    counts: {
      eligible: 0, unknownWeight: 0, processed: 0, created: 0, updated: 0, unchanged: 0, watchExcluded: 0, skipped: 0, needsReview: 0, priceChanges: 0, imageChanges: 0,
      availabilityChanges: 0, variantChanges: 0, pricesPaused: 0, missing: 0, archived: 0, gone: 0, failed: 0, rateLimitEvents: 0,
    },
    errors: [], warnings: [], products: [],
  };
  const http = new PoliteHttp(settings.REQUEST_DELAY_MS, log, { userAgent: MK_SOURCE.userAgent, label: "Michael Kors", acceptLanguage: "en-US,en;q=0.9", challenge: /captcha|verify you are human|_abck|bm-verify|access denied/i });

  try {
    log.info("start", `MICHAEL KORS SYNC STARTED (${s.mode}, source=${settings.SOURCE_MODE}, limit=${limit || "none"}, trigger=${trigger}); authorized importer=${MICHAEL_KORS_AUTHORIZED_IMPORTER}`);
    if (!MICHAEL_KORS_AUTHORIZED_IMPORTER) s.warnings.push("MICHAEL_KORS_AUTHORIZED_IMPORTER=false: Michael Kors images and description text are not copied.");

    let shopify: MkOps | null = null;
    if (hasShopifyCredentials()) {
      shopify = new MkOps(log);
      await shopify.ensureDefinitions(dryRun);
      await shopify.resolveLocation();
      s.shopifyChecked = true;
    } else if (!dryRun) {
      throw new Aborted("Live sync requires the existing Shopify Admin API credentials in on-sync/.env.");
    } else {
      s.warnings.push("No Shopify credentials: dry run matched against the local database only.");
    }

    const fx = await getExchangeRate(settings, log, { store: { db: mdb, getState: getMState } });
    s.fx = { ok: fx.ok, rate: fx.rate, provider: fx.provider, fetchedAt: fx.fetchedAt, origin: fx.origin, reason: fx.reason };
    if (!fx.ok) s.warnings.push(`NO VALID EXCHANGE RATE (${fx.reason}). Price updates are paused; new products are not created.`);
    else if (fx.origin === "cached") s.warnings.push(`Exchange rate provider unavailable - using the last valid rate: ${fx.reason}`);

    const ctx: Ctx = { settings, dryRun, shopify, log, syncId, fx, s };
    const wanted = opts.styles?.length ? new Set(opts.styles.map((x) => x.toUpperCase())) : null;
    const seenStyles = new Set<string>();     // eligible styles seen this scan (for missing detection)
    const excludedStyles = new Set<string>(); // watches / excluded categories seen this scan
    let complete = false;
    let blocked: string | null = null;
    let fetchFailures = 0;

    const handle = async (st: MkStyle) => {
      if (seenStyles.has(st.styleCode) || excludedStyles.has(st.styleCode)) return; // duplicate listing: one product only
      const n = normalizeMk(st, settings);
      if (n.exclusion.excluded) { excludedStyles.add(n.styleCode); s.products.push(await recordExcluded(n, ctx)); return; }
      seenStyles.add(n.styleCode);
      const rep = await processStyle(n, ctx);
      s.products.push(rep);
      tally(s, rep);
    };

    if (settings.SOURCE_MODE === "feed") {
      const feed = readFeed(settings.FEED_DIR, log);
      complete = feed.errors.length === 0 && feed.files > 0;
      // a browser harvest writes a manifest: the scan is complete only if the harvest was, and it must be fresh
      const m = feed.manifest;
      if (m) {
        const ageH = (Date.now() - new Date(m.harvestedAt).getTime()) / 3600_000;
        if (!m.complete) { complete = false; s.warnings.push(`Feed harvest ${m.run} was incomplete.`); }
        if (ageH > settings.SYNC_INTERVAL_HOURS + 1) { complete = false; s.warnings.push(`Feed is ${ageH.toFixed(1)} h old (harvest ${m.run}) - prices may be stale; refresh the harvest.`); }
        log.info("discover", `feed harvest ${m.run} at ${m.harvestedAt}: ${m.listed} styles listed, ${m.fetched} pages read, ${m.failed} failed, ${m.watchUrls} watch URLs skipped`);
      }
      for (const e of feed.errors) { s.errors.push({ id: e.file, stage: "feed", message: e.message }); s.counts.failed++; fetchFailures++; }
      s.discovery = { styles: feed.styles.length + (feed.manifest?.watchUrls ?? 0), complete, duplicatesMerged: 0, watchUrlsExcluded: feed.manifest?.watchUrls ?? 0, pagesFetched: feed.files, requests: 0 };
      for (const st of feed.styles) {
        if (wanted && !wanted.has(st.styleCode)) continue;
        if (limit > 0 && seenStyles.size >= limit) break;
        try { await handle(st); } catch (e) { fetchFailures++; failed(s, log, st.styleCode, st.url, e, settings); }
        s.counts.processed++;
      }
      if (!limit && !wanted) s.discovery.duplicatesMerged = Math.max(0, feed.styles.length - seenStyles.size - excludedStyles.size - s.counts.failed);
    } else {
      let discovery;
      try { discovery = await discoverMk(http, log); }
      catch (e) { throw e instanceof SourceBlockedError ? new Aborted(`${e.message}. Geo restrictions and bot protection are respected, never bypassed: supply an authorized product feed (SOURCE_MODE=feed) or have Michael Kors grant the importer access.`) : e; }
      complete = discovery.complete;
      s.discovery = { styles: discovery.urls.length + discovery.watchUrls.length, complete, duplicatesMerged: discovery.duplicates, watchUrlsExcluded: discovery.watchUrls.length, pagesFetched: 0, requests: 0 };
      for (const w of discovery.watchUrls) {
        excludedStyles.add(w.style);
        if (!wanted || wanted.has(w.style)) s.products.push(await recordExcludedUrl(w, ctx));
      }
      const pool: DiscoveredUrl[] = wanted ? discovery.urls.filter((u) => wanted.has(u.style)) : discovery.urls;
      for (const u of pool) {
        if (limit > 0 && seenStyles.size >= limit) break;
        try {
          const page = await retry(() => fetchMkProduct(http, u.url), { attempts: 2, baseMs: 5000, onRetry: (e, a, w) => log.warn("parse", `product page retry ${a} in ${w}ms: ${errMsg(e)}`, { url: u.url }) });
          s.discovery.pagesFetched++;
          if (page.gone || !page.style) { s.counts.gone++; log.warn("parse", `listed in the sitemap but not a live product page (${page.finalUrl})`, { url: u.url }); continue; }
          await handle(page.style);
        } catch (e) {
          if (e instanceof SourceBlockedError) { blocked = e.message; log.error("source", e.message); break; }
          if (e instanceof AccessControlledError) { fetchFailures++; log.warn("source", e.message, { url: u.url }); continue; }
          fetchFailures++;
          failed(s, log, u.style, u.url, e, settings);
        }
        s.counts.processed++;
      }
      if (blocked) { s.status = "aborted"; s.errors.push({ stage: "source", message: blocked }); }
    }
    s.counts.eligible = seenStyles.size;

    if (!dryRun && shopify && !blocked) await publishPending(shopify, settings, log, s);

    // ---- missing products: ONLY after a complete, reliable, unlimited, unfiltered scan ----
    const lastCount = Number(getMState("last_complete_count") ?? 0);
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
      if (!dryRun) setMState("last_complete_count", String(seenStyles.size));
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
    mdb.prepare("UPDATE sync_runs SET finished_at = ?, duration_ms = ?, status = ?, summary_json = ?, errors_json = ? WHERE id = ?")
      .run(s.finishedAt, s.durationMs, s.status, JSON.stringify(rest), JSON.stringify(s.errors), syncId);
    fs.writeFileSync(path.join(LOG_DIR, `${syncId}.report.json`), JSON.stringify(s, null, 2));
    fs.writeFileSync(path.join(LOG_DIR, `${syncId}.report.txt`), formatMkReport(s));
    log.info("complete", `sync ${s.status} in ${Math.round(s.durationMs / 1000)}s`, rest.counts as unknown as Record<string, unknown>);
    releaseMLock();
  }
  return s;
}

interface Ctx { settings: MkSettings; dryRun: boolean; shopify: MkOps | null; log: Logger; syncId: string; fx: FxRate; s: MkSyncSummary }

function failed(s: MkSyncSummary, log: Logger, id: string, url: string, e: unknown, settings: MkSettings) {
  const msg = errMsg(e);
  log.error("product", msg, { url }, id);
  s.errors.push({ id, stage: "product", message: msg });
  s.counts.failed++;
  s.products.push({ ...emptyReport(id, url, settings), outcome: "failed", error: msg });
  upsertRow({ style_code: id, source_url: url, import_status: "error", error_message: msg, last_sync_status: "failed" });
}

export function pricesFor(n: NormalizedStyle, fx: FxRate, settings: MkSettings): Map<string, MkPrice> {
  return new Map(n.colours.map((c) => [c.colour, calculateMkPrice({ currentUsd: c.currentUsd, regularUsd: c.regularUsd, currency: c.currency, weightKg: n.weightKg }, fx, settings)]));
}

/** SKIP + LOG: a watch (or an EXCLUDED_CATEGORIES product) is never created, updated, archived or deleted. */
async function recordExcluded(n: NormalizedStyle, ctx: Ctx): Promise<MkProductReport> {
  const { log, dryRun, shopify, s } = ctx;
  const watch = n.exclusion.status === "watch_excluded";
  const reason = watch ? WATCH_SKIP_REASON : n.exclusion.reason ?? "excluded";
  if (watch) s.counts.watchExcluded++; else s.counts.skipped++;
  log.info("exclude", `${watch ? "WATCH_EXCLUDED" : "SKIPPED"} ${n.styleCode} "${n.name}" [${n.exclusion.level}] ${n.exclusion.reason}`, undefined, n.styleCode);
  const rep: MkProductReport = { ...reportBase(n, ctx.settings, new Map()), outcome: watch ? "watch_excluded" : "skipped", exclusion: `${n.exclusion.level}: ${n.exclusion.reason}` };
  // if an earlier import linked this style in Shopify, only its status metafields are written (no product change)
  const existing = shopify ? await shopify.byCustomId(n.styleCode) : null;
  if (existing) {
    rep.shopifyProductId = existing.id;
    rep.notes.push("a Shopify product already carries this style number: left untouched except michael_kors_sync.import_status / skip_reason");
    if (!dryRun) await shopify!.metafieldsSet(existing.id, [
      { namespace: MKNS, key: "import_status", type: "single_line_text_field", value: n.exclusion.status! },
      { namespace: MKNS, key: "skip_reason", type: "single_line_text_field", value: reason },
    ]);
  }
  if (!dryRun) {
    const now = new Date().toISOString();
    upsertRow({
      style_code: n.styleCode, source_url: n.sourceUrl, canonical_url: n.canonicalUrl, title: n.title, gender: n.gender, category: n.category, source_category: n.sourceCategory,
      channel: n.channel, first_seen_at: getRow(n.styleCode)?.first_seen_at ?? now, last_seen_at: now, missing_scans: 0, import_status: n.exclusion.status, skip_reason: reason,
      exclusion_level: n.exclusion.level, last_sync_status: n.exclusion.status, error_message: null,
    });
  }
  return rep;
}

async function recordExcludedUrl(u: DiscoveredUrl, ctx: Ctx): Promise<MkProductReport> {
  ctx.s.counts.watchExcluded++;
  ctx.log.info("exclude", `WATCH_EXCLUDED ${u.style} [url] ${u.url}`, undefined, u.style);
  if (!ctx.dryRun) {
    const now = new Date().toISOString();
    upsertRow({ style_code: u.style, source_url: u.url, first_seen_at: getRow(u.style)?.first_seen_at ?? now, last_seen_at: now, missing_scans: 0, import_status: "watch_excluded", skip_reason: WATCH_SKIP_REASON, exclusion_level: "url", last_sync_status: "watch_excluded" });
  }
  return { ...emptyReport(u.style, u.url, ctx.settings), outcome: "watch_excluded", exclusion: "url: product URL names a watch (page not fetched)" };
}

async function processStyle(n: NormalizedStyle, ctx: Ctx): Promise<MkProductReport> {
  const { settings, dryRun, shopify, log, syncId, fx } = ctx;
  const now = new Date().toISOString();
  const id = n.styleCode;
  const prices = pricesFor(n, fx, settings);
  const w = [...prices.values()][0]?.weight;
  log.info("parse", `${n.title}: ${n.colours.length} colour(s), ${n.variants.length} variants, ${n.images.length} images; ${n.colours.map((c) => `${c.colour} $${c.currentUsd} -> ₹${prices.get(c.colour)?.fsrPrice ?? "?"}`).join("; ")}; shipping ₹${w?.surchargeInr} (${w?.reason})`, undefined, id);

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

  const rep: MkProductReport = { ...reportBase(n, settings, prices), outcome: "unchanged", changes, shopifyProductId: r?.shopify_product_id ?? null };

  // ---- CHECK DUPLICATE: 1 source product id (unique metafield) -> stored id -> 2/3 SKU / style number -> 5 title ----
  let existing: GShopifyProduct | null = null;
  let identifier: Record<string, unknown> = { customId: { namespace: MKNS, key: "source_product_id", value: id } };
  if (shopify && (changes.length || !r?.shopify_product_id)) {
    existing = await shopify.byCustomId(id);
    if (!existing && r?.shopify_product_id) {
      existing = await shopify.byId(r.shopify_product_id);
      if (existing) rep.notes.push("matched by stored Shopify product id");
    }
    if (!existing) {
      const bySku = await shopify.skuCollisions(id);
      const byTitle = bySku.length ? [] : await shopify.titleMatches(n.title);
      const found = [...bySku, ...byTitle];
      const live = found.filter((c) => c.status !== "ARCHIVED");
      if (found.length) rep.notes.push(`existing non-synced product(s) matching this style (${bySku.length ? "SKU / style number" : "same title"}): ${found.map((c) => `"${c.title}" [${c.status}]`).join(", ")}`);
      if (live.length && !settings.ADOPT_EXISTING_PRODUCTS) {
        rep.outcome = "needs_review";
        rep.notes.push("not imported: a product listed by hand already matches. Set ADOPT_EXISTING_PRODUCTS=true to link it instead of creating a duplicate.");
        if (!dryRun) upsertRow({ ...baseRow(n, now), last_sync_status: "needs_review", import_status: "skipped", skip_reason: "matches an existing hand-made product", error_message: null });
        return rep;
      }
      if (live.length) { existing = await shopify.byId(live[0].id); rep.notes.push(`adopting existing product "${live[0].title}"`); }
    }
  }
  if (existing) identifier = { id: existing.id };

  if (r?.shopify_product_id && !changes.length) {
    rep.outcome = dryRun ? "planned_unchanged" : "unchanged";
    if (!dryRun) upsertRow({ style_code: id, last_seen_at: now, missing_scans: 0, availability: n.availability });
    return rep;
  }
  if (!existing && !r?.shopify_product_id && !pricesOk) {
    rep.outcome = "needs_review";
    rep.notes.push(`not created: ${[...prices.values()].find((p) => !p.ok)?.reason}`);
    return rep;
  }

  let plan;
  try {
    plan = buildMkPlan({ n, existing, row: r, settings, prices, fx, images: imagesFor(id), locationId: shopify?.locationId ?? null, nowIso: now });
  } catch (e) {
    if (e instanceof ExcludedProduct) { rep.outcome = e.status === "watch_excluded" ? "watch_excluded" : "skipped"; rep.notes.push(e.message); return rep; }
    if (!(e instanceof PlanConflict)) throw e;
    rep.outcome = "needs_review";
    rep.notes.push(e.message);
    if (!dryRun) upsertRow({ ...baseRow(n, now), shopify_product_id: existing?.id ?? r?.shopify_product_id ?? null, last_sync_status: "needs_review", import_status: "skipped", skip_reason: e.message });
    return rep;
  }
  rep.notes.push(...plan.notes);

  if (dryRun) {
    rep.outcome = plan.action === "create" ? "planned_create" : "planned_update";
    rep.planned = plan.metafields.length ? { ...plan.input, "(metafieldsSet)": plan.metafields } : plan.input;
    return rep;
  }

  const result = await retry(() => shopify!.productSet(plan.input, identifier), {
    attempts: 3, baseMs: 3000, shouldRetry: (e) => (e as { retryable?: boolean }).retryable === true,
    onRetry: (e, a, wait) => log.warn("shopify", `productSet retry ${a} in ${wait}ms: ${errMsg(e)}`, undefined, id),
  });
  if (plan.metafields.length) await shopify!.metafieldsSet(result.id, plan.metafields);
  rep.outcome = plan.action === "create" ? "created" : "updated";
  rep.shopifyProductId = result.id;

  let imageHash = r?.image_hash ?? null;
  if (plan.imagesSent) {
    const alts = new Map(n.images.map((i) => [i.key, i.alt]));
    const mapped = mapUploadedMedia(plan.imagesSent, result.media.nodes, alts);
    if (mapped) {
      replaceImages(id, plan.imagesSent.map((im) => ({ source_key: im.key, colour: im.colour, media_id: mapped.get(im.key) ?? null, uploaded_at: now })));
      imageHash = n.hashes.image;
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
    const prev = JSON.parse(r.snapshot_json) as { colours?: { colour: string; currentUsd: number | null; fsrPrice?: number | null }[] };
    for (const c of n.colours) {
      const old = prev.colours?.find((x) => x.colour === c.colour);
      const p = prices.get(c.colour)!;
      if (old && old.currentUsd !== c.currentUsd) {
        recordPriceChange({ style: id, colour: c.colour, at: now, oldUsd: old.currentUsd, newUsd: c.currentUsd!, oldRegular: null, newRegular: null, oldFsr: old.fsrPrice ?? null, newFsr: p.fsrPrice!, rate: fx.rate!, syncId });
        log.info("price", `${c.colour}: $${old.currentUsd} -> $${c.currentUsd}; FSR ₹${old.fsrPrice ?? "?"} -> ₹${p.fsrPrice}`, undefined, id);
      }
    }
  }
  log.info("shopify", `${rep.outcome} ${result.id}`, { notes: plan.notes }, id);

  const cheapest = [...prices.values()].filter((p) => p.ok).sort((a, b) => a.fsrPrice! - b.fsrPrice!)[0];
  upsertRow({
    ...baseRow(n, now),
    shopify_product_id: result.id,
    shopify_status: (plan.input.status as string) ?? existing?.status ?? r?.shopify_status ?? null,
    ...(plan.pricesPaused ? {} : {
      source_price_usd: cheapest?.sourcePriceUsd ?? null, fsr_selling_price: cheapest?.fsrPrice ?? null, landed_cost_inr: cheapest?.landedCostInr ?? null,
      profit_adjustment_inr: cheapest?.profitInr ?? null, exchange_rate: fx.rate, exchange_rate_timestamp: fx.fetchedAt, exchange_rate_provider: fx.provider,
      price_hash: n.hashes.price, fsr_price_hash: fsrPriceHash,
    }),
    weight_surcharge_inr: w?.surchargeInr ?? null,
    weight_surcharge_reason: w?.reason ?? null,
    last_synced_at: now,
    last_sync_status: rep.outcome,
    import_status: rep.outcome === "created" ? "imported" : "updated",
    skip_reason: null,
    exclusion_level: null,
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
  return rep;
}

function baseRow(n: NormalizedStyle, now: string): Partial<MkRow> & { style_code: string } {
  const existing = getRow(n.styleCode);
  return {
    style_code: n.styleCode, source_product_ids: JSON.stringify(Object.fromEntries(n.variants.map((v) => [v.sku, v.sourceSku]))), source_url: n.sourceUrl,
    canonical_url: n.canonicalUrl, title: n.title, gender: n.gender, category: n.category, source_category: n.sourceCategory, channel: n.channel,
    colours: JSON.stringify(n.colours.map((c) => c.colour)), source_weight_kg: n.weightKg, availability: n.availability,
    first_seen_at: existing?.first_seen_at ?? now, last_seen_at: now, missing_scans: 0,
  };
}

function reportBase(n: NormalizedStyle, settings: MkSettings, prices: Map<string, MkPrice>): MkProductReport {
  const w = [...prices.values()][0]?.weight;
  return {
    style: n.styleCode, title: n.title, name: n.name, url: n.sourceUrl, outcome: "unchanged", sourceCategory: n.sourceCategory, gender: n.gender, productType: n.productType, channel: n.channel,
    colours: n.colours.map((c) => {
      const p = prices.get(c.colour);
      return { colour: c.colour, availability: c.availability, usd: p?.sourcePriceUsd ?? c.currentUsd, regularUsd: p?.sourceSalePriceUsd != null ? p.sourceRegularPriceUsd : null, convertedInr: p?.convertedPriceInr ?? null, shipping: p?.weight.surchargeInr ?? null, landed: p?.landedCostInr ?? null, profit: p?.profitInr ?? null, fsrPrice: p?.fsrPrice ?? null };
    }),
    variants: n.variants.length, sizes: n.sizeOrder, weightKg: n.weightKg, weightReason: w?.reason ?? null, availability: n.availability, eta: settings.DEFAULT_ETA,
    images: n.images.length, changes: [], notes: [], missing: n.missing,
  };
}

function emptyReport(style: string, url: string, settings: MkSettings): MkProductReport {
  return {
    style, title: style, name: style, url, outcome: "failed", sourceCategory: null, gender: null, productType: null, channel: null, colours: [], variants: 0, sizes: [],
    weightKg: null, weightReason: null, availability: null, eta: settings.DEFAULT_ETA, images: 0, changes: [], notes: [], missing: [],
  };
}

async function handleMissing(row: MkRow, ctx: Ctx) {
  const { settings, dryRun, shopify, log, s } = ctx;
  if (row.last_sync_status === "archived") return;
  const scans = row.missing_scans + 1;
  s.counts.missing++;
  const threshold = Math.max(2, settings.PRODUCT_MISSING_CONFIRMATION_SCANS);
  if (scans < threshold) {
    log.warn("removal", `not in the Michael Kors catalog (${scans}/${threshold} consecutive reliable scans)`, undefined, row.style_code);
    if (!dryRun) upsertRow({ style_code: row.style_code, missing_scans: scans, last_sync_status: "missing" });
    return;
  }
  if (dryRun || !shopify) { log.info("removal", `[dry-run] would ${settings.MISSING_ACTION} after ${scans} missing scans`, undefined, row.style_code); return; }
  try {
    const status = settings.MISSING_ACTION === "archive" ? "ARCHIVED" : "DRAFT";
    await shopify.setStatus(row.shopify_product_id!, status); // never deleted
    await shopify.metafieldsSet(row.shopify_product_id!, [{ namespace: MKNS, key: "source_status", type: "single_line_text_field", value: "removed_from_source" }]);
    s.counts.archived++;
    upsertRow({ style_code: row.style_code, missing_scans: scans, last_sync_status: "archived", shopify_status: status });
    log.warn("removal", `${status} after ${scans} consecutive missing scans`, undefined, row.style_code);
  } catch (e) {
    s.counts.failed++;
    s.errors.push({ id: row.style_code, stage: "removal", message: errMsg(e) });
    log.error("removal", errMsg(e), undefined, row.style_code);
  }
}

async function publishPending(shopify: MkOps, settings: MkSettings, log: Logger, s: MkSyncSummary) {
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

function tally(s: MkSyncSummary, r: MkProductReport) {
  const c = s.counts;
  if (r.outcome === "created" || r.outcome === "planned_create") c.created++;
  else if (r.outcome === "updated" || r.outcome === "planned_update") c.updated++;
  else if (r.outcome === "unchanged" || r.outcome === "planned_unchanged") c.unchanged++;
  else if (r.outcome === "needs_review") c.needsReview++;
  else if (r.outcome === "watch_excluded") c.watchExcluded++;
  else if (r.outcome === "skipped") c.skipped++;
  if (r.notes.some((x) => x.startsWith("PRICE UPDATES PAUSED"))) c.pricesPaused++;
  if (r.weightKg == null && !["failed", "watch_excluded", "skipped"].includes(r.outcome)) c.unknownWeight++;
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
  needs_review: "NEEDS REVIEW", failed: "FAILED", gone: "WITHDRAWN", watch_excluded: "WATCH_EXCLUDED", skipped: "SKIPPED",
};

export function formatMkReport(s: MkSyncSummary): string {
  const c = s.counts;
  const L: string[] = [];
  L.push(`${s.syncId}  (${s.mode === "dry_run" ? "DRY RUN - no Shopify changes made" : "LIVE"})  source=${s.sourceMode}`);
  L.push(`Started ${s.startedAt}  Finished ${s.finishedAt}  (${Math.round(s.durationMs / 1000)}s)  Status: ${s.status}`);
  if (s.fx) L.push(`Exchange rate: ${s.fx.ok ? `1 USD = ₹${s.fx.rate} (${s.fx.provider}, ${s.fx.origin}, ${s.fx.fetchedAt})` : `NONE - ${s.fx.reason}`}`);
  if (s.discovery) L.push(`Source: ${s.discovery.styles} styles${s.discovery.complete ? "" : " (INCOMPLETE)"}; ${s.discovery.watchUrlsExcluded} watch URLs excluded before fetching; ${s.discovery.duplicatesMerged} duplicate listings merged; ${s.discovery.pagesFetched} pages read; ${s.discovery.requests} requests`);
  L.push(`Shopify matching: ${s.shopifyChecked ? "checked against live store" : "NOT checked - local database only"}    Missing-product scan reliable: ${s.scanReliable ? "yes" : "no"}`);
  const verb = s.mode === "dry_run" ? "would be " : "";
  L.push("");
  L.push(`Eligible styles:          ${c.eligible}`);
  L.push(`Unknown weight (fallback shipping): ${c.unknownWeight}`);
  L.push(`Products ${verb}created:   ${c.created}`);
  L.push(`Products ${verb}updated:   ${c.updated}`);
  L.push(`Unchanged:                ${c.unchanged}`);
  L.push(`WATCH_EXCLUDED:           ${c.watchExcluded}`);
  L.push(`Skipped (other rules):    ${c.skipped}`);
  L.push(`Needs review:             ${c.needsReview}`);
  L.push(`Price / image / variant / availability changes: ${c.priceChanges} / ${c.imageChanges} / ${c.variantChanges} / ${c.availabilityChanges}`);
  L.push(`Missing / archived:       ${c.missing} / ${c.archived}`);
  L.push(`Failed:                   ${c.failed}    Rate-limit events: ${c.rateLimitEvents}`);
  for (const e of s.errors) L.push(`  - [${e.stage}] ${e.id ?? ""} ${e.message}`);
  if (s.warnings.length) { L.push(""); L.push("WARNINGS:"); for (const w of s.warnings) L.push(`  ! ${w}`); }
  L.push(""); L.push("==== PRODUCTS ====");
  for (const p of s.products) {
    L.push("");
    L.push(`${ACTION[p.outcome] ?? p.outcome}  ${p.title}  [${p.style}]${p.shopifyProductId ? `  ${p.shopifyProductId}` : ""}`);
    L.push(`  Source: ${p.url}`);
    if (p.exclusion) { L.push(`  Excluded (${p.exclusion})`); continue; }
    if (p.error) { L.push(`  Error: ${p.error}`); continue; }
    L.push(`  Category: ${p.sourceCategory ?? "—"}    Type: ${p.productType ?? "—"}    Gender: ${p.gender ?? "—"}${p.channel ? `    ${p.channel}` : ""}`);
    L.push(`  Weight: ${p.weightKg != null ? `${p.weightKg} kg` : "unknown"} (${p.weightReason ?? "—"})`);
    L.push(`  Variants: ${p.variants} (${p.colours.length} colour(s) × ${p.sizes.join("/")})    Images: ${p.images}    ETA: ${p.eta}`);
    for (const col of p.colours) {
      L.push(`  • ${col.colour.padEnd(18)} ${col.availability.padEnd(12)} ${usd(col.usd)}${col.regularUsd != null ? ` (was ${usd(col.regularUsd)})` : ""} -> ${inr(col.convertedInr)} + shipping ${inr(col.shipping)} = landed ${inr(col.landed)} + profit ${inr(col.profit)} = FSR ${inr(col.fsrPrice)}`);
    }
    if (p.changes.length) L.push(`  Changes: ${p.changes.join(", ")}`);
    for (const note of p.notes) L.push(`  - ${note}`);
    if (p.missing.length) L.push(`  Not on source page: ${p.missing.join(", ")}`);
  }
  return L.join("\n") + "\n";
}

export function nextMkScheduledAt(settings = getMkSettings()): string | null {
  if (settings.SYNC_PAUSED) return null;
  const last = mdb.prepare("SELECT started_at FROM sync_runs WHERE trigger = 'scheduler' AND status != 'running' ORDER BY started_at DESC LIMIT 1").get() as { started_at: string } | undefined;
  if (!last) return new Date().toISOString();
  return new Date(new Date(last.started_at).getTime() + settings.SYNC_INTERVAL_HOURS * 3600_000).toISOString();
}

/**
 * Owner decision (2026-09-26): imported Michael Kors products go live. Activates products this sync created as DRAFT
 * that Michael Kors has in stock (fully sold-out ones stay hidden - store policy), then publishes ACTIVE ones.
 */
export async function activateImported(): Promise<{ activated: number; skippedSoldOut: number; warnings: string[]; errors: string[] }> {
  const settings = getMkSettings();
  const log = new Logger(null, { db: mdb, name: "michaelkors-activate" });
  const shopify = new MkOps(log);
  const out = { activated: 0, skippedSoldOut: 0, warnings: [] as string[], errors: [] as string[] };
  for (const r of allRows().filter((x) => x.shopify_product_id && x.shopify_status === "DRAFT" && x.import_status !== "watch_excluded")) {
    if (r.availability !== "in_stock") { out.skippedSoldOut++; continue; }
    try {
      await shopify.setStatus(r.shopify_product_id!, "ACTIVE");
      upsertRow({ style_code: r.style_code, shopify_status: "ACTIVE" });
      out.activated++;
    } catch (e) { out.errors.push(`${r.style_code}: ${errMsg(e)}`); }
  }
  const s = { warnings: out.warnings, errors: [] as { id?: string; stage: string; message: string }[] } as unknown as MkSyncSummary;
  await publishPending(shopify, settings, log, s);
  out.errors.push(...s.errors.map((e) => `${e.id}: ${e.message}`));
  return out;
}
