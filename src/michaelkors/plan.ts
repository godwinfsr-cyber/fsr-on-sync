import { hash } from "../util.ts";
import type { FxRate } from "../gymshark/fx.ts";
import type { GShopifyProduct } from "../gymshark/ops.ts";
import { MICHAEL_KORS_AUTHORIZED_IMPORTER, type MkSettings } from "./config.ts";
import type { ImageRow, MkRow } from "./db.ts";
import { isExcludedMichaelKorsProduct, WATCH_SKIP_REASON } from "./exclusion.ts";
import type { NormalizedStyle } from "./normalize.ts";
import type { MkPrice } from "./pricing.ts";

export const MKNS = "michael_kors_sync";

export const OOS_TAG = "auto-oos-hidden"; // same tag the store's fullsizerun-oos-hider task and the other syncs use
export const COLOR = "Color";
export const SIZE = "Size";

export interface MkPlanInput {
  n: NormalizedStyle;
  existing: GShopifyProduct | null;
  row: MkRow | undefined;
  settings: MkSettings;
  prices: Map<string, MkPrice>;   // by (normalized) colour name
  fx: FxRate;
  images: ImageRow[];                   // what this sync uploaded before (source key -> Shopify media id)
  locationId: string | null;
  nowIso: string;
}

export interface MkPlan {
  action: "create" | "update";
  input: Record<string, unknown>;
  metafields: Record<string, string>[];   // updates: applied with metafieldsSet (merge); creates: inside productSet
  notes: string[];
  deferredVariants: number;               // new sizes/colours not added because no valid price exists yet
  pricesPaused: boolean;
  imagesSent: { key: string; colour: string }[] | null; // order of our images inside input.files (null = media untouched)
  written: { title: string; descHash: string; seoHash: string; eta: string | null; prices: Record<string, string> };
}

const money = (v: number | null | undefined) => (v == null ? null : v.toFixed(2));
export const seoHash = (seo: { title: string | null; description: string | null }) => hash([seo.title ?? "", seo.description ?? ""]);

/**
 * Source-controlled (always follows Michael Kors): variant structure (Color x Size), SKUs, availability,
 * source prices + michael_kors_sync metafields, images, specifications.
 * FSR-controlled: selling price comes only from the formula (a price edited in Shopify is kept until Michael Kors's USD
 * price for that colour changes); title / description / SEO / ETA are written on create and later only while they
 * still equal what this sync last wrote; product type is set on create only; manual tags are never removed.
 */
export function buildMkPlan(p: MkPlanInput): MkPlan {
  const { n, existing: e, settings: s, prices, fx } = p;
  // FINAL SAFETY CHECK: nothing that is (or looks like) a Michael Kors watch reaches Shopify - re-run on the final data
  const ex = isExcludedMichaelKorsProduct({ title: n.name, category: n.sourceCategory, productType: n.productType, url: n.sourceUrl, canonicalUrl: n.canonicalUrl }, s.EXCLUDED_CATEGORIES.split(","));
  if (n.exclusion.excluded || ex.excluded) throw new ExcludedProduct((n.exclusion.excluded ? n.exclusion : ex));
  let row = p.row;
  // Created by this sync but no local row (e.g. database rebuilt): Shopify's current values ARE what we wrote.
  if (!row && e?.sourceId?.value === n.styleCode) {
    row = {
      written_title: e.title, written_desc_hash: hash(e.descriptionHtml), written_seo_hash: seoHash(e.seo), written_eta: e.eta?.value ?? null,
      written_prices: JSON.stringify(Object.fromEntries(e.variants.nodes.filter((v) => v.sku).map((v) => [v.sku!.toUpperCase(), v.price]))),
      price_hash: n.hashes.price, image_hash: e.media.nodes.length ? n.hashes.image : null,
    } as MkRow;
  }
  const notes: string[] = [];
  const input: Record<string, unknown> = {};
  const create = !e;
  const contentAllowed = MICHAEL_KORS_AUTHORIZED_IMPORTER; // BRAND_AUTHORIZATION (config.ts): images + descriptions authorised
  const desc = contentAllowed ? n.descriptionHtml : n.factsHtml;
  const seo = { title: n.seoTitle, description: n.seoDescription };
  const available = n.availability !== "out_of_stock";

  // ---- option compatibility: a hand-made product with other options cannot be merged safely ----
  if (e) {
    const foreign = e.variants.nodes.filter((v) => v.selectedOptions.some((o) => o.name !== COLOR && o.name !== SIZE) && !(v.selectedOptions.length === 1 && v.selectedOptions[0].value === "Default Title"));
    if (foreign.length) throw new PlanConflict(`existing product uses options ${[...new Set(foreign.flatMap((v) => v.selectedOptions.map((o) => o.name)))].join("/")} instead of Color/Size - left for review`);
  }

  // ---- FSR-controlled text ----
  let writtenTitle = row?.written_title ?? "";
  let writtenDescHash = row?.written_desc_hash ?? "";
  let writtenSeoHash = row?.written_seo_hash ?? "";
  if (create) {
    Object.assign(input, { title: n.title, descriptionHtml: desc, vendor: s.VENDOR, productType: n.productType, seo });
    writtenTitle = n.title; writtenDescHash = hash(desc); writtenSeoHash = seoHash(seo);
  } else {
    if (e.title !== n.title) {
      if (row?.written_title && e.title === row.written_title) { input.title = n.title; writtenTitle = n.title; notes.push(`title: "${e.title}" -> "${n.title}"`); }
      else notes.push("title edited in Shopify - preserved");
    }
    if (hash(e.descriptionHtml) !== hash(desc)) {
      const untouched = row?.written_desc_hash && hash(e.descriptionHtml) === row.written_desc_hash;
      if (untouched || s.OVERWRITE_MANUAL_DESCRIPTION) { input.descriptionHtml = desc; writtenDescHash = hash(desc); notes.push(untouched ? "description updated from source" : "manual description overwritten (OVERWRITE_MANUAL_DESCRIPTION=true)"); }
      else notes.push("description edited in Shopify - preserved");
    }
    if (e.vendor !== s.VENDOR) { input.vendor = s.VENDOR; notes.push(`vendor: "${e.vendor}" -> "${s.VENDOR}"`); }
    if (seoHash(e.seo) !== seoHash(seo)) {
      if (row?.written_seo_hash && seoHash(e.seo) === row.written_seo_hash) { input.seo = seo; writtenSeoHash = seoHash(seo); notes.push("SEO defaults refreshed"); }
      else notes.push("SEO customised in Shopify - preserved");
    }
  }

  // ---- tags + status (store policy: out of stock -> hidden as DRAFT with the oos-hider's tag) ----
  const tagSet = new Set([...(e?.tags ?? []), ...n.tags].filter((t) => t !== "Instant Ship"));
  if (create) {
    input.status = available ? s.NEW_PRODUCT_STATUS : "DRAFT";
    if (!available) { tagSet.add(OOS_TAG); notes.push("every size sold out at Michael Kors - created as DRAFT"); }
  } else if (!available && e.status === "ACTIVE") {
    input.status = "DRAFT"; tagSet.add(OOS_TAG); notes.push(`every size sold out at Michael Kors - hidden (DRAFT + ${OOS_TAG})`);
  } else if (available && e.status === "DRAFT" && e.tags.includes(OOS_TAG)) {
    input.status = "ACTIVE"; tagSet.delete(OOS_TAG); notes.push("back in stock at Michael Kors - restored to ACTIVE");
  } else if (available && e.status === "ARCHIVED" && row?.last_sync_status === "archived") {
    input.status = "ACTIVE"; notes.push("product reappeared on Michael Kors - un-archived");
  }
  const tags = [...tagSet].sort();
  if (create || tags.join("|") !== [...e.tags].sort().join("|")) input.tags = tags;

  // ---- variants: Color x Size exactly as Michael Kors lists them (nothing manufactured) ----
  const writtenBefore: Record<string, string> = row?.written_prices ? JSON.parse(row.written_prices) : {};
  const sourcePriceChanged = !!row?.price_hash && row.price_hash !== n.hashes.price;
  const writtenPrices: Record<string, string> = {};
  const evBySku = new Map((e?.variants.nodes ?? []).filter((v) => v.sku).map((v) => [v.sku!.toUpperCase(), v]));
  const used = new Set<string>();
  const variants: Record<string, unknown>[] = [];
  let deferred = 0;
  let pricesPaused = false;
  let preserved = 0;
  let priceMoves = 0;
  for (const nv of n.variants) {
    const ev = evBySku.get(nv.sku);
    if (ev) used.add(ev.id);
    const price = prices.get(nv.colour);
    let vPrice: string | null;
    let vCompare: string | null;
    if (!price?.ok) {
      pricesPaused = true;
      if (!ev) { deferred++; continue; } // cannot sell a new size/colour without a valid price
      vPrice = ev.price; vCompare = ev.compareAtPrice;
      if (writtenBefore[nv.sku]) writtenPrices[nv.sku] = writtenBefore[nv.sku];
    } else {
      const target = money(price.fsrPrice)!;
      const compare = money(price.compareAtPrice);
      const wrote = writtenBefore[nv.sku];
      if (ev && wrote != null && ev.price !== wrote && !sourcePriceChanged) {
        vPrice = ev.price; vCompare = ev.compareAtPrice; writtenPrices[nv.sku] = wrote; preserved++;
      } else {
        if (ev && ev.price !== target) priceMoves++;
        vPrice = target; vCompare = compare; writtenPrices[nv.sku] = target;
      }
    }
    const v: Record<string, unknown> = {
      optionValues: [{ optionName: COLOR, name: nv.colour }, { optionName: SIZE, name: nv.size }],
      sku: nv.sku,
      price: vPrice,
      compareAtPrice: vCompare,
      // no FSR stock is held: orderable while Michael Kors has the size, blocked when it is sold out there
      inventoryPolicy: nv.availability === "out_of_stock" ? "DENY" : "CONTINUE",
      taxable: true,
      inventoryItem: { tracked: true, sku: nv.sku, requiresShipping: true },
    };
    if (ev) v.id = ev.id;
    else if (p.locationId) v.inventoryQuantities = [{ locationId: p.locationId, name: "available", quantity: 0 }];
    variants.push(v);
  }
  if (preserved) notes.push(`${preserved} selling price(s) edited in Shopify - preserved until Michael Kors's USD price changes`);
  if (priceMoves) notes.push(`${priceMoves} variant price(s) recalculated`);
  if (pricesPaused) notes.push(`PRICE UPDATES PAUSED: ${[...prices.values()].find((x) => !x.ok)?.reason ?? "no valid price"} - existing prices left unchanged`);
  if (deferred) notes.push(`${deferred} new variant(s) not added until a valid price exists`);

  // variants already in Shopify but no longer listed by Michael Kors: kept (never deleted); ours become unorderable
  const prefix = `${n.styleCode}-`;
  let dropped = 0;
  let manual = 0;
  for (const ev of e?.variants.nodes ?? []) {
    if (used.has(ev.id)) continue;
    const ours = (ev.sku ?? "").toUpperCase().startsWith(prefix);
    const keep: Record<string, unknown> = { id: ev.id, optionValues: ev.selectedOptions.map((o) => ({ optionName: o.name, name: o.value })) };
    if (ours) { keep.inventoryPolicy = "DENY"; dropped++; } else manual++;
    variants.push(keep);
  }
  if (dropped) notes.push(`${dropped} variant(s) no longer listed by Michael Kors - kept as unavailable`);
  if (manual) notes.push(`kept ${manual} manually added variant(s) untouched`);
  // a product adopted from a single "Default Title" variant cannot keep it next to Color/Size variants
  const defaultTitle = variants.filter((v) => (v.optionValues as { optionName: string }[]).some((o) => o.optionName === "Title"));
  if (defaultTitle.length && variants.length > defaultTitle.length) throw new PlanConflict("existing product has a single default variant plus source sizes - left for review");

  const optionValues = (name: string) => [...new Set(variants.map((v) => (v.optionValues as { optionName: string; name: string }[]).find((o) => o.optionName === name)?.name).filter(Boolean) as string[])];
  input.productOptions = [
    { name: COLOR, position: 1, values: optionValues(COLOR).map((name) => ({ name })) },
    { name: SIZE, position: 2, values: optionValues(SIZE).map((name) => ({ name })) },
  ];
  input.variants = variants;

  // ---- images: only when Michael Kors's image set changed (or nothing uploaded yet). Photos already uploaded are
  // referenced by their Shopify media id, so they are never uploaded twice; manually added media is kept. ----
  let imagesSent: MkPlan["imagesSent"] = null;
  if (!contentAllowed) {
    if (n.images.length) notes.push("images NOT uploaded: MICHAEL_KORS_AUTHORIZED_IMPORTER=false");
  } else if (n.images.length && (create || !e.media.nodes.length || !row?.image_hash || row.image_hash !== n.hashes.image)) {
    const onProduct = new Set((e?.media.nodes ?? []).map((m) => m.id));
    const known = new Map(p.images.filter((i) => i.media_id && onProduct.has(i.media_id)).map((i) => [i.source_key, i.media_id!]));
    const ourIds = new Set(p.images.map((i) => i.media_id).filter(Boolean));
    let reused = 0;
    const files: Record<string, unknown>[] = n.images.map((im) => {
      const id = known.get(im.key);
      if (id) { reused++; return { id }; }
      return { originalSource: im.url, contentType: "IMAGE", alt: im.alt };
    });
    const manualMedia = (e?.media.nodes ?? []).filter((m) => !ourIds.has(m.id));
    files.push(...manualMedia.map((m) => ({ id: m.id })));
    input.files = files;
    imagesSent = n.images.map((im) => ({ key: im.key, colour: im.colour }));
    if (!create) notes.push(`images: ${n.images.length - reused} new, ${reused} already uploaded (reused)${manualMedia.length ? `, ${manualMedia.length} manual kept` : ""}`);
  }

  // ---- metafields (michael_kors_sync.*) ----
  const mf = (key: string, value: string | number | null | undefined, type = "single_line_text_field") => (value == null || value === "" ? null : { namespace: MKNS, key, type, value: String(value) });
  const ok = [...prices.values()].filter((x) => x.ok);
  const cheapest = ok.sort((a, b) => a.fsrPrice! - b.fsrPrice!)[0];
  const weight = [...prices.values()][0]?.weight;
  const perColour = n.colours.map((c) => {
    const pr = prices.get(c.colour);
    return { colour: c.colour, colour_code: c.colourCode, availability: c.availability, source_price_usd: pr?.sourcePriceUsd ?? c.currentUsd, source_regular_price_usd: pr?.sourceRegularPriceUsd ?? null, source_sale_price_usd: pr?.sourceSalePriceUsd ?? null, converted_price_inr: pr?.convertedPriceInr != null ? Math.round(pr.convertedPriceInr * 100) / 100 : null, shipping_adjustment_inr: pr?.weight.surchargeInr ?? null, landed_cost_inr: pr?.landedCostInr != null ? Math.round(pr.landedCostInr * 100) / 100 : null, profit_adjustment_inr: pr?.profitInr ?? null, fsr_selling_price: pr?.fsrPrice ?? null };
  });
  const metafields = [
    { namespace: MKNS, key: "source_product_id", value: n.styleCode }, // typed by its unique "id" definition
    mf("source_sku", n.styleCode),
    mf("source_variant_ids", JSON.stringify(Object.fromEntries(n.variants.map((v) => [v.sku, v.sourceSku]))), "json"),
    mf("source_url", n.sourceUrl, "url"),
    mf("canonical_url", n.canonicalUrl, "url"),
    mf("source_category", n.sourceCategory),
    mf("category", n.category),
    mf("gender", n.gender),
    mf("collection", n.channel ?? n.category),
    mf("source_channel", n.sourceChannel),
    mf("source_variant_availability", JSON.stringify(Object.fromEntries(n.variants.map((v) => [v.sku, v.sourceAvailability]))), "json"),
    mf("colours", JSON.stringify(n.colours.map((c) => c.colour)), "json"),
    mf("source_status", "active"),
    mf("source_availability", n.availability),
    mf("source_last_seen_at", p.nowIso, "date_time"),
    mf("source_last_synced_at", p.nowIso, "date_time"),
    mf("specifications", JSON.stringify({ fields: n.specs }), "json"),
    mf("source_weight_kg", n.weightKg, "number_decimal"),
    mf("shipping_adjustment_inr", weight?.surchargeInr, "number_decimal"),
    mf("shipping_adjustment_reason", weight?.reason),
    mf("weight_source", n.weightSource),
    mf("import_status", create ? "imported" : "updated"),
    mf("authorization", "Official Authorized Importer (India) - Full Size Run"),
  ].filter(Boolean) as Record<string, string>[];
  if (cheapest && !pricesPaused) {
    metafields.push(...[
      mf("source_price_usd", cheapest.sourcePriceUsd?.toFixed(2), "number_decimal"),
      mf("source_regular_price_usd", cheapest.sourceRegularPriceUsd?.toFixed(2), "number_decimal"),
      mf("source_sale_price_usd", cheapest.sourceSalePriceUsd?.toFixed(2), "number_decimal"),
      mf("exchange_rate", fx.rate, "number_decimal"),
      mf("exchange_rate_timestamp", fx.fetchedAt, "date_time"),
      mf("exchange_rate_provider", fx.provider),
      mf("converted_price_inr", cheapest.convertedPriceInr?.toFixed(2), "number_decimal"),
      mf("landed_cost_inr", cheapest.landedCostInr?.toFixed(2), "number_decimal"),
      mf("profit_adjustment_inr", cheapest.profitInr, "number_decimal"),
      mf("fsr_selling_price", money(cheapest.fsrPrice), "number_decimal"),
      mf("variant_pricing", JSON.stringify(perColour), "json"),
    ].filter(Boolean) as Record<string, string>[]);
  }

  let writtenEta = row?.written_eta ?? null;
  const currentEta = e?.eta?.value ?? null;
  if (create || currentEta == null || (currentEta === row?.written_eta && currentEta !== s.DEFAULT_ETA)) {
    if (currentEta !== s.DEFAULT_ETA) {
      metafields.push({ namespace: "custom", key: "eta", type: "single_line_text_field", value: s.DEFAULT_ETA });
      if (!create) notes.push(`ETA: "${currentEta ?? "(none)"}" -> "${s.DEFAULT_ETA}"`);
    }
    writtenEta = s.DEFAULT_ETA;
  } else if (currentEta !== s.DEFAULT_ETA) {
    notes.push(`ETA "${currentEta}" set manually in Shopify - preserved`);
  }
  // productSet REPLACES the metafield list, so metafields only travel inside productSet on create.
  if (create) input.metafields = metafields;

  return {
    action: create ? "create" : "update",
    input,
    metafields: create ? [] : metafields,
    notes,
    deferredVariants: deferred,
    pricesPaused,
    imagesSent,
    written: { title: writtenTitle, descHash: writtenDescHash, seoHash: writtenSeoHash, eta: writtenEta, prices: writtenPrices },
  };
}

export class PlanConflict extends Error {}

/** Thrown by the final safety check: the product must not be created or updated. */
export class ExcludedProduct extends Error {
  status: "watch_excluded" | "skipped";
  level: string | null;
  constructor(r: { status: "watch_excluded" | "skipped" | null; level: string | null; reason: string | null }) {
    super(r.status === "watch_excluded" ? `${WATCH_SKIP_REASON} (${r.reason})` : r.reason ?? "excluded");
    this.status = r.status ?? "skipped";
    this.level = r.level;
  }
}

/** After productSet: which Shopify media id now holds each of our images (matched by position, then alt text). */
export function mapUploadedMedia(sent: { key: string; colour: string }[], media: { id: string; alt: string | null }[], alts: Map<string, string>): Map<string, string> | null {
  const out = new Map<string, string>();
  if (media.length >= sent.length) {
    sent.forEach((s, i) => out.set(s.key, media[i].id));
    // sanity: where we set alt text, it must match at that position
    const mismatch = sent.some((s, i) => alts.get(s.key) && media[i].alt && media[i].alt !== alts.get(s.key));
    if (!mismatch) return out;
  }
  out.clear();
  for (const s of sent) {
    const alt = alts.get(s.key);
    const hit = alt ? media.find((m) => m.alt === alt && ![...out.values()].includes(m.id)) : undefined;
    if (hit) out.set(s.key, hit.id);
  }
  return out.size === sent.length ? out : null;
}

