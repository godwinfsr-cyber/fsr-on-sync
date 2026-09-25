import { escapeHtml, hash } from "../util.ts";
import { cleanDescription, clip, titleCase } from "../gymshark/normalize.ts";
import { parseMap, type MkSettings } from "./config.ts";
import { isExcludedMichaelKorsProduct, type ExclusionResult } from "./exclusion.ts";
import type { MkStyle } from "./source.ts";

export type Availability = "in_stock" | "out_of_stock";

export interface NormalizedVariant {
  sku: string;                   // FSR variant SKU: <STYLE>-<colour code>[-<size>]  (sizes as sold on FSR: UK for shoes)
  sourceSku: string;             // Michael Kors variant id
  colour: string;
  size: string;
  sourceSize: string;            // as Michael Kors lists it ("5_dot_0", "XS", "NS")
  availability: Availability;
  sourceAvailability: string;    // InStock / OutOfStock / PreOrder ... as Michael Kors states it
  priceUsd: number | null;
  regularUsd: number | null;
}

export interface NormalizedColour {
  colour: string;
  colourCode: string | null;
  currentUsd: number | null;     // highest variant price in this colour (sizes normally share one price)
  regularUsd: number | null;     // michaelkors.com publishes no "was" price in its structured data
  currency: string | null;
  availability: Availability;
}

export interface NormalizedStyle {
  styleCode: string;
  sourceUrl: string;
  canonicalUrl: string | null;
  name: string;
  title: string;
  brand: string;
  gender: "Men" | "Women" | "Kids" | "Unisex" | null;
  category: string | null;       // "Shoes > Boots" (department removed)
  sourceCategory: string | null; // full source path "Women > Shoes > Boots"
  channel: "Outlet" | "Sale" | "New" | null;
  sourceChannel: "regular" | "sale" | "outlet" | "final_sale" | "new_arrival";
  weightSource: string | null;   // where the weight came from ("specification" | "owner category weight") or null
  productType: string;
  colours: NormalizedColour[];
  variants: NormalizedVariant[];
  sizeOrder: string[];
  specs: Record<string, string>;
  specSections: { heading: string; items: string[] }[];
  descriptionHtml: string;
  factsHtml: string;
  seoTitle: string;
  seoDescription: string;
  images: { key: string; url: string; alt: string; colour: string }[];
  tags: string[];
  availability: Availability;
  weightKg: number | null;
  exclusion: ExclusionResult;
  missing: string[];
  hashes: { content: string; image: string; specification: string; price: string; variant: string; availability: string };
}

const DISCLAIMER =
  "<p><strong>Disclaimer:</strong> Product images are for reference only. The actual product may vary slightly in color, texture, or details due to lighting, photography angles, or display settings.</p>";

const SHOE = /\b(shoes?|sneakers?|boots?|sandals?|pumps?|heels?|flats?|loafers?|slides?|mules?|espadrilles?|wedges?|platforms?|slippers?)\b/i;

export function genderOf(path: string[]): NormalizedStyle["gender"] {
  const p = path.map((x) => x.toLowerCase());
  if (p.some((x) => /^(kids?|girls?|boys?)$/.test(x))) return "Kids";
  if (p.some((x) => /^(men|men's|mens)$/.test(x))) return "Men";
  if (p.some((x) => /^(women|women's|womens)$/.test(x))) return "Women";
  return null;
}

/**
 * Storefront size label. fullsizerun.in lists shoes in UK sizes (store rule): men's UK = US - 0.5, women's UK = US - 2.
 * Kids' shoe sizes have no agreed rule yet, so they keep the US label ("US 3") and are flagged.
 */
export function sizeLabel(raw: string, isShoe: boolean, gender: NormalizedStyle["gender"]): { size: string; flag?: string } {
  // Michael Kors encodes punctuation in size values: 5_dot_5 -> 5.5, L_fslash_XL -> L/XL
  const TOKENS: Record<string, string> = { dot: ".", fslash: "/", slash: "/", dash: "-", hyphen: "-", comma: ",", plus: "+", amp: "&" };
  const s = raw.trim().replace(/_/g, " ").replace(/\s+(dot|fslash|slash|dash|hyphen|comma|plus|amp)\s+/gi, (_m, t: string) => TOKENS[t.toLowerCase()]).replace(/\s+/g, " ").trim();
  if (!s || /^(ns|os|one ?size|no size|default( title)?)$/i.test(s)) return { size: "One Size" };
  const n = Number(s);
  if (isShoe && Number.isFinite(n)) {
    const fmt = (x: number) => String(Math.round(x * 10) / 10);
    if (gender === "Women") return { size: fmt(n - 2) };
    if (gender === "Men") return { size: fmt(n - 0.5) };
    return { size: `US ${fmt(n)}`, flag: "shoe sizes kept in US (no UK conversion rule for this department)" };
  }
  if (Number.isFinite(n)) return { size: String(n) };
  return { size: /^[0-9]*x*[sml]$|^[0-9]?xl$/i.test(s) ? s.toUpperCase() : s };
}

export function productTypeOf(categoryPath: string, name: string, s: Pick<MkSettings, "PRODUCT_TYPE_MAP" | "DEFAULT_PRODUCT_TYPE">): string {
  const map = parseMap(s.PRODUCT_TYPE_MAP);
  const hay = `${categoryPath} ${name}`.toLowerCase();
  for (const [k, v] of Object.entries(map)) if (hay.includes(k)) return v;
  return s.DEFAULT_PRODUCT_TYPE;
}

/** Highest-resolution rendition the image server offers (ECOM_Image_Zoom = 1300 x 1750 vs Large = 796 x 1072). */
export function hiRes(url: string): string {
  return url.replace(/\/transform\/ECOM_Image_[A-Za-z]+\//, "/transform/ECOM_Image_Zoom/");
}

export function imageKey(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/i, "").split("?")[0].toLowerCase();
}

/** "Weight: 1.2 lbs" / "Weight 540g" in the source specification -> kg. Only an explicitly labelled weight counts. */
export function weightFromText(text: string): number | null {
  const m = text.match(/\bweight\b[^0-9]{0,15}(\d+(?:\.\d+)?)\s*(kg|kilograms?|g|grams?|lbs?|pounds?|oz|ounces?)\b/i);
  if (!m) return null;
  const v = Number(m[1]);
  const u = m[2].toLowerCase();
  const kg = u.startsWith("k") ? v : u.startsWith("g") ? v / 1000 : u.startsWith("l") || u.startsWith("p") ? v * 0.45359237 : v * 0.028349523;
  return kg > 0 && kg < 100 ? Math.round(kg * 1000) / 1000 : null;
}

function weightFor(path: string, spec: string): number | null {
  if (!spec.trim()) return null;
  const map = parseMap(spec);
  const hay = path.toLowerCase();
  for (const [k, v] of Object.entries(map)) if (hay.includes(k) && Number(v) > 0) return Number(v);
  return null;
}

const rank = (x: string) => {
  const order = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "2XL", "3XL"];
  const i = order.indexOf(x.toUpperCase());
  if (i >= 0) return i;
  const n = Number(x.replace(/^US\s*/i, ""));
  return Number.isFinite(n) ? 100 + n : 1000;
};

export function normalizeMk(st: MkStyle, s: Pick<MkSettings, "PRODUCT_TYPE_MAP" | "DEFAULT_PRODUCT_TYPE" | "BASE_TAGS" | "VENDOR" | "CATEGORY_WEIGHT_KG" | "EXCLUDED_CATEGORIES">): NormalizedStyle {
  const path = (st.category ?? "").split(">").map((x) => x.trim()).filter(Boolean);
  const crumbs = st.breadcrumbs.slice(0, -1);
  const fullPath = path.length ? path : crumbs;
  const channel = fullPath.find((x) => /^(outlet|sale|new)$/i.test(x));
  const gender = genderOf(fullPath);
  const catParts = fullPath.filter((x) => !/^(outlet|sale|new|women|men|kids|women's|men's|view all)$/i.test(x));
  const category = catParts.length ? catParts.join(" > ") : null;
  const name = st.name.replace(/^michael\s+kors\s+/i, "").trim();
  const title = `Michael Kors ${name}`;
  const isShoe = !/clothing/i.test(fullPath.join(" ")) && SHOE.test(`${fullPath.join(" ")} ${name}`);
  const productType = productTypeOf(fullPath.join(" > "), name, s);
  const missing = [...st.missing];

  const exclusion = isExcludedMichaelKorsProduct(
    { title: st.name, category: st.category, breadcrumbs: st.breadcrumbs, url: st.url, canonicalUrl: st.canonicalUrl, description: st.description },
    s.EXCLUDED_CATEGORIES.split(","),
  );

  // ---- variants (Color x Size exactly as listed) ----
  const variants: NormalizedVariant[] = [];
  const flags = new Set<string>();
  const seenSku = new Set<string>();
  for (const v of st.variants) {
    const colour = titleCase(v.colour.toLowerCase());
    const { size, flag } = sizeLabel(v.size, isShoe, gender);
    if (flag) flags.add(flag);
    const cc = v.colourCode ?? colour.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 6);
    const sku = `${st.styleCode}-${cc}${size === "One Size" ? "" : `-${size.replace(/\s+/g, "")}`}`;
    if (seenSku.has(sku)) continue; // same colour + size listed twice
    seenSku.add(sku);
    variants.push({ sku, sourceSku: v.sourceSku, colour, size, sourceSize: v.size, availability: v.inStock ? "in_stock" : "out_of_stock", sourceAvailability: v.availability, priceUsd: v.priceUsd, regularUsd: v.regularUsd });
  }
  missing.push(...flags);
  const sizeOrder = [...new Set(variants.map((v) => v.size))].sort((a, b) => rank(a) - rank(b));

  const colours: NormalizedColour[] = [];
  for (const c of [...new Set(variants.map((v) => v.colour))]) {
    const vs = variants.filter((v) => v.colour === c);
    const prices = vs.map((v) => v.priceUsd).filter((x): x is number => x != null);
    const src = st.variants.find((v) => titleCase(v.colour.toLowerCase()) === c && v.priceUsd != null && v.currency) ?? st.variants.find((v) => titleCase(v.colour.toLowerCase()) === c);
    if (new Set(prices).size > 1) missing.push(`${c}: sizes have different prices ($${Math.min(...prices)}–$${Math.max(...prices)}); the highest is used`);
    const regs = vs.map((v) => v.regularUsd).filter((x): x is number => x != null);
    // the page's own "Was / Now" block applies to the colour(s) currently selling at that "Now" price
    const cur = prices.length ? Math.max(...prices) : null;
    if (!regs.length && st.listPriceUsd != null && cur != null && st.salePriceUsd != null && cur === st.salePriceUsd && st.listPriceUsd > cur) regs.push(st.listPriceUsd);
    colours.push({
      colour: c, colourCode: src?.colourCode ?? null, currentUsd: prices.length ? Math.max(...prices) : null, regularUsd: regs.length ? Math.max(...regs) : null, currency: src?.currency ?? null,
      availability: vs.some((v) => v.availability === "in_stock") ? "in_stock" : "out_of_stock",
    });
  }

  // ---- images: the page gallery, then each other colour's own photo ----
  const images: NormalizedStyle["images"] = [];
  const seen = new Set<string>();
  const colourOfImage = (u: string) => colours.find((c) => c.colourCode && new RegExp(`-${c.colourCode}-`, "i").test(u))?.colour ?? colours[0]?.colour ?? "Default";
  const push = (raw: string) => {
    const u = hiRes(raw);
    const key = imageKey(u);
    if (seen.has(key)) return;
    seen.add(key);
    const colour = colourOfImage(u);
    const n = images.filter((i) => i.colour === colour).length;
    images.push({ key, url: u, alt: `${title} - ${colour}${n ? ` - ${n + 1}` : ""}`, colour });
  };
  st.images.forEach(push);
  for (const v of st.variants) if (v.image) push(v.image);

  // ---- content (authorized reuse of Michael Kors' description) ----
  const specs: Record<string, string> = Object.fromEntries(Object.entries({
    Brand: "Michael Kors", "Style number": st.styleCode, Department: gender, Category: category, Collection: channel ?? null,
    Colours: colours.map((c) => c.colour).join(", ") || null, Sizes: sizeOrder.filter((x) => x !== "One Size").join(", ") || null,
    "Size system": isShoe && (gender === "Women" || gender === "Men") ? "UK" : null,
  }).filter(([, v]) => v != null && v !== "")) as Record<string, string>;
  const specTable = `<table><tbody>${Object.entries(specs).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join("")}</tbody></table>`;
  const skuLine = `<p><strong>SKU - ${escapeHtml(st.styleCode)}</strong></p>`;
  // the page's Details section keeps Michael Kors' formatting and exact figures; JSON-LD text is the fallback
  const details = st.detailsHtml ? cleanDescription(st.detailsHtml).replace(/(<br\s*\/?>\s*)?•?\s*Style\s*#\s*[A-Z0-9-]+\s*/gi, "") : "";
  const plainDetails = details.replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").trim();
  const body = details || (st.description ? `<p>${escapeHtml(st.description)}</p>` : "");
  const descriptionHtml = [body, `<h3>Specifications</h3>${specTable}`, "<p> </p>", skuLine, "<p> </p>", DISCLAIMER].join("");
  const factsHtml = [skuLine, `<h3>Specifications</h3>${specTable}`, "<p> </p>", DISCLAIMER].join("");
  const seoTitle = `${title} | Full Size Run`.length <= 70 ? `${title} | Full Size Run` : clip(title, 70);
  const seoDescription = clip(`${title}${colours.length > 1 ? ` in ${colours.length} colours` : colours[0] ? ` in ${colours[0].colour}` : ""}. ${plainDetails.replace(/\s*\n\s*/g, " ") || st.description}`, 320);

  const availability: Availability = colours.some((c) => c.availability === "in_stock") ? "in_stock" : "out_of_stock";
  // actual weight when Michael Kors states one; else an owner-configured category weight; else unknown (fallback shipping)
  const stated = weightFromText(plainDetails) ?? weightFromText(st.description);
  const ownerWeight = stated == null ? weightFor(fullPath.join(" > "), s.CATEGORY_WEIGHT_KG) : null;
  const weightKg = stated ?? ownerWeight;
  const weightSource = stated != null ? "specification" : ownerWeight != null ? "owner category weight" : null;
  if (weightKg == null) missing.push("weight (not stated by Michael Kors)");
  const onSale = colours.some((c) => c.regularUsd != null && c.currentUsd != null && c.currentUsd < c.regularUsd);
  const finalSale = /final sale/i.test(`${fullPath.join(" ")} ${st.description}`);
  const sourceChannel: NormalizedStyle["sourceChannel"] = finalSale ? "final_sale" : /^outlet$/i.test(channel ?? "") ? "outlet" : /^sale$/i.test(channel ?? "") || onSale ? "sale" : /^new$/i.test(channel ?? "") ? "new_arrival" : "regular";
  const leaf = catParts.at(-1) ? titleCase(catParts.at(-1)!.toLowerCase()) : null;
  const tags = [...new Set([
    ...s.BASE_TAGS.split(",").map((t) => t.trim()).filter(Boolean),
    ...(gender ? [gender] : []),
    ...(leaf ? [leaf, `Michael Kors ${leaf}`] : []),
    ...(channel ? [`Michael Kors ${titleCase(channel.toLowerCase())}`] : []),
    ...(sourceChannel !== "regular" ? [sourceChannel.replace("_", "-")] : []),
  ])];

  const n: Omit<NormalizedStyle, "hashes"> = {
    styleCode: st.styleCode, sourceUrl: st.url, canonicalUrl: st.canonicalUrl, name, title, brand: "Michael Kors", gender, category, sourceCategory: st.category,
    channel: (channel ? titleCase(channel.toLowerCase()) : null) as NormalizedStyle["channel"], sourceChannel, weightSource, productType, colours, variants, sizeOrder, specs,
    specSections: [], descriptionHtml, factsHtml, seoTitle, seoDescription, images, tags, availability, weightKg, exclusion, missing,
  };
  return {
    ...n,
    hashes: {
      content: hash({ t: n.title, d: n.descriptionHtml, tags: n.tags, v: s.VENDOR, p: n.productType }),
      image: hash(n.images.map((i) => i.key)),
      specification: hash(n.specs),
      price: hash(n.colours.map((c) => [c.colour, c.currentUsd, c.regularUsd, c.currency, n.weightKg])),
      variant: hash(n.variants.map((v) => [v.sku, v.colour, v.size])),
      availability: hash(n.variants.map((v) => [v.sku, v.availability === "out_of_stock" ? 0 : 1])),
    },
  };
}
