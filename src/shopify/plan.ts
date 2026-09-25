import type { Settings } from "../config.ts";
import type { ProductRow } from "../db.ts";
import type { NormalizedProduct } from "../normalize.ts";
import type { PriceResult } from "../pricing.ts";
import { escapeHtml, hash } from "../util.ts";
import { NS, type ShopifyProduct } from "./ops.ts";

export const OOS_TAG = "auto-oos-hidden"; // same tag the existing fullsizerun-oos-hider task uses

export interface PlanInput {
  n: NormalizedProduct;
  existing: ShopifyProduct | null;   // current Shopify state (null = create)
  row: ProductRow | undefined;       // what this system last wrote
  settings: Settings;
  price: PriceResult;
  locationId: string | null;
  contentAllowed: boolean;           // CONTENT_REUSE_CONFIRMED: may we copy ON images/description text?
  nowIso: string;
}

export interface Plan {
  action: "create" | "update";
  input: Record<string, unknown>;
  notes: string[];                   // human-readable explanation of each decision
  metafields: Record<string, string>[]; // for updates: apply with metafieldsSet (merge semantics)
  written: { title: string; descHash: string; seoHash: string; eta: string | null; price: string | null; imagesWritten: boolean };
}

const money = (v: number | null) => (v == null ? null : v.toFixed(2));
export const seoHash = (seo: { title: string | null; description: string | null }) => hash([seo.title ?? "", seo.description ?? ""]);

/** Description without ON's copyrighted text, used until content reuse is confirmed. */
function descriptionFor(n: NormalizedProduct, contentAllowed: boolean): string {
  if (contentAllowed) return n.descriptionHtml;
  return n.descriptionHtml.replace(`<p>${escapeHtml(n.sourceDescription ?? "")}</p><p> </p>`, "");
}

/**
 * Decides exactly what to send to Shopify's productSet for one product.
 * Source-controlled: sizes/variants, variant SKUs, availability, source metafields, source images.
 * FSR-controlled (only written on create, or later if still equal to what we last wrote, i.e. never
 * manually edited): title, description, SEO, ETA, selling price. Manual tags are always kept.
 */
export function buildPlan(p: PlanInput): Plan {
  const { n, existing: e, settings: s, price } = p;
  // A product this sync created (it carries our source-id metafield) but that has no local row yet
  // (e.g. database rebuilt): its current Shopify values ARE what we wrote, so use them as the baseline.
  let row = p.row;
  if (!row && e?.sourceId?.value === n.sourceProductId) {
    row = {
      written_title: e.title, written_desc_hash: hash(e.descriptionHtml), written_seo_hash: seoHash(e.seo), written_eta: e.eta?.value ?? null,
      written_price: e.variants.nodes[0]?.price ?? null, image_hash: e.media.nodes.length ? n.hashes.image : null, last_sync_status: "linked", missing_scans: 0,
    } as ProductRow;
  }
  const notes: string[] = [];
  const input: Record<string, unknown> = {};
  const create = !e;
  const anyAvailable = n.sizes.some((z) => z.available);
  const desc = descriptionFor(n, p.contentAllowed);
  // SEO defaults also quote ON's text, so they fall under the same content gate.
  const seo = { title: n.seoTitle, description: p.contentAllowed ? n.seoDescription : `${n.title}. Shop On shoes at Full Size Run.` };

  // ---- content fields ----
  let writtenTitle = row?.written_title ?? "";
  let writtenDescHash = row?.written_desc_hash ?? "";
  let writtenSeoHash = row?.written_seo_hash ?? "";
  if (create) {
    Object.assign(input, { title: n.title, descriptionHtml: desc, vendor: s.VENDOR, productType: s.PRODUCT_TYPE, seo });
    writtenTitle = n.title; writtenDescHash = hash(desc); writtenSeoHash = seoHash(seo);
  } else {
    if (e.title !== n.title) {
      if (row?.written_title && e.title === row.written_title) { input.title = n.title; writtenTitle = n.title; notes.push(`title: "${e.title}" -> "${n.title}"`); }
      else notes.push("title differs from source but was edited in Shopify - preserved");
    }
    if (hash(e.descriptionHtml) !== hash(desc)) {
      if (row?.written_desc_hash && hash(e.descriptionHtml) === row.written_desc_hash) { input.descriptionHtml = desc; writtenDescHash = hash(desc); notes.push("description updated from source"); }
      else notes.push("description edited in Shopify - preserved");
    }
    // vendor / product type drive the store's smart collections, so they follow the configured mapping
    if (e.vendor !== s.VENDOR) { input.vendor = s.VENDOR; notes.push(`vendor: "${e.vendor}" -> "${s.VENDOR}"`); }
    if (e.productType !== s.PRODUCT_TYPE) { input.productType = s.PRODUCT_TYPE; notes.push(`product type: "${e.productType}" -> "${s.PRODUCT_TYPE}"`); }
    const newSeo = seo;
    if (seoHash(e.seo) !== seoHash(newSeo)) {
      if (row?.written_seo_hash && seoHash(e.seo) === row.written_seo_hash) { input.seo = newSeo; writtenSeoHash = seoHash(newSeo); notes.push("SEO defaults refreshed"); }
      else notes.push("SEO customised in Shopify - preserved");
    }
  }

  // ---- tags: never remove manual tags; never add Instant Ship to ETA products ----
  const baseTags = new Set([...(e?.tags ?? []), ...n.tags].filter((t) => t !== "Instant Ship"));
  // ---- status: honour the store's "out of stock -> hidden" policy using the oos-hider's tag ----
  if (create) {
    input.status = anyAvailable ? s.NEW_PRODUCT_STATUS : "DRAFT";
    if (!anyAvailable) { baseTags.add(OOS_TAG); notes.push("no sizes available at source - created as DRAFT"); }
  } else if (!anyAvailable && e.status === "ACTIVE") {
    input.status = "DRAFT"; baseTags.add(OOS_TAG); notes.push("all sizes unavailable - hidden (DRAFT + auto-oos-hidden)");
  } else if (anyAvailable && e.status === "DRAFT" && e.tags.includes(OOS_TAG)) {
    input.status = "ACTIVE"; baseTags.delete(OOS_TAG); notes.push("sizes back in stock - restored to ACTIVE");
  } else if (anyAvailable && e.status === "ARCHIVED" && row?.last_sync_status === "archived") {
    input.status = "ACTIVE"; notes.push("product reappeared on source - un-archived");
  }
  const tags = [...baseTags].sort();
  if (create || tags.join("|") !== [...e.tags].sort().join("|")) input.tags = tags;

  // ---- variants (one per size, exact source label) ----
  const sizeOf = (v: ShopifyProduct["variants"]["nodes"][number]) => v.selectedOptions.find((o) => o.name === s.SIZE_OPTION_NAME)?.value ?? v.selectedOptions[0]?.value;
  const existingBySize = new Map((e?.variants.nodes ?? []).map((v) => [sizeOf(v), v]));
  const existingBySku = new Map((e?.variants.nodes ?? []).filter((v) => v.sku).map((v) => [v.sku!.toUpperCase(), v]));
  const matchedIds = new Set<string>();
  // Same size variant: its current SKU, else current storefront label, else the SKU it was created with
  // (e.g. "<sku>-9" from before the US->UK switch) - so relabelling reuses variants instead of duplicating.
  const findExisting = (z: NormalizedProduct["sizes"][number]) => {
    const cands = [existingBySku.get(z.variantSku.toUpperCase()), existingBySize.get(z.label), existingBySku.get(`${n.sourceSku}-${z.sourceLabel}`.toUpperCase())];
    return cands.find((v) => v && !matchedIds.has(v.id));
  };
  const manualPrice = !create && row?.written_price != null;
  let writtenPrice: string | null = row?.written_price ?? null;
  const targetPrice = money(price.price);
  const targetCompare = money(price.compareAtPrice);
  let priceOverrides = 0;
  const ours0 = new Set(n.sizes.map((z) => z.label));
  const variants: Record<string, unknown>[] = n.sizes.map((z, i) => {
    const ev = findExisting(z);
    if (ev) matchedIds.add(ev.id);
    let vPrice = targetPrice;
    let vCompare = targetCompare;
    if (ev && manualPrice && ev.price !== row!.written_price) { vPrice = ev.price; vCompare = ev.compareAtPrice; priceOverrides++; }
    const v: Record<string, unknown> = {
      optionValues: [{ optionName: s.SIZE_OPTION_NAME, name: z.label }],
      sku: z.variantSku,
      price: vPrice,
      compareAtPrice: vCompare,
      inventoryPolicy: z.available ? "CONTINUE" : "DENY",
      position: i + 1,
      inventoryItem: { tracked: true, sku: z.variantSku, ...(n.countryCode ? { countryCodeOfOrigin: n.countryCode } : {}) },
    };
    if (ev) v.id = ev.id;
    else if (p.locationId) v.inventoryQuantities = [{ locationId: p.locationId, name: "available", quantity: 0 }];
    return v;
  });
  if (priceOverrides) notes.push(`${priceOverrides} variant price(s) edited in Shopify - preserved`);
  else writtenPrice = targetPrice;
  const relabelled = n.sizes.filter((z) => { const v = e?.variants.nodes.find((x) => x.sku?.toUpperCase() === `${n.sourceSku}-${z.sourceLabel}`.toUpperCase()); return v && matchedIds.has(v.id) && sizeOf(v) !== z.label; }).length;
  if (relabelled) notes.push(`${relabelled} size(s) relabelled to ${s.SIZE_SYSTEM} sizing (same variants, no duplicates)`);
  // variants that exist in Shopify but not in our size list were added manually: keep them untouched
  const ours = ours0;
  for (const ev of e?.variants.nodes ?? []) {
    const label = sizeOf(ev);
    if (!matchedIds.has(ev.id) && label && !ours.has(label)) {
      variants.push({ id: ev.id, optionValues: [{ optionName: s.SIZE_OPTION_NAME, name: label }] });
      notes.push(`kept manually added variant "${label}"`);
    }
  }
  input.productOptions = [{ name: s.SIZE_OPTION_NAME, position: 1, values: variants.map((v) => ({ name: (v.optionValues as { name: string }[])[0].name })) }];
  input.variants = variants;

  // ---- images: upload only when new or changed, and only once content reuse is confirmed ----
  let imagesWritten = false;
  if (!p.contentAllowed) {
    if (n.images.length) notes.push("images NOT uploaded: CONTENT_REUSE_CONFIRMED is false");
  } else if (n.images.length && (create || !e?.media.nodes.length || (row ? row.image_hash !== n.hashes.image : false))) {
    // (no local row but media already present = product created earlier, e.g. the live test; keep its media)
    input.files = n.images.map((url, i) => ({ originalSource: url, contentType: "IMAGE", alt: `${n.imageAlt} - ${i + 1}` }));
    imagesWritten = true;
    if (!create) notes.push(`media replaced with ${n.images.length} current source image(s)`);
  }

  // ---- metafields ----
  const mf = (key: string, value: string | null, type = "single_line_text_field") => (value == null || value === "" ? null : { namespace: NS, key, type, value });
  const metafields: (Record<string, string> | null)[] = [
    // the custom-ID metafield must be sent without a type (its "id" definition supplies it)
    { namespace: NS, key: "source_product_id", value: n.sourceProductId },
    mf("source_url", n.sourceUrl, "url"),
    mf("source_sku", n.sourceSku),
    mf("source_style_code", n.styleCode),
    mf("source_last_synced_at", p.nowIso, "date_time"),
    mf("source_last_seen_at", p.nowIso, "date_time"),
    mf("source_price", n.price != null ? String(n.price) : null, "number_decimal"),
    mf("source_list_price", n.listPrice != null ? String(n.listPrice) : null, "number_decimal"),
    mf("source_currency", n.currency),
    mf("source_status", anyAvailable ? "available" : "unavailable"),
    mf("source_hash", hash(n.hashes)),
    mf("materials", n.materials),
    mf("country_of_origin", n.countryOfOrigin),
  ].filter(Boolean) as Record<string, string>[];
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
  // productSet REPLACES the whole metafield list (omitted ones are deleted - verified live), so metafields
  // only travel inside productSet on create. Updates send them via metafieldsSet, which merges.
  const mfList = metafields.filter(Boolean) as Record<string, string>[];
  if (create) input.metafields = mfList;

  return {
    action: create ? "create" : "update",
    input,
    notes,
    metafields: create ? [] : mfList,
    written: { title: writtenTitle, descHash: writtenDescHash, seoHash: writtenSeoHash, eta: writtenEta, price: writtenPrice, imagesWritten },
  };
}
