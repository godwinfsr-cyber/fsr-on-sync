import type { FxRate } from "../gymshark/fx.ts";
import type { GShopifyProduct, GVariant } from "../gymshark/ops.ts";
import { hash } from "../util.ts";
import type { StanleySettings } from "./config.ts";
import type { ImageRow, StanleyRow } from "./db.ts";
import { SELLABLE, type NormalizedProduct, type NormalizedVariant } from "./normalize.ts";
import { SNS } from "./ops.ts";
import type { StanleyPrice } from "./pricing.ts";

export const OOS_TAG = "auto-oos-hidden"; // same tag the store's fullsizerun-oos-hider task and the other syncs use
const TITLE_OPT = { optionName: "Title", name: "Default Title" };

export interface SPlanInput {
  key: string;                          // FSR product key (stanley_sync.source_product_id)
  n: NormalizedProduct;
  existing: GShopifyProduct | null;
  row: StanleyRow | undefined;
  settings: StanleySettings;
  prices: Map<string, StanleyPrice>;    // by variant SKU
  fx: FxRate;
  images: ImageRow[];                   // what this sync uploaded before (source key -> Shopify media id)
  locationId: string | null;
  nowIso: string;
  importStatus: "created" | "updated";
}

export interface SPlan {
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
export const optionValuesOf = (n: NormalizedProduct, v: NormalizedVariant) => (n.hasColourOption ? [{ optionName: "Color", name: v.colour }] : [TITLE_OPT]);

/**
 * Source-controlled (always follows Stanley): variants, SKUs, barcodes, availability, source prices, images,
 * specifications and the stanley_sync metafields.
 * FSR-controlled: the selling price comes only from the formula (a price edited in Shopify is kept until Stanley's USD
 * price changes); title / description / SEO / ETA are written on create and later only while they still equal what
 * this sync last wrote; product type is set on create only; manual tags, media, notes and variants are never removed.
 */
export function buildStanleyPlan(p: SPlanInput): SPlan {
  const { n, existing: e, settings: s, prices, fx, key } = p;
  let row = p.row;
  // Created by this sync but no local row (e.g. database rebuilt): Shopify's current values ARE what we wrote.
  if (!row && e?.sourceId?.value === key) {
    row = {
      written_title: e.title, written_desc_hash: hash(e.descriptionHtml), written_seo_hash: seoHash(e.seo), written_eta: e.eta?.value ?? null,
      written_prices: JSON.stringify(Object.fromEntries(e.variants.nodes.filter((v) => v.sku).map((v) => [v.sku!.toUpperCase(), v.price]))),
      price_hash: n.hashes.price, image_hash: e.media.nodes.length ? n.hashes.image : null, source_skus: JSON.stringify(e.variants.nodes.map((v) => v.sku).filter(Boolean)),
    } as StanleyRow;
  }
  const notes: string[] = [];
  const input: Record<string, unknown> = {};
  const create = !e;
  const contentAllowed = s.AUTHORIZED_IMPORTER;
  const desc = contentAllowed ? n.descriptionHtml : n.factsHtml;
  const seo = { title: n.seoTitle, description: n.seoDescription };
  const available = SELLABLE.includes(n.availability);
  const optName = n.hasColourOption ? "Color" : "Title";

  // ---- option compatibility: a hand-made product with other options cannot be merged safely ----
  if (e) {
    const foreign = e.variants.nodes.filter((v) => v.selectedOptions.some((o) => o.name !== optName) && !(v.selectedOptions.length === 1 && v.selectedOptions[0].value === "Default Title" && optName === "Title"));
    if (foreign.length) throw new PlanConflict(`existing product uses options ${[...new Set(foreign.flatMap((v) => v.selectedOptions.map((o) => o.name)))].join("/")} instead of ${optName} - left for review`);
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

  // ---- tags + status (store policy: out of stock -> hidden as DRAFT with the oos-hider's tag; never deleted) ----
  const tagSet = new Set([...(e?.tags ?? []), ...n.tags].filter((t) => t !== "Instant Ship"));
  if (create) {
    input.status = available ? s.NEW_PRODUCT_STATUS : "DRAFT";
    if (!available) { tagSet.add(OOS_TAG); notes.push("every colour sold out at Stanley - created as DRAFT"); }
  } else if (!available && e.status === "ACTIVE") {
    input.status = "DRAFT"; tagSet.add(OOS_TAG); notes.push(`every colour sold out at Stanley - hidden (DRAFT + ${OOS_TAG})`);
  } else if (available && e.status === "DRAFT" && e.tags.includes(OOS_TAG)) {
    input.status = "ACTIVE"; tagSet.delete(OOS_TAG); notes.push("back in stock at Stanley - restored to ACTIVE");
  } else if (available && e.status === "ARCHIVED" && row?.last_sync_status === "archived") {
    input.status = "ACTIVE"; notes.push("product reappeared on Stanley - un-archived");
  }
  const tags = [...tagSet].sort();
  if (create || tags.join("|") !== [...e.tags].sort().join("|")) input.tags = tags;

  // ---- variants exactly as Stanley lists them. Matched by SKU, then by colour (Stanley re-SKUs a colour when it moves
  // it to another listing: the Shopify variant keeps its id and gets the new SKU instead of colliding). ----
  const writtenBefore: Record<string, string> = row?.written_prices ? JSON.parse(row.written_prices) : {};
  const ourSkus = new Set<string>([...Object.keys(writtenBefore), ...(row?.source_skus ? (JSON.parse(row.source_skus) as string[]) : [])].map((x) => x.toUpperCase()));
  // on a product this sync created, a Stanley-format SKU (12 digits, optional letter) is ours even if the local record lost it
  const isOurs = (sku: string) => ourSkus.has(sku) || (e?.sourceId?.value === key && /^\d{9,14}[A-Z]?$/.test(sku));
  const sourcePriceChanged = !!row?.price_hash && row.price_hash !== n.hashes.price;
  const writtenPrices: Record<string, string> = {};
  const evBySku = new Map((e?.variants.nodes ?? []).filter((v) => v.sku).map((v) => [v.sku!.toUpperCase(), v]));
  const used = new Set<string>();
  for (const nv of n.variants) { const ev = evBySku.get(nv.sku); if (ev) used.add(ev.id); }
  const valueOf = (v: GVariant) => v.selectedOptions.find((o) => o.name === optName)?.value.toLowerCase() ?? "";
  const variants: Record<string, unknown>[] = [];
  let deferred = 0;
  let pricesPaused = false;
  let preserved = 0;
  let priceMoves = 0;
  let reSkued = 0;
  for (const nv of n.variants) {
    let ev = evBySku.get(nv.sku);
    if (!ev) {
      const want = (optionValuesOf(n, nv)[0].name).toLowerCase();
      ev = (e?.variants.nodes ?? []).find((x) => !used.has(x.id) && valueOf(x) === want && isOurs((x.sku ?? "").toUpperCase()));
      if (ev) { used.add(ev.id); reSkued++; }
    }
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
      const wrote = ev ? writtenBefore[(ev.sku ?? "").toUpperCase()] : undefined;
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
      barcode: nv.barcode,
      price: vPrice,
      compareAtPrice: vCompare,
      // no FSR stock is held: orderable while Stanley has the colour, blocked when it is sold out there
      inventoryPolicy: SELLABLE.includes(nv.availability) ? "CONTINUE" : "DENY",
      taxable: true,
      inventoryItem: { tracked: true, sku: nv.sku, requiresShipping: true },
    };
    if (ev) v.id = ev.id;
    else if (p.locationId) v.inventoryQuantities = [{ locationId: p.locationId, name: "available", quantity: 0 }];
    variants.push(v);
  }
  if (reSkued) notes.push(`${reSkued} colour(s) moved to a new Stanley SKU - existing variant re-used`);
  if (preserved) notes.push(`${preserved} selling price(s) edited in Shopify - preserved until Stanley's USD price changes`);
  if (priceMoves) notes.push(`${priceMoves} variant price(s) recalculated`);
  if (pricesPaused) notes.push(`PRICE UPDATES PAUSED: ${[...prices.values()].find((x) => !x.ok)?.reason ?? "no valid price"} - existing prices left unchanged`);
  if (deferred) notes.push(`${deferred} new variant(s) not added until a valid price exists`);

  // variants already in Shopify but no longer listed by Stanley: kept (never deleted); ours become unorderable
  let dropped = 0;
  let manual = 0;
  for (const ev of e?.variants.nodes ?? []) {
    if (used.has(ev.id)) continue;
    const keep: Record<string, unknown> = { id: ev.id, optionValues: ev.selectedOptions.map((o) => ({ optionName: o.name, name: o.value })) };
    if (isOurs((ev.sku ?? "").toUpperCase())) { keep.inventoryPolicy = "DENY"; dropped++; } else manual++;
    variants.push(keep);
  }
  if (dropped) notes.push(`${dropped} variant(s) no longer listed by Stanley - kept as unavailable`);
  if (manual) notes.push(`kept ${manual} manually added variant(s) untouched`);
  const combos = variants.map((v) => (v.optionValues as { name: string }[]).map((o) => o.name.toLowerCase()).join("/"));
  const dup = combos.find((c, i) => combos.indexOf(c) !== i);
  if (dup) throw new PlanConflict(`two variants would share the option value "${dup}" - left for review`);
  const defaultTitle = variants.filter((v) => (v.optionValues as { optionName: string }[]).some((o) => o.optionName === "Title"));
  if (defaultTitle.length && variants.length > defaultTitle.length) throw new PlanConflict("existing product has a single default variant plus source colours - left for review");

  input.productOptions = [{
    name: optName, position: 1,
    values: [...new Set(variants.map((v) => (v.optionValues as { optionName: string; name: string }[]).find((o) => o.optionName === optName)?.name).filter(Boolean) as string[])].map((value) => ({ name: value })),
  }];
  input.variants = variants;

  // ---- images: only when Stanley's image set changed (or nothing uploaded yet). Photos already uploaded are referenced
  // by their Shopify media id, so they are never uploaded twice; manually added media is kept. ----
  let imagesSent: SPlan["imagesSent"] = null;
  if (!contentAllowed) {
    if (n.images.length) notes.push("images NOT uploaded: STANLEY_AUTHORIZED_IMPORTER is false");
  } else if (n.images.length && (create || !e.media.nodes.length || !row?.image_hash || row.image_hash !== n.hashes.image)) {
    const onProduct = new Set((e?.media.nodes ?? []).map((m) => m.id));
    const known = new Map(p.images.filter((i) => i.media_id && onProduct.has(i.media_id)).map((i) => [i.source_key, i.media_id!]));
    const ourIds = new Set(p.images.map((i) => i.media_id).filter(Boolean));
    const manualMedia = (e?.media.nodes ?? []).filter((m) => !ourIds.has(m.id));
    const room = Math.max(0, 250 - manualMedia.length);
    const mine = n.images.slice(0, room);
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

  // ---- metafields (stanley_sync.*) ----
  const mf = (k: string, value: string | number | null | undefined, type = "single_line_text_field") => (value == null || value === "" ? null : { namespace: SNS, key: k, type, value: String(value) });
  const ok = [...prices.values()].filter((x) => x.ok);
  const cheapest = [...ok].sort((a, b) => a.fsrPrice! - b.fsrPrice!)[0];
  const perVariant = n.variants.map((v) => {
    const pr = prices.get(v.sku);
    return {
      colour: v.colour, sku: v.sku, source_variant_id: v.sourceVariantId, source_product_id: v.sourceProductId, availability: v.availability,
      source_price_usd: pr?.sourcePriceUsd ?? v.currentUsd, source_regular_price_usd: pr?.sourceRegularPriceUsd ?? null, source_sale_price_usd: pr?.sourceSalePriceUsd ?? null,
      converted_price_inr: pr?.convertedPriceInr != null ? Math.round(pr.convertedPriceInr * 100) / 100 : null, fsr_selling_price: pr?.fsrPrice ?? null, fsr_compare_at_price: pr?.compareAtPrice ?? null,
    };
  });
  const metafields = [
    { namespace: SNS, key: "source_product_id", value: key }, // typed by its unique "id" definition
    mf("source_product_ids", JSON.stringify(n.sourceProductIds), "json"),
    mf("source_variant_id", n.variants.length === 1 ? n.variants[0].sourceVariantId : null),
    mf("source_variant_ids", JSON.stringify(Object.fromEntries(n.variants.map((v) => [v.sku, v.sourceVariantId]))), "json"),
    mf("source_url", n.sourceUrl, "url"),
    mf("canonical_url", n.canonicalUrl, "url"),
    mf("source_sku", n.skus.join(", ")),
    mf("category", n.category),
    mf("collection", n.collection),
    mf("capacity", n.capacity),
    mf("source_product_type", n.sourceProductType),
    mf("colours", JSON.stringify(n.variants.map((v) => v.colour)), "json"),
    mf("source_status", "active"),
    mf("source_availability", n.availability),
    mf("import_status", p.importStatus),
    mf("source_last_seen_at", p.nowIso, "date_time"),
    mf("source_last_synced_at", p.nowIso, "date_time"),
    mf("specifications", JSON.stringify(n.specs), "json"),
    mf("content_hash", n.hashes.content),
    mf("pricing_adjustment_inr", s.PRICING_ADJUSTMENT_INR, "number_decimal"),
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
