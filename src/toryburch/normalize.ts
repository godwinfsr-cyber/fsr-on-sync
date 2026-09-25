import { escapeHtml, hash } from "../util.ts";
import { clip, titleCase } from "../gymshark/normalize.ts";
import { imageKey, sizeLabel } from "../michaelkors/normalize.ts";
import { parseMap, type TbSettings } from "./config.ts";
import { isExcludedToryBurchProduct, type ExclusionResult } from "./exclusion.ts";
import type { TbStyle } from "./source.ts";

export { imageKey };
export type Availability = "in_stock" | "out_of_stock";

export interface NormalizedVariant {
  sku: string;                   // FSR variant SKU: <STYLE>-<colour code>[-<size>]  (shoe sizes as sold on FSR: UK)
  sourceSku: string;             // Tory Burch variant id (UPC)
  sourceStyleNumber: string | null; // "135634-928"
  colour: string;
  size: string;
  sourceSize: string;            // as Tory Burch lists it ("7.5", "OS", "XS")
  availability: Availability;
  stockStatus: string | null;
  priceUsd: number | null;
  regularUsd: number | null;
}

export interface NormalizedColour {
  colour: string;
  colourCode: string | null;
  currentUsd: number | null;     // current selling price (sale price when on sale); highest across sizes
  regularUsd: number | null;     // original price, only when genuinely on sale (> current)
  currency: string | null;
  availability: Availability;
}

export interface NormalizedStyle {
  styleCode: string;
  sourceUrl: string;
  canonicalUrl: string | null;
  handle: string;
  name: string;
  title: string;
  brand: string;
  gender: "Women" | "Men" | "Kids" | "Unisex" | null;
  department: string | null;
  productClass: string | null;
  category: string | null;       // "Handbags > Shoulder Bags"
  sourceCategory: string | null; // same (Tory Burch department > class [> subclass])
  collection: string | null;     // "Sale", "New", ... (breadcrumb / classification)
  breadcrumbs: string[];
  staticUrl: string | null;
  onSale: boolean;
  productType: string;
  colours: NormalizedColour[];
  variants: NormalizedVariant[];
  sizeOrder: string[];
  specs: Record<string, string>;
  details: string[];
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
  hashes: { content: string; image: string; specification: string; price: string; variant: string; availability: string; product: string };
}

const DISCLAIMER =
  "<p><strong>Disclaimer:</strong> Product images are for reference only. The actual product may vary slightly in color, texture, or details due to lighting, photography angles, or display settings.</p>";

const DIMENSION = /\b(length|height|width|depth|drop|heel height|platform|diameter|dimensions?|measures|circumference|lens|bridge|temple)\b\s*:?|\d+(\.\d+)?"\s*\(\d/i;
const CARE = /\b(dry clean|hand wash|machine wash|spot clean|do not (wash|bleach|tumble)|wipe clean|care)\b/i;
const MATERIAL = /\b(leather|suede|canvas|cotton|silk|wool|cashmere|linen|polyester|nylon|viscose|rayon|brass|metal|gold|silver|plated|crystal|pearl|acetate|rubber|lining|upper|sole|outsole|insole|%)\b/i;

export function productTypeOf(categoryPath: string, name: string, s: Pick<TbSettings, "PRODUCT_TYPE_MAP" | "DEFAULT_PRODUCT_TYPE">): string {
  const map = parseMap(s.PRODUCT_TYPE_MAP);
  const hay = (categoryPath || name).toLowerCase();
  for (const [k, v] of Object.entries(map)) if (hay.includes(k)) return v;
  return s.DEFAULT_PRODUCT_TYPE;
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
  if (x === "00") return 99;
  const n = Number(x.replace(/^US\s*/i, "").replace(/\s.*$/, ""));
  return Number.isFinite(n) ? 100 + n : 1000;
};

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

export function normalizeTb(st: TbStyle, s: Pick<TbSettings, "PRODUCT_TYPE_MAP" | "DEFAULT_PRODUCT_TYPE" | "BASE_TAGS" | "VENDOR" | "CATEGORY_WEIGHT_KG" | "EXCLUDED_CATEGORIES">): NormalizedStyle {
  const name = st.name.replace(/^tory\s+burch\s+/i, "").replace(/®/g, "").trim();
  const title = `Tory Burch ${name}`;
  const category = st.category;
  const isShoe = /^shoes?$/i.test(st.department ?? "") || (!st.department && /\/shoes\//i.test(st.url));
  // toryburch.com/en-us sells womenswear: its shoe sizes are US women's -> FSR lists UK women's (US - 2)
  const gender: NormalizedStyle["gender"] = "Women";
  const onSale = st.variants.some((v) => v.regularUsd != null) || st.breadcrumbs.some((b) => /^sale\b/i.test(b));
  // topLevelClassificationCategoryName is an internal merchandising label ("Image Check", "Hidden Category", "Exclusions"):
  // only the customer-facing Sale / New collections are kept
  const collection = st.breadcrumbs.find((b) => /^(sale|new|new arrivals)$/i.test(b)) ?? (st.collection && /^(sale|new|new arrivals)$/i.test(st.collection) ? st.collection : null);
  const productType = productTypeOf(category ?? "", name, s);
  const missing = [...st.missing];

  const exclusion = isExcludedToryBurchProduct({
    title: st.name, department: st.department, productClass: st.productClass, subclass: st.subclass, category, breadcrumbs: st.breadcrumbs,
    collection: st.primaryCategoryId, url: st.url, canonicalUrl: st.canonicalUrl, staticUrl: st.staticUrl, variantNames: st.variantNames,
    description: [st.description, ...st.details].join(" "),
  }, s.EXCLUDED_CATEGORIES.split(","));

  // ---- variants (Color x Size exactly as listed; width kept in the size label where Tory Burch lists one) ----
  const variants: NormalizedVariant[] = [];
  const flags = new Set<string>();
  const seenSku = new Set<string>();
  for (const v of st.variants) {
    const colour = titleCase(v.colour.toLowerCase());
    // clothing sizes are labels, not numbers: "00" and "0" are different dress sizes, so only shoes / one-size go through sizeLabel
    const { size: base, flag } = isShoe || /^(ns|os|one ?size|no size)$/i.test(v.size.trim()) ? sizeLabel(v.size, isShoe, gender) : { size: v.size.trim().toUpperCase(), flag: undefined };
    if (flag) flags.add(flag);
    const size = v.width && !/^(m|medium|b|regular|standard)$/i.test(v.width) ? `${base} ${v.width.toUpperCase()}` : base;
    const cc = v.colourCode ?? colour.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 6);
    const sku = `${st.styleCode}-${cc}${size === "One Size" ? "" : `-${size.replace(/\s+/g, "")}`}`;
    if (seenSku.has(sku)) continue; // same colour + size listed twice
    seenSku.add(sku);
    variants.push({
      sku, sourceSku: v.sourceVariantId, sourceStyleNumber: v.styleNumber, colour, size, sourceSize: v.width ? `${v.size} ${v.width}` : v.size,
      availability: v.inStock ? "in_stock" : "out_of_stock", stockStatus: v.stockStatus, priceUsd: v.priceUsd, regularUsd: v.regularUsd,
    });
  }
  missing.push(...flags);
  const sizeOrder = [...new Set(variants.map((v) => v.size))].sort((a, b) => rank(a) - rank(b));

  const colours: NormalizedColour[] = [];
  for (const c of [...new Set(variants.map((v) => v.colour))]) {
    const vs = variants.filter((v) => v.colour === c);
    const prices = vs.map((v) => v.priceUsd).filter((x): x is number => x != null);
    const regulars = vs.map((v) => v.regularUsd).filter((x): x is number => x != null);
    const src = st.variants.find((v) => titleCase(v.colour.toLowerCase()) === c);
    if (new Set(prices).size > 1) missing.push(`${c}: sizes have different prices ($${Math.min(...prices)}–$${Math.max(...prices)}); the highest is used`);
    const current = prices.length ? Math.max(...prices) : null;
    const regular = regulars.length ? Math.max(...regulars) : null;
    colours.push({
      colour: c, colourCode: src?.colourCode ?? null, currentUsd: current, regularUsd: regular != null && current != null && regular > current ? regular : null, currency: src?.currency ?? null,
      availability: vs.some((v) => v.availability === "in_stock") ? "in_stock" : "out_of_stock",
    });
  }

  // ---- images: each colour's gallery (variant images), then any group images; de-duplicated by image path ----
  const images: NormalizedStyle["images"] = [];
  const seen = new Set<string>();
  const push = (u: string, colour: string) => {
    const key = imageKey(u);
    if (seen.has(key)) return;
    seen.add(key);
    const n = images.filter((i) => i.colour === colour).length;
    images.push({ key, url: u, alt: `${title} - ${colour}${n ? ` - ${n + 1}` : ""}`, colour });
  };
  for (const v of st.variants) for (const u of v.images) push(u, titleCase(v.colour.toLowerCase()));
  for (const u of st.images) push(u, colours[0]?.colour ?? "Default");

  // ---- content (authorized reuse of Tory Burch's description, details and specifications) ----
  const dims = st.details.filter((d) => DIMENSION.test(d));
  const care = st.details.filter((d) => CARE.test(d) && !dims.includes(d));
  const materials = st.details.filter((d) => MATERIAL.test(d) && !dims.includes(d) && !care.includes(d));
  const specs: Record<string, string> = Object.fromEntries(Object.entries({
    Brand: "Tory Burch", "Style number": st.styleCode, Department: st.department, Category: st.productClass ? [st.productClass, st.subclass].filter(Boolean).join(" > ") : null,
    Collection: collection, Colours: colours.map((c) => c.colour).join(", ") || null, Sizes: sizeOrder.filter((x) => x !== "One Size").join(", ") || null,
    "Size system": isShoe ? "UK (women's)" : null, Material: st.material ? titleCase(st.material) : materials.join("; ") || null,
    Dimensions: dims.join("; ") || null, Care: care.join("; ") || null,
  }).filter(([, v]) => v != null && v !== "")) as Record<string, string>;
  const specTable = `<table><tbody>${Object.entries(specs).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join("")}</tbody></table>`;
  const skuLine = `<p><strong>SKU - ${escapeHtml(st.styleCode)}</strong></p>`;
  const body = st.description ? `<p>${escapeHtml(st.description)}</p>` : "";
  const detailList = st.details.length ? `<ul>${st.details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>` : "";
  const descriptionHtml = [body, detailList, `<h3>Specifications</h3>${specTable}`, "<p> </p>", skuLine, "<p> </p>", DISCLAIMER].join("");
  const factsHtml = [skuLine, `<h3>Specifications</h3>${specTable}`, "<p> </p>", DISCLAIMER].join("");
  const seoTitle = `${title} | Full Size Run`.length <= 70 ? `${title} | Full Size Run` : clip(title, 70);
  const seoDescription = clip(`${title}${colours.length > 1 ? ` in ${colours.length} colours` : colours[0] ? ` in ${colours[0].colour}` : ""}. ${st.description}`, 320);

  const leaf = st.productClass ? titleCase(st.productClass.toLowerCase()) : null;
  const tags = [...new Set([
    ...s.BASE_TAGS.split(",").map((t) => t.trim()).filter(Boolean),
    ...(gender ? [gender] : []),
    ...(st.department ? [`Tory Burch ${titleCase(st.department.toLowerCase())}`] : []),
    ...(leaf ? [leaf, `Tory Burch ${leaf}`] : []),
  ])];

  const availability: Availability = colours.some((c) => c.availability === "in_stock") ? "in_stock" : "out_of_stock";
  const weightKg = weightFor([st.department, st.productClass, st.subclass].filter(Boolean).join(" > "), s.CATEGORY_WEIGHT_KG);
  const n: Omit<NormalizedStyle, "hashes"> = {
    styleCode: st.styleCode, sourceUrl: st.url, canonicalUrl: st.canonicalUrl, handle: slugify(`tory-burch-${name}-${st.styleCode}`), name, title, brand: "Tory Burch", gender,
    department: st.department, productClass: st.productClass, category, sourceCategory: [st.department, st.productClass, st.subclass].filter(Boolean).join(" > ") || null,
    collection, breadcrumbs: st.breadcrumbs, staticUrl: st.staticUrl, onSale, productType, colours, variants, sizeOrder, specs, details: st.details,
    descriptionHtml, factsHtml, seoTitle, seoDescription, images, tags, availability, weightKg, exclusion, missing,
  };
  const hashes = {
    content: hash({ t: n.title, d: n.descriptionHtml, tags: n.tags, v: s.VENDOR, p: n.productType }),
    image: hash(n.images.map((i) => i.key)),
    specification: hash(n.specs),
    price: hash(n.colours.map((c) => [c.colour, c.currentUsd, c.regularUsd, c.currency])),
    variant: hash(n.variants.map((v) => [v.sku, v.colour, v.size])),
    availability: hash(n.variants.map((v) => [v.sku, v.availability === "out_of_stock" ? 0 : 1])),
  };
  return { ...n, hashes: { ...hashes, product: hash(hashes) } };
}
