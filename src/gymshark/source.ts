import type { Logger } from "../logger.ts";
import type { PoliteHttp } from "../politeHttp.ts";
import { GYMSHARK_SOURCE } from "./config.ts";

// ---------- discovery: robots.txt-listed sitemap index -> products sitemap(s) ----------

export interface DiscoveredUrl { handle: string; url: string }
export interface Discovery { urls: DiscoveredUrl[]; sitemaps: string[]; complete: boolean }

const locs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));

/** Product-sitemap URLs from the index (English US store only; the es-US mirror lists the same products). */
export function parseSitemapIndex(xml: string): string[] {
  return locs(xml).filter((u) => /\/sitemap_products_\d+\.xml/.test(u) && !/\/es-US\//i.test(u));
}

/** Product page URLs from a products sitemap (the <image:loc> entries are ignored - pages are the source of truth). */
export function parseProductSitemap(xml: string): DiscoveredUrl[] {
  const out: DiscoveredUrl[] = [];
  for (const block of xml.split(/<url>/).slice(1)) {
    const m = block.match(/<loc>\s*([^<\s]+)\s*<\/loc>/);
    const u = m?.[1];
    const h = u?.match(/^https:\/\/www\.gymshark\.com\/products\/([^/?#]+)\/?$/)?.[1];
    if (u && h) out.push({ handle: decodeURIComponent(h).toLowerCase(), url: `${GYMSHARK_SOURCE.origin}/products/${h}` });
  }
  return out;
}

export async function discoverGymshark(http: PoliteHttp, log: Logger): Promise<Discovery> {
  const idx = await http.get(GYMSHARK_SOURCE.sitemapIndex, "application/xml,text/xml;q=0.9,*/*;q=0.5");
  if (idx.status !== 200) throw new Error(`sitemap index HTTP ${idx.status}`);
  const sitemaps = parseSitemapIndex(idx.body);
  if (!sitemaps.length) throw new Error("no products sitemap listed in the sitemap index");
  const seen = new Map<string, DiscoveredUrl>();
  let complete = true;
  for (const sm of sitemaps) {
    const r = await http.get(sm, "application/xml,text/xml;q=0.9,*/*;q=0.5");
    if (r.status !== 200) { complete = false; log.warn("discover", `products sitemap ${sm} returned HTTP ${r.status} - scan marked incomplete`); continue; }
    for (const u of parseProductSitemap(r.body)) if (!seen.has(u.handle)) seen.set(u.handle, u);
  }
  const urls = [...seen.values()].filter((u) => !GYMSHARK_SOURCE.excludedHandles.includes(u.handle));
  log.info("discover", `${urls.length} product URLs in ${sitemaps.length} products sitemap(s)${complete ? "" : " (incomplete)"}`);
  return { urls, sitemaps, complete };
}

// ---------- product page: Next.js page data (__NEXT_DATA__) + JSON-LD ----------

export interface GsSize {
  variantId: string;
  size: string;                  // as Gymshark labels it ("xs", "m", "default title")
  sku: string;
  barcode: string | null;
  inStock: boolean;
  inventoryQuantity: number | null; // Gymshark's own warehouse count (informational, never copied to FSR stock)
  price: number | null;          // per-size price field (Gymshark truncates it - the colour price is authoritative)
}

export interface GsColour {
  productId: string;             // Gymshark (Shopify) product id of this colourway
  handle: string;
  url: string;
  colour: string;
  colourCode: string | null;     // "BB2J" from the SKU A5A2Z-BB2J-XS
  price: number | null;          // current selling price, USD (what the page shows)
  compareAtPrice: number | null; // original price when on sale
  currency: string | null;
  inStock: boolean;
  isNewRelease: boolean;
  sizes: GsSize[];
  images: { url: string; width: number | null; height: number | null; alt: string | null }[];
}

export interface GsStyle {
  styleCode: string;             // "A5A2Z" - shared by every colourway
  pageProductId: string;         // product id of the page we read
  pageHandle: string;
  url: string;
  canonicalUrl: string | null;
  title: string;
  descriptionHtml: string;       // Gymshark's description HTML of the page's colourway (raw)
  gender: string[];              // ["m"], ["f"], ["m","f"]
  category: string | null;
  subcategory: string | null;
  division: string | null;
  range: string | null;
  fit: string | null;
  activities: string[];
  features: string[];
  season: string | null;
  seamType: string | null;
  garmentRise: string | null;
  garmentLength: string | null;
  braSupport: string | null;
  patternType: string | null;
  sizeGuide: string | null;
  labels: string[];
  willRestock: boolean | null;
  weightKg: number | null;       // Gymshark does not publish weights today; kept for when it does
  colours: GsColour[];
  missing: string[];
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((x): x is string => !!x) : []);

/** Stable identity of a Gymshark CDN image: path without the cache-busting ?v= query. */
export function imageKey(url: string): string {
  return url.replace(/^https?:/, "").split("?")[0].toLowerCase();
}
/** Full-resolution original (drop Shopify CDN resize params, keep the version so the file is current). */
export function originalImageUrl(url: string): string {
  const u = new URL(url.startsWith("//") ? `https:${url}` : url);
  for (const k of ["width", "height", "crop", "format"]) u.searchParams.delete(k);
  return u.toString();
}

function parseSizes(v: unknown): GsSize[] {
  if (!Array.isArray(v)) return [];
  return (v as Json[]).map((s) => ({
    variantId: String(s.id ?? ""),
    size: String(s.size ?? "").trim(),
    sku: String(s.sku ?? "").trim().toUpperCase(),
    barcode: str(s.barcode),
    inStock: s.inStock === true,
    inventoryQuantity: num(s.inventoryQuantity),
    price: num(s.price),
  })).filter((s) => s.sku && s.size);
}

function parseImages(v: unknown): GsColour["images"] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: GsColour["images"] = [];
  for (const m of v as Json[]) {
    const u = str(m.url) ?? str(m.src);
    if (!u || !/\.(jpe?g|png|webp)(\?|$)/i.test(u)) continue; // videos / 3D models are not imported as images
    const key = imageKey(u);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: originalImageUrl(u), width: num(m.width), height: num(m.height), alt: str(m.altText) });
  }
  return out;
}

function parseColour(v: Json, fallbackCurrency: string | null): GsColour {
  const sizes = parseSizes(v.availableSizes);
  const code = sizes[0]?.sku.split("-")[1] ?? null;
  const handle = String(v.handle ?? "");
  return {
    productId: String(v.id ?? ""),
    handle,
    url: `${GYMSHARK_SOURCE.origin}/products/${handle}`,
    colour: str(v.colour) ?? "Default",
    colourCode: code,
    price: num(v.price),
    compareAtPrice: num(v.compareAtPrice),
    currency: str(v.currencyCode) ?? fallbackCurrency,
    inStock: v.inStock === true,
    isNewRelease: v.isNewRelease === true,
    sizes,
    images: parseImages(v.media),
  };
}

export class NotAProductPage extends Error {}

/** Parses a Gymshark product page. Everything comes from the page's own embedded data - nothing is inferred. */
export function parseProductPage(html: string, url: string): GsStyle {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new NotAProductPage("no __NEXT_DATA__ on page");
  const data = JSON.parse(m[1]) as { props?: { pageProps?: { productData?: { product?: Json; variants?: Json[] } } } };
  const pd = data.props?.pageProps?.productData;
  const p = pd?.product;
  if (!p) throw new NotAProductPage("page has no product data");
  const styleCode = String(p.sku ?? "").trim().toUpperCase();
  if (!styleCode) throw new Error("product has no style code (sku)");

  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((x) => { try { return JSON.parse(x[1]) as Json; } catch { return null; } }).filter(Boolean) as Json[];
  const group = ld.find((x) => x["@type"] === "ProductGroup" || x["@type"] === "Product");
  const ldCurrency = str(((group?.hasVariant as Json[] | undefined)?.[0]?.offers as Json | undefined)?.priceCurrency);
  const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? null;

  const pageColour = parseColour({ ...p, currencyCode: (pd.variants?.find((v) => String(v.id) === String(p.id))?.currencyCode) ?? null }, ldCurrency);
  // productData.variants lists every colourway of the style (including this page's); fall back to the page alone
  const siblings = (pd.variants ?? []).map((v) => parseColour(v, ldCurrency ?? pageColour.currency));
  const byId = new Map<string, GsColour>();
  for (const c of [pageColour, ...siblings]) {
    if (!c.productId || !c.sizes.length) continue;
    const prev = byId.get(c.productId);
    // the page's own entry carries the untruncated price; sibling entries fill in currency / media if missing
    byId.set(c.productId, prev ? { ...c, ...prev, currency: prev.currency ?? c.currency, images: prev.images.length ? prev.images : c.images } : c);
  }
  // only colourways that really belong to this style code
  const colours = [...byId.values()].filter((c) => c.sizes.every((s) => s.sku.startsWith(`${styleCode}-`) || s.sku === styleCode));

  const bra = p.braSupport as Json | string | null;
  const pattern = p.patternType as Json | string | null;
  const style: GsStyle = {
    styleCode,
    pageProductId: String(p.id),
    pageHandle: String(p.handle ?? ""),
    url,
    canonicalUrl: canonical,
    title: str(p.title) ?? styleCode,
    descriptionHtml: typeof p.description === "string" ? p.description : "",
    gender: strs(p.gender).map((g) => g.toLowerCase()),
    category: str(p.category),
    subcategory: str(p.subcategory),
    division: str(p.division),
    range: str(p.range),
    fit: str(p.fit),
    activities: strs(p.activities),
    features: strs(p.features),
    season: str(p.season),
    seamType: str(p.seamType),
    garmentRise: str(p.garmentRise),
    garmentLength: str(p.garmentLength),
    braSupport: typeof bra === "string" ? str(bra) : null,
    patternType: typeof pattern === "string" ? str(pattern) : null,
    sizeGuide: str(p.sizeGuide),
    labels: strs(p.labels),
    willRestock: typeof p.willRestock === "boolean" ? p.willRestock : null,
    weightKg: null,
    colours,
    missing: [],
  };
  const missing = style.missing;
  if (!style.descriptionHtml.trim()) missing.push("description");
  if (!colours.length) missing.push("variants");
  if (colours.some((c) => c.price == null)) missing.push("price (some colours)");
  if (colours.some((c) => !c.images.length)) missing.push("images (some colours)");
  missing.push("weight (not published by Gymshark)");
  return style;
}

export interface FetchedPage { gone: boolean; style: GsStyle | null; finalUrl: string }

export async function fetchGymsharkProduct(http: PoliteHttp, url: string): Promise<FetchedPage> {
  const r = await http.get(url);
  if (r.status === 404 || r.status === 410) return { gone: true, style: null, finalUrl: r.url };
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`);
  // a discontinued product can redirect to a collection page
  if (!/\/products\//.test(new URL(r.url).pathname)) return { gone: true, style: null, finalUrl: r.url };
  try {
    return { gone: false, style: parseProductPage(r.body, url), finalUrl: r.url };
  } catch (e) {
    if (e instanceof NotAProductPage) return { gone: true, style: null, finalUrl: r.url };
    throw e;
  }
}
