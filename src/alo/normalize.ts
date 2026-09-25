import { cleanDescription, clip, titleCase } from "../gymshark/normalize.ts";
import { escapeHtml, hash } from "../util.ts";
import { ALO_SOURCE, list, parseMap, type AloSettings } from "./config.ts";
import { imageKey, type AloRawProduct } from "./source.ts";

export type Availability = "in_stock" | "low_stock" | "out_of_stock" | "coming_soon";
export const SELLABLE: Availability[] = ["in_stock", "low_stock"];

// ---------- catalog -> styles ----------

export interface StyleGroup { styleId: string; listings: AloRawProduct[]; foreignSkus?: Set<string> }
export interface Grouping { styles: StyleGroup[]; excluded: Record<string, number>; invalid: { handle: string; reason: string }[] }

type GroupSettings = Pick<AloSettings, "EXCLUDED_PRODUCT_TYPES" | "EXCLUDED_VENDORS" | "EXCLUDED_TAGS" | "IMPORT_CATEGORIES">;

const tagValue = (tags: string[], prefix: string) => tags.find((t) => t.startsWith(prefix))?.slice(prefix.length).trim() || null;

/**
 * ALO style id, in order of trust: its StyleId tag, its YGroup_ tag (ALO's own style grouping), then the handle
 * prefix when at least one SKU starts with it. Unisex styles are listed twice (a "-mens" copy tagged "MensU3032RG"
 * or "WomensM4216R"); the prefix is dropped so both listings land on one style. ALO sometimes lists a successor
 * style's SKUs inside a listing (W5561R legging with W51312R… sizes), so SKUs are not required to match the id.
 * null = no trustworthy identifier (never invented).
 */
export function styleIdOf(p: AloRawProduct): string | null {
  const clean = (v: string | null | undefined) => v?.replace(/^(Mens|Womens|Men|Women)(?=[A-Z]\d)/, "").trim().toUpperCase() || null;
  const valid = (id: string | null): id is string => !!id && /^[A-Z0-9]{4,}$/.test(id);
  const tag = clean(tagValue(p.tags, "StyleId:"));
  if (valid(tag)) return tag;
  const group = clean(p.tags.find((t) => /^YGroup_/.test(t))?.slice(7));
  if (valid(group)) return group;
  const fromHandle = p.handle.split("-")[0].toUpperCase();
  if (/^[A-Z]{1,3}\d{3,}[A-Z0-9]*$/.test(fromHandle) && p.variants.some((v) => (v.sku ?? "").toUpperCase().startsWith(fromHandle))) return fromHandle;
  return null;
}

/** SKU prefix match where the remainder is digits only (U3032RG066620 belongs to U3032RG, not U3032R). */
export const skuBelongsTo = (sku: string, style: string) => sku.startsWith(style) && /^\d+$/.test(sku.slice(style.length));

export function exclusionReason(p: AloRawProduct, s: GroupSettings): string | null {
  const types = list(s.EXCLUDED_PRODUCT_TYPES).map((x) => x.toLowerCase());
  if (types.includes(p.product_type.trim().toLowerCase())) return `product type "${p.product_type}"`;
  if (list(s.EXCLUDED_VENDORS).map((x) => x.toLowerCase()).includes(p.vendor.trim().toLowerCase())) return `vendor "${p.vendor}"`;
  const tags = new Set(list(s.EXCLUDED_TAGS).map((x) => x.toLowerCase()));
  const hit = p.tags.find((t) => tags.has(t.toLowerCase()));
  if (hit) return `tag "${hit}"`;
  const wanted = list(s.IMPORT_CATEGORIES).map((x) => x.toLowerCase());
  if (wanted.length && !p.product_type.split(":").some((seg) => wanted.includes(seg.trim().toLowerCase()))) return "not in IMPORT_CATEGORIES";
  if (!p.variants.length) return "no variants";
  return null;
}

export function groupAloCatalog(products: AloRawProduct[], s: GroupSettings): Grouping {
  const excluded: Record<string, number> = {};
  const invalid: Grouping["invalid"] = [];
  const byStyle = new Map<string, AloRawProduct[]>();
  for (const p of products) {
    const why = exclusionReason(p, s);
    if (why) { excluded[why] = (excluded[why] ?? 0) + 1; continue; }
    const id = styleIdOf(p);
    if (!id) { invalid.push({ handle: p.handle, reason: "missing product ID: no StyleId tag matching its SKUs" }); continue; }
    const arr = byStyle.get(id) ?? [];
    arr.push(p);
    byStyle.set(id, arr);
  }
  // listings in ALO's own order: the women's / original listing before a "-mens" copy
  const all = [...byStyle.entries()].map(([styleId, listings]) => ({ styleId, listings: listings.sort((a, b) => Number(/-mens$/.test(a.handle)) - Number(/-mens$/.test(b.handle))) }));
  // every SKU goes to exactly one style (never two Shopify products): the style its code names, else the first to list it
  const owner = new Map<string, string>();
  for (const g of all) for (const p of g.listings) for (const v of p.variants) {
    const sku = (v.sku ?? "").trim().toUpperCase();
    if (!sku) continue;
    const cur = owner.get(sku);
    if (!cur || (!skuBelongsTo(sku, cur) && skuBelongsTo(sku, g.styleId))) owner.set(sku, g.styleId);
  }
  const styles: StyleGroup[] = [];
  for (const g of all) {
    const skus = g.listings.flatMap((p) => p.variants.map((v) => (v.sku ?? "").trim().toUpperCase()).filter(Boolean));
    const foreign = new Set(skus.filter((k) => owner.get(k) !== g.styleId));
    if (skus.length && foreign.size === new Set(skus).size) { const why = "every SKU already listed under another style"; excluded[why] = (excluded[why] ?? 0) + g.listings.length; continue; }
    styles.push(foreign.size ? { ...g, foreignSkus: foreign } : g);
  }
  return { styles, excluded, invalid };
}

// ---------- style -> FSR product ----------

export interface NormalizedVariant {
  sku: string;                   // ALO variant SKU, kept as-is (e.g. W54234R081940)
  sourceVariantId: string;
  sourceProductId: string;       // ALO product id of the colourway
  colour: string;
  size: string;                  // storefront label (UK for shoes when SIZE_SYSTEM=UK)
  sourceSize: string;            // ALO's own size label
  length: string | null;         // ALO's Length option (one value per colourway - kept as a specification)
  barcode: string | null;
  availability: Availability;
  currentUsd: number | null;     // ALO's current selling price
  regularUsd: number | null;     // compare-at when on sale, else the current price
  grams: number | null;
}

export interface NormalizedColour {
  colour: string;
  sourceProductId: string;
  handle: string;
  url: string;
  availability: Availability;
  minUsd: number | null;
}

export interface NormalizedStyle {
  styleId: string;
  sourceUrl: string;
  canonicalUrl: string;
  handles: string[];
  name: string;
  title: string;
  gender: "Men" | "Women" | "Unisex" | null;
  category: string | null;
  subcategory: string | null;
  collection: string | null;
  sourceProductType: string;
  productType: string;
  isFootwear: boolean;
  colours: NormalizedColour[];
  variants: NormalizedVariant[];
  sizeOrder: string[];
  optionNames: ("Color" | "Size")[];            // [] = single variant with Shopify's default "Title" option
  sizeConversion: Record<string, string> | null; // ALO label -> storefront label (shoes only)
  specs: Record<string, string>;
  descriptionHtml: string;
  factsHtml: string;             // without ALO's text (used when AUTHORIZATION_CONFIRMED=false)
  seoTitle: string;
  seoDescription: string;
  images: { key: string; url: string; alt: string; colour: string }[];
  imagesCapped: number;
  tags: string[];
  availability: Availability;
  sourceUpdatedAt: string | null;
  duplicatesSkipped: number;     // variants already listed under another handle (men's/women's copies)
  missing: string[];
  hashes: { content: string; image: string; specification: string; price: string; variant: string; availability: string };
}

export interface StyleDetails { barcodes: Record<string, string>; attribs: Record<string, string> | null }

type NormSettings = Pick<AloSettings, "TITLE_TEMPLATE" | "BASE_TAGS" | "PRODUCT_TYPE_MAP" | "DEFAULT_APPAREL_TYPE" | "DEFAULT_OTHER_TYPE" | "VENDOR" | "SIZE_SYSTEM" | "MEN_US_TO_UK_OFFSET" | "WOMEN_US_TO_UK_OFFSET" | "MAX_IMAGES_PER_COLOUR">;

const DISCLAIMER =
  "<p><strong>Disclaimer:</strong> Product images are for reference only. The actual product may vary slightly in color, texture, or details due to lighting, photography angles, or display settings.</p>";
const MAX_MEDIA = 250; // Shopify's per-product media limit

const num = (v: string | null | undefined) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const fmtSize = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));
const slug = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function genderOf(listings: AloRawProduct[]): NormalizedStyle["gender"] {
  const set = new Set<string>();
  for (const p of listings) {
    const first = p.product_type.split(":")[0].trim().toLowerCase();
    if (first === "women" || first === "men") set.add(first);
    const bv = tagValue(p.tags, "BVCategory:")?.toLowerCase();
    if (bv === "women" || bv === "men") set.add(bv);
    if (/\bunisex\b/i.test(p.title) || p.tags.some((t) => /^unisex:/i.test(t))) set.add("unisex");
  }
  // accessories carry no gender in their type; ALO's own "Women:…" / "Men:…" tags are the next best statement
  if (!set.size) for (const p of listings) for (const t of p.tags) { const m = t.match(/^(Women|Men):/); if (m) set.add(m[1].toLowerCase()); }
  if (set.has("unisex") || (set.has("women") && set.has("men"))) return "Unisex";
  if (set.has("women")) return "Women";
  if (set.has("men")) return "Men";
  return null;
}

/** ALO product type path -> Shopify product type, most specific segment first. */
export function productTypeOf(aloType: string, s: Pick<AloSettings, "PRODUCT_TYPE_MAP" | "DEFAULT_APPAREL_TYPE" | "DEFAULT_OTHER_TYPE">): string {
  const map = parseMap(s.PRODUCT_TYPE_MAP);
  const segs = aloType.split(":").map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) if (map[segs[i]]) return map[segs[i]];
  return segs[0] === "women" || segs[0] === "men" ? s.DEFAULT_APPAREL_TYPE : s.DEFAULT_OTHER_TYPE;
}

/**
 * Storefront size label. Apparel keeps ALO's label ("XS", "2XL", "One Size"). Shoes use UK sizes on this store:
 * men/unisex UK = US - 0.5, women UK = US - 2. ALO's dual labels ("8M/9.5W") are unisex -> the men's figure is used
 * (same rule as the ON sync). Returns null when the label cannot be converted without guessing.
 */
export function shoeSizeUk(raw: string, gender: NormalizedStyle["gender"], s: Pick<AloSettings, "MEN_US_TO_UK_OFFSET" | "WOMEN_US_TO_UK_OFFSET">): string | null {
  const t = raw.replace(/\s+/g, " ").trim();
  const n = "(\\d{1,2}(?:\\.5)?)";
  let m = t.match(new RegExp(`^${n} ?M ?/ ?${n} ?W$`, "i"));
  if (m) return fmtSize(Number(m[1]) - s.MEN_US_TO_UK_OFFSET);
  m = t.match(new RegExp(`^${n} ?W$`, "i"));
  if (m) return fmtSize(Number(m[1]) - s.WOMEN_US_TO_UK_OFFSET);
  m = t.match(new RegExp(`^${n} ?M$`, "i"));
  if (m) return fmtSize(Number(m[1]) - s.MEN_US_TO_UK_OFFSET);
  m = t.match(new RegExp(`^(?:EU ?\\d{2}(?:\\.5)? ?/ ?)?US ?${n}$`, "i")) ?? t.match(new RegExp(`^${n}$`));
  if (m && gender === "Women") return fmtSize(Number(m[1]) - s.WOMEN_US_TO_UK_OFFSET);
  if (m && gender === "Men") return fmtSize(Number(m[1]) - s.MEN_US_TO_UK_OFFSET);
  return null;
}

export function apparelSize(raw: string): string {
  const t = raw.trim();
  if (/^(one ?size|os|o\/s|default title)$/i.test(t)) return "One Size";
  if (/^[0-9]*x*[sml]$/i.test(t) || /^[0-9]?xl$/i.test(t)) return t.toUpperCase();
  return t;
}

function optionIndex(p: AloRawProduct, ...names: string[]): number | null {
  const o = p.options.find((x) => names.includes(x.name.trim().toLowerCase()));
  return o ? o.position : null;
}
const opt = (v: AloRawProduct["variants"][number], pos: number | null) => (pos == null ? null : ((pos === 1 ? v.option1 : pos === 2 ? v.option2 : v.option3) ?? "").trim() || null);

function availabilityOf(p: AloRawProduct, available: boolean, size: string | null): Availability {
  if (available) {
    const low = size && p.tags.some((t) => new RegExp(`^Computed:UnderInventoryThreshold:\\d+:for:${size.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i").test(t));
    return low ? "low_stock" : "in_stock";
  }
  return p.tags.some((t) => /coming ?soon/i.test(t)) ? "coming_soon" : "out_of_stock";
}
function rollup(list: Availability[]): Availability {
  if (list.includes("in_stock")) return "in_stock";
  if (list.includes("low_stock")) return "low_stock";
  if (list.includes("coming_soon")) return "coming_soon";
  return "out_of_stock";
}

function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? "").replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").trim();
}

export function normalizeAlo(g: StyleGroup, details: StyleDetails, s: NormSettings): NormalizedStyle {
  const primary = g.listings[0];
  const gender = genderOf(g.listings);
  const sourceProductType = primary.product_type;
  const productType = productTypeOf(sourceProductType, s);
  const isFootwear = /(^|:)shoes(:|$)/i.test(sourceProductType) || productType === "Sneakers";
  const typeSegs = sourceProductType.split(":").map((x) => x.trim()).filter(Boolean);
  const pathSegs = /^(women|men|unisex)$/i.test(typeSegs[0] ?? "") ? typeSegs.slice(1) : typeSegs;
  const category = pathSegs.length ? pathSegs[pathSegs.length - 1] : null;
  const subcategory = pathSegs.length > 1 ? pathSegs.slice(0, -1).join(" > ") : null;
  const collection = tagValue(primary.tags, "Fabric:");

  // ---- variants: every SKU once, colourways in ALO's order; duplicate listings (men's copies) add nothing ----
  const seenSku = new Set<string>();
  const colours: NormalizedColour[] = [];
  const variants: NormalizedVariant[] = [];
  const lengths = new Set<string>();
  let dupes = 0;
  let noSku = 0;
  let hasColour = false;
  let hasSize = false;
  const colourImages: { colour: string; listing: AloRawProduct }[] = [];
  // Colour names shared by several contributing colourways are ALL suffixed with ALO's colour code, so a name
  // never depends on ALO's listing order (an order change would otherwise swap names and collide in Shopify).
  const baseOf = (p: AloRawProduct) => {
    const cPos = optionIndex(p, "color", "colour");
    const first = p.variants.find((v) => v.sku);
    return ((first && cPos ? opt(first, cPos) : null) ?? p.title.split(" - ").slice(1).join(" - ").trim()) || "Default";
  };
  const shared = new Map<string, number>();
  {
    const seen = new Set<string>();
    for (const p of g.listings) {
      const skus = p.variants.map((v) => (v.sku ?? "").trim().toUpperCase()).filter((k) => k && !seen.has(k) && !g.foreignSkus?.has(k));
      if (!skus.length) continue;
      skus.forEach((k) => seen.add(k));
      const b = baseOf(p).toLowerCase();
      shared.set(b, (shared.get(b) ?? 0) + 1);
    }
  }
  const usedNames = new Set<string>();
  for (const p of g.listings) {
    const cPos = optionIndex(p, "color", "colour");
    const sPos = optionIndex(p, "size");
    const lPos = optionIndex(p, "length");
    hasColour ||= cPos != null;
    hasSize ||= sPos != null;
    const fresh = p.variants.filter((v) => {
      const sku = (v.sku ?? "").trim().toUpperCase();
      if (!sku) { noSku++; return false; }
      if (seenSku.has(sku) || g.foreignSkus?.has(sku)) { dupes++; return false; }
      return true;
    });
    if (!fresh.length) continue;
    const baseColour = baseOf(p);
    const length = lPos ? opt(fresh[0], lPos) : null;
    if (length) lengths.add(length);
    const code = (p.variants.find((v) => v.sku)?.sku ?? "").trim().toUpperCase().slice(g.styleId.length, -1);
    let colour = (shared.get(baseColour.toLowerCase()) ?? 0) > 1 ? `${baseColour} (${code || String(p.id).slice(-4)})` : baseColour;
    if (usedNames.has(colour.toLowerCase())) colour = `${baseColour} (${String(p.id).slice(-4)})`;
    usedNames.add(colour.toLowerCase());
    const vs: NormalizedVariant[] = fresh.map((v) => {
      const sku = v.sku!.trim().toUpperCase();
      seenSku.add(sku);
      const rawSize = (sPos ? opt(v, sPos) : null) ?? "One Size";
      const current = num(v.price);
      const compare = num(v.compare_at_price);
      return {
        sku, sourceVariantId: String(v.id), sourceProductId: String(p.id), colour, size: rawSize, sourceSize: rawSize, length,
        barcode: details.barcodes[sku] ?? null, availability: availabilityOf(p, v.available, sPos ? opt(v, sPos) : null),
        currentUsd: current, regularUsd: compare != null && current != null && compare > current ? compare : current, grams: v.grams ?? null,
      };
    });
    variants.push(...vs);
    const prices = vs.map((v) => v.currentUsd).filter((x): x is number => x != null);
    colours.push({
      colour, sourceProductId: String(p.id), handle: p.handle, url: `${ALO_SOURCE.origin}/products/${p.handle}`,
      availability: rollup(vs.map((v) => v.availability)), minUsd: prices.length ? Math.min(...prices) : null,
    });
    colourImages.push({ colour, listing: p });
  }

  // ---- sizes: apparel as listed; shoes converted to UK only when every label converts without a collision ----
  let sizeConversion: Record<string, string> | null = null;
  const notes: string[] = [];
  if (isFootwear && s.SIZE_SYSTEM === "UK") {
    const conv: Record<string, string> = {};
    let ok = true;
    for (const v of variants) {
      const uk = /^(one ?size|os)$/i.test(v.sourceSize) ? "One Size" : shoeSizeUk(v.sourceSize, gender, s);
      if (!uk) { ok = false; notes.push(`shoe size "${v.sourceSize}" has no safe UK conversion - ALO labels kept`); break; }
      conv[v.sourceSize] = uk;
    }
    const perColour = new Map<string, Set<string>>();
    if (ok) for (const v of variants) {
      const set = perColour.get(v.colour) ?? new Set<string>();
      if (set.has(conv[v.sourceSize])) { ok = false; notes.push(`two ALO sizes map to UK ${conv[v.sourceSize]} - ALO labels kept`); break; }
      set.add(conv[v.sourceSize]);
      perColour.set(v.colour, set);
    }
    if (ok) { for (const v of variants) v.size = conv[v.sourceSize]; sizeConversion = conv; }
  } else {
    for (const v of variants) v.size = apparelSize(v.sourceSize);
  }
  const sizeOrder: string[] = [];
  for (const v of variants) if (!sizeOrder.includes(v.size)) sizeOrder.push(v.size);

  // ---- names ----
  const primaryColourSuffix = colours[0] ? new RegExp(`\\s+-\\s+${colours[0].colour.replace(/ \(.+\)$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") : null;
  let name = primary.title.trim();
  if (primaryColourSuffix && primaryColourSuffix.test(name)) name = name.replace(primaryColourSuffix, "");
  else if (name.includes(" - ")) name = name.split(" - ")[0];
  name = name.replace(/^alo\s+(?=\S)/i, "").trim() || primary.title.trim();
  const title = fillTemplate(s.TITLE_TEMPLATE, { title: name, gender: gender ?? "", style: g.styleId });

  // ---- specifications: only what ALO states (tags, options, page attributes) ----
  const attribs = details.attribs ?? {};
  const fabrication = attribs.fabrication ?? null;
  const composition = fabrication?.split("\n").map((x) => x.trim()).find((l) => /\d{1,3}\s?%/.test(l)) ?? null;
  const fabricText = fabrication?.split("\n").map((x) => x.trim()).filter((l) => l && l !== composition).join(" ") || null;
  const activities = [...new Set(g.listings.flatMap((p) => p.tags.map((t) => t.match(/^(?:Women|Men|Unisex):Activity:(.+)$/i)?.[1]?.trim()).filter((x): x is string => !!x)))];
  const extraAttribs = Object.entries(attribs).filter(([k]) => !["fabrication", "fit"].includes(k)).map(([k, v]) => [titleCase(k.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()), v.replace(/\n+/g, " · ")]);
  const specs: Record<string, string> = Object.fromEntries(Object.entries({
    Brand: "ALO Yoga",
    "Style ID": g.styleId,
    Gender: gender,
    Category: category,
    Subcategory: subcategory,
    Collection: collection,
    Fabric: fabricText,
    Composition: composition,
    Fit: attribs.fit ? attribs.fit.replace(/\n+/g, " · ") : null,
    Length: lengths.size ? [...lengths].join(", ") : tagValue(primary.tags, "Length:"),
    Waist: tagValue(primary.tags, "Waist:"),
    Support: tagValue(primary.tags, "Support:"),
    Warmth: tagValue(primary.tags, "Warmth:"),
    Activity: activities.length ? activities.join(", ") : null,
    Colours: colours.map((c) => c.colour).join(", ") || null,
    ...Object.fromEntries(extraAttribs),
    "Sizes (ALO)": sizeConversion ? [...new Set(variants.map((v) => v.sourceSize))].join(", ") : null,
  }).filter(([, v]) => v != null && v !== "")) as Record<string, string>;

  const cleaned = cleanDescription(primary.body_html ?? "");
  const details_li = [
    fabricText || composition ? `<li><strong>Fabric:</strong> ${escapeHtml([fabricText, composition].filter(Boolean).join(" - "))}</li>` : "",
    attribs.fit ? `<li><strong>Fit:</strong> ${escapeHtml(attribs.fit.replace(/\n+/g, ". ").replace(/\.\./g, "."))}</li>` : "",
    specs.Length ? `<li><strong>Length:</strong> ${escapeHtml(specs.Length)}</li>` : "",
  ].filter(Boolean).join("");
  const skuLine = `<p><strong>SKU - ${escapeHtml(g.styleId)}</strong></p>`;
  const sizeNote = sizeConversion ? "<p><strong>NOTE:</strong> Sizes are listed in UK sizing.</p>" : "";
  const descriptionHtml = [cleaned, details_li ? `<ul>${details_li}</ul>` : "", "<p> </p>", skuLine, sizeNote, "<p> </p>", DISCLAIMER].filter(Boolean).join("");
  const specTable = `<table><tbody>${Object.entries(specs).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join("")}</tbody></table>`;
  const factsHtml = [skuLine, `<h3>Specifications</h3>${specTable}`, "<p> </p>", DISCLAIMER].join("");

  const seoTitle = `${title} | Full Size Run`.length <= 70 ? `${title} | Full Size Run` : clip(title, 70);
  const plain = cleaned.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const seoDescription = clip(`ALO Yoga ${name}${gender ? ` (${gender})` : ""}${colours.length > 1 ? ` in ${colours.length} colours` : colours[0] ? ` in ${colours[0].colour}` : ""}. ${plain}`, 320);

  // ---- images: each colourway's gallery in ALO's order; one copy per photo; capped at Shopify's 250 ----
  const images: NormalizedStyle["images"] = [];
  const seenImg = new Set<string>();
  let capped = 0;
  for (const { colour, listing } of colourImages) {
    let n = 0;
    for (const im of [...listing.images].sort((a, b) => a.position - b.position)) {
      if (!/\.(jpe?g|png|webp)(\?|$)/i.test(im.src)) continue;
      const key = imageKey(im.src);
      if (seenImg.has(key)) continue;
      if ((s.MAX_IMAGES_PER_COLOUR && n >= s.MAX_IMAGES_PER_COLOUR) || images.length >= MAX_MEDIA) { capped++; continue; }
      seenImg.add(key);
      n++;
      images.push({ key, url: im.src.startsWith("//") ? `https:${im.src}` : im.src, alt: `ALO Yoga ${name} - ${colour}${n > 1 ? ` - ${n}` : ""}`, colour });
    }
  }

  const typeTag = slug(productType);
  const tags = [...new Set([
    ...list(s.BASE_TAGS),
    ...(typeTag ? [typeTag] : []),
    ...(gender === "Women" ? ["womens"] : gender === "Men" ? ["mens"] : gender === "Unisex" ? ["unisex", "womens", "mens"] : []),
    ...activities.map((a) => ({ run: "running", train: "training" })[a.toLowerCase()] ?? slug(a)),
  ].filter(Boolean))];

  const availability = rollup(colours.map((c) => c.availability));
  const missing: string[] = [...notes];
  if (!cleaned.trim()) missing.push("description");
  if (!details.attribs) missing.push("page attributes (fabric / fit) - not fetched");
  else if (!composition && /^(women|men|unisex)$/i.test(typeSegs[0] ?? "")) missing.push("fabric composition");
  if (variants.some((v) => v.currentUsd == null)) missing.push("price (some variants)");
  if (!variants.some((v) => v.barcode)) missing.push("barcodes");
  if (!images.length) missing.push("images");
  if (noSku) missing.push(`${noSku} variant(s) without SKU skipped`);
  const updated = g.listings.map((p) => p.updated_at).filter((x): x is string => !!x).sort();

  const n: Omit<NormalizedStyle, "hashes"> = {
    styleId: g.styleId, sourceUrl: colours[0]?.url ?? `${ALO_SOURCE.origin}/products/${primary.handle}`, canonicalUrl: `${ALO_SOURCE.origin}/products/${primary.handle}`,
    handles: g.listings.map((p) => p.handle), name, title, gender, category, subcategory, collection, sourceProductType, productType, isFootwear, colours, variants,
    sizeOrder, optionNames: [...(hasColour || colours.length > 1 ? ["Color" as const] : []), ...(hasSize || variants.length > colours.length ? ["Size" as const] : [])], sizeConversion, specs, descriptionHtml, factsHtml, seoTitle, seoDescription, images, imagesCapped: capped, tags, availability,
    sourceUpdatedAt: updated.length ? updated[updated.length - 1] : null, duplicatesSkipped: dupes, missing,
  };
  return {
    ...n,
    hashes: {
      content: hash({ t: n.title, d: n.descriptionHtml, tags: n.tags, v: s.VENDOR, p: n.productType }),
      image: hash(n.images.map((i) => i.key)),
      specification: hash(n.specs),
      price: hash(n.variants.map((v) => [v.sku, v.currentUsd, v.regularUsd])),
      variant: hash(n.variants.map((v) => [v.sku, v.colour, v.size, v.barcode])),
      availability: hash(n.variants.map((v) => [v.sku, SELLABLE.includes(v.availability) ? 1 : 0])),
    },
  };
}
