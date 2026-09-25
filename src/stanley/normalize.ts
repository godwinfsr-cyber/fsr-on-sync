import { cleanDescription, clip } from "../gymshark/normalize.ts";
import { escapeHtml, hash } from "../util.ts";
import { STANLEY_SOURCE, list, parseMap, type StanleySettings } from "./config.ts";
import { imageKey, type PageDetail, type StanleyRawProduct, type StanleyRawVariant } from "./source.ts";

export type Availability = "in_stock" | "out_of_stock";
export const SELLABLE: Availability[] = ["in_stock"];

// ---------- catalog -> FSR products ----------
//
// Stanley lists every seasonal drop of a product as its own listing ("The Quencher ProTour Flip Straw Tumbler | 40 OZ"
// exists as the evergreen listing plus Back-to-School, Mother's Day, Picnic ... listings), and shows them together as
// colour swatches. Listings with the same normalised title are therefore ONE FSR product with Color variants.
// Different capacities are different Stanley products (the capacity is part of the title) and stay separate.

export interface ProductGroup { titleKey: string; listings: StanleyRawProduct[]; foreignSkus?: Set<string> }
export interface Grouping { groups: ProductGroup[]; excluded: Record<string, number>; invalid: { handle: string; reason: string }[] }

type GroupSettings = Pick<StanleySettings, "EXCLUDED_PRODUCT_TYPES" | "EXCLUDED_TAGS" | "EXCLUDED_TITLE_PATTERNS">;

/** "The Quencher® ProTour Flip Straw Tumbler | 30 OZ - Stanley Create" -> "the quencher protour flip straw tumbler 30 oz" */
export function titleKeyOf(title: string): string {
  return title.toLowerCase()
    .replace(/[®™©]/g, "")
    .replace(/\s*-\s*stanley create\s*$/i, "")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/(^|\s)\.|\.(\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const num = (v: string | null | undefined) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const skuOf = (v: StanleyRawVariant) => (v.sku ?? "").trim().toUpperCase();

export function exclusionReason(p: StanleyRawProduct, s: GroupSettings): string | null {
  if (list(s.EXCLUDED_PRODUCT_TYPES).map((x) => x.toLowerCase()).includes(p.product_type.trim().toLowerCase())) return `product type "${p.product_type}"`;
  const tags = new Set(list(s.EXCLUDED_TAGS).map((x) => x.toLowerCase()));
  const hit = p.tags.find((t) => tags.has(t.toLowerCase()));
  if (hit) return `tag "${hit}"`;
  const pat = list(s.EXCLUDED_TITLE_PATTERNS).find((x) => p.title.toLowerCase().includes(x.toLowerCase()));
  if (pat) return `title contains "${pat}"`;
  if (!p.variants.length) return "no variants";
  if (!p.variants.some((v) => (num(v.price) ?? 0) > 0)) return "free / promotional item (price $0)";
  if (!p.variants.some((v) => skuOf(v))) return "no SKU on any variant";
  return null;
}

export function groupStanleyCatalog(products: StanleyRawProduct[], s: GroupSettings): Grouping {
  const excluded: Record<string, number> = {};
  const invalid: Grouping["invalid"] = [];
  const byTitle = new Map<string, StanleyRawProduct[]>();
  for (const p of products) {
    const why = exclusionReason(p, s);
    if (why) { excluded[why] = (excluded[why] ?? 0) + 1; continue; }
    const key = titleKeyOf(p.title);
    if (!key) { invalid.push({ handle: p.handle, reason: "missing product title" }); continue; }
    const arr = byTitle.get(key) ?? [];
    arr.push(p);
    byTitle.set(key, arr);
  }
  // primary listing first: the evergreen listing (most colours), then oldest id - deterministic
  const all = [...byTitle.entries()].map(([titleKey, listings]) => ({ titleKey, listings: listings.sort((a, b) => b.variants.length - a.variants.length || a.id - b.id) }));
  // every SKU belongs to exactly one FSR product (Stanley occasionally lists one SKU under two titles)
  const owner = new Map<string, string>();
  for (const g of all) for (const p of g.listings) for (const v of p.variants) { const k = skuOf(v); if (k && !owner.has(k)) owner.set(k, g.titleKey); }
  const groups: ProductGroup[] = [];
  for (const g of all) {
    const skus = g.listings.flatMap((p) => p.variants.map(skuOf).filter(Boolean));
    const foreign = new Set(skus.filter((k) => owner.get(k) !== g.titleKey));
    if (skus.length && foreign.size === new Set(skus).size) { const why = "every SKU already listed under another product"; excluded[why] = (excluded[why] ?? 0) + g.listings.length; continue; }
    groups.push(foreign.size ? { ...g, foreignSkus: foreign } : g);
  }
  return { groups, excluded, invalid };
}

// ---------- group -> FSR product ----------

export interface NormalizedVariant {
  sku: string;                   // Stanley variant SKU, kept as-is (e.g. 100000147719)
  sourceVariantId: string;
  sourceProductId: string;       // Stanley listing (product) id the variant comes from
  colour: string;                // option value ("Default Title" for single-variant products)
  barcode: string | null;
  weight: string | null;
  availability: Availability;
  currentUsd: number | null;     // Stanley's current selling price
  regularUsd: number | null;     // compare-at when on sale, else the current price
  imageKey: string | null;       // Stanley's own variant photo
}

export interface NormalizedColour { colour: string; sourceProductId: string; handle: string; url: string; availability: Availability; minUsd: number | null }

export interface NormalizedProduct {
  titleKey: string;
  primaryProductId: string;      // Stanley id of the primary listing (becomes the FSR key when first seen)
  sourceProductIds: Record<string, string>; // handle -> Stanley product id
  sourceUrl: string;
  canonicalUrl: string;
  handles: string[];
  name: string;                  // Stanley's title
  title: string;                 // FSR title
  category: string | null;
  collection: string | null;
  capacity: string | null;
  sourceProductType: string;
  productType: string;
  colours: NormalizedColour[];
  variants: NormalizedVariant[];
  hasColourOption: boolean;
  specs: Record<string, string>;
  descriptionHtml: string;
  factsHtml: string;             // without Stanley's text (used when AUTHORIZED_IMPORTER=false)
  seoTitle: string;
  seoDescription: string;
  images: { key: string; url: string; alt: string; colour: string }[];
  imagesSkipped: number;         // photos of colours Stanley no longer sells, or over the caps
  tags: string[];
  skus: string[];
  availability: Availability;
  sourceUpdatedAt: string | null;
  duplicatesSkipped: number;
  missing: string[];
  hashes: { content: string; image: string; specification: string; price: string; variant: string; availability: string };
}

export interface ProductDetails { barcodes: Record<string, string>; weights: Record<string, string>; page: PageDetail | null }

type NormSettings = Pick<StanleySettings, "TITLE_TEMPLATE" | "BASE_TAGS" | "PRODUCT_TYPE_MAP" | "DEFAULT_PRODUCT_TYPE" | "VENDOR">;

const DISCLAIMER =
  "<p><strong>Disclaimer:</strong> Product images are for reference only. The actual product may vary slightly in color, texture, or details due to lighting, photography angles, or display settings.</p>";
const MAX_MEDIA = 250;               // Shopify's per-product media limit
const MAX_IMAGES_PER_COLOUR = 6;
const MAX_GENERAL_IMAGES = 6;        // lifestyle / detail shots not tied to one colour
const slug = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/['’®™]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const relaxed = (s: string) => compact(s).replace(/20(?=[a-z]|$)/g, ""); // "Black 2.0 Fade" ~ "Black Fade"
// Stanley boilerplate that is store policy, not product information (and wrong on a reseller's page)
const POLICY_LINE = /<p>(?:(?!<\/p>).)*not eligible for promotions or resell(?:(?!<\/p>).)*<\/p>/gis;

function colourOptionPos(p: StanleyRawProduct): number | null {
  const o = p.options.find((x) => /^colou?r$/i.test(x.name.trim()));
  return o ? o.position : null;
}
const optVal = (v: StanleyRawVariant, pos: number) => ((pos === 1 ? v.option1 : pos === 2 ? v.option2 : v.option3) ?? "").trim();

/** Which current colour a Stanley photo shows: its variant link, else a "-Colour-" segment of the file name. */
export function imageColour(src: string, variantColour: string | null, colours: string[]): string | null | "retired" {
  if (variantColour) return variantColour;
  const file = decodeURIComponent(src.split("?")[0].split("/").pop() ?? "").replace(/\.(png|jpe?g|webp)$/i, "");
  const segs = file.split(/-/).map((x) => x.replace(/_/g, " ").trim()).filter(Boolean);
  for (const seg of segs) { const c = colours.find((col) => compact(col) === compact(seg)); if (c) return c; }
  for (const seg of segs) { const c = colours.find((col) => relaxed(col) === relaxed(seg)); if (c) return c; }
  // "Web_PNG_Square-<Product>-<Colour>-<Shot>": a colour shot of a colour not (or no longer) sold
  if (/^web[ _]png[ _]square/i.test(file) && segs.length >= 3) return "retired";
  return null; // general lifestyle / detail shot
}

/** Stanley's product type, then its category breadcrumb (most specific first). Merchandising tags are too noisy
 * ("Camp Cookware" sits on tumblers) and are not used. */
export function productTypeOf(p: StanleyRawProduct, breadcrumb: string[], s: Pick<StanleySettings, "PRODUCT_TYPE_MAP" | "DEFAULT_PRODUCT_TYPE">): string {
  const map = parseMap(s.PRODUCT_TYPE_MAP);
  for (const k of [p.product_type, ...[...breadcrumb].reverse()].map((x) => x.trim().toLowerCase())) if (map[k]) return map[k];
  return s.DEFAULT_PRODUCT_TYPE;
}

export function capacityOf(title: string, specs: Record<string, string>): string | null {
  if (specs.Capacity) return specs.Capacity;
  const m = title.match(/\b(\d+(?:\.\d+)?\s?(?:OZ|QT|L|Cups?|Can))\b(?:\s*\|\s*(\d+(?:\.\d+)?\s?(?:OZ|QT|L|Cups?|Can)))*/i);
  return m ? title.slice(title.indexOf(m[0])).split(/\s-\s/)[0].replace(/\s*\|\s*/g, " / ").trim() : null;
}

function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? "").replace(/\s{2,}/g, " ").trim();
}

export function normalizeStanley(g: ProductGroup, details: ProductDetails, s: NormSettings): NormalizedProduct {
  const primary = g.listings[0];
  const page = details.page;
  const productType = productTypeOf(primary, page?.breadcrumb ?? [], s);

  // ---- variants: one per colour; the first listing (in primary order) that has the colour IN STOCK wins, else the
  // first listing that lists it. Every SKU once. ----
  type Cand = { v: StanleyRawVariant; p: StanleyRawProduct; colour: string };
  const cands = new Map<string, Cand[]>();
  const colourOrder: string[] = [];
  let hasColourOption = false;
  const seenSku = new Set<string>();
  for (const p of g.listings) {
    const pos = colourOptionPos(p);
    hasColourOption ||= pos != null;
    for (const v of p.variants) {
      const sku = skuOf(v);
      if (!sku || seenSku.has(sku) || g.foreignSkus?.has(sku) || !((num(v.price) ?? 0) > 0)) continue;
      seenSku.add(sku);
      const colour = (pos != null ? optVal(v, pos) : "") || (p.variants.length === 1 && g.listings.length === 1 ? "Default Title" : v.title.trim() || "Default");
      const k = colour.toLowerCase();
      if (!cands.has(k)) { cands.set(k, []); colourOrder.push(k); }
      cands.get(k)!.push({ v, p, colour });
    }
  }
  const multiVariant = colourOrder.length > 1 || hasColourOption;
  const variants: NormalizedVariant[] = [];
  const chosenListing = new Map<string, StanleyRawProduct>();
  let dupes = 0;
  for (const k of colourOrder) {
    const list = cands.get(k)!;
    const pick = list.find((c) => c.v.available) ?? list[0];
    dupes += list.length - 1;
    const colour = multiVariant && pick.colour === "Default Title" ? "Default" : pick.colour;
    const current = num(pick.v.price);
    const compare = num(pick.v.compare_at_price);
    const sku = skuOf(pick.v);
    chosenListing.set(colour, pick.p);
    variants.push({
      sku, sourceVariantId: String(pick.v.id), sourceProductId: String(pick.p.id), colour,
      barcode: details.barcodes[sku] || null, weight: details.weights[sku] ?? null,
      availability: pick.v.available ? "in_stock" : "out_of_stock",
      currentUsd: current, regularUsd: compare != null && current != null && compare > current ? compare : current,
      imageKey: pick.v.featured_image?.src ? imageKey(pick.v.featured_image.src) : null,
    });
  }
  const colours: NormalizedColour[] = variants.map((v) => {
    const p = chosenListing.get(v.colour)!;
    return { colour: v.colour, sourceProductId: v.sourceProductId, handle: p.handle, url: `${STANLEY_SOURCE.origin}/products/${p.handle}`, availability: v.availability, minUsd: v.currentUsd };
  });

  // ---- names ----
  const name = primary.title.replace(/\s+/g, " ").trim();
  const title = /^stanley\b/i.test(name) ? name : fillTemplate(s.TITLE_TEMPLATE, { title: name });

  // ---- specifications: only what Stanley states (page spec list, product JSON, title) ----
  const pageSpecs = page?.specs ?? {};
  const capacity = capacityOf(name, pageSpecs);
  const breadcrumb = page?.breadcrumb ?? [];
  const category = breadcrumb.length ? breadcrumb[breadcrumb.length - 1] : (primary.product_type && !/^normal$/i.test(primary.product_type) ? primary.product_type : null);
  const collection = breadcrumb.length > 1 ? breadcrumb[0] : null;
  const weights = [...new Set(variants.map((v) => v.weight).filter((x): x is string => !!x))];
  const specs: Record<string, string> = Object.fromEntries(Object.entries({
    Brand: "Stanley 1913",
    Collection: collection,
    Category: category,
    Capacity: capacity,
    ...pageSpecs,
    ...(pageSpecs.Weight || !weights.length ? {} : { "Shipping weight": weights.join(", ") }),
    Care: page?.care ?? null,
    Colours: multiVariant ? variants.map((v) => v.colour).join(", ") : null,
  }).filter(([, v]) => v != null && v !== "")) as Record<string, string>;

  const cleaned = cleanDescription((primary.body_html ?? "").replace(POLICY_LINE, "")).replace(POLICY_LINE, "").replace(/(<p>\s*<\/p>\s*)+$/g, "");
  const specList = Object.entries(pageSpecs).map(([k, v]) => `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</li>`).join("");
  const careLine = page?.care ? `<p><strong>Care:</strong> ${escapeHtml(page.care)}</p>` : "";
  const skuLine = variants.length === 1 ? `<p><strong>SKU - ${escapeHtml(variants[0].sku)}</strong></p>` : "";
  const descriptionHtml = [cleaned, specList ? `<ul>${specList}</ul>` : "", careLine, "<p> </p>", skuLine, DISCLAIMER].filter(Boolean).join("");
  const specTable = `<table><tbody>${Object.entries(specs).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join("")}</tbody></table>`;
  const factsHtml = [skuLine, `<h3>Specifications</h3>${specTable}`, "<p> </p>", DISCLAIMER].filter(Boolean).join("");

  const seoTitle = `${title} | Full Size Run`.length <= 70 ? `${title} | Full Size Run` : clip(title, 70);
  const plain = cleaned.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const seoDescription = clip(`${title}${variants.length > 1 ? ` in ${variants.length} colours` : ""}. ${plain}`, 320);

  // ---- images: the variant photo first, then that colour's other photos, then a few general shots. Photos of colours
  // Stanley no longer sells are left out. One copy per photo (URLs normalised). ----
  const colourNames = variants.map((v) => v.colour);
  const perColour = new Map<string, { key: string; url: string }[]>(colourNames.map((c) => [c, []]));
  const general: { key: string; url: string }[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  const chosenIds = new Set(variants.map((v) => Number(v.sourceVariantId)));
  const variantColour = new Map(variants.map((v) => [Number(v.sourceVariantId), v.colour]));
  for (const p of g.listings) {
    const contributes = variants.some((v) => v.sourceProductId === String(p.id));
    const soleColour = p.variants.length === 1 && contributes ? variants.find((v) => v.sourceProductId === String(p.id))!.colour : null;
    for (const im of [...p.images].sort((a, b) => a.position - b.position)) {
      if (!/\.(jpe?g|png|webp)(\?|$)/i.test(im.src)) continue;
      const key = imageKey(im.src);
      if (seen.has(key)) continue;
      seen.add(key);
      const url = (im.src.startsWith("//") ? `https:${im.src}` : im.src).split("?")[0];
      const linked = im.variant_ids.find((id) => chosenIds.has(id));
      const linkedOther = !linked && im.variant_ids.length > 0; // photo of a variant we did not pick (duplicate / retired colour)
      const c = soleColour ?? (linkedOther ? "retired" : imageColour(im.src, linked ? variantColour.get(linked)! : null, colourNames));
      if (c === "retired" || (!contributes && c == null)) { skipped++; continue; }
      if (c == null) general.push({ key, url });
      else perColour.get(c)!.push({ key, url });
    }
  }
  const images: NormalizedProduct["images"] = [];
  for (const v of variants) {
    const arr = perColour.get(v.colour)!;
    // Stanley's own variant photo leads its colour's gallery
    const lead = v.imageKey ? arr.findIndex((x) => x.key === v.imageKey) : -1;
    if (lead > 0) arr.unshift(...arr.splice(lead, 1));
    arr.forEach((im, i) => {
      if (i >= MAX_IMAGES_PER_COLOUR || images.length >= MAX_MEDIA) { skipped++; return; }
      images.push({ ...im, colour: v.colour, alt: `${title}${multiVariant ? ` - ${v.colour}` : ""}${i ? ` - ${i + 1}` : ""}` });
    });
  }
  general.forEach((im, i) => {
    if (i >= MAX_GENERAL_IMAGES || images.length >= MAX_MEDIA) { skipped++; return; }
    images.push({ ...im, colour: "", alt: `${title} - detail ${i + 1}` });
  });

  const typeTag = slug(productType);
  const series = ["Quencher", "IceFlow", "ProTour", "Adventure", "Classic", "Everyday", "All Day", "Aerolight", "Go", "Flowstate"].filter((x) => new RegExp(`\\b${x}\\b`, "i").test(name));
  const tags = [...new Set([...list(s.BASE_TAGS), typeTag, ...(category ? [slug(category)] : []), ...series.map(slug)].filter(Boolean))];

  const availability: Availability = variants.some((v) => v.availability === "in_stock") ? "in_stock" : "out_of_stock";
  const missing: string[] = [];
  if (!cleaned.trim()) missing.push("description");
  if (!page) missing.push("product page specifications - not fetched");
  else if (!Object.keys(page.specs).length) missing.push("specification list");
  if (variants.some((v) => v.currentUsd == null)) missing.push("price (some variants)");
  if (!variants.some((v) => v.barcode)) missing.push("barcodes");
  if (!images.length) missing.push("images");
  const updated = g.listings.map((p) => p.updated_at).filter((x): x is string => !!x).sort();

  const n: Omit<NormalizedProduct, "hashes"> = {
    titleKey: g.titleKey, primaryProductId: String(primary.id), sourceProductIds: Object.fromEntries(g.listings.map((p) => [p.handle, String(p.id)])),
    sourceUrl: `${STANLEY_SOURCE.origin}/products/${primary.handle}`, canonicalUrl: `${STANLEY_SOURCE.origin}/products/${primary.handle}`, handles: g.listings.map((p) => p.handle),
    name, title, category, collection, capacity, sourceProductType: primary.product_type, productType, colours, variants, hasColourOption: multiVariant, specs,
    descriptionHtml, factsHtml, seoTitle, seoDescription, images, imagesSkipped: skipped, tags, skus: variants.map((v) => v.sku), availability,
    sourceUpdatedAt: updated.length ? updated[updated.length - 1] : null, duplicatesSkipped: dupes, missing,
  };
  return {
    ...n,
    hashes: {
      content: hash({ t: n.title, d: n.descriptionHtml, tags: n.tags, v: s.VENDOR, p: n.productType }),
      image: hash(n.images.map((i) => [i.key, i.colour])),
      specification: hash(n.specs),
      price: hash(n.variants.map((v) => [v.sku, v.currentUsd, v.regularUsd])),
      variant: hash(n.variants.map((v) => [v.sku, v.colour, v.barcode])),
      availability: hash(n.variants.map((v) => [v.sku, SELLABLE.includes(v.availability) ? 1 : 0])),
    },
  };
}
