import fs from "node:fs";
import path from "node:path";
import { LOG_DIR, hasShopifyCredentials, type Settings } from "./config.ts";
import { acquireLock, allProducts, db, getProduct, getSettings, nextSyncId, releaseLock, upsertProduct, type ProductRow } from "./db.ts";
import { Logger } from "./logger.ts";
import { normalize, type NormalizedProduct } from "./normalize.ts";
import { calculatePrice, type PriceResult } from "./pricing.ts";
import { SourceBrowser } from "./source/browser.ts";
import { discoverCatalog, type DiscoveryResult } from "./source/discover.ts";
import { fetchProductDetail } from "./source/detail.ts";
import type { ListingItem } from "./source/types.ts";
import { ShopifyOps, type ShopifyProduct } from "./shopify/ops.ts";
import { buildPlan } from "./shopify/plan.ts";
import { SourceBlockedError, errMsg, hash, retry } from "./util.ts";

export interface SyncOptions { dryRun?: boolean; limit?: number; trigger?: string; skus?: string[] }

export interface ProductReport {
  sku: string;
  title: string;
  url: string;
  outcome: "created" | "updated" | "unchanged" | "failed" | "needs_review" | "planned_create" | "planned_update" | "planned_unchanged";
  sourcePrice: number | null;
  sourceListPrice: number | null;
  currency: string | null;
  fsrPrice: number | null;
  fsrCompareAt: number | null;
  priceNote?: string;
  sizes: { label: string; available: boolean; hint: string | null; listed: boolean }[];
  images: number;
  changes: string[];
  notes: string[];
  missing: string[];
  shopifyProductId?: string | null;
  error?: string;
  plannedProductSet?: Record<string, unknown>; // dry-run only: exact productSet input that would be sent
}

export interface SyncSummary {
  syncId: string;
  mode: "dry_run" | "live";
  trigger: string;
  status: "success" | "partial" | "failed" | "aborted";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  discovery: { colorways: number; groups: number; groupsReported: number | null; pages: number; complete: boolean } | null;
  limit: number;
  shopifyChecked: boolean;
  counts: {
    discovered: number; processed: number; created: number; updated: number; unchanged: number; priceChanges: number;
    sizeChanges: number; stockChanges: number; imageChanges: number; archived: number; missing: number; needsReview: number; failed: number;
  };
  errors: { sku?: string; stage: string; message: string }[];
  warnings: string[];
  products: ProductReport[];
}

class Aborted extends Error {}

export async function runSync(opts: SyncOptions = {}): Promise<SyncSummary> {
  const settings = getSettings();
  const dryRun = opts.dryRun ?? settings.DRY_RUN;
  const limit = opts.limit ?? settings.SYNC_LIMIT;
  const trigger = opts.trigger ?? "manual";
  const syncId = nextSyncId();
  const log = new Logger(syncId);
  const startedAt = new Date();

  if (!acquireLock(syncId)) throw new Error("Another sync is already running (lock held)");
  db.prepare("UPDATE sync_runs SET status = 'aborted', finished_at = COALESCE(finished_at, ?) WHERE status = 'running'").run(startedAt.toISOString());
  db.prepare("INSERT INTO sync_runs (id, started_at, mode, trigger, status) VALUES (?,?,?,?, 'running')").run(syncId, startedAt.toISOString(), dryRun ? "dry_run" : "live", trigger);

  const summary: SyncSummary = {
    syncId, mode: dryRun ? "dry_run" : "live", trigger, status: "success", startedAt: startedAt.toISOString(), finishedAt: "", durationMs: 0,
    discovery: null, limit, shopifyChecked: false,
    counts: { discovered: 0, processed: 0, created: 0, updated: 0, unchanged: 0, priceChanges: 0, sizeChanges: 0, stockChanges: 0, imageChanges: 0, archived: 0, missing: 0, needsReview: 0, failed: 0 },
    errors: [], warnings: [], products: [],
  };
  const browser = new SourceBrowser(settings.REQUEST_DELAY_MS);

  try {
    log.info("start", `sync started (${summary.mode}, limit=${limit || "none"}, trigger=${trigger})`);
    if (!settings.CONTENT_REUSE_CONFIRMED) summary.warnings.push("CONTENT_REUSE_CONFIRMED=false: ON images and description text will not be copied to Shopify until you confirm you have permission.");
    if (!(settings.EXCHANGE_RATE > 0)) summary.warnings.push("EXCHANGE_RATE is not configured: Full Size Run prices cannot be calculated.");
    if (settings.MARKUP_VALUE === 0) summary.warnings.push("MARKUP_VALUE is 0: calculated prices are pure currency conversion with no margin.");

    let shopify: ShopifyOps | null = null;
    if (hasShopifyCredentials()) {
      shopify = new ShopifyOps(log);
      await shopify.ensureDefinitions(dryRun);
      await shopify.resolveLocation();
      summary.shopifyChecked = true;
    } else if (!dryRun) {
      throw new Aborted("Live sync requires Shopify Admin API credentials (SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET or SHOPIFY_ADMIN_ACCESS_TOKEN). See README.");
    } else {
      summary.warnings.push("No Shopify credentials: dry-run matched against the local database only (Shopify lookups skipped).");
    }
    if (!dryRun && !(settings.EXCHANGE_RATE > 0)) throw new Aborted("Live sync refused: EXCHANGE_RATE must be configured so no product is published with a wrong price.");

    await browser.open();
    let discovery: DiscoveryResult;
    try {
      discovery = await discoverCatalog(browser, log);
    } catch (e) {
      throw e instanceof SourceBlockedError ? new Aborted(e.message) : e;
    }
    summary.discovery = { colorways: discovery.items.length, groups: discovery.groupsDiscovered, groupsReported: discovery.groupsReported, pages: discovery.pagesVisited, complete: discovery.complete };
    summary.counts.discovered = discovery.items.length;
    log.info("discovery", `discovered ${discovery.items.length} colorways in ${discovery.groupsDiscovered}/${discovery.groupsReported ?? "?"} product groups`);
    if (!discovery.complete) summary.warnings.push(`Discovery incomplete (${discovery.groupsDiscovered} of ${discovery.groupsReported ?? "?"} groups) - removal detection skipped this run.`);

    // ON files kids'/youth shoes under /unisex/ URLs; their SKUs start with 3K (kids) or 3Y (youth)
    const isKids = (i: ListingItem) => /^3[KY]/i.test(i.sku) || /\/kids\//i.test(i.url) || /\b(kids'?|youth|toddler|infant)\b/i.test(`${i.groupName} ${i.variantName}`);
    if (!settings.INCLUDE_KIDS) {
      const kids = discovery.items.filter(isKids).length;
      if (kids) summary.warnings.push(`${kids} kids' colorways skipped (INCLUDE_KIDS=false).`);
      discovery.items = discovery.items.filter((i) => !isKids(i));
      summary.counts.discovered = discovery.items.length;
    }
    const wanted = opts.skus?.length ? new Set(opts.skus.map((x) => x.toUpperCase())) : null;
    const pool = wanted ? discovery.items.filter((i) => wanted.has(i.sku.toUpperCase())) : discovery.items;
    if (wanted) summary.warnings.push(`SKU filter: ${pool.length}/${wanted.size} requested SKUs found on source.`);
    const items = limit > 0 ? pool.slice(0, limit) : pool;
    let blocked: string | null = null;
    for (const item of items) {
      try {
        const rep = await processItem(item, { settings, dryRun, shopify, browser, log });
        summary.products.push(rep);
        tally(summary, rep);
      } catch (e) {
        if (e instanceof SourceBlockedError) { blocked = e.message; log.error("source", e.message); break; }
        const msg = errMsg(e);
        log.error("product", msg, undefined, item.sku);
        summary.errors.push({ sku: item.sku, stage: "product", message: msg });
        summary.counts.failed++;
        summary.products.push(failedReport(item, msg));
        if (!dryRun) upsertProduct({ source_product_id: item.sku, source_url: item.url, title: item.variantName, last_seen_at: new Date().toISOString(), last_sync_status: "failed", error_message: msg, missing_scans: 0 });
      }
      summary.counts.processed++;
    }
    if (blocked) {
      summary.status = "aborted";
      summary.errors.push({ stage: "source", message: blocked });
    }

    // ---- publish ACTIVE products to the store's sales channels (once each) ----
    if (!dryRun && shopify && !blocked) await publishPending(shopify, settings, log, summary);

    // ---- removal / discontinuation (only on a complete, unlimited, unblocked scan) ----
    if (!blocked && !limit && !wanted && discovery.complete) {
      const seen = new Set(discovery.items.map((i) => i.sku));
      for (const row of allProducts()) {
        if (seen.has(row.source_product_id) || !row.shopify_product_id) continue;
        await handleMissing(row, { settings, dryRun, shopify, log, summary });
      }
    }
  } catch (e) {
    summary.status = e instanceof Aborted ? "aborted" : "failed";
    summary.errors.push({ stage: "sync", message: errMsg(e) });
    log.error("sync", errMsg(e));
  } finally {
    await browser.close();
    if (summary.status === "success" && summary.counts.failed > 0) summary.status = "partial";
    const finished = new Date();
    summary.finishedAt = finished.toISOString();
    summary.durationMs = finished.getTime() - startedAt.getTime();
    const { products: _products, ...rest } = summary;
    db.prepare("UPDATE sync_runs SET finished_at = ?, duration_ms = ?, status = ?, summary_json = ?, errors_json = ? WHERE id = ?")
      .run(summary.finishedAt, summary.durationMs, summary.status, JSON.stringify(rest), JSON.stringify(summary.errors), syncId);
    fs.writeFileSync(path.join(LOG_DIR, `${syncId}.report.json`), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(LOG_DIR, `${syncId}.report.txt`), formatReport(summary));
    log.info("complete", `sync ${summary.status} in ${Math.round(summary.durationMs / 1000)}s`, rest.counts as unknown as Record<string, unknown>);
    releaseLock();
  }
  return summary;
}

interface Ctx { settings: Settings; dryRun: boolean; shopify: ShopifyOps | null; browser: SourceBrowser; log: Logger }

async function processItem(item: ListingItem, ctx: Ctx): Promise<ProductReport> {
  const { settings, dryRun, shopify, browser, log } = ctx;
  const now = new Date().toISOString();
  const row = getProduct(item.sku);
  const prev: NormalizedProduct | null = row?.snapshot_json ? JSON.parse(row.snapshot_json) : null;

  const detail = await retry(() => fetchProductDetail(browser, item.url, item.sku), {
    attempts: 3, baseMs: 5000, onRetry: (e, a, w) => log.warn("parse", `detail retry ${a} in ${w}ms: ${errMsg(e)}`, undefined, item.sku),
  });
  // snapshots store the ON (US) label as sourceLabel; older snapshots only had label, which was the US size
  const n = normalize(item, detail, settings, prev?.sizes.map((z) => z.sourceLabel ?? z.label) ?? []);
  const price = calculatePrice(n.price, n.listPrice, settings);
  log.info("parse", `${n.title}: $${n.price} (list $${n.listPrice ?? "-"}), ${n.sizes.filter((z) => z.available).length}/${n.sizes.length} sizes available, ${n.images.length} images`, undefined, item.sku);

  // ---- change detection vs. what we last synced ----
  const changes: string[] = [];
  if (!row?.shopify_product_id) changes.push("new");
  if (row?.price_hash && row.price_hash !== n.hashes.price) changes.push("source price");
  if (row?.last_fsr_price != null && price.price != null && row.last_fsr_price !== price.price) changes.push("FSR price");
  if (prev && prev.sizes.map((z) => z.label).join() !== n.sizes.map((z) => z.label).join()) changes.push("sizes");
  if (row?.availability_hash && row.availability_hash !== n.hashes.availability) changes.push("availability");
  if (row?.image_hash && row.image_hash !== n.hashes.image) changes.push("images");
  if (row?.content_hash && row.content_hash !== n.hashes.content) changes.push("content");
  if (row?.written_eta && row.written_eta !== settings.DEFAULT_ETA) changes.push("ETA setting");
  if (settings.CONTENT_REUSE_CONFIRMED && row?.shopify_product_id && !row.image_hash) changes.push("images pending (content reuse now confirmed)");
  if (row?.last_sync_status && ["failed", "needs_review", "missing", "archived"].includes(row.last_sync_status)) changes.push(`retry after ${row.last_sync_status}`);

  const report: ProductReport = {
    sku: n.sourceProductId, title: n.title, url: n.sourceUrl, outcome: "unchanged",
    sourcePrice: n.price, sourceListPrice: n.listPrice, currency: n.currency, fsrPrice: price.price, fsrCompareAt: price.compareAtPrice,
    priceNote: price.ok ? undefined : price.reason,
    sizes: n.sizes.map((z) => ({ label: z.label, available: z.available, hint: z.stockHint, listed: z.listedBySource })),
    images: n.images.length, changes, notes: [], missing: n.missing, shopifyProductId: row?.shopify_product_id ?? null,
  };

  // ---- match in Shopify: unique source-id metafield first, then stored id, then SKU collision check ----
  let existing: ShopifyProduct | null = null;
  let identifier: Record<string, unknown> = { customId: { namespace: "on_sync", key: "source_product_id", value: n.sourceProductId } };
  if (shopify && (changes.length || !row?.shopify_product_id)) {
    existing = await shopify.byCustomId(n.sourceProductId);
    if (!existing && row?.shopify_product_id) {
      existing = await shopify.byId(row.shopify_product_id);
      if (existing) report.notes.push("matched by stored Shopify product id");
    }
    if (!existing) {
      const collisions = await shopify.skuCollisions(n.sourceSku);
      const live = collisions.filter((c) => c.status !== "ARCHIVED");
      if (collisions.length) report.notes.push(`existing non-synced product(s) with this SKU: ${collisions.map((c) => `"${c.title}" [${c.status}]`).join(", ")}`);
      if (live.length && !settings.ADOPT_EXISTING_PRODUCTS) {
        report.outcome = "needs_review";
        report.notes.push("not imported: an ACTIVE/DRAFT manual product already uses this SKU. Set ADOPT_EXISTING_PRODUCTS=true to link it (manual title/description/price are preserved).");
        if (!dryRun) upsertProduct({ ...baseRow(n, now), last_sync_status: "needs_review", error_message: "SKU collision with manual product" });
        return report;
      }
      if (live.length) {
        existing = await shopify.byId(live[0].id);
        identifier = { id: live[0].id };
        report.notes.push(`adopting existing product "${live[0].title}"`);
      }
    } else {
      identifier = { id: existing.id };
    }
  }
  if (existing) identifier = { id: existing.id };

  if (row?.shopify_product_id && !changes.length) {
    report.outcome = dryRun ? "planned_unchanged" : "unchanged";
    if (!dryRun) upsertProduct({ source_product_id: n.sourceProductId, last_seen_at: now, missing_scans: 0 });
    return report;
  }

  if (!price.ok) {
    if (!dryRun) throw new Error(`cannot price product: ${price.reason}`);
    report.notes.push(`price not calculable: ${price.reason}`);
  }

  const plan = buildPlan({ n, existing, row, settings, price, locationId: shopify?.locationId ?? null, contentAllowed: settings.CONTENT_REUSE_CONFIRMED, nowIso: now });
  report.notes.push(...plan.notes);

  if (dryRun) {
    report.outcome = plan.action === "create" ? "planned_create" : "planned_update";
    report.plannedProductSet = plan.metafields.length ? { ...plan.input, "(metafieldsSet)": plan.metafields } : plan.input;
    return report;
  }

  const result = await retry(() => shopify!.productSet(plan.input, identifier), {
    attempts: 3, baseMs: 3000, shouldRetry: (e) => (e as { retryable?: boolean }).retryable === true,
    onRetry: (e, a, w) => log.warn("shopify", `productSet retry ${a} in ${w}ms: ${errMsg(e)}`, undefined, n.sourceProductId),
  });
  if (plan.metafields.length) await shopify!.metafieldsSet(result.id, plan.metafields);
  report.outcome = plan.action === "create" ? "created" : "updated";
  report.shopifyProductId = result.id;
  log.info("shopify", `${report.outcome} ${result.id} (${result.variants.nodes.length} variants)`, { notes: plan.notes }, n.sourceProductId);

  upsertProduct({
    ...baseRow(n, now),
    shopify_product_id: result.id,
    shopify_status: result.status,
    last_fsr_price: price.price,
    last_synced_at: now,
    last_detail_at: now,
    last_sync_status: report.outcome,
    content_hash: n.hashes.content,
    image_hash: plan.written.imagesWritten || (!row && existing?.media.nodes.length && settings.CONTENT_REUSE_CONFIRMED) ? n.hashes.image : row?.image_hash ?? null,
    availability_hash: n.hashes.availability,
    price_hash: n.hashes.price,
    written_title: plan.written.title,
    // hash what Shopify actually stored (it normalises HTML entities), so later comparisons are exact
    written_desc_hash: "descriptionHtml" in plan.input || plan.action === "create" ? hash(result.descriptionHtml) : plan.written.descHash,
    written_seo_hash: plan.written.seoHash,
    written_eta: plan.written.eta,
    written_price: plan.written.price,
    error_message: null,
    snapshot_json: JSON.stringify(n),
  });
  return report;
}

function baseRow(n: NormalizedProduct, now: string): Partial<ProductRow> & { source_product_id: string } {
  const existing = getProduct(n.sourceProductId);
  return {
    source_product_id: n.sourceProductId,
    source_url: n.sourceUrl,
    source_sku: n.sourceSku,
    source_style_code: n.styleCode,
    title: n.title,
    gender: n.gender,
    last_source_price: n.price,
    last_source_list_price: n.listPrice,
    last_source_currency: n.currency,
    first_seen_at: existing?.first_seen_at ?? now,
    last_seen_at: now,
    missing_scans: 0,
  };
}

async function handleMissing(row: ProductRow, ctx: { settings: Settings; dryRun: boolean; shopify: ShopifyOps | null; log: Logger; summary: SyncSummary }) {
  const { settings, dryRun, shopify, log, summary } = ctx;
  if (row.last_sync_status === "archived") return;
  const scans = row.missing_scans + 1;
  summary.counts.missing++;
  const threshold = settings.PRODUCT_MISSING_CONFIRMATION_SCANS;
  if (scans < threshold) {
    log.warn("removal", `not seen on source (${scans}/${threshold} confirmation scans)`, undefined, row.source_product_id);
    if (!dryRun) upsertProduct({ source_product_id: row.source_product_id, missing_scans: scans, last_sync_status: "missing" });
    return;
  }
  const action = settings.MISSING_ACTION;
  if (dryRun || !shopify) {
    log.info("removal", `[dry-run] would apply "${action}" after ${scans} missing scans`, undefined, row.source_product_id);
    return;
  }
  try {
    if (action === "archive") await shopify.setStatus(row.shopify_product_id!, "ARCHIVED");
    else if (action === "draft") await shopify.setStatus(row.shopify_product_id!, "DRAFT");
    else {
      const p = await shopify.byId(row.shopify_product_id!);
      if (p) await shopify.productSet({ variants: p.variants.nodes.map((v) => ({ id: v.id, optionValues: v.selectedOptions.map((o) => ({ optionName: o.name, name: o.value })), inventoryPolicy: "DENY" })) }, { id: p.id });
    }
    summary.counts.archived++;
    upsertProduct({ source_product_id: row.source_product_id, missing_scans: scans, last_sync_status: "archived", shopify_status: action === "archive" ? "ARCHIVED" : action === "draft" ? "DRAFT" : row.shopify_status });
    log.warn("removal", `applied "${action}" after ${scans} missing scans`, undefined, row.source_product_id);
  } catch (e) {
    summary.counts.failed++;
    summary.errors.push({ sku: row.source_product_id, stage: "removal", message: errMsg(e) });
    log.error("removal", errMsg(e), undefined, row.source_product_id);
  }
}

async function publishPending(shopify: ShopifyOps, settings: Settings, log: Logger, summary: SyncSummary) {
  const pending = allProducts().filter((r) => r.shopify_product_id && r.shopify_status === "ACTIVE" && !r.published);
  if (!pending.length) return;
  const pubs = await shopify.resolvePublications(settings.PUBLISH_CHANNELS.split(","));
  if (!pubs) {
    summary.warnings.push(`${pending.length} ACTIVE product(s) not yet published to sales channels: the Shopify app needs the read_publications and write_publications scopes.`);
    return;
  }
  let ok = 0;
  for (const r of pending) {
    try {
      await shopify.publish(r.shopify_product_id!, pubs);
      upsertProduct({ source_product_id: r.source_product_id, published: 1 });
      ok++;
    } catch (e) {
      summary.errors.push({ sku: r.source_product_id, stage: "publish", message: errMsg(e) });
      log.error("publish", errMsg(e), undefined, r.source_product_id);
    }
  }
  log.info("publish", `published ${ok}/${pending.length} product(s) to: ${settings.PUBLISH_CHANNELS}`);
}

function tally(s: SyncSummary, r: ProductReport) {
  const c = s.counts;
  if (r.outcome === "created" || r.outcome === "planned_create") c.created++;
  else if (r.outcome === "updated" || r.outcome === "planned_update") c.updated++;
  else if (r.outcome === "unchanged" || r.outcome === "planned_unchanged") c.unchanged++;
  else if (r.outcome === "needs_review") c.needsReview++;
  if (r.outcome !== "needs_review" && !r.changes.includes("new")) {
    if (r.changes.some((x) => x.includes("price"))) c.priceChanges++;
    if (r.changes.includes("sizes")) c.sizeChanges++;
    if (r.changes.includes("availability")) c.stockChanges++;
    if (r.changes.includes("images")) c.imageChanges++;
  }
}

function failedReport(item: ListingItem, msg: string): ProductReport {
  return { sku: item.sku, title: item.variantName, url: item.url, outcome: "failed", sourcePrice: item.price, sourceListPrice: null, currency: item.currency, fsrPrice: null, fsrCompareAt: null, sizes: [], images: 0, changes: [], notes: [], missing: [], error: msg };
}

const inr = (v: number | null) => (v == null ? "—" : `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);

export function formatReport(s: SyncSummary): string {
  const c = s.counts;
  const L: string[] = [];
  L.push(`${s.syncId}  (${s.mode === "dry_run" ? "DRY RUN - no Shopify changes made" : "LIVE"})`);
  L.push(`Sync started:  ${s.startedAt}`);
  L.push(`Sync finished: ${s.finishedAt}`);
  L.push(`Duration:      ${Math.round(s.durationMs / 1000)}s`);
  L.push(`Status:        ${s.status}`);
  if (s.discovery) L.push(`Source:        ${s.discovery.colorways} colorways in ${s.discovery.groups}/${s.discovery.groupsReported ?? "?"} product groups over ${s.discovery.pages} listing pages${s.limit ? ` (processing first ${s.limit})` : ""}`);
  L.push(`Shopify matching: ${s.shopifyChecked ? "checked against live store" : "NOT checked (no credentials) - local database only"}`);
  L.push("");
  const verb = s.mode === "dry_run" ? "would be " : "";
  L.push(`Products discovered:          ${c.discovered}`);
  L.push(`Products processed:           ${c.processed}`);
  L.push(`Products ${verb}created:       ${c.created}`);
  L.push(`Products ${verb}updated:       ${c.updated}`);
  L.push(`Products unchanged:           ${c.unchanged}`);
  L.push(`Products needing review:      ${c.needsReview}`);
  L.push(`Products with price changes:  ${c.priceChanges}`);
  L.push(`Products with size changes:   ${c.sizeChanges}`);
  L.push(`Products with stock changes:  ${c.stockChanges}`);
  L.push(`Products with image changes:  ${c.imageChanges}`);
  L.push(`Products missing from source: ${c.missing}`);
  L.push(`Products archived:            ${c.archived}`);
  L.push(`Products failed:              ${c.failed}`);
  L.push(`Errors:                       ${s.errors.length ? "" : "none"}`);
  for (const e of s.errors) L.push(`  - [${e.stage}] ${e.sku ?? ""} ${e.message}`);
  if (s.warnings.length) { L.push(""); L.push("WARNINGS:"); for (const w of s.warnings) L.push(`  ! ${w}`); }
  const groups: [string, ProductReport["outcome"][]][] = [
    ["NEW", ["planned_create", "created"]], ["UPDATE", ["planned_update", "updated"]], ["NEEDS REVIEW", ["needs_review"]], ["FAILED", ["failed"]], ["UNCHANGED", ["planned_unchanged", "unchanged"]],
  ];
  for (const [label, outs] of groups) {
    const ps = s.products.filter((p) => outs.includes(p.outcome));
    if (!ps.length) continue;
    L.push(""); L.push(`==== ${label} (${ps.length}) ====`);
    for (const p of ps) {
      L.push("");
      L.push(p.title);
      L.push(`  SKU: ${p.sku}    ${p.url}`);
      if (p.error) { L.push(`  ERROR: ${p.error}`); continue; }
      L.push(`  PRICE: source $${p.sourcePrice ?? "?"}${p.sourceListPrice ? ` (list $${p.sourceListPrice})` : ""} -> FSR ${p.fsrPrice != null ? inr(p.fsrPrice) : `not calculated (${p.priceNote})`}${p.fsrCompareAt ? `, compare-at ${inr(p.fsrCompareAt)}` : ""}`);
      L.push(`  SIZES: ${p.sizes.map((z) => `${z.label}${z.available ? "" : " (unavailable)"}${z.hint ? ` [${z.hint}]` : ""}`).join(", ") || "none found"}`);
      L.push(`  IMAGES: ${p.images}`);
      if (p.changes.length) L.push(`  CHANGES: ${p.changes.join(", ")}`);
      for (const note of p.notes) L.push(`  - ${note}`);
      const miss = p.missing.filter((m) => !m.startsWith("barcode"));
      if (miss.length) L.push(`  MISSING FROM SOURCE: ${miss.join(", ")}`);
    }
  }
  return L.join("\n") + "\n";
}

export function nextScheduledAt(settings = getSettings()): string | null {
  if (settings.SYNC_PAUSED) return null;
  const last = db.prepare("SELECT started_at FROM sync_runs WHERE trigger = 'scheduler' AND status != 'running' ORDER BY started_at DESC LIMIT 1").get() as { started_at: string } | undefined;
  if (!last) return new Date().toISOString();
  return new Date(new Date(last.started_at).getTime() + settings.SYNC_INTERVAL_HOURS * 3600_000).toISOString();
}

