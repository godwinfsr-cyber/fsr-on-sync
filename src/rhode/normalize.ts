import { cleanDescription, clip, titleCase } from "../gymshark/normalize.ts";
import { escapeHtml, hash } from "../util.ts";
import { RHODE_SOURCE, categoryCollections, list, parseMap, type RhodeSettings } from "./config.ts";
import { imageKey, isImage, normalizeImageUrl, type PageDetails, type RhodeRawProduct, type RhodeRawVariant } from "./source.ts";

export type Availability = "in_stock" | "out_of_stock";

// ---------- catalog -> FSR products ----------

/**
 * One FSR product. Rhode lists every shade of a line as its own product (peptide-lip-tint-ribbon,
 * peptide-lip-tint-espresso ...) and ties them together with a "pdp:<line>" tag; those become ONE FSR product with a
 * Shade option ("family"). Everything else is one Rhode product -> one FSR product with Rhode's own variants.
 */
export interface RGroup { key: string; family: string | null; members: RhodeRawProduct[] }
export interface Grouping { groups: RGroup[]; excluded: Record<string, number>; excludedHandles: string[] }

type GroupSettings = Pick<RhodeSettings, "EXCLUDED_HANDLES" | "EXCLUDED_PRODUCT_TYPES" | "GROUP_SHADES">;

export const slug = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/\+/g, " ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const words = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim().split(" ");

export function exclusionReason(p: RhodeRawProduct, s: GroupSettings): string | null {
  if (list(s.EXCLUDED_HANDLES).map((x) => x.toLowerCase()).includes(p.handle.toLowerCase())) return "excluded handle (gift wrap / gift card)";
  if (list(s.EXCLUDED_PRODUCT_TYPES).map((x) => x.toLowerCase()).includes(p.product_type.trim().toLowerCase())) return `product type "${p.product_type}"`;
  if (/gift ?card/i.test(p.product_type) || /gift-?card/i.test(p.handle)) return "gift card";
  if (!p.variants.length) return "no variants";
  return null;
}

/** Word prefix shared by every title, each title keeping at least one word after it (the shade). */
function prefixFits(prefix: string[], ms: RhodeRawProduct[]): boolean {
  return prefix.length > 0 && ms.every((m) => { const w = words(m.title); return w.length > prefix.length && prefix.every((x, i) => w[i] === x); });
}
function lcp(ms: RhodeRawProduct[]): string[] {
  const all = ms.map((m) => words(m.title));
  const out: string[] = [];
  for (let i = 0; all.every((w) => i < w.length && w[i] === all[0][i]); i++) out.push(all[0][i]);
  return out;
}

/** The line name of a pdp group ("peptide lip tint") and which members are shades of it. Sets that share the tag
 * ("the spotwear set") and multi-variant members stay separate products. Nothing is guessed: no fit -> no family. */
export function familyOf(tag: string, members: RhodeRawProduct[]): { name: string | null; shades: RhodeRawProduct[]; others: RhodeRawProduct[] } {
  const single = members.filter((m) => m.variants.length === 1);
  const multi = members.filter((m) => m.variants.length !== 1);
  const attempt = (ms: RhodeRawProduct[]) => {
    const tagWords = tag.replace(/^pdp:/i, "").split("-").filter(Boolean);
    if (prefixFits(tagWords, ms)) return tagWords;
    const common = lcp(ms);
    return prefixFits(common, ms) ? common : null;
  };
  let shades = single;
  let others = multi;
  let pre = shades.length ? attempt(shades) : null;
  if (!pre) {
    const sets = single.filter((m) => /^the\s/i.test(m.title) || /\bset\b|\bkit\b|\btrio\b/i.test(m.title));
    const rest = single.filter((m) => !sets.includes(m));
    if (sets.length && rest.length) { pre = attempt(rest); shades = rest; others = [...multi, ...sets]; }
  }
  if (!pre) return { name: null, shades: [], others: members };
  return { name: pre.join(" "), shades, others };
}

export function groupRhodeCatalog(products: RhodeRawProduct[], s: GroupSettings): Grouping {
  const excluded: Record<string, number> = {};
  const excludedHandles: string[] = [];
  const kept: RhodeRawProduct[] = [];
  for (const p of products) {
    const why = exclusionReason(p, s);
    if (why) { excluded[why] = (excluded[why] ?? 0) + 1; excludedHandles.push(p.handle); continue; }
    kept.push(p);
  }
  const order = new Map(kept.map((p, i) => [p.id, i]));
  const byTag = new Map<string, RhodeRawProduct[]>();
  const singles: RhodeRawProduct[] = [];
  for (const p of kept) {
    const tag = s.GROUP_SHADES ? p.tags.find((t) => /^pdp:/i.test(t)) : undefined;
    if (!tag) { singles.push(p); continue; }
    const arr = byTag.get(tag.toLowerCase()) ?? [];
    arr.push(p);
    byTag.set(tag.toLowerCase(), arr);
  }
  // families with the same line name merge (e.g. Rhode's seasonal "summer" peptide lip tints join Peptide Lip Tint)
  const families = new Map<string, { name: string; members: RhodeRawProduct[] }>();
  const orphans: RhodeRawProduct[] = []; // pdp-tagged shades whose own tag group gave no line name (e.g. a lone new shade)
  for (const [tag, ms] of byTag) {
    const f = familyOf(tag, ms);
    if (!f.name) { orphans.push(...f.others); continue; }
    singles.push(...f.others);
    const key = `family:${slug(f.name)}`;
    const cur = families.get(key) ?? { name: f.name, members: [] };
    cur.members.push(...f.shades);
    families.set(key, cur);
  }
  for (const p of orphans) {
    const fam = p.variants.length === 1 && !/^the\s|\bset\b|\bkit\b/i.test(p.title) ? [...families.values()].find((f) => prefixFits(words(f.name), [p])) : undefined;
    if (fam) fam.members.push(p); else singles.push(p);
  }
  const groups: RGroup[] = [
    ...[...families.entries()].map(([key, f]) => ({ key, family: f.name, members: f.members.sort((a, b) => a.id - b.id) })),
    ...singles.map((p) => ({ key: String(p.id), family: null, members: [p] })),
  ];
  // Rhode's own catalog order (newest first), by each group's first appearance
  groups.sort((a, b) => Math.min(...a.members.map((m) => order.get(m.id)!)) - Math.min(...b.members.map((m) => order.get(m.id)!)));
  return { groups, excluded, excludedHandles };
}

// ---------- group -> FSR product ----------

export interface NormalizedVariant {
  sku: string;                   // Rhode variant SKU, kept as-is (e.g. RHS00023-SC6)
  sourceVariantId: string;
  sourceProductId: string;
  handle: string;
  label: string;                 // "Ribbon", "Big (4.2 Oz)", "Default Title"
  optionValues: { optionName: string; name: string }[];
  availability: Availability;
  currentUsd: number | null;     // Rhode's current selling price
  regularUsd: number | null;     // compare-at when on sale, else the current price
  grams: number | null;
  imageKey: string | null;       // the photo shown for this variant
}

export interface NormalizedShade {
  value: string;                 // option value
  sourceProductId: string;
  handle: string;
  url: string;
  sku: string;
  availability: Availability;
  usd: number | null;
  ingredients: string | null;
}

export interface NormalizedGroup {
  key: string;
  family: string | null;
  name: string;                  // Rhode's (line) name, lower case as Rhode writes it
  title: string;                 // Shopify title
  handles: string[];
  primaryHandle: string;
  sourceProductIds: Record<string, string>;
  sourceUrl: string;
  canonicalUrl: string;
  sourceProductType: string;
  productType: string;           // FSR product type = category (Skincare / Makeup / Sets / Accessories)
  category: string;
  subcategory: string | null;
  collections: string[];         // Rhode storefront collections the product is in ("Skincare", "Lip + Cheek" ...)
  optionNames: string[];         // [] = single variant with Shopify's default "Title" option
  variants: NormalizedVariant[];
  shades: NormalizedShade[];
  skuBase: string;
  size: string | null;
  specs: Record<string, string>;
  descriptionHtml: string;
  shortDescription: string;
  factsHtml: string;             // without Rhode's text (used when CONTENT_REUSE_CONFIRMED=false)
  seoTitle: string;
  seoDescription: string;
  images: { key: string; url: string; alt: string; colour: string }[];
  tags: string[];
  availability: Availability;
  sourceUpdatedAt: string | null;
  missing: string[];
  hashes: { content: string; image: string; specification: string; price: string; variant: string; availability: string };
}

export interface GroupContext {
  details: Map<string, PageDetails | null>;   // by handle
  membership: Map<string, Set<number>>;       // Rhode collection handle -> product ids
  collectionTitles: Map<string, string>;      // handle -> title
}

type NormSettings = Pick<RhodeSettings, "TITLE_TEMPLATE" | "BASE_TAGS" | "PRODUCT_TYPE_MAP" | "DEFAULT_PRODUCT_TYPE" | "VENDOR" | "CATEGORY_COLLECTIONS" | "NAV_COLLECTIONS">;

const DISCLAIMER =
  "<p><strong>Disclaimer:</strong> Product images are for reference only. The actual product may vary slightly in color, texture, or details due to lighting, photography angles, or display settings.</p>";
const MAX_MEDIA = 250; // Shopify's per-product media limit
const num = (v: string | null | undefined) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** "raspberry jelly" -> "Raspberry Jelly", "pbj" -> "PBJ", "iphone 16 pro" -> "iPhone 16 Pro", units stay lower case. */
export function displayValue(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").split(" ").map((w) => {
    const lw = w.toLowerCase();
    if (/^iphone/.test(lw)) return `iPhone${w.slice(6)}`;
    if (/^\(?(oz|fl|ml|g|mm)\)?[.,]?$/.test(lw)) return lw;
    if (/^[a-z]{2,4}$/.test(lw) && !/[aeiouy]/.test(lw)) return lw.toUpperCase();
    return w.replace(/^(\(?)([a-z])/, (_m, p, c) => p + c.toUpperCase());
  }).join(" ");
}

/** "Size: 10ml / .3 fl oz." from Rhode's description (null when the description doesn't state it). */
export function sizeFrom(html: string): string | null {
  const text = html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  const m = text.match(/\bsize:\s*([^\n]+?)(?:\.(?=\s|$)|\n|$)/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

export function categoryOf(members: RhodeRawProduct[], ctx: Pick<GroupContext, "membership">, s: Pick<RhodeSettings, "CATEGORY_COLLECTIONS" | "PRODUCT_TYPE_MAP" | "DEFAULT_PRODUCT_TYPE">): { category: string; subcategory: string | null; via: string } {
  const p = members[0];
  const type = p.product_type.trim();
  let category: string | null = null;
  let via = "";
  for (const [handle, cat] of categoryCollections(s)) {
    if (members.some((m) => ctx.membership.get(handle)?.has(m.id))) { category = cat; via = `Rhode collection "${handle}"`; break; }
  }
  if (!category) {
    const map = parseMap(s.PRODUCT_TYPE_MAP);
    category = map[type.toLowerCase()] ?? (/\bset\b|\bkit\b/i.test(type) ? map.set : null) ?? s.DEFAULT_PRODUCT_TYPE;
    via = map[type.toLowerCase()] ? `Rhode product type "${type}"` : "default";
  }
  let subcategory: string | null = null;
  if (category === "Makeup") subcategory = /lip/i.test(type) ? "Lip" : /blush|bronz|cheek|highlight|essence|pearl/i.test(type) ? "Cheek" : null;
  else if (category === "Skincare" || category === "Accessories") subcategory = type ? titleCase(type.toLowerCase()) : null;
  return { category, subcategory, via };
}

function availabilityOf(v: RhodeRawVariant): Availability { return v.available ? "in_stock" : "out_of_stock"; }

function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? "").replace(/\s{2,}/g, " ").trim();
}

function optionOf(v: RhodeRawVariant, pos: number): string | null {
  return ((pos === 1 ? v.option1 : pos === 2 ? v.option2 : v.option3) ?? "").trim() || null;
}

export function normalizeRhode(g: RGroup, ctx: GroupContext, s: NormSettings): NormalizedGroup {
  // primary: for a family the oldest shade (Rhode's original listing of the line), else the product itself
  const primary = g.members[0];
  const { category, subcategory } = categoryOf(g.members, ctx, s);
  const productType = category;
  const name = (g.family ?? primary.title).trim();
  const titleName = titleCase(name.toLowerCase()).replace(/\bRhode\b/gi, "Rhode");
  const title = /\brhode\b/i.test(name) ? titleName : fillTemplate(s.TITLE_TEMPLATE, { title: titleName });
  const optionName = g.family ? (/lip|blush|bronz|cheek|color|essence|highlight|pearl/i.test(g.members.map((m) => m.product_type).join(" ")) ? "Shade" : "Style") : null;

  // ---- variants ----
  const seenSku = new Set<string>();
  const variants: NormalizedVariant[] = [];
  const shades: NormalizedShade[] = [];
  const images: NormalizedGroup["images"] = [];
  const seenImg = new Set<string>();
  const notes: string[] = [];
  const usedValues = new Set<string>();
  const addImages = (p: RhodeRawProduct, colour: string, altBase: string) => {
    let n = 0;
    for (const im of [...p.images].sort((a, b) => a.position - b.position)) {
      if (!isImage(im)) continue;
      const key = imageKey(im.src);
      n++;
      if (seenImg.has(key) || images.length >= MAX_MEDIA) continue;
      seenImg.add(key);
      images.push({ key, url: normalizeImageUrl(im.src), alt: (im.alt && im.alt.trim()) || `${altBase}${n > 1 ? ` - ${n}` : ""}`, colour });
    }
  };
  const firstImageKey = (p: RhodeRawProduct) => { const im = [...p.images].sort((a, b) => a.position - b.position).find(isImage); return im ? imageKey(im.src) : null; };
  const skuOf = (v: RhodeRawVariant) => {
    let sku = (v.sku ?? "").trim().toUpperCase();
    if (!sku) { sku = `RHODE-${v.id}`; notes.push(`variant ${v.id} has no Rhode SKU - identified as ${sku}`); }
    if (seenSku.has(sku)) { notes.push(`Rhode SKU ${sku} is used twice - second use suffixed with its variant id`); sku = `${sku}-${v.id}`; }
    seenSku.add(sku);
    return sku;
  };

  if (g.family) {
    for (const p of g.members) {
      const v = p.variants[0];
      let value = displayValue(words(p.title).slice(words(g.family).length).join(" "));
      if (usedValues.has(value.toLowerCase())) value = `${value} (${p.handle})`;
      usedValues.add(value.toLowerCase());
      const sku = skuOf(v);
      const current = num(v.price);
      const compare = num(v.compare_at_price);
      variants.push({
        sku, sourceVariantId: String(v.id), sourceProductId: String(p.id), handle: p.handle, label: value, optionValues: [{ optionName: optionName!, name: value }],
        availability: availabilityOf(v), currentUsd: current, regularUsd: compare != null && current != null && compare > current ? compare : current, grams: v.grams ?? null,
        imageKey: firstImageKey(p),
      });
      shades.push({ value, sourceProductId: String(p.id), handle: p.handle, url: `${RHODE_SOURCE.origin}/products/${p.handle}`, sku, availability: availabilityOf(v), usd: current, ingredients: ctx.details.get(p.handle)?.ingredients ?? null });
      addImages(p, value, `${title} - ${value}`);
    }
  } else {
    const p = primary;
    const opts = [...p.options].sort((a, b) => a.position - b.position).filter((o) => !(o.name === "Title" && o.values.length === 1 && o.values[0] === "Default Title"));
    for (const v of p.variants) {
      const sku = skuOf(v);
      const current = num(v.price);
      const compare = num(v.compare_at_price);
      const optionValues = opts.map((o) => ({ optionName: displayValue(o.name), name: displayValue(optionOf(v, o.position) ?? "Default") }));
      const own = v.featured_image?.src ?? [...p.images].find((im) => im.variant_ids?.includes(v.id))?.src ?? null;
      variants.push({
        sku, sourceVariantId: String(v.id), sourceProductId: String(p.id), handle: p.handle, label: optionValues.map((o) => o.name).join(" / ") || "Default Title", optionValues,
        availability: availabilityOf(v), currentUsd: current, regularUsd: compare != null && current != null && compare > current ? compare : current, grams: v.grams ?? null,
        imageKey: own ? imageKey(own) : null,
      });
    }
    addImages(p, "product", title);
  }

  // ---- details from the product pages (only what Rhode states) ----
  const det = ctx.details.get(primary.handle) ?? null;
  const tab = (re: RegExp) => Object.entries(det?.tabs ?? {}).find(([k]) => re.test(k))?.[1] ?? [];
  const benefits = tab(/benefit/i);
  const application = tab(/application|how to use|usage/i);
  const keyIngredients = tab(/key ingredient/i);
  const size = sizeFrom(primary.body_html ?? "");
  const ingredientSets = g.family ? shades.map((sh) => [sh.value, sh.ingredients] as const) : [["", det?.ingredients ?? null] as const];
  const distinctIng = [...new Set(ingredientSets.map(([, i]) => i).filter(Boolean))] as string[];

  const skus = variants.map((v) => v.sku);
  const bases = [...new Set(skus.map((x) => x.split("-")[0]))];
  const skuBase = bases.length === 1 ? bases[0] : bases.join(" / ");

  // collections Rhode files the product under (any member), in the storefront's nav order
  const navHandles = list(s.NAV_COLLECTIONS).map((x) => x.toLowerCase());
  const collections = navHandles.filter((h) => g.members.some((m) => ctx.membership.get(h)?.has(m.id))).map((h) => titleCase((ctx.collectionTitles.get(h) ?? h).toLowerCase()));

  const specs: Record<string, string> = Object.fromEntries(Object.entries({
    Brand: s.VENDOR,
    "Rhode product type": primary.product_type ? titleCase(primary.product_type.toLowerCase()) : null,
    Category: category,
    Subcategory: subcategory,
    Size: size,
    [optionName ?? "Options"]: g.family ? shades.map((x) => x.value).join(", ") : variants.length > 1 ? variants.map((v) => v.label).join(", ") : null,
    "Rhode collections": collections.length ? collections.join(", ") : null,
    "Key ingredients": keyIngredients.length ? keyIngredients.map((l) => l.split(/\s+[—–-]\s+/)[0].trim()).join(", ") : null,
    SKU: skuBase,
  }).filter(([, v]) => v != null && v !== "")) as Record<string, string>;

  const cleaned = cleanDescription(primary.body_html ?? "");
  const section = (h: string, body: string) => (body ? `<h3>${h}</h3>${body}` : "");
  const ul = (lines: string[]) => (lines.length ? `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>` : "");
  let ingredientsHtml = "";
  if (distinctIng.length === 1) ingredientsHtml = `<p>${escapeHtml(distinctIng[0])}</p>`;
  // shades differ (colourants / fragrance): one collapsible list per shade keeps the page readable
  else if (distinctIng.length > 1) ingredientsHtml = ingredientSets.filter(([, i]) => i).map(([v, i]) => `<details><summary>${escapeHtml(v)}</summary><p>${escapeHtml(i!)}</p></details>`).join("");
  const skuLine = `<p><strong>SKU - ${escapeHtml(skuBase)}</strong></p>`;
  const descriptionHtml = [
    cleaned,
    section("Benefits", ul(benefits)),
    section("How to use", application.map((l) => `<p>${escapeHtml(l)}</p>`).join("")),
    section("Key ingredients", ul(keyIngredients)),
    section("Ingredients", ingredientsHtml),
    "<p> </p>", skuLine, "<p> </p>", DISCLAIMER,
  ].filter(Boolean).join("");
  const specTable = `<table><tbody>${Object.entries(specs).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join("")}</tbody></table>`;
  const factsHtml = [skuLine, `<h3>Specifications</h3>${specTable}`, "<p> </p>", DISCLAIMER].join("");

  const plain = cleaned.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const shortDescription = clip(plain.split(/(?<=[.!?])\s/)[0] ?? plain, 200);
  const seoTitle = `${title} | Full Size Run`.length <= 70 ? `${title} | Full Size Run` : clip(title, 70);
  const seoDescription = clip(`${title}${g.family ? ` in ${shades.length} ${optionName === "Shade" ? "shades" : "styles"}` : ""}. ${plain}`, 320);

  const tags = [...new Set([
    ...list(s.BASE_TAGS), category, ...(subcategory ? [subcategory] : []),
    ...(primary.product_type ? [`Rhode ${titleCase(primary.product_type.toLowerCase())}`] : []),
  ].filter(Boolean))];

  const availability: Availability = variants.some((v) => v.availability === "in_stock") ? "in_stock" : "out_of_stock";
  const missing: string[] = [...new Set(notes)];
  if (!cleaned.trim()) missing.push("description");
  if (!det) missing.push("product page details (benefits / application / ingredients) - not fetched");
  else {
    if (!benefits.length) missing.push("benefits");
    if (!application.length) missing.push("usage instructions");
    if (!distinctIng.length) missing.push("ingredients");
  }
  if (!size && !g.family && variants.length === 1) missing.push("size");
  if (variants.some((v) => v.currentUsd == null)) missing.push("price (some variants)");
  if (!images.length) missing.push("images");
  const updated = g.members.map((p) => p.updated_at).filter((x): x is string => !!x).sort();

  const n: Omit<NormalizedGroup, "hashes"> = {
    key: g.key, family: g.family, name, title, handles: g.members.map((p) => p.handle), primaryHandle: primary.handle,
    sourceProductIds: Object.fromEntries(g.family ? shades.map((x) => [x.value, x.sourceProductId]) : [["product", String(primary.id)]]),
    sourceUrl: `${RHODE_SOURCE.origin}/products/${primary.handle}`, canonicalUrl: `${RHODE_SOURCE.origin}/products/${primary.handle}`,
    sourceProductType: primary.product_type, productType, category, subcategory, collections,
    optionNames: g.family ? [optionName!] : [...new Set(variants.flatMap((v) => v.optionValues.map((o) => o.optionName)))],
    variants, shades, skuBase, size, specs, descriptionHtml, shortDescription, factsHtml, seoTitle, seoDescription, images, tags, availability,
    sourceUpdatedAt: updated.length ? updated[updated.length - 1] : null, missing,
  };
  return {
    ...n,
    hashes: {
      content: hash({ t: n.title, d: n.descriptionHtml, tags: n.tags, v: s.VENDOR, p: n.productType }),
      image: hash(n.images.map((i) => i.key)),
      specification: hash(n.specs),
      price: hash(n.variants.map((v) => [v.sku, v.currentUsd, v.regularUsd])),
      variant: hash(n.variants.map((v) => [v.sku, v.optionValues])),
      availability: hash(n.variants.map((v) => [v.sku, v.availability === "in_stock" ? 1 : 0])),
    },
  };
}
