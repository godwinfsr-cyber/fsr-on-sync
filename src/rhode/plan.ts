import type { FxRate } from "../gymshark/fx.ts";
import type { GShopifyProduct } from "../gymshark/ops.ts";
import { hash } from "../util.ts";
import type { RhodeSettings } from "./config.ts";
import type { ImageRow, RhodeRow } from "./db.ts";
import type { NormalizedGroup } from "./normalize.ts";
import { RNS } from "./ops.ts";
import type { RhodePrice } from "./pricing.ts";

export const OOS_TAG = "auto-oos-hidden"; // same tag the store's fullsizerun-oos-hider task and the other syncs use
const TITLE_OPT = { optionName: "Title", name: "Default Title" };

export interface RPlanInput {
  n: NormalizedGroup;
  existing: GShopifyProduct | null;
  row: RhodeRow | undefined;
  settings: RhodeSettings;
  prices: Map<string, RhodePrice>;      // by variant SKU
  fx: FxRate;
  images: ImageRow[];                   // what this sync uploaded before (source key -> Shopify media id)
  locationId: string | null;
  nowIso: string;
}

export interface RPlan {
  action: "create" | "update";
  input: Record<string, unknown>;
  metafields: Record<string, string>[];   // updates: applied with metafieldsSet (merge); creates: inside productSet
  notes: string[];
  deferredVariants: number;               // new variants not added because no valid price exists yet
  pricesPaused: boolean;
  priceMoves: number;
  imagesSent: { key: string; colour: string }[] | null; // order of our images inside input.files (null = media untouched)
  written: { title: string; descHash: string; seoHash: string; eta: string | null; prices: Record<string, string> };
}

export class PlanConflict extends Error {}

const money = (v: number | null | undefined) => (v == null ? null : v.toFixed(2));
export const seoHash = (seo: { title: string | null; description: string | null }) => hash([seo.title ?? "", seo.description ?? ""]);
const optionValuesOf = (n: NormalizedGroup, v: NormalizedGroup["variants"][number]) => (n.optionNames.length ? v.optionValues : [TITLE_OPT]);

/**
 * Source-controlled (always follows Rhode): variants, SKUs, availability, source prices, images, specifications and
 * the rhode_sync metafields.
 * FSR-controlled: the selling price comes only from the formula (a price edited in Shopify is kept until Rhode's USD
 * price changes); title / description / SEO / ETA are written on create and later only while they still equal what
 * this sync last wrote; product type is set on create only; manual tags, media and variants are never removed.
 */
export function buildRhodePlan(p: RPlanInput): RPlan {
  const { n, existing: e, settings: s, prices, fx } = p;
  let row = p.row;
  // Created by this sync but no local row (e.g. database rebuilt): Shopify's current values ARE what we wrote.
  if (!row && e?.sourceId?.value === n.key) {
    row = {
      written_title: e.title, written_desc_hash: hash(e.descriptionHtml), written_seo_hash: seoHash(e.seo), written_eta: e.eta?.value ?? null,
      written_prices: JSON.stringify(Object.fromEntries(e.variants.nodes.filter((v) => v.sku).map((v) => [v.sku!.toUpperCase(), v.price]))),
      price_hash: n.hashes.price, image_hash: e.media.nodes.length ? n.hashes.image : null,
    } as RhodeRow;
  }
  const notes: string[] = [];
  const input: Record<string, unknown> = {};
  const create = !e;
  const contentAllowed = s.CONTENT_REUSE_CONFIRMED;
  const desc = contentAllowed ? n.descriptionHtml : n.factsHtml;
  const seo = { title: n.seoTitle, description: n.seoDescription };
  const available = n.availability === "in_stock";
  const allowed = new Set<string>(n.optionNames.length ? n.optionNames : ["Title"]);

  // ---- option compatibility: a hand-made product with other options cannot be merged safely ----
  if (e) {
    const foreign = e.variants.nodes.filter((v) => v.selectedOptions.some((o) => !allowed.has(o.name)) && !(v.selectedOptions.length === 1 && v.selectedOptions[0].value === "Default Title" && !n.optionNames.length));
    if (foreign.length) throw new PlanConflict(`existing product uses options ${[...new Set(foreign.flatMap((v) => v.selectedOptions.map((o) => o.name)))].join("/")} instead of ${[...allowed].join("/")} - left for review`);
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
      const blank = !e.seo.title && !e.seo.description;
      if (blank || (row?.written_seo_hash && seoHash(e.seo) === row.written_seo_hash)) { input.seo = seo; writtenSeoHash = seoHash(seo); notes.push(blank ? "SEO was blank - defaults written" : "SEO defaults refreshed"); }
      else notes.push("SEO customised in Shopify - preserved");
    }
  }

  // ---- tags + status (store policy: out of stock -> hidden as DRAFT with the oos-hider's tag) ----
  const tagSet = new Set([...(e?.tags ?? []), ...n.tags].filter((t) => t !== "Instant Ship"));
  if (create) {
    input.status = available ? s.NEW_PRODUCT_STATUS : "DRAFT";
    if (!available) { tagSet.add(OOS_TAG); notes.push("sold out at Rhode - created as DRAFT"); }
  } else if (!available && e.status === "ACTIVE") {
    input.status = "DRAFT"; tagSet.add(OOS_TAG); notes.push(`sold out at Rhode - hidden (DRAFT + ${OOS_TAG})`);
  } else if (available && e.status === "DRAFT" && e.tags.includes(OOS_TAG)) {
    input.status = "ACTIVE"; tagSet.delete(OOS_TAG); notes.push("back in stock at Rhode - restored to ACTIVE");
  } else if (available && e.status === "ARCHIVED" && row?.last_sync_status === "archived") {
    input.status = "ACTIVE"; notes.push("product reappeared on Rhode - un-archived");
  }
  const tags = [...tagSet].sort();
  if (create || tags.join("|") !== [...e.tags].sort().join("|")) input.tags = tags;

  // ---- variants exactly as Rhode lists them (nothing manufactured) ----
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
    const price = prices.get(nv.sku);
    let vPrice: string | null;
    let vCompare: string | null;
    if (!price?.ok) {
      pricesPaused = true;
      if (!ev) { deferred++; continue; } // a new variant cannot be sold without a valid price
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
      optionValues: optionValuesOf(n, nv),
      sku: nv.sku,
      price: vPrice,
      compareAtPrice: vCompare,
      // no FSR stock is held: orderable while Rhode sells it, blocked when it is sold out there
      inventoryPolicy: nv.availability === "in_stock" ? "CONTINUE" : "DENY",
      taxable: true,
      inventoryItem: { tracked: true, sku: nv.sku, requiresShipping: true, ...(nv.grams ? { measurement: { weight: { value: nv.grams, unit: "GRAMS" } } } : {}) },
    };
    if (ev) v.id = ev.id;
    else if (p.locationId) v.inventoryQuantities = [{ locationId: p.locationId, name: "available", quantity: 0 }];
    variants.push(v);
  }
  if (preserved) notes.push(`${preserved} selling price(s) edited in Shopify - preserved until Rhode's USD price changes`);
  if (priceMoves) notes.push(`${priceMoves} variant price(s) recalculated`);
  if (pricesPaused) notes.push(`PRICE UPDATES PAUSED: ${[...prices.values()].find((x) => !x.ok)?.reason ?? "no valid price"} - existing prices left unchanged`);
  if (deferred) notes.push(`${deferred} new variant(s) not added until a valid price exists`);

  // variants already in Shopify but no longer listed by Rhode: kept (never deleted); ours become unorderable
  const ourSkus = new Set<string>([...(row?.source_skus ? (JSON.parse(row.source_skus) as string[]) : []), ...Object.keys(writtenBefore)].map((x) => x.toUpperCase()));
  let dropped = 0;
  let manual = 0;
  for (const ev of e?.variants.nodes ?? []) {
    if (used.has(ev.id)) continue;
    const keep: Record<string, unknown> = { id: ev.id, optionValues: ev.selectedOptions.map((o) => ({ optionName: o.name, name: o.value })) };
    if (ourSkus.has((ev.sku ?? "").toUpperCase())) { keep.inventoryPolicy = "DENY"; dropped++; } else manual++;
    variants.push(keep);
  }
  if (dropped) notes.push(`${dropped} variant(s) no longer listed by Rhode - kept as unavailable`);
  if (manual) notes.push(`kept ${manual} manually added variant(s) untouched`);
  const defaultTitle = variants.filter((v) => (v.optionValues as { optionName: string }[]).some((o) => o.optionName === "Title"));
  if (defaultTitle.length && variants.length > defaultTitle.length) throw new PlanConflict("existing product has a single default variant plus Rhode shades/sizes - left for review");

  const names = n.optionNames.length ? n.optionNames : ["Title"];
  input.productOptions = names.map((name, i) => ({
    name, position: i + 1,
    values: [...new Set(variants.map((v) => (v.optionValues as { optionName: string; name: string }[]).find((o) => o.optionName === name)?.name).filter(Boolean) as string[])].map((value) => ({ name: value })),
  }));
  input.variants = variants;

  // ---- images: only when Rhode's image set changed (or nothing uploaded yet). Photos already uploaded are
  // referenced by their Shopify media id, so they are never uploaded twice; manually added media is kept. ----
  let imagesSent: RPlan["imagesSent"] = null;
  if (!contentAllowed) {
    if (n.images.length) notes.push("images NOT uploaded: CONTENT_REUSE_CONFIRMED is false");
  } else if (n.images.length && (create || !e.media.nodes.length || !row?.image_hash || row.image_hash !== n.hashes.image)) {
    const onProduct = new Set((e?.media.nodes ?? []).map((m) => m.id));
    const known = new Map(p.images.filter((i) => i.media_id && onProduct.has(i.media_id)).map((i) => [i.source_key, i.media_id!]));
    const ourIds = new Set(p.images.map((i) => i.media_id).filter(Boolean));
    const manualMedia = (e?.media.nodes ?? []).filter((m) => !ourIds.has(m.id));
    const mine = n.images.slice(0, Math.max(0, 250 - manualMedia.length));
    let reused = 0;
    const files: Record<string, unknown>[] = mine.map((im) => {
      const id = known.get(im.key);
      if (id) { reused++; return { id }; }
      return { originalSource: im.url, contentType: "IMAGE", alt: im.alt };
    });
    files.push(...manualMedia.map((m) => ({ id: m.id })));
    input.files = files;
    imagesSent = mine.map((im) => ({ key: im.key, colour: im.colour }));
    if (mine.length < n.images.length) notes.push(`${n.images.length - mine.length} image(s) left out: Shopify allows 250 media per product`);
    if (!create) notes.push(`images: ${mine.length - reused} new, ${reused} already uploaded (reused)${manualMedia.length ? `, ${manualMedia.length} manual kept` : ""}`);
  }

  // ---- metafields (rhode_sync namespace) ----
  const mf = (key: string, value: string | number | null | undefined, type = "single_line_text_field") => (value == null || value === "" ? null : { namespace: RNS, key, type, value: String(value) });
  const ok = [...prices.values()].filter((x) => x.ok);
  const cheapest = [...ok].sort((a, b) => a.fsrPrice! - b.fsrPrice!)[0];
  const perVariant = n.variants.map((v) => {
    const pr = prices.get(v.sku);
    return {
      variant: v.label, sku: v.sku, source_variant_id: v.sourceVariantId, source_product_id: v.sourceProductId, url: `${n.sourceUrl.replace(/\/products\/.*$/, "")}/products/${v.handle}`, availability: v.availability,
      source_price_usd: pr?.sourcePriceUsd ?? v.currentUsd, source_regular_price_usd: pr?.sourceRegularPriceUsd ?? v.regularUsd, source_sale_price_usd: pr?.sourceSalePriceUsd ?? null,
      converted_price_inr: pr?.convertedPriceInr != null ? Math.round(pr.convertedPriceInr * 100) / 100 : null, fsr_selling_price: pr?.fsrPrice ?? null,
    };
  });
  const primaryVariant = n.variants[0];
  const metafields = [
    { namespace: RNS, key: "source_product_id", value: n.key }, // typed by its unique "id" definition
    mf("source_product_ids", JSON.stringify(n.sourceProductIds), "json"),
    // one Rhode variant: its id; several: "SKU=id" pairs (one type for every product, so it can never change type)
    mf("source_variant_id", n.variants.length === 1 ? primaryVariant?.sourceVariantId : n.variants.map((v) => `${v.sku}=${v.sourceVariantId}`).join(", ")),
    mf("source_url", n.sourceUrl, "url"),
    mf("canonical_url", n.canonicalUrl, "url"),
    mf("source_handle", n.primaryHandle),
    mf("source_sku", n.variants.length === 1 ? primaryVariant?.sku : n.skuBase),
    mf("category", n.subcategory ? `${n.category} / ${n.subcategory}` : n.category),
    mf("collection", n.collections.join(", ")),
    mf("product_type", n.sourceProductType),
    mf("short_description", n.shortDescription, "multi_line_text_field"),
    mf("size", n.size),
    mf("shades", n.shades.length ? JSON.stringify(n.shades) : null, "json"),
    mf("source_status", "active"),
    mf("source_availability", n.availability),
    mf("source_last_seen_at", p.nowIso, "date_time"),
    mf("source_last_synced_at", p.nowIso, "date_time"),
    mf("specifications", JSON.stringify(n.specs), "json"),
    mf("pricing_adjustment_inr", s.PRICING_ADJUSTMENT_INR, "number_decimal"),
    mf("import_status", create ? "created" : "updated"),
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
      mf("fsr_selling_price", money(cheapest.fsrPrice), "number_decimal"),
      mf("variant_pricing", JSON.stringify(perVariant), "json"),
    ].filter(Boolean) as Record<string, string>[]);
  }

  let writtenEta = row?.written_eta ?? null;
  const currentEta = e?.eta?.value ?? null;
  if (create || currentEta == null || (currentEta === row?.written_eta && currentEta !== s.ETA)) {
    if (currentEta !== s.ETA) {
      metafields.push({ namespace: "custom", key: "eta", type: "single_line_text_field", value: s.ETA });
      if (!create) notes.push(`ETA: "${currentEta ?? "(none)"}" -> "${s.ETA}"`);
    }
    writtenEta = s.ETA;
  } else if (currentEta !== s.ETA) {
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
    priceMoves,
    imagesSent,
    written: { title: writtenTitle, descHash: writtenDescHash, seoHash: writtenSeoHash, eta: writtenEta, prices: writtenPrices },
  };
}
