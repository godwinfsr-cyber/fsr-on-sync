// CoachItem -> Shopify productSet input: title / type / tags / description in the store's existing Coach format, one
// variant per size (UK sizes for shoes, store rule), prices from the pricing engine, coach_sync.* metafields, custom.eta.
import type { FxRate } from "../gymshark/fx.ts";
import { calculateMkPrice, roundPrice, type MkPrice } from "../michaelkors/pricing.ts";
import { escapeHtml } from "../util.ts";
import { CNS, type CoachSettings } from "./config.ts";
import type { CoachItem } from "./dedupe.ts";
import { isExcludedCoachProduct, isExcludedCoachWatch, type ExclusionResult } from "./exclusion.ts";

export const OOS_TAG = "auto-oos-hidden"; // the store's out-of-stock rule (same tag the other importers + the oos-hider use)

// ---------------- pricing ----------------

export interface CoachPrice extends MkPrice {
  sourceCurrentUsd: number | null;
}

/**
 * SOURCE USD (current selling price) -> x LIVE USD/INR -> + WEIGHT-BAND SHIPPING = LANDED -> + PROFIT BAND = FSR PRICE.
 * Compare-at = Coach's regular price x the same rate ONLY (no shipping, no profit), and only when it is above the FSR price.
 * Coach's cart / promo-code discounts are never applied (only the price the product page shows).
 */
export function priceVariant(currentUsd: number | null, regularUsd: number | null, currency: string | null, fx: Pick<FxRate, "ok" | "rate" | "base">, s: CoachSettings): CoachPrice {
  const regular = regularUsd != null && currentUsd != null && regularUsd > currentUsd ? regularUsd : null;
  const p = calculateMkPrice(
    { currentUsd, regularUsd: regular, currency, weightKg: null },
    fx,
    { SOURCE_PRICE_BASIS: "CURRENT_SELLING", COMPARE_AT_MODE: "NONE", WEIGHT_SURCHARGE_ENABLED: s.WEIGHT_SURCHARGE_ENABLED, WEIGHT_SURCHARGE_FALLBACK_INR: s.WEIGHT_SURCHARGE_FALLBACK_INR, WEIGHT_BANDS: s.WEIGHT_BANDS, PROFIT_BANDS: s.PROFIT_BANDS, PRICE_ROUNDING_MODE: s.PRICE_ROUNDING_MODE },
  );
  let compareAtPrice: number | null = null;
  if (p.ok && regular != null && fx.rate) {
    const c = roundPrice(regular * fx.rate, s.PRICE_ROUNDING_MODE);
    if (c > p.fsrPrice!) compareAtPrice = c;
  }
  return { ...p, compareAtPrice, sourceRegularPriceUsd: regular ?? currentUsd, sourceCurrentUsd: currentUsd };
}

// ---------------- classification ----------------

// same rules the store's nav-tools/classify2.mjs uses for the existing Coach products (headword of the name)
const TYPE_RULES: [string, RegExp][] = [
  ["Accessories", /(belt set|jewelry box|charm|strap|extender|key ring|keychain|kit|notebook|sunglass case|hat|cap|beanie|headband|earmuffs|muffler|scarf|wrap|stole|cape|poncho|belt|glove|bandana|umbrella|socks?|lanyard|tray)$/],
  ["Jewelry", /(ring set|earring set|bracelet|necklace|earrings?|ring|pendant|bangle|brooch|anklet)$/],
  ["Sneakers", /(sneaker|runner|trainer)s?$/],
  ["Shoes", /(clog|slide|sandal|mary jane|loafer|mule|derby|flip flop|slingback|lug sole|boot|bootie|heel|espadrille|flat|ballet|pump|slipper|oxford)s?$/],
  ["Wallets", /(wallet gift set|wallet|wristlet|card case|card holder|coin case|id case|billfold)$/],
  ["Eyewear", /(sunglasses|eyeglasses|glasses|optical)$/],
  ["Bags", /(bag|tote|crossbody|pouch|pack|brief|backpack|clutch|satchel|hobo|carry on|duffle|duffel|messenger|sling|bucket|carryall|briefcase|holdall)$/],
  ["Apparel", /(trench|trench coat|t-shirt|tee|shirt|hoodie|jacket|jeans|trunks|coat|dress|skirt|pants?|shorts?|cardigan|sweater|sweatshirt|top|blazer|vest|polo|windbreaker|bomber|parka|jumpsuit|leggings|bra|tank|pullover|anorak|puffer|blouse|crewneck|button down|button up|racer|knit|jumper|overshirt)$/],
];
const CLASS_TYPE: [RegExp, string][] = [
  [/sneaker/i, "Sneakers"], [/shoe|boot|sandal/i, "Shoes"], [/wallet|small leather/i, "Wallets"], [/bag/i, "Bags"], [/eyewear|sunglass/i, "Eyewear"],
  [/jewel/i, "Jewelry"], [/ready to wear|apparel|clothing|outerwear/i, "Apparel"], [/accessor/i, "Accessories"],
];
export function headword(name: string): string {
  return name.replace(/^coach\s+/i, "").split(/\s+(?:In|With|For)\s+/i)[0].replace(/\s+\d+$/, "").trim().toLowerCase();
}
export function productTypeOf(item: Pick<CoachItem, "name" | "subcategory" | "category">): string {
  const h = headword(item.name);
  for (const [t, re] of TYPE_RULES) if (re.test(h)) return t;
  for (const [re, t] of CLASS_TYPE) if (re.test(item.subcategory ?? "") || re.test(item.category ?? "")) return t;
  return "Accessories";
}
export const isShoe = (item: Pick<CoachItem, "name" | "subcategory" | "category">, type = productTypeOf(item)) => type === "Shoes" || type === "Sneakers" || /shoe/i.test(item.subcategory ?? "");

// ---------------- sizes ----------------

const US_TO_UK: Record<string, number> = { Women: 2, Men: 0.5 };
/** Shoe size label as sold on FSR (UK). null = cannot be converted without guessing (gender / format unknown). */
export function ukShoeSize(us: string, gender: string | null): string | null {
  const n = Number(us);
  const off = gender ? US_TO_UK[gender] : undefined;
  if (!Number.isFinite(n) || off == null) return null;
  const uk = n - off;
  return uk > 0 ? String(uk) : null;
}

// ---------------- product input ----------------

export interface BuiltProduct {
  input: Record<string, unknown>;
  title: string;
  handle: string;
  productType: string;
  status: "ACTIVE" | "DRAFT";
  prices: CoachPrice[];
  cheapest: CoachPrice | null;
  variantCount: number;
  imageCount: number;
  notes: string[];
}

export class NotImportable extends Error {
  status: "watch_excluded" | "skipped" | "needs_review" | "pricing_error";
  constructor(status: NotImportable["status"], msg: string) { super(msg); this.status = status; }
}

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\w\s/-]/g, "").replace(/[\s_/]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
const genderLabel = (g: string | null) => (g === "Women" ? "Women's" : g === "Men" ? "Men's" : g === "Unisex" ? "Unisex" : null);
const money = (v: number | null | undefined) => (v == null ? null : v.toFixed(2));

export function titleOf(item: Pick<CoachItem, "name" | "colourName" | "gender">): string {
  const g = genderLabel(item.gender);
  const name = /^coach/i.test(item.name) ? item.name.replace(/^coach/i, "Coach") : `Coach ${item.name}`; // "Coach Square Sunglasses"
  return `${name} - ${item.colourName}${g ? ` (${g})` : ""}`;
}

export function exclusionOf(item: CoachItem, s: CoachSettings, productType?: string): ExclusionResult {
  return isExcludedCoachProduct({
    title: item.name, category: item.category, subcategory: item.subcategory, filterCategory: item.filterCategory, categoryId: item.categoryId,
    breadcrumbs: item.breadcrumbs, productType, url: item.sourceUrls[0], canonicalUrl: item.canonicalUrl, finalUrl: item.finalUrl,
    description: [item.descriptionText, ...item.details].join(" "),
  }, { excludedCategories: s.EXCLUDED_CATEGORIES.split(","), includeRestored: s.INCLUDE_RESTORED });
}

/** Builds the productSet input. Throws NotImportable when the product must not be created. */
export function buildProduct(item: CoachItem, images: { url: string; alt: string }[], fx: FxRate, s: CoachSettings, nowIso: string, locationId: string | null): BuiltProduct {
  const productType = productTypeOf(item);
  // FINAL SAFETY CHECK: nothing (product, variant, image) is built for an excluded product
  const ex = exclusionOf(item, s, productType);
  if (ex.excluded) throw new NotImportable(ex.status!, ex.reason!);
  if (isExcludedCoachWatch({ title: item.name, productType, url: item.sourceUrls.join(" ") }).excluded) throw new NotImportable("watch_excluded", "watch");
  if (!item.colourName) throw new NotImportable("needs_review", "colour name not published on the page - not created (never invented)");
  if (!item.variants.length) throw new NotImportable("needs_review", "no variants on the page");
  if (!fx.ok || !fx.rate) throw new NotImportable("pricing_error", fx.reason ?? "no valid exchange rate");
  const notes: string[] = [];
  const shoe = isShoe(item, productType);
  const title = titleOf(item);
  const handle = slugify(`coach ${item.name} ${item.colourName} ${item.key}`);

  // ---- variants ----
  const sized = item.variants.filter((v) => v.size);
  const widths = new Set(sized.map((v) => v.width).filter(Boolean));
  const variants: Record<string, unknown>[] = [];
  const prices: CoachPrice[] = [];
  const seen = new Set<string>();
  const ordered = [...item.variants].sort((a, b) => sizeOrder(a.size) - sizeOrder(b.size) || String(a.width).localeCompare(String(b.width)));
  for (const v of ordered) {
    let label: string | null = null;
    if (v.size) {
      if (shoe && s.SIZE_SYSTEM === "UK") {
        const uk = ukShoeSize(v.size, item.gender);
        if (uk == null) throw new NotImportable("needs_review", `shoe size ${v.size} (${item.gender ?? "no gender"}) cannot be converted to UK without guessing`);
        label = uk;
      } else label = v.size;
      if (widths.size > 1 && v.width) label += ` (${v.width})`;
    }
    const optionName = label == null ? "Title" : "Size";
    const optionValue = label ?? "Default Title";
    if (seen.has(optionValue)) { notes.push(`duplicate size ${optionValue} skipped`); continue; }
    seen.add(optionValue);
    const price = priceVariant(v.priceUsd, item.regularUsd, v.currency, fx, s);
    if (!price.ok) throw new NotImportable("pricing_error", `${v.sourceSku}: ${price.reason}`);
    prices.push(price);
    const sku = label == null ? item.key : `${item.key}-${label.replace(/\s+/g, "")}`;
    const gtin = v.gtin?.replace(/\D/g, "").replace(/^0+(?=\d{12,13}$)/, "") ?? null;
    variants.push({
      optionValues: [{ optionName, name: optionValue }],
      sku,
      ...(gtin && /^\d{8,14}$/.test(gtin) ? { barcode: gtin } : {}),
      price: money(price.fsrPrice),
      compareAtPrice: money(price.compareAtPrice),
      inventoryPolicy: v.inStock ? "CONTINUE" : "DENY", // no FSR stock is held: orderable while Coach has it (ETA 15-20 days)
      taxable: true,
      inventoryItem: { tracked: true, sku, requiresShipping: true },
      ...(locationId ? { inventoryQuantities: [{ locationId, name: "available", quantity: 0 }] } : {}),
    });
  }
  const optionName = (variants[0].optionValues as { optionName: string }[])[0].optionName;
  if (variants.some((v) => (v.optionValues as { optionName: string }[])[0].optionName !== optionName)) throw new NotImportable("needs_review", "mix of sized and one-size variants");
  const available = item.variants.some((v) => v.inStock);
  const status: "ACTIVE" | "DRAFT" = available ? s.NEW_PRODUCT_STATUS : "DRAFT";
  const cheapest = [...prices].sort((a, b) => a.fsrPrice! - b.fsrPrice!)[0] ?? null;

  // ---- text (existing Coach template in this store) ----
  const g = genderLabel(item.gender);
  const bulletsHtml = item.features.length ? `<ul>${item.features.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>` : "";
  const descriptionHtml = [
    item.descriptionText ? `<p>${escapeHtml(item.descriptionText)}</p>` : "",
    bulletsHtml,
    item.material ? `<p>Material: ${escapeHtml(item.material)}</p>` : "",
    `<p><strong>SKU - ${escapeHtml(item.key)}</strong></p>`,
    shoe ? `<p><strong>NOTE:</strong> Sizes are UK sizing${item.gender === "Women" ? " (women's UK = US − 2)" : item.gender === "Men" ? " (men's UK = US − 0.5)" : ""}.</p>` : "",
    `<p><strong>ETA:</strong> ${escapeHtml(s.DEFAULT_ETA)}</p>`,
    "<p><strong>Disclaimer:</strong> Product images are for reference only. The actual product may vary slightly in color, texture, or details due to lighting, photography angles, or display settings.</p>",
  ].join("");
  const plain = item.descriptionText ?? item.features.join(". ");
  const seo = { title, description: `${title}. ${plain}`.slice(0, 320) };

  const tags = new Set([
    ...s.BASE_TAGS.split(",").map((t) => t.trim()).filter(Boolean), productType, ...(item.gender ? [item.gender] : []),
    ...(item.filterCategory ? [titleCase(item.filterCategory)] : []), ...(item.onOutlet ? ["Coach Outlet"] : []), ...(item.onMainline ? ["Coach Mainline"] : []),
    ...(!available ? [OOS_TAG] : []),
  ]);
  if (!available) notes.push("every size sold out at Coach - created as DRAFT (store out-of-stock rule)");

  // ---- metafields ----
  const mf = (key: string, value: string | number | null | undefined, type = "single_line_text_field") => (value == null || value === "" ? null : { namespace: CNS, key, type, value: String(value) });
  const w = cheapest?.weight;
  const metafields = [
    // keys the store's existing Coach products already use (same types) - the Shopify-side duplicate check reads these
    mf("source_product_id", item.key), mf("source_sku", item.key), mf("source_style_code", item.style),
    mf("source_url", item.canonicalUrl ?? item.sourceUrls[0]), mf("source_price", cheapest?.sourceCurrentUsd), mf("source_list_price", item.regularUsd),
    mf("source_currency", "USD"), mf("source_status", available ? "available" : "sold_out"),
    mf("source_last_seen_at", nowIso), mf("source_last_synced_at", nowIso),
    // importer metafields
    mf("source_mainline_url", item.mainlineUrls[0]), mf("source_outlet_url", item.outletUrls[0]), mf("canonical_url", item.canonicalUrl),
    mf("source_style_number", item.style), mf("source_model_number", null), mf("source_reference_number", item.key),
    mf("source_gtins", JSON.stringify([...new Set(item.variants.map((v) => v.gtin).filter(Boolean))]), "json"),
    mf("source_variant_ids", JSON.stringify(item.variants.map((v) => v.sourceSku)), "json"),
    mf("source_regular_price_usd", money(cheapest?.sourceRegularPriceUsd), "number_decimal"),
    mf("source_sale_price_usd", money(cheapest?.sourceSalePriceUsd), "number_decimal"),
    mf("source_price_usd", money(cheapest?.sourcePriceUsd), "number_decimal"),
    mf("exchange_rate", fx.rate, "number_decimal"), mf("exchange_rate_provider", fx.provider), mf("exchange_rate_timestamp", fx.fetchedAt, "date_time"),
    mf("converted_price_inr", money(cheapest?.convertedPriceInr), "number_decimal"),
    mf("source_weight_kg", null, "number_decimal"), mf("shipping_adjustment_inr", w?.surchargeInr, "number_decimal"), mf("shipping_reason", w?.reason),
    mf("landed_cost_inr", money(cheapest?.landedCostInr), "number_decimal"), mf("profit_adjustment_inr", cheapest?.profitInr, "number_decimal"),
    mf("fsr_selling_price", money(cheapest?.fsrPrice), "number_decimal"),
    mf("category", item.category), mf("subcategory", item.subcategory), mf("collection", item.collection), mf("gender", item.gender),
    mf("color", item.colourName), mf("color_code", item.colourCode), mf("material", item.material), mf("dimensions", item.dimensions),
    mf("source_reach", item.onMainline && item.onOutlet ? "mainline+outlet" : item.onOutlet ? "outlet" : "mainline"),
    mf("import_status", "imported"), mf("imported_at", nowIso, "date_time"), mf("importer", "fsr-coach-import (one-time, cloud)"),
    mf("authorization", "Official Authorized Importer (India) - Full Size Run"),
    { namespace: "custom", key: "eta", type: "single_line_text_field", value: s.DEFAULT_ETA },
  ].filter(Boolean) as Record<string, string>[];

  const input: Record<string, unknown> = {
    title, handle, descriptionHtml, vendor: s.VENDOR, productType, status, tags: [...tags].sort(), seo,
    productOptions: [{ name: optionName, position: 1, values: variants.map((v) => ({ name: (v.optionValues as { name: string }[])[0].name })) }],
    variants, metafields,
    files: images.map((im) => ({ originalSource: im.url, contentType: "IMAGE", alt: im.alt })),
  };
  if (!images.length) notes.push("no product images found");
  if (g == null) notes.push("gender not published - no gender in title");
  return { input, title, handle, productType, status, prices, cheapest, variantCount: variants.length, imageCount: images.length, notes };
}

const APPAREL = ["XXS", "XS", "XS/S", "S", "S/M", "M", "M/L", "L", "L/XL", "XL", "XXL", "2XL", "3XL"];
function sizeOrder(size: string | null): number {
  if (!size) return 0;
  const n = Number(size);
  if (Number.isFinite(n)) return n;
  const i = APPAREL.indexOf(size.toUpperCase());
  return i >= 0 ? 100 + i : 1000;
}
