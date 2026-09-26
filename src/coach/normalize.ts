// Harvested coach.com product page -> per-colour listings. Everything comes from Coach's own page data (JSON-LD
// ProductGroup / Product / BreadcrumbList + the storefront's embedded product object); nothing is invented - a field
// the page does not carry stays null.
//
// Coach variant ids are fixed-width: "CDE37 YNL  7   B" = style(6) colour(5) size(4) width, "CV933 IMXAQ" = style colour.
// ONE Full Size Run product = one Coach style + colour ("CV933-IMXAQ"), exactly like the store's existing Coach products
// (coach_sync.source_product_id). A style page can list variants of OTHER style numbers (e.g. the C1231 wallet page carries
// CW385 colours), so listings are keyed by the variant's own style + colour, never by the page URL.

export type Json = Record<string, unknown>;

export interface FeedEntry {
  url: string;                  // requested path or absolute URL (mainline or /products/outlet/...)
  finalUrl?: string;
  canonical?: string | null;
  title?: string;
  gone?: boolean;
  status?: number;
  ld: Json[];
  webDesc?: string | null;      // WebPage JSON-LD description: "<li> ...\n<li> ..." bullet list
  main?: {
    id?: string; masterId?: string; orderable?: boolean;
    customAttributes?: Record<string, unknown>;
    pricingInfo?: { list?: { value?: number; currency?: string } | null; sales?: { value?: number; currency?: string } | null; promotionalPrice?: unknown }[];
    variationAttributes?: { id: string; name: string; values: { name: string; value: string; orderable?: boolean }[] }[];
    variantsAssigned?: string[];
    canonicals?: Record<string, string>;
    images?: { src: string; alt?: string }[];
  } | null;
  longDescription?: string | null;
  itemCategory?: string[] | null;
  categoryId?: string | null;
  imageSequence?: string | null;
}

export interface ListingVariant {
  sourceSku: string;            // raw Coach variant id, e.g. "CDE37 YNL  7   B"
  size: string | null;          // Coach size as listed ("7", "XS", "M/L", "ONE") - null for colour-only products
  width: string | null;         // shoe width letter where Coach lists one ("B", "D")
  gtin: string | null;
  priceUsd: number | null;      // current selling price (Coach's sale price when on sale)
  currency: string | null;
  inStock: boolean;
}

export interface Listing {
  key: string;                  // "CV933-IMXAQ" (style-colour, Coach's own product reference)
  style: string;                // "CV933"
  colourCode: string;           // "IMXAQ"
  colourName: string | null;    // "Gold/Walnut/Black"
  name: string;                 // "Teri Shoulder Bag In Signature Canvas"
  pageStyle: string;            // style number of the page this listing was read from
  ownPage: boolean;             // listing's style = the page's own style (most authoritative page for it)
  isMainColour: boolean;        // the colour the storefront rendered (its embedded object / list price belong to it)
  sourceUrl: string;            // absolute URL that was read
  finalUrl: string | null;
  canonicalUrl: string | null;
  outletUrl: string | null;     // /products/outlet/... form, when Coach lists the style in the Outlet
  mainlineUrl: string | null;   // /products/... (non-outlet) form, when Coach lists it on mainline
  reach: string | null;         // Coach c_productReach: retail | outlet | multi
  isOutlet: boolean;
  gender: string | null;        // Women | Men | Unisex (Coach c_gender)
  category: string | null;      // "Women > Bags > Shoulder Bags" (item_category / breadcrumbs)
  subcategory: string | null;   // Coach classification, e.g. "Bags", "Other Shoes"
  filterCategory: string | null;// e.g. "CARD CASES"
  categoryId: string | null;    // e.g. "outlet-wallets-card-cases"
  breadcrumbs: string[];
  collection: string | null;    // Outlet | Sale | New | Disney X Coach ... (customer-facing collection)
  material: string | null;
  dimensions: string | null;    // '9 1/2" (L) x 6" (H) x 3" (W)' from the details list, else JSON-LD measurements
  descriptionText: string | null; // Coach's prose description (JSON-LD description) when it is prose
  details: string[];            // Coach's bullet list (materials, closures, dimensions ...)
  features: string[];
  variants: ListingVariant[];
  regularUsd: number | null;    // Coach's list / original price (only where the page states it for this style)
  images: string[];             // image base URLs from the page, in Coach's order (no rendition params)
  imageSuffixHints: string[];   // gallery view codes Coach uses for this product family (a0, a3, a8 ...)
  missing: string[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v != null ? [v as T] : []);
const ORIGIN = "https://www.coach.com";

export const htmlText = (s: string) => s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim();

/** "<li> a\n<li> b<li>Style No. X</li>" -> ["a", "b", "Style No. X"] */
export function bullets(html: string | null | undefined): string[] {
  if (!html) return [];
  return html.split(/<li[^>]*>/i).map((x) => htmlText(x.replace(/<\/li>/gi, ""))).filter(Boolean);
}

/** Fixed-width Coach variant id -> parts. Also accepts the dashed URL form ("CV933-IMXAQ"). */
export function parseVariantId(raw: string): { style: string; colour: string; size: string | null; width: string | null } | null {
  const s = String(raw ?? "").replace(/%2F/gi, "/");
  if (!s.trim()) return null;
  if (!/\s/.test(s.trim()) && /^[A-Z0-9]+-[A-Z0-9/]+$/i.test(s.trim())) {
    const [style, colour] = s.trim().toUpperCase().split("-");
    return { style, colour, size: null, width: null };
  }
  const style = s.slice(0, 6).trim().toUpperCase();
  const colour = s.slice(6, 11).trim().toUpperCase();
  const size = s.slice(11, 15).trim() || null;
  const width = s.slice(15).trim() || null;
  if (!style || !colour) return null;
  return { style, colour, size: size ? size.toUpperCase() : null, width: width ? width.toUpperCase() : null };
}

export const productKey = (style: string, colour: string) => `${style.trim().toUpperCase()}-${colour.trim().toUpperCase()}`;

export function absUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try { return new URL(u, ORIGIN).toString(); } catch { return null; }
}
export const isOutletPath = (u: string | null | undefined) => !!u && /\/products\/outlet\//i.test(u);
/** Same product URL whether reached through mainline or Outlet, with or without query / colour suffix. */
export function normalizeUrl(u: string | null | undefined): string | null {
  const a = absUrl(u);
  if (!a) return null;
  const x = new URL(a);
  let p = decodeURIComponent(x.pathname).toLowerCase().replace(/\/products\/outlet\//, "/products/").replace(/\/+$/, "");
  p = p.replace(/\/([a-z0-9]+)(?:[- ][a-z0-9/]+)?\.html$/, "/$1.html");
  return `https://www.coach.com${p}`;
}

/** Style number from a product route: /products/teri-shoulder-bag/CV933-IMXAQ.html -> CV933 */
export function styleFromUrl(u: string): string | null {
  const m = decodeURIComponent(absUrl(u) ? new URL(absUrl(u)!).pathname : u).match(/\/([A-Za-z0-9]+)(?:[- ][A-Za-z0-9/]+)?\.html$/);
  return m ? m[1].toUpperCase() : null;
}

const imageBase = (u: string) => u.replace(/\?.*$/, "").replace(/_(?:a\d+|_?v\d+|swatch)$/i, "");
const imageSuffix = (u: string) => (u.replace(/\?.*$/, "").match(/_((?:a\d+))$/i)?.[1] ?? null);

function dimensionsOf(details: string[], ldVariant: Json | undefined): string | null {
  const d = details.find((x) => /\d[\d\s/]*"\s*\((?:L|H|W)\)/i.test(x) || /\(L\)\s*x/i.test(x));
  if (d) return d;
  if (!ldVariant) return null;
  const q = (k: string) => num((ldVariant[k] as Json | undefined)?.value);
  const [h, w, dep] = [q("height"), q("width"), q("depth")];
  return h || w || dep ? [dep != null ? `${dep}" (L)` : null, h != null ? `${h}" (H)` : null, w != null ? `${w}" (W)` : null].filter(Boolean).join(" x ") : null;
}

/** Parses one harvested page into per-colour listings (a page can hold several colours and even several style numbers). */
export function parseEntry(e: FeedEntry): Listing[] {
  if (e.gone) return [];
  const group = e.ld.find((x) => x["@type"] === "ProductGroup");
  const single = e.ld.find((x) => x["@type"] === "Product");
  const base = group ?? single;
  if (!base) return [];
  const crumbsLd = e.ld.find((x) => x["@type"] === "BreadcrumbList");
  const breadcrumbs = arr<Json>(crumbsLd?.itemListElement).sort((a, b) => (num(a.position) ?? 0) - (num(b.position) ?? 0))
    .map((i) => str(i.name) ?? "").filter(Boolean).slice(0, -1); // last crumb is the product itself
  const sourceUrl = absUrl(e.url)!;
  const ca = (e.main?.customAttributes ?? {}) as Record<string, unknown>;
  const mainKey = str(e.main?.id) ? parseVariantId(String(e.main!.id)) : null;
  // the style whose page this is: Coach's canonical URL names it (/products/<slug>/<STYLE>[-<COLOUR>].html)
  const pageStyle = (styleFromUrl(e.canonical ?? e.finalUrl ?? sourceUrl) ?? str(base.productGroupID) ?? mainKey?.style ?? "").toUpperCase();
  // Coach's internal merchandising buckets are not categories
  const internal = (x: string) => !x || /^(hidden primary categories|system-hidden|all products|hidden)$/i.test(x.trim());
  const ic = (e.itemCategory ?? []).filter((x) => !internal(x));
  const bc = breadcrumbs.filter((x) => !internal(x));
  const category = ic.length ? ic.join(" > ") : bc.join(" > ") || null;
  const collection = breadcrumbs.find((b) => /^(outlet|sale|new|new arrivals)$/i.test(b)) ?? ((e.itemCategory ?? [])[0] && /^(new|sale)$/i.test(e.itemCategory![0]) ? e.itemCategory![1] ?? e.itemCategory![0] : null) ?? null;
  const details = bullets(e.longDescription ?? e.webDesc);
  const features = details.filter((d) => !/^style no\./i.test(d));
  const ldDesc = str(base.description) ?? "";
  // JSON-LD description is Coach's prose copy, unless it is just the bullet list flattened
  const flat = htmlText(details.join(" "));
  const descriptionText = ldDesc && ldDesc.replace(/\s+/g, " ") !== flat && !flat.startsWith(ldDesc.slice(0, 60)) ? htmlText(ldDesc) : null;
  const name = htmlText(str(base.name) ?? str(ca.c_productEnglishName) ?? pageStyle).replace(/^coach\s*®?\s+/i, "").replace(/®/g, "").trim();
  const reach = str(ca.c_productReach);
  const isOutlet = ca.c_isOutlet === true || reach === "outlet" || isOutletPath(e.canonical) || isOutletPath(e.finalUrl) || breadcrumbs[0]?.toLowerCase() === "outlet";
  const canonicalUrl = absUrl(e.canonical);
  const urls = [sourceUrl, absUrl(e.finalUrl), canonicalUrl, str(group?.url), str(single?.["@id"])].filter(Boolean) as string[];
  const outletUrl = urls.find(isOutletPath) ?? null;
  const mainlineUrl = urls.find((u) => !isOutletPath(u)) ?? null;
  const pageList = num(e.main?.pricingInfo?.[0]?.list?.value);
  const mainColourName = e.main?.variationAttributes?.find((a) => a.id === "color")?.values.find((v) => v.value?.toUpperCase() === mainKey?.colour)?.name ?? null;
  const pageMissing = [!e.main ? "embedded product data (gender / classification / list price)" : null, !details.length ? "details list" : null].filter(Boolean) as string[];
  const sequence = (e.imageSequence ?? "").split(",").map((x) => x.trim()).filter((x) => /^a\d+$/i.test(x));
  const mainImages = (e.main?.images ?? []).map((i) => i.src);

  // ---- group JSON-LD variants by their own style + colour ----
  const variantsLd = arr<Json>(group?.hasVariant).length ? arr<Json>(group!.hasVariant) : single ? [single] : [];
  const byKey = new Map<string, { style: string; colour: string; vs: Json[]; parsed: ReturnType<typeof parseVariantId>[] }>();
  for (const v of variantsLd) {
    const p = parseVariantId(String(str(v.productID) ?? str(v.sku) ?? str(v.mpn) ?? ""));
    if (!p) continue;
    const k = productKey(p.style, p.colour);
    const g = byKey.get(k) ?? { style: p.style, colour: p.colour, vs: [], parsed: [] };
    g.vs.push(v); g.parsed.push(p);
    byKey.set(k, g);
  }
  const singleColour = str(single?.color);
  const singleKey = str(single?.sku) ? parseVariantId(String(single!.sku)) : null;

  const out: Listing[] = [];
  for (const [key, g] of byKey) {
    const isMainColour = !!mainKey && productKey(mainKey.style, mainKey.colour) === key;
    const colourName = str(g.vs.find((v) => str(v.color))?.color)
      ?? (isMainColour ? mainColourName : null)
      ?? (singleKey && productKey(singleKey.style, singleKey.colour) === key ? singleColour : null)
      ?? (byKey.size === 1 ? singleColour ?? mainColourName : null);
    const variants: ListingVariant[] = g.vs.map((v, i) => {
      const o = arr<Json>(v.offers)[0];
      const p = g.parsed[i]!;
      const size = p.size && !/^(ONE|OS|NS|O\/S)$/i.test(p.size) ? p.size : null;
      return {
        sourceSku: String(str(v.productID) ?? str(v.sku) ?? key), size, width: size ? p.width : null,
        gtin: str(v.gtin14) ?? str(v.gtin13) ?? str(v.gtin12) ?? str(v.gtin) ?? null,
        priceUsd: num(o?.price), currency: str(o?.priceCurrency),
        inStock: /InStock|LimitedAvailability|PreOrder|BackOrder/i.test(String(o?.availability ?? "")),
      };
    });
    const imgs = [...(isMainColour ? mainImages : []), ...g.vs.flatMap((v) => arr<unknown>(v.image).map((x) => (typeof x === "string" ? x : str((x as Json)?.url) ?? "")))]
      .filter(Boolean).map((u) => u.replace(/\?.*$/, ""));
    const hints = [...new Set([...mainImages.map(imageSuffix), ...imgs.map(imageSuffix), ...sequence].filter(Boolean) as string[])];
    // name, description, category and list price on this page describe the PAGE's style only; other style numbers in the
    // ProductGroup are different products (e.g. "Restored Rogue Bag With Leather Sequins" listed on the alligator Rogue page)
    const ownPage = g.style === pageStyle;
    // the list price the page states belongs to the rendered style; other styles on the page have no stated list price
    const regularUsd = pageList != null && ownPage && g.style === mainKey?.style ? pageList : null;
    const missing = [...pageMissing];
    if (!colourName) missing.push("colour name");
    if (variants.some((v) => v.priceUsd == null)) missing.push("price (some variants)");
    if (!imgs.length) missing.push("images on page");
    missing.push("weight (not published by Coach)");
    out.push({
      key, style: g.style, colourCode: g.colour, colourName, name, pageStyle, ownPage, isMainColour,
      sourceUrl, finalUrl: absUrl(e.finalUrl), canonicalUrl, outletUrl, mainlineUrl, reach, isOutlet,
      gender: str(ca.c_gender), category, subcategory: str(ca.c_classification), filterCategory: str(ca.c_filterCategory), categoryId: str(e.categoryId),
      breadcrumbs, collection, material: str(base.material) ?? str(ca.c_material),
      dimensions: dimensionsOf(details, g.vs[0]), descriptionText, details, features,
      variants, regularUsd, images: [...new Set(imgs)], imageSuffixHints: hints, missing,
    });
  }
  return out;
}

export { imageBase, imageSuffix };
