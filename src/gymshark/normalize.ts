import * as cheerio from "cheerio";
import { escapeHtml, hash } from "../util.ts";
import { parseMap, type GymsharkSettings } from "./config.ts";
import { imageKey, type GsStyle } from "./source.ts";

export const LOW_STOCK_QTY = 5; // Gymshark's own count at or below this = "low_stock" (information only)

export type Availability = "in_stock" | "low_stock" | "out_of_stock";

export interface NormalizedVariant {
  sku: string;                   // Gymshark variant SKU, e.g. A5A2Z-BB2J-XS (kept as-is)
  sourceVariantId: string;
  sourceProductId: string;       // Gymshark product id of the colourway
  colour: string;
  size: string;                  // storefront label, e.g. "XS", "One Size"
  barcode: string | null;
  availability: Availability;
  sourceQuantity: number | null;
}

export interface NormalizedColour {
  colour: string;
  colourCode: string | null;
  sourceProductId: string;
  handle: string;
  url: string;
  currentUsd: number | null;
  regularUsd: number | null;     // compare-at when on sale, else the current price
  currency: string | null;
  availability: Availability;
  isNewRelease: boolean;
}

export interface SpecSection { heading: string; items: string[] }

export interface NormalizedStyle {
  styleCode: string;
  sourceUrl: string;
  canonicalUrl: string | null;
  handle: string;
  name: string;                  // Gymshark's product name
  title: string;                 // Shopify title from TITLE_TEMPLATE
  brand: string;
  gender: "Men" | "Women" | "Unisex" | null;
  category: string | null;       // "Leggings"
  subcategory: string | null;
  division: string | null;
  productType: string;
  colours: NormalizedColour[];
  variants: NormalizedVariant[];
  sizeOrder: string[];
  specs: Record<string, string>; // only fields Gymshark states
  specSections: SpecSection[];   // from the description's own headings
  descriptionHtml: string;       // Gymshark description (cleaned) + FSR SKU line + disclaimer
  factsHtml: string;             // the same without Gymshark's text (used when CONTENT_REUSE_CONFIRMED=false)
  seoTitle: string;
  seoDescription: string;
  images: { key: string; url: string; alt: string; colour: string }[];
  tags: string[];
  availability: Availability;
  weightKg: number | null;
  missing: string[];
  hashes: { content: string; image: string; specification: string; price: string; variant: string; availability: string };
}

const DISCLAIMER =
  "<p><strong>Disclaimer:</strong> Product images are for reference only. The actual product may vary slightly in color, texture, or details due to lighting, photography angles, or display settings.</p>";

export const titleCase = (s: string) => s.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().replace(/(^|[\s\-/&(])([a-z])/g, (_m, p, c) => p + c.toUpperCase());

export function sizeLabel(raw: string): string {
  const s = raw.trim();
  if (/^default( title)?$/i.test(s) || /^one ?size$/i.test(s) || /^os$/i.test(s)) return "One Size";
  if (/^[0-9]*x*[sml]$/i.test(s) || /^[0-9]?xl$/i.test(s)) return s.toUpperCase();
  return /[a-z]/.test(s) && s === s.toLowerCase() ? titleCase(s) : s;
}

export function genderLabel(g: string[]): NormalizedStyle["gender"] {
  const set = new Set(g.map((x) => x.toLowerCase()));
  if (set.has("u") || (set.has("m") && set.has("f"))) return "Unisex";
  if (set.has("m")) return "Men";
  if (set.has("f")) return "Women";
  return null;
}

function availabilityOf(inStock: boolean, qty: number | null): Availability {
  if (!inStock) return "out_of_stock";
  return qty != null && qty > 0 && qty <= LOW_STOCK_QTY ? "low_stock" : "in_stock";
}
function rollup(list: Availability[]): Availability {
  if (!list.some((a) => a !== "out_of_stock")) return "out_of_stock";
  return list.some((a) => a === "in_stock") ? "in_stock" : "low_stock";
}

/**
 * Gymshark description HTML -> clean Shopify HTML. Keeps paragraphs, bold headings, lists and line breaks;
 * drops editor debris (<meta>, data-mce spans, attributes, empty paragraphs) and the "SKU: X-Y" line, which
 * names one colourway only (FSR's own SKU line for the style is added instead).
 */
export function cleanDescription(html: string): string {
  const $ = cheerio.load(`<div id="root">${html}</div>`, null, false);
  const root = $("#root");
  root.find("meta,script,style,iframe,img,video,svg,form,input,button").remove();
  root.find("span,font,div:not(#root),a,u,section").each((_i, el) => { $(el).replaceWith($(el).contents()); });
  root.find("*").each((_i, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? "";
    if (!["p", "br", "strong", "b", "em", "i", "ul", "ol", "li", "h2", "h3", "h4", "h5"].includes(tag)) { $(el).replaceWith($(el).contents()); return; }
    for (const a of Object.keys((el as { attribs?: Record<string, string> }).attribs ?? {})) $(el).removeAttr(a);
  });
  let out = root.html() ?? "";
  out = out
    .replace(/(<br\s*\/?>\s*)?(-\s*|•\s*)?SKU:(&nbsp;|\s)*[A-Z0-9]+(-[A-Z0-9]+)*\s*/gi, "")
    .replace(/<p>(\s|&nbsp;|<br\s*\/?>)*/gi, "<p>")                       // leading breaks inside paragraphs
    .replace(/(\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, "</p>")
    .replace(/<p>\s*<\/p>/gi, "")
    .replace(/\n+/g, "")
    .trim();
  return out;
}

/** "HEADING" + bullet lines, read from the cleaned description. Nothing is added that the text does not say. */
export function specSectionsFrom(cleanHtml: string): SpecSection[] {
  const text = cleanHtml
    .replace(/<\/?(strong|b)>/gi, "\u0001")
    .replace(/<li>/gi, "\n• ")
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/?[uo]l>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
  const sections: SpecSection[] = [];
  let cur: SpecSection | null = null;
  for (const rawLine of text.split("\n")) {
    const bold = /^\s*\u0001[^\u0001]+\u0001\s*$/.test(rawLine);
    const line = rawLine.replace(/\u0001/g, "").trim();
    if (!line) continue;
    if (bold && line === line.toUpperCase() && /[A-Z]/.test(line) && line.length <= 40) { cur = { heading: titleCase(line.toLowerCase()), items: [] }; sections.push(cur); continue; }
    const bullet = line.match(/^[•\-–·*]\s*(.+)$/);
    if (bullet) {
      if (!cur) { cur = { heading: "Features", items: [] }; sections.push(cur); }
      cur.items.push(bullet[1].trim());
    }
  }
  return sections.filter((s) => s.items.length);
}

export function compositionOf(sections: SpecSection[]): string | null {
  for (const s of sections) for (const i of s.items) if (/\b\d{1,3}\s?%\s*[A-Za-z]/.test(i) && /%.*(cotton|polyester|elastane|nylon|polyamide|spandex|viscose|modal|lyocell|wool|recycled|fibre|fiber)/i.test(i)) return i;
  return null;
}

function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? "").replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").replace(/\s+-\s*$/, "").trim();
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6)).trimEnd()}…`;
}

export function normalizeGymshark(st: GsStyle, s: Pick<GymsharkSettings, "TITLE_TEMPLATE" | "BASE_TAGS" | "PRODUCT_TYPE_MAP" | "DEFAULT_PRODUCT_TYPE" | "VENDOR">): NormalizedStyle {
  const gender = genderLabel(st.gender);
  const category = st.category ? titleCase(st.category) : null;
  const subcategory = st.subcategory ? titleCase(st.subcategory) : null;
  // PRODUCT_TYPE_MAP keys may be a Gymshark category ("bags") or division ("apparel"); category wins
  const typeMap = parseMap(s.PRODUCT_TYPE_MAP);
  const productType = (st.category && typeMap[st.category.toLowerCase()]) || (st.division && typeMap[st.division.toLowerCase()]) || s.DEFAULT_PRODUCT_TYPE;
  const name = st.title.replace(/^gymshark\s+/i, "").trim();
  const title = fillTemplate(s.TITLE_TEMPLATE, { title: name, gender: gender ?? "", style: st.styleCode });

  // colours: the page's own colourway first, then Gymshark's order
  const ordered = [...st.colours].sort((a, b) => (a.productId === st.pageProductId ? -1 : b.productId === st.pageProductId ? 1 : 0));
  const sizeOrder: string[] = [];
  const variants: NormalizedVariant[] = [];
  const colours: NormalizedColour[] = [];
  const usedColourNames = new Map<string, number>();
  for (const c of ordered) {
    // two colourways with the same display name would collide as option values: disambiguate with the colour code
    const n = (usedColourNames.get(c.colour.toLowerCase()) ?? 0) + 1;
    usedColourNames.set(c.colour.toLowerCase(), n);
    const colour = n > 1 ? `${c.colour} (${c.colourCode ?? n})` : c.colour;
    const vs = c.sizes.map((z) => {
      const size = sizeLabel(z.size);
      if (!sizeOrder.includes(size)) sizeOrder.push(size);
      return { sku: z.sku, sourceVariantId: z.variantId, sourceProductId: c.productId, colour, size, barcode: z.barcode, availability: availabilityOf(z.inStock, z.inventoryQuantity), sourceQuantity: z.inventoryQuantity };
    });
    variants.push(...vs);
    const regular = c.compareAtPrice != null && c.price != null && c.compareAtPrice > c.price ? c.compareAtPrice : c.price;
    colours.push({
      colour, colourCode: c.colourCode, sourceProductId: c.productId, handle: c.handle, url: c.url, currentUsd: c.price, regularUsd: regular,
      currency: c.currency, availability: rollup(vs.map((v) => v.availability)), isNewRelease: c.isNewRelease,
    });
  }

  const cleaned = cleanDescription(st.descriptionHtml);
  const specSections = specSectionsFrom(cleaned);
  const composition = compositionOf(specSections);
  const fit = st.fit && !/final sale|non.?returnable/i.test(st.fit) ? titleCase(st.fit) : null;
  const specs: Record<string, string> = Object.fromEntries(Object.entries({
    Brand: "Gymshark",
    "Style code": st.styleCode,
    Gender: gender,
    Category: category,
    Subcategory: subcategory,
    Division: st.division ? titleCase(st.division) : null,
    Range: st.range ? titleCase(st.range) : null,
    Fit: fit,
    Activity: st.activities.length ? st.activities.join(", ") : null,
    Features: st.features.length ? st.features.map(titleCase).join(", ") : null,
    Material: composition,
    Construction: st.seamType && st.seamType.toLowerCase() !== st.division?.toLowerCase() ? (/^c&s$/i.test(st.seamType) ? "Cut & sew" : titleCase(st.seamType)) : null,
    Rise: st.garmentRise ? titleCase(st.garmentRise) : null,
    Length: st.garmentLength ? titleCase(st.garmentLength) : null,
    "Support level": st.braSupport ? titleCase(st.braSupport) : null,
    Pattern: st.patternType ? titleCase(st.patternType) : null,
    Season: st.season ? st.season.toUpperCase() : null,
    Colours: colours.map((c) => c.colour).join(", ") || null,
    "Returns note (Gymshark)": st.fit && /final sale|non.?returnable/i.test(st.fit) ? st.fit.replace(/\*/g, "").trim() : null,
  }).filter(([, v]) => v != null && v !== "")) as Record<string, string>;

  const specTable = `<table><tbody>${Object.entries(specs).filter(([k]) => !/returns note/i.test(k)).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join("")}</tbody></table>`;
  const skuLine = `<p><strong>SKU - ${escapeHtml(st.styleCode)}</strong></p>`;
  const factsHtml = [skuLine, `<h3>Specifications</h3>${specTable}`, "<p> </p>", DISCLAIMER].join("");
  const descriptionHtml = [cleaned, "<p> </p>", skuLine, "<p> </p>", DISCLAIMER].join("");

  const seoTitle = `${title} | Full Size Run`.length <= 70 ? `${title} | Full Size Run` : clip(title, 70);
  const plain = cleaned.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const seoDescription = clip(`Gymshark ${name}${gender ? ` (${gender})` : ""}${colours.length > 1 ? ` in ${colours.length} colours` : colours[0] ? ` in ${colours[0].colour}` : ""}. ${plain}`, 320);

  const images: NormalizedStyle["images"] = [];
  const seenImg = new Set<string>();
  for (const c of ordered) {
    const colour = colours.find((x) => x.sourceProductId === c.productId)!.colour;
    c.images.forEach((im, i) => {
      const key = imageKey(im.url);
      if (seenImg.has(key)) return;
      seenImg.add(key);
      images.push({ key, url: im.url, alt: im.alt ?? `Gymshark ${name} - ${colour}${i ? ` - ${i + 1}` : ""}`, colour });
    });
  }

  const tags = [...new Set([
    ...s.BASE_TAGS.split(",").map((t) => t.trim()).filter(Boolean),
    ...(gender ? [gender] : []),
    ...(category ? [category, `Gymshark ${category}`] : []),
    ...(st.range ? [`Gymshark ${titleCase(st.range)}`] : []),
    ...st.activities.map(titleCase),
  ])];

  const availability = rollup(colours.map((c) => c.availability));
  const missing = [...st.missing];
  if (!composition) missing.push("material composition");
  const n: Omit<NormalizedStyle, "hashes"> = {
    styleCode: st.styleCode, sourceUrl: st.url, canonicalUrl: st.canonicalUrl, handle: st.pageHandle, name, title, brand: "Gymshark", gender, category, subcategory,
    division: st.division, productType, colours, variants, sizeOrder, specs, specSections, descriptionHtml, factsHtml, seoTitle, seoDescription, images, tags,
    availability, weightKg: st.weightKg, missing,
  };
  return {
    ...n,
    hashes: {
      content: hash({ t: n.title, d: n.descriptionHtml, tags: n.tags, v: s.VENDOR, p: n.productType }),
      image: hash(n.images.map((i) => i.key)),
      specification: hash([n.specs, n.specSections]),
      price: hash(n.colours.map((c) => [c.colour, c.currentUsd, c.regularUsd, c.currency])),
      variant: hash(n.variants.map((v) => [v.sku, v.colour, v.size, v.barcode])),
      availability: hash(n.variants.map((v) => [v.sku, v.availability === "out_of_stock" ? 0 : 1])),
    },
  };
}
