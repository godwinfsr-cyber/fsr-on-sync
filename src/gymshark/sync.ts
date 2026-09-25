import fs from "node:fs";
import path from "node:path";
import { LOG_DIR, hasShopifyCredentials } from "../config.ts";
import { Logger } from "../logger.ts";
import { AccessControlledError, PoliteHttp } from "../politeHttp.ts";
import { SourceBlockedError, errMsg, hash, retry } from "../util.ts";
import { GYMSHARK_SOURCE, type GymsharkSettings } from "./config.ts";
import { acquireGLock, allRows, gdb, getGymsharkSettings, getRow, imagesFor, nextGymsharkSyncId, recordPriceChange, releaseGLock, replaceImages, upsertRow, type GymsharkRow } from "./db.ts";
import { getExchangeRate, type FxRate } from "./fx.ts";
import { normalizeGymshark, type NormalizedStyle } from "./normalize.ts";
import { GymsharkOps, type GShopifyProduct } from "./ops.ts";
import { COLOR, PlanConflict, buildGymsharkPlan, mapUploadedMedia } from "./plan.ts";
import { calculateGymsharkPrice, type GymsharkPrice } from "./pricing.ts";
import { discoverGymshark, fetchGymsharkProduct, type DiscoveredUrl } from "./source.ts";

export interface GSyncOptions { dryRun?: boolean; limit?: number; trigger?: string; handles?: string[] }

export type Outcome = "created" | "updated" | "unchanged" | "failed" | "needs_review" | "gone" | "planned_create" | "planned_update" | "planned_unchanged";

export interface ColourPriceReport {
  colour: string; availability: string; usd: number | null; regularUsd: number | null; saleUsd: number | null;
  convertedInr: number | null; fsrPrice: number | null; compareAt: number | null;
}

export interface GProductReport {
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
  weightKg: number | null;
  weightSurcharge: number | null;
  weightReason: string | null;
  profit: number;
  availability: string | null;
  eta: string;
  images: number;
  specifications: number;
  changes: string[];
  notes: string[];
  missing: string[];
  shopifyProductId?: string | null;
  error?: string;
  planned?: Record<string, unknown>;
}

export interface GSyncSummary {
  syncId: string;
  mode: "dry_run" | "live";
  trigger: string;
  status: "success" | "partial" | "failed" | "aborted";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  limit: number;
  shopifyChecked: boolean;
  fx: { ok: boolean; rate: number | null; provider: string | null; providerUpdatedAt: string | null; fetchedAt: string | null; origin: string; reason?: string } | null;
  discovery: { urls: number; complete: boolean; pagesFetched: number; coveredBySibling: number; requests: number } | null;
  counts: {
    discoveredUrls: number; styles: number; processed: number; created: number; updated: number; unchanged: number; priceChanges: number; imageChanges: number;
    specChanges: number; availabilityChanges: number; variantChanges: number; pricesPaused: number; archived: number; missing: number; needsReview: number;
    gone: number; accessControlled: number; failed: number; rateLimitEvents: number;
  };
  errors: { id?: string; stage: string; message: string }[];
  warnings: string[];
  products: GProductReport[];
}

class Aborted extends Error {}

export async function runGymsharkSync(opts: GSyncOptions = {}): Promise<GSyncSummary> {
  const settings = getGymsharkSettings();
  const dryRun = opts.dryRun ?? settings.DRY_RUN;
  const limit = opts.limit ?? settings.SYNC_LIMIT;
  const trigger = opts.trigger ?? "manual";
  const syncId = nextGymsharkSyncId();
  const log = new Logger(syncId, { db: gdb, name: "gymshark-sync" });
  const startedAt = new Date();

  if (!acquireGLock(syncId)) throw new Error("Another Gymshark sync is already running (lock held)");
  gdb.prepare("UPDATE sync_runs SET status = 'aborted', finished_at = COALESCE(finished_at, ?) WHERE status = 'running'").run(startedAt.toISOString());
  gdb.prepare("INSERT INTO sync_runs (id, started_at, mode, trigger, status) VALUES (?,?,?,?, 'running')").run(syncId, startedAt.toISOString(), dryRun ? "dry_run" : "live", trigger);

  const s: GSyncSummary = {
    syncId, mode: dryRun ? "dry_run" : "live", trigger, status: "success", startedAt: startedAt.toISOString(), finishedAt: "", durationMs: 0, limit, shopifyChecked: false, fx: null, discovery: null,
    counts: {
      discoveredUrls: 0, styles: 0, processed: 0, created: 0, updated: 0, unchanged: 0, priceChanges: 0, imageChanges: 0, specChanges: 0, availabilityChanges: 0, variantChanges: 0,
      pricesPaused: 0, archived: 0, missing: 0, needsReview: 0, gone: 0, accessControlled: 0, failed: 0, rateLimitEvents: 0,
    },
    errors: [], warnings: [], products: [],
  };
  const http = new PoliteHttp(settings.REQUEST_DELAY_MS, log, { userAgent: GYMSHARK_SOURCE.userAgent, label: "Gymshark", acceptLanguage: "en-US,en;q=0.9", challenge: /captcha-container|g-recaptcha|verify you are human|cf-challenge/i });

  try {
    log.info("start", `Gymshark sync started (${s.mode}, limit=${limit || "none"}, trigger=${trigger})`);
    if (!settings.CONTENT_REUSE_CONFIRMED) s.warnings.push("CONTENT_REUSE_CONFIRMED=false: Gymshark images and description text are not copied to Shopify.");

    let shopify: GymsharkOps | null = null;
    if (hasShopifyCredentials()) {
      shopify = new GymsharkOps(log);
      await shopify.ensureDefinitions(dryRun);
      await shopify.resolveLocation();
      s.shopifyChecked = true;
    } else if (!dryRun) {
      throw new Aborted("Live sync requires Shopify Admin API credentials (SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET). See README.");
    } else {
      s.warnings.push("No Shopify credentials: dry run matched against the local database only.");
    }

    // ---- exchange rate: fetched once per run, stored with every product it prices ----
    const fx = await getExchangeRate(settings, log);
    s.fx = { ok: fx.ok, rate: fx.rate, provider: fx.provider, providerUpdatedAt: fx.providerUpdatedAt, fetchedAt: fx.fetchedAt, origin: fx.origin, reason: fx.reason };
    if (!fx.ok) s.warnings.push(`NO VALID EXCHANGE RATE (${fx.reason}). Price updates are paused; new products are not created until a valid rate is available.`);
    else if (fx.origin === "cached") s.warnings.push(`Exchange rate provider unavailable - using the last valid rate: ${fx.reason}`);

    let discovery;
    try { discovery = await discoverGymshark(http, log); }
    catch (e) { throw e instanceof SourceBlockedError ? new Aborted(e.message) : e; }
    const lastComplete = Number((gdb.prepare("SELECT value FROM state WHERE key = 'last_complete_count'").get() as { value: string } | undefined)?.value ?? 0);
    let complete = discovery.complete;
    if (complete && lastComplete && discovery.urls.length < lastComplete * 0.5) {
      complete = false;
      s.warnings.push(`Sitemap lists only ${discovery.urls.length} product URLs vs ${lastComplete} last time - treated as incomplete, removal detection skipped.`);
    }
    let pool: DiscoveredUrl[] = discovery.urls;
    const wanted = opts.handles?.length ? new Set(opts.handles.map((h) => h.replace(/^.*\/products\//, "").replace(/[/?#].*$/, "").toLowerCase())) : null;
    if (wanted) {
      pool = pool.filter((u) => wanted.has(u.handle));
      s.warnings.push(`Handle filter: ${pool.length}/${wanted.size} requested product URLs found in the sitemap.`);
      for (const h of wanted) if (!pool.some((u) => u.handle === h)) pool.push({ handle: h, url: `${GYMSHARK_SOURCE.origin}/products/${h}` });
    }
    s.counts.discoveredUrls = discovery.urls.length;
    s.discovery = { urls: discovery.urls.length, complete, pagesFetched: 0, coveredBySibling: 0, requests: 0 };

    // ---- one page per style: every page lists all colourways of its style, so siblings are skipped ----
    const covered = new Set<string>();
    const seenStyles = new Set<string>();
    let blocked: string | null = null;
    let fetchFailures = 0;
    const queued = new Set<string>(); // pages behind a virtual waiting room (limited drops): skipped, never bypassed
    for (const u of pool) {
      if (limit > 0 && seenStyles.size >= limit) break;
      if (covered.has(u.handle)) { s.discovery.coveredBySibling++; continue; }
      try {
        const page = await retry(() => fetchGymsharkProduct(http, u.url), {
          attempts: 2, baseMs: 5000, onRetry: (e, a, w) => log.warn("parse", `product page retry ${a} in ${w}ms: ${errMsg(e)}`, { url: u.url }),
        });
        s.discovery.pagesFetched++;
        covered.add(u.handle);
        if (page.gone || !page.style) {
          s.counts.gone++;
          log.warn("parse", `listed in the sitemap but not a live product page (${page.finalUrl}) - left for removal detection`, { url: u.url });
          continue;
        }
        const st = page.style;
        for (const c of st.colours) covered.add(c.handle.toLowerCase());
        if (seenStyles.has(st.styleCode) || GYMSHARK_SOURCE.excludedSkus.includes(st.styleCode)) continue;
        seenStyles.add(st.styleCode);
        const rep = await processStyle(normalizeGymshark(st, settings), { settings, dryRun, shopify, log, syncId, fx });
        s.products.push(rep);
        tally(s, rep);
      } catch (e) {
        if (e instanceof SourceBlockedError) { blocked = e.message; log.error("source", e.message); break; }
        if (e instanceof AccessControlledError) {
          queued.add(u.handle);
          s.counts.accessControlled++;
          log.warn("source", e.message, { url: u.url });
          continue;
        }
        fetchFailures++;
        const msg = errMsg(e);
        log.error("product", msg, { url: u.url });
        s.errors.push({ id: u.handle, stage: "product", message: msg });
        s.counts.failed++;
        s.products.push(failedReport(u, msg, settings));
      }
      s.counts.processed++;
    }
    s.counts.styles = seenStyles.size;
    if (blocked) { s.status = "aborted"; s.errors.push({ stage: "source", message: blocked }); }

    if (!dryRun && shopify && !blocked) await publishPending(shopify, settings, log, s);

    // ---- removals: only after a complete, unlimited, unfiltered, unblocked scan with no failed pages ----
    if (!blocked && !limit && !wanted && complete && !fetchFailures) {
      for (const row of allRows()) {
        if (seenStyles.has(row.style_code) || !row.shopify_product_id) continue;
        if (queued.size && rowHandles(row).some((h) => queued.has(h))) continue; // queued, not gone
        await handleMissing(row, { settings, dryRun, shopify, log, s });
      }
      if (!dryRun) gdb.prepare("INSERT INTO state (key, value) VALUES ('last_complete_count', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(discovery.urls.length));
    } else if (!limit && !wanted && fetchFailures) {
      s.warnings.push(`${fetchFailures} product page(s) failed - removal detection skipped this run.`);
    }
    if (queued.size) s.warnings.push(`${queued.size} product page(s) are behind Gymshark's virtual waiting room (limited drop) - skipped, not bypassed; they are retried on later syncs.`);
  } catch (e) {
    s.status = e instanceof Aborted ? "aborted" : "failed";
    s.errors.push({ stage: "sync", message: errMsg(e) });
    log.error("sync", errMsg(e));
  } finally {
    if (s.status === "success" && s.counts.failed > 0) s.status = "partial";
    s.counts.rateLimitEvents = http.rateLimitEvents;
    if (s.discovery) s.discovery.requests = http.requests;
    const finished = new Date();
    s.finishedAt = finished.toISOString();
    s.durationMs = finished.getTime() - startedAt.getTime();
    const { products: _p, ...rest } = s;
    gdb.prepare("UPDATE sync_runs SET finished_at = ?, duration_ms = ?, status = ?, summary_json = ?, errors_json = ? WHERE id = ?")
      .run(s.finishedAt, s.durationMs, s.status, JSON.stringify(rest), JSON.stringify(s.errors), syncId);
    fs.writeFileSync(path.join(LOG_DIR, `${syncId}.report.json`), JSON.stringify(s, null, 2));
    fs.writeFileSync(path.join(LOG_DIR, `${syncId}.report.txt`), formatGymsharkReport(s));
    log.info("complete", `sync ${s.status} in ${Math.round(s.durationMs / 1000)}s`, rest.counts as unknown as Record<string, unknown>);
    releaseGLock();
  }
  return s;
}

interface Ctx { settings: GymsharkSettings; dryRun: boolean; shopify: GymsharkOps | null; log: Logger; syncId: string; fx: FxRate }

export function pricesFor(n: NormalizedStyle, fx: FxRate, settings: GymsharkSettings): Map<string, GymsharkPrice> {
  return new Map(n.colours.map((c) => [c.colour, calculateGymsharkPrice({ currentUsd: c.currentUsd, regularUsd: c.regularUsd, currency: c.currency, weightKg: n.weightKg }, fx, settings)]));
}

async function processStyle(n: NormalizedStyle, ctx: Ctx): Promise<GProductReport> {
  const { settings, dryRun, shopify, log, syncId, fx } = ctx;
  const now = new Date().toISOString();
  const id = n.styleCode;
  const prices = pricesFor(n, fx, settings);
  const w = [...prices.values()][0]?.weight;
  log.info("parse", `${n.title}: ${n.colours.length} colour(s), ${n.variants.length} variants, ${n.images.length} images; ${n.colours.map((c) => `${c.colour} $${c.currentUsd}${c.regularUsd && c.regularUsd !== c.currentUsd ? ` (was $${c.regularUsd})` : ""} -> ₹${prices.get(c.colour)?.fsrPrice ?? "?"}`).join("; ")}; weight surcharge ₹${w?.surchargeInr} (${w?.reason})`, undefined, id);

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
  if (settings.CONTENT_REUSE_CONFIRMED && r?.shopify_product_id && !r.image_hash && n.images.length) changes.push("images pending");
  if (r?.last_sync_status && ["failed", "needs_review", "missing", "archived"].includes(r.last_sync_status)) changes.push(`retry after ${r.last_sync_status}`);

  const rep: GProductReport = { ...reportBase(n, settings, prices), outcome: "unchanged", changes, shopifyProductId: r?.shopify_product_id ?? null };

  // ---- match: unique gymshark_sync.source_product_id -> stored product id -> SKU collision check ----
  let existing: GShopifyProduct | null = null;
  let identifier: Record<string, unknown> = { customId: { namespace: "gymshark_sync", key: "source_product_id", value: id } };
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
    plan = buildGymsharkPlan({ n, existing, row: r, settings, prices, fx, images: imagesFor(id), locationId: shopify?.locationId ?? null, nowIso: now });
  } catch (e) {
    if (!(e instanceof PlanConflict)) throw e;
    rep.outcome = "needs_review";
    rep.notes.push(e.message);
    if (!dryRun) upsertRow({ ...baseRow(n, now), shopify_product_id: existing?.id ?? r?.shopify_product_id ?? null, last_sync_status: "needs_review", error_message: e.message });
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

  // ---- image bookkeeping (dedupe on the next run) + one photo per variant from its colourway ----
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
      rep.notes.push(`could not map uploaded media (${result.media.nodes.length} on product, ${plan.imagesSent.length} sent) - images will be re-checked next sync`);
      log.warn("images", "uploaded media could not be matched to source images", { sent: plan.imagesSent.length, onProduct: result.media.nodes.length }, id);
      imageHash = null;
    }
  } else if (settings.CONTENT_REUSE_CONFIRMED && existing?.media.nodes.length && !r) {
    imageHash = n.hashes.image;
  }

  // ---- price history (per colour, from the previous snapshot) ----
  if (!plan.pricesPaused && r?.snapshot_json) {
    const prev = JSON.parse(r.snapshot_json) as { colours?: { colour: string; currentUsd: number | null; regularUsd: number | null; fsrPrice?: number | null }[] };
    for (const c of n.colours) {
      const old = prev.colours?.find((x) => x.colour === c.colour);
      const p = prices.get(c.colour)!;
      if (old && (old.currentUsd !== c.currentUsd || old.regularUsd !== c.regularUsd)) {
        recordPriceChange({ style: id, colour: c.colour, at: now, oldUsd: old.currentUsd, newUsd: c.currentUsd!, oldRegular: old.regularUsd, newRegular: c.regularUsd, oldFsr: old.fsrPrice ?? null, newFsr: p.fsrPrice!, rate: fx.rate!, syncId });
        log.info("price", `${c.colour}: $${old.currentUsd} -> $${c.currentUsd}; FSR ₹${old.fsrPrice ?? "?"} -> ₹${p.fsrPrice}`, undefined, id);
      }
    }
  }
  log.info("shopify", `${rep.outcome} ${result.id}`, { notes: plan.notes }, id);

  const okPrices = [...prices.values()].filter((p) => p.ok);
  const cheapest = okPrices.sort((a, b) => a.fsrPrice! - b.fsrPrice!)[0];
  upsertRow({
    ...baseRow(n, now),
    shopify_product_id: result.id,
    shopify_status: (plan.input.status as string) ?? existing?.status ?? r?.shopify_status ?? null,
    ...(plan.pricesPaused ? {} : {
      source_price_usd: cheapest?.sourcePriceUsd ?? null, source_regular_price_usd: cheapest?.sourceRegularPriceUsd ?? null, fsr_selling_price: cheapest?.fsrPrice ?? null,
      exchange_rate: fx.rate, exchange_rate_timestamp: fx.fetchedAt, exchange_rate_provider: fx.provider, price_hash: n.hashes.price, fsr_price_hash: fsrPriceHash,
    }),
    weight_surcharge_inr: w?.surchargeInr ?? null,
    weight_surcharge_reason: w?.reason ?? null,
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
    snapshot_json: JSON.stringify({ ...n, colours: n.colours.map((c) => ({ ...c, fsrPrice: prices.get(c.colour)?.fsrPrice ?? null })) }),
  });
  return rep;
}

function rowHandles(row: GymsharkRow): string[] {
  const snap = row.snapshot_json ? (JSON.parse(row.snapshot_json) as { colours?: { handle: string }[] }) : null;
  return [row.handle ?? "", ...(snap?.colours ?? []).map((c) => c.handle)].filter(Boolean).map((h) => h.toLowerCase());
}

function baseRow(n: NormalizedStyle, now: string): Partial<GymsharkRow> & { style_code: string } {
  const existing = getRow(n.styleCode);
  return {
    style_code: n.styleCode, source_product_ids: JSON.stringify(Object.fromEntries(n.colours.map((c) => [c.colour, c.sourceProductId]))), source_url: n.sourceUrl,
    canonical_url: n.canonicalUrl, handle: n.handle, title: n.title, gender: n.gender, category: n.category, subcategory: n.subcategory, division: n.division,
    colours: JSON.stringify(n.colours.map((c) => c.colour)), source_weight_kg: n.weightKg, availability: n.availability,
    first_seen_at: existing?.first_seen_at ?? now, last_seen_at: now, missing_scans: 0,
  };
}

function reportBase(n: NormalizedStyle, settings: GymsharkSettings, prices: Map<string, GymsharkPrice>): GProductReport {
  const w = [...prices.values()][0]?.weight;
  return {
    style: n.styleCode, title: n.title, name: n.name, url: n.sourceUrl, outcome: "unchanged", category: n.category, gender: n.gender, productType: n.productType,
    colours: n.colours.map((c) => {
      const p = prices.get(c.colour);
      return { colour: c.colour, availability: c.availability, usd: p?.sourcePriceUsd ?? c.currentUsd, regularUsd: p?.sourceRegularPriceUsd ?? c.regularUsd, saleUsd: p?.sourceSalePriceUsd ?? null, convertedInr: p?.convertedPriceInr ?? null, fsrPrice: p?.fsrPrice ?? null, compareAt: p?.compareAtPrice ?? null };
    }),
    variants: n.variants.length, sizes: n.sizeOrder, weightKg: n.weightKg, weightSurcharge: w?.surchargeInr ?? null, weightReason: w?.reason ?? null, profit: settings.FSR_PROFIT_INR,
    availability: n.availability, eta: settings.DEFAULT_ETA, images: n.images.length, specifications: Object.keys(n.specs).length + n.specSections.reduce((a, x) => a + x.items.length, 0),
    changes: [], notes: [], missing: n.missing,
  };
}

function failedReport(u: DiscoveredUrl, msg: string, settings: GymsharkSettings): GProductReport {
  return {
    style: u.handle, title: u.handle, name: u.handle, url: u.url, outcome: "failed", category: null, gender: null, productType: null, colours: [], variants: 0, sizes: [],
    weightKg: null, weightSurcharge: null, weightReason: null, profit: settings.FSR_PROFIT_INR, availability: null, eta: settings.DEFAULT_ETA, images: 0, specifications: 0,
    changes: [], notes: [], missing: [], error: msg,
  };
}

async function handleMissing(row: GymsharkRow, ctx: { settings: GymsharkSettings; dryRun: boolean; shopify: GymsharkOps | null; log: Logger; s: GSyncSummary }) {
  const { settings, dryRun, shopify, log, s } = ctx;
  if (row.last_sync_status === "archived") return;
  const scans = row.missing_scans + 1;
  s.counts.missing++;
  const threshold = settings.PRODUCT_MISSING_CONFIRMATION_SCANS;
  if (scans < threshold) {
    log.warn("removal", `not in the Gymshark catalog (${scans}/${threshold} confirmation scans)`, undefined, row.style_code);
    if (!dryRun) upsertRow({ style_code: row.style_code, missing_scans: scans, last_sync_status: "missing" });
    return;
  }
  if (dryRun || !shopify) { log.info("removal", `[dry-run] would ${settings.MISSING_ACTION} after ${scans} missing scans`, undefined, row.style_code); return; }
  try {
    const status = settings.MISSING_ACTION === "archive" ? "ARCHIVED" : "DRAFT";
    await shopify.setStatus(row.shopify_product_id!, status); // never deleted
    await shopify.metafieldsSet(row.shopify_product_id!, [{ namespace: "gymshark_sync", key: "source_status", type: "single_line_text_field", value: "removed_from_source" }]);
    s.counts.archived++;
    upsertRow({ style_code: row.style_code, missing_scans: scans, last_sync_status: "archived", shopify_status: status });
    log.warn("removal", `${status} after ${scans} missing scans`, undefined, row.style_code);
  } catch (e) {
    s.counts.failed++;
    s.errors.push({ id: row.style_code, stage: "removal", message: errMsg(e) });
    log.error("removal", errMsg(e), undefined, row.style_code);
  }
}

async function publishPending(shopify: GymsharkOps, settings: GymsharkSettings, log: Logger, s: GSyncSummary) {
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

function tally(s: GSyncSummary, r: GProductReport) {
  const c = s.counts;
  if (r.outcome === "created" || r.outcome === "planned_create") c.created++;
  else if (r.outcome === "updated" || r.outcome === "planned_update") c.updated++;
  else if (r.outcome === "unchanged" || r.outcome === "planned_unchanged") c.unchanged++;
  else if (r.outcome === "needs_review") c.needsReview++;
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
const ACTION: Partial<Record<Outcome, string>> = { planned_create: "CREATE", created: "CREATED", planned_update: "UPDATE", updated: "UPDATED", planned_unchanged: "NO CHANGE", unchanged: "NO CHANGE", needs_review: "NEEDS REVIEW", failed: "FAILED", gone: "WITHDRAWN" };

export function formatGymsharkReport(s: GSyncSummary): string {
  const c = s.counts;
  const L: string[] = [];
  L.push(`${s.syncId}  (${s.mode === "dry_run" ? "DRY RUN - no Shopify changes made" : "LIVE"})`);
  L.push(`Sync started:  ${s.startedAt}`);
  L.push(`Sync finished: ${s.finishedAt}`);
  L.push(`Duration:      ${Math.round(s.durationMs / 1000)}s`);
  L.push(`Status:        ${s.status}`);
  if (s.fx) L.push(`Exchange rate: ${s.fx.ok ? `1 USD = ₹${s.fx.rate} (${s.fx.provider}, ${s.fx.origin}, obtained ${s.fx.fetchedAt}, provider time ${s.fx.providerUpdatedAt ?? "n/a"})` : `NONE - ${s.fx.reason}`}`);
  if (s.discovery) L.push(`Source:        gymshark.com sitemap lists ${s.discovery.urls} product URLs${s.discovery.complete ? "" : " (INCOMPLETE)"}; ${s.discovery.pagesFetched} pages read, ${s.discovery.coveredBySibling} colour pages covered by a sibling page${s.limit ? `; limited to ${s.limit} styles` : ""}; ${s.discovery.requests} requests`);
  L.push(`Shopify matching: ${s.shopifyChecked ? "checked against live store" : "NOT checked - local database only"}`);
  L.push("");
  const verb = s.mode === "dry_run" ? "would be " : "";
  L.push(`Styles (FSR products) found:   ${c.styles}`);
  L.push(`Products ${verb}created:        ${c.created}`);
  L.push(`Products ${verb}updated:        ${c.updated}`);
  L.push(`Products unchanged:            ${c.unchanged}`);
  L.push(`Products needing review:       ${c.needsReview}`);
  L.push(`Prices changed:                ${c.priceChanges}`);
  L.push(`Price updates paused:          ${c.pricesPaused}`);
  L.push(`Variants changed:              ${c.variantChanges}`);
  L.push(`Images changed:                ${c.imageChanges}`);
  L.push(`Specifications changed:        ${c.specChanges}`);
  L.push(`Availability changed:          ${c.availabilityChanges}`);
  L.push(`Missing from source:           ${c.missing}`);
  L.push(`Products archived:             ${c.archived}`);
  L.push(`Withdrawn pages:               ${c.gone}`);
  L.push(`Waiting-room pages (skipped):  ${c.accessControlled ?? 0}`);
  L.push(`Failed:                        ${c.failed}`);
  L.push(`Rate-limit events:             ${c.rateLimitEvents}`);
  L.push(`Errors:                        ${s.errors.length ? "" : "none"}`);
  for (const e of s.errors) L.push(`  - [${e.stage}] ${e.id ?? ""} ${e.message}`);
  if (s.warnings.length) { L.push(""); L.push("WARNINGS:"); for (const w of s.warnings) L.push(`  ! ${w}`); }
  L.push(""); L.push("==== PRODUCTS ====");
  for (const p of s.products) {
    L.push("");
    L.push("GYMSHARK PRODUCT");
    L.push(`  Name:           ${p.name}`);
    L.push(`  Shopify title:  ${p.title}`);
    L.push(`  Style code:     ${p.style}`);
    L.push(`  Source:         ${p.url}`);
    if (p.error) { L.push(`  Action:         ${ACTION[p.outcome]}  (${p.error})`); continue; }
    L.push(`  Category:       ${p.category ?? "—"}    Gender: ${p.gender ?? "—"}    Product type: ${p.productType ?? "—"}`);
    L.push(`  Variants:       ${p.variants} (${p.colours.length} colour(s) × sizes ${p.sizes.join("/")})`);
    L.push(`  Weight:         ${p.weightKg != null ? `${p.weightKg} kg` : "unknown"} -> surcharge ${inr(p.weightSurcharge)} (${p.weightReason})    FSR profit: ${inr(p.profit)}`);
    for (const col of p.colours) {
      L.push(`  • ${col.colour.padEnd(22)} ${col.availability.padEnd(12)} Gymshark ${usd(col.usd)}${col.saleUsd != null ? ` (sale; regular ${usd(col.regularUsd)})` : ""} -> ${inr(col.convertedInr != null ? Math.round(col.convertedInr * 100) / 100 : null)} -> FSR ${inr(col.fsrPrice)}${col.compareAt ? `  compare-at ${inr(col.compareAt)}` : ""}`);
    }
    L.push(`  ETA:            ${p.eta}`);
    L.push(`  Action:         ${ACTION[p.outcome]}${p.shopifyProductId ? `  ${p.shopifyProductId}` : ""}`);
    L.push(`  Images:         ${p.images}    Specifications: ${p.specifications}`);
    if (p.changes.length) L.push(`  Changes:        ${p.changes.join(", ")}`);
    for (const note of p.notes) L.push(`  - ${note}`);
    if (p.missing.length) L.push(`  Not on source page: ${p.missing.join(", ")}`);
  }
  return L.join("\n") + "\n";
}

export function nextGymsharkScheduledAt(settings = getGymsharkSettings()): string | null {
  if (settings.SYNC_PAUSED) return null;
  const last = gdb.prepare("SELECT started_at FROM sync_runs WHERE trigger = 'scheduler' AND status != 'running' ORDER BY started_at DESC LIMIT 1").get() as { started_at: string } | undefined;
  if (!last) return new Date().toISOString();
  return new Date(new Date(last.started_at).getTime() + settings.SYNC_INTERVAL_HOURS * 3600_000).toISOString();
}
