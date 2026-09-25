import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { FetchResult } from "../politeHttp.ts";
import { TB_SOURCE } from "./config.ts";
import { excludedDepartmentOfUrl, isWatchUrl } from "./exclusion.ts";

// ---------- transport ----------
// "http": toryburch.com through ../politeHttp.ts (honest User-Agent, sequential, 403 / challenge = stop, never bypassed).
// "feed": saved product pages (.html) in FEED_DIR supplied under the authorization. Both produce the same parsed pages.

export interface Fetcher { get(url: string, accept?: string): Promise<FetchResult> }

export interface DiscoveredUrl { style: string; url: string; department: string }
export interface Discovery {
  urls: DiscoveredUrl[];             // to be read
  watchUrls: DiscoveredUrl[];        // excluded at URL level during discovery (never fetched)
  excludedUrls: (DiscoveredUrl & { rule: string })[]; // EXCLUDED_CATEGORIES departments (never fetched)
  duplicates: number;                // same style listed more than once (?color= variants, several routes)
  sitemaps: string[];
  complete: boolean;
}

const locs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));

/** Style number from a product route: /en-us/handbags/shoulder-bags/mcgraw-canvas-wedge/135634.html -> 135634 */
export function styleFromUrl(u: string): string | null {
  try {
    const m = new URL(u, TB_SOURCE.origin).pathname.match(/\/([^/]+)\/([A-Za-z0-9][A-Za-z0-9._-]*)\.html$/);
    return m ? decodeURIComponent(m[2]).toUpperCase() : null;
  } catch { return null; }
}
export function departmentOfUrl(u: string): string {
  try { return new URL(u, TB_SOURCE.origin).pathname.split("/").filter(Boolean)[1] ?? ""; } catch { return ""; }
}

/** Product sitemap(s) of the en-us storefront only (the index also lists en-ca, fr-ca, en-eu ... mirrors). */
export function parseSitemapIndex(xml: string, locale = TB_SOURCE.locale): string[] {
  return locs(xml).filter((u) => new RegExp(`/${locale}/sitemap-product[^/]*\\.xml$`, "i").test(u));
}

/** en-us product routes, one per style (?color= links and duplicate routes of the same style are merged). */
export function parseProductSitemap(xml: string, locale = TB_SOURCE.locale): { urls: DiscoveredUrl[]; duplicates: number } {
  const seen = new Map<string, DiscoveredUrl>();
  let duplicates = 0;
  for (const raw of locs(xml)) {
    let u: URL;
    try { u = new URL(raw); } catch { continue; }
    if (!u.pathname.startsWith(`/${locale}/`)) continue;
    const style = styleFromUrl(u.origin + u.pathname);
    if (!style) continue;
    if (seen.has(style)) { duplicates++; continue; }
    seen.set(style, { style, url: u.origin + u.pathname, department: departmentOfUrl(u.pathname) });
  }
  return { urls: [...seen.values()], duplicates };
}

export async function discoverTb(http: Fetcher, log: Logger, excludedCategories: string[] = []): Promise<Discovery> {
  const idx = await http.get(TB_SOURCE.sitemapIndex, "application/xml,text/xml;q=0.9,*/*;q=0.5");
  if (idx.status !== 200) throw new Error(`sitemap index HTTP ${idx.status}`);
  const sitemaps = parseSitemapIndex(idx.body);
  if (!sitemaps.length) throw new Error(`no ${TB_SOURCE.locale} product sitemap listed in the sitemap index`);
  const all = new Map<string, DiscoveredUrl>();
  let duplicates = 0;
  let complete = true;
  for (const sm of sitemaps) {
    const r = await http.get(sm, "application/xml,text/xml;q=0.9,*/*;q=0.5");
    if (r.status !== 200) { complete = false; log.warn("discover", `product sitemap ${sm} returned HTTP ${r.status} - scan marked incomplete`); continue; }
    if (!/<\/urlset>\s*$/.test(r.body.trim())) { complete = false; log.warn("discover", `product sitemap ${sm} looks truncated - scan marked incomplete`); }
    const parsed = parseProductSitemap(r.body);
    duplicates += parsed.duplicates;
    for (const u of parsed.urls) { if (all.has(u.style)) duplicates++; else all.set(u.style, u); }
  }
  const urls: DiscoveredUrl[] = [];
  const watchUrls: DiscoveredUrl[] = [];
  const excludedUrls: Discovery["excludedUrls"] = [];
  for (const u of all.values()) {
    if (isWatchUrl(u.url)) { watchUrls.push(u); continue; }
    const rule = excludedDepartmentOfUrl(u.url, excludedCategories);
    if (rule) { excludedUrls.push({ ...u, rule }); continue; }
    urls.push(u);
  }
  log.info("discover", `${all.size} styles in ${sitemaps.length} product sitemap(s): ${urls.length} to read, ${watchUrls.length} watches excluded by URL, ${excludedUrls.length} in excluded departments, ${duplicates} duplicate listings merged${complete ? "" : " (INCOMPLETE)"}`);
  return { urls, watchUrls, excludedUrls, duplicates, sitemaps, complete };
}

// ---------- product page: schema.org JSON-LD + the storefront's embedded product object ----------

export interface TbVariant {
  sourceVariantId: string;       // Tory Burch variant id (= UPC), e.g. 196133250297
  styleNumber: string | null;    // "135634-928" (style-colour)
  colourCode: string | null;     // "928"
  colour: string;                // "Natural / Classic Cuoio" (swatch name), fallback the JSON-LD colour group
  size: string;                  // raw: "OS", "7.5", "XS", "00"
  width: string | null;          // shoe width where Tory Burch lists one
  priceUsd: number | null;       // current selling price (the sale price when on sale)
  regularUsd: number | null;     // original price when the product is on sale
  currency: string | null;
  inStock: boolean;
  stockStatus: string | null;    // IN_STOCK | ONLY_X_LEFT | SOLD_OUT | ...
  images: string[];
  url: string | null;
}

export interface TbStyle {
  styleCode: string;
  url: string;
  canonicalUrl: string | null;
  name: string;
  brand: string;
  department: string | null;     // "Handbags"
  productClass: string | null;   // "Shoulder Bags"
  subclass: string | null;       // "Loafers"
  category: string | null;       // "Handbags > Shoulder Bags"
  breadcrumbs: string[];
  collection: string | null;     // topLevelClassificationCategoryName, e.g. "New"
  primaryCategoryId: string | null;
  staticUrl: string | null;
  description: string;           // plain text
  details: string[];             // bullet points (materials, dimensions, care ...)
  material: string | null;
  priceType: string | null;      // "Single" | "Sale" | ...
  images: string[];
  variants: TbVariant[];
  variantNames: string[];
  missing: string[];
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v != null ? [v as T] : []);

export class NotAProductPage extends Error {}

export function ldBlocks(html: string): Json[] {
  const out: Json[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]) as Json | Json[];
      for (const x of arr<Json>(j)) out.push(...(Array.isArray(x["@graph"]) ? (x["@graph"] as Json[]) : [x]));
    } catch { /* malformed block - ignored */ }
  }
  return out;
}

/** The Next.js flight payload (self.__next_f.push([1,"..."])) decoded to text. */
export function flightText(html: string): string {
  let out = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
    try { out += JSON.parse(`"${m[1]}"`); } catch { /* partial chunk */ }
  }
  return out;
}

/** Balanced JSON value (object / array) starting at `start` (which must be "{" or "["). */
function balancedAt(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

export interface EmbeddedProduct {
  id?: string; styleId?: string; name?: string; brand?: string; material?: string; shortDescription?: string; longDescription?: string;
  topLevelClassificationCategoryName?: string; primaryCategoryId?: string; price?: { currency?: string; type?: string; min?: number; max?: number };
  sizes?: { name: string; value: string }[]; widths?: { name: string; value: string }[];
  swatches?: { colorNumber: string; colorName: string; colorGroup?: string; images?: string[]; price?: { type?: string; min?: number; max?: number; currency?: string }; soldOut?: boolean }[];
  variations?: { id: string; images?: string[]; values: Record<string, string>; styleNumber?: string; soldOut?: boolean }[];
  staticURL?: string; productDepartmentId?: string; productDepartmentName?: string; productClassId?: string; productClassName?: string; productSubclassName?: string;
}
export interface EmbeddedInventory { productId: string; price?: { type?: string; currency?: string; min?: number; max?: number }; inventoryStatus?: { value?: string; quantity?: number } }

/** The storefront's own product object for this style (department, class, swatch names, sale / original price ...). */
export function embeddedProduct(flight: string, style: string): { product: EmbeddedProduct | null; inventory: EmbeddedInventory[] } {
  let product: EmbeddedProduct | null = null;
  const esc = style.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of flight.matchAll(new RegExp(`"id":"${esc}","styleId":"`, "gi"))) {
    const start = flight.lastIndexOf("{", m.index);
    const raw = start >= 0 ? balancedAt(flight, start) : null;
    if (!raw) continue;
    try {
      const o = JSON.parse(raw) as EmbeddedProduct;
      if (Array.isArray(o.variations) && Array.isArray(o.swatches)) { product = o; break; }
    } catch { /* not this one */ }
  }
  const ids = new Set((product?.variations ?? []).map((v) => v.id));
  let inventory: EmbeddedInventory[] = [];
  if (ids.size) {
    for (const m of flight.matchAll(/"inventory":\[/g)) {
      const raw = balancedAt(flight, m.index + '"inventory":'.length);
      if (!raw) continue;
      try {
        const list = JSON.parse(raw) as EmbeddedInventory[];
        if (list.some((x) => ids.has(x.productId))) { inventory = list; break; }
      } catch { /* ignored */ }
    }
  }
  return { product, inventory };
}

const htmlText = (s: string) => s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim();
export function bulletList(html: string | null | undefined): string[] {
  if (!html) return [];
  const lis = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => htmlText(m[1])).filter(Boolean);
  return lis.length ? lis : htmlText(html) ? [htmlText(html)] : [];
}

/** Largest square rendition of a Tory Burch image-server URL: ".pdp-1200x1200.jpg" -> ".pdp-2000x2000.jpg". */
export function upscaleImage(u: string, preset: string): string {
  return u.replace(/\.pdp-\d+x\d+\.(jpe?g|png|webp)(\?.*)?$/i, `.${preset}.$1`);
}
const colourParam = (u: string | null): string | null => { try { return u ? new URL(u).searchParams.get("color") : null; } catch { return null; } };

/** Parses one product page. Everything comes from Tory Burch's own markup - nothing is inferred. */
export function parseTbPage(ld: Json[], flight: string, url: string, canonical: string | null, imagePreset = "pdp-2000x2000"): TbStyle {
  const group = ld.find((x) => x["@type"] === "ProductGroup") ?? ld.find((x) => x["@type"] === "Product");
  if (!group) throw new NotAProductPage("no Product / ProductGroup structured data on page");
  const crumbsLd = ld.find((x) => x["@type"] === "BreadcrumbList");
  const breadcrumbs = arr<Json>(crumbsLd?.itemListElement)
    .sort((a, b) => (num(a.position) ?? 0) - (num(b.position) ?? 0))
    .map((i) => str((i.item as Json | undefined)?.name) ?? str(i.name) ?? "").filter(Boolean);
  const styleCode = (styleFromUrl(canonical ?? url) ?? str(group.productGroupID) ?? str(group.sku) ?? "").toUpperCase();
  if (!styleCode) throw new Error("product has no style number");
  const { product: ep, inventory } = embeddedProduct(flight, styleCode);
  const inv = new Map(inventory.map((x) => [x.productId, x]));
  const swatch = new Map((ep?.swatches ?? []).map((s) => [s.colorNumber, s]));
  const epVar = new Map((ep?.variations ?? []).map((v) => [v.id, v]));
  const missing: string[] = [];
  if (!ep) missing.push("embedded product data (department / swatch names / original price)");

  const variants: TbVariant[] = [];
  const vs = arr<Json>(group.hasVariant);
  const list = vs.length ? vs : [group];
  const variantNames: string[] = [];
  for (const v of list) {
    const o = arr<Json>(v.offers)[0] ?? null;
    const id = String(str(v.sku) ?? styleCode);
    const e = epVar.get(id);
    const code = e?.values?.color ?? colourParam(str(o?.url) ?? str(v.url));
    const sw = code ? swatch.get(code) : undefined;
    const iv = inv.get(id);
    const current = num(o?.price) ?? (iv?.price?.min ?? null);
    const priceInfo = iv?.price ?? sw?.price ?? ep?.price;
    const regular = priceInfo?.type === "Sale" && priceInfo.max != null && current != null && priceInfo.max > current ? priceInfo.max : null;
    const status = iv?.inventoryStatus?.value ?? null;
    const ldAvail = /InStock|LimitedAvailability|PreOrder|BackOrder/i.test(String(o?.availability ?? ""));
    const inStock = status ? /^(IN_STOCK|ONLY_X_LEFT|LOW_STOCK|PREORDER|BACKORDER)$/i.test(status) : e ? !e.soldOut : ldAvail;
    const images = arr<string>(v.image).filter((x) => typeof x === "string").map((x) => upscaleImage(x, imagePreset));
    const width = e?.values?.width ?? null;
    if (str(v.name)) variantNames.push(str(v.name)!);
    variants.push({
      sourceVariantId: id, styleNumber: e?.styleNumber ?? (code ? `${styleCode}-${code}` : null), colourCode: code ?? null,
      colour: sw?.colorName ?? str(v.color) ?? "Default", size: e?.values?.size ?? str(v.size) ?? "OS", width,
      priceUsd: current, regularUsd: regular, currency: str(o?.priceCurrency) ?? iv?.price?.currency ?? null, inStock, stockStatus: status ?? (ldAvail ? "IN_STOCK" : "SOLD_OUT"),
      images, url: str(o?.url) ?? str(v.url),
    });
  }
  const groupImages = arr<unknown>(group.image).map((x) => (typeof x === "string" ? x : str((x as Json)?.url) ?? "")).filter(Boolean).map((x) => upscaleImage(x, imagePreset));
  const description = htmlText(ep?.shortDescription ?? "") || (str(group.description) ?? "").replace(/\s+/g, " ").trim();
  const dept = ep?.productDepartmentName ?? null;
  const cls = ep?.productClassName ?? null;
  const st: TbStyle = {
    styleCode, url, canonicalUrl: canonical, name: htmlText(str(group.name) ?? ep?.name ?? styleCode), brand: str((group.brand as Json | undefined)?.name) ?? ep?.brand ?? "Tory Burch",
    department: dept, productClass: cls, subclass: ep?.productSubclassName ?? null,
    category: [dept, cls].filter(Boolean).join(" > ") || str(group.category) || null,
    breadcrumbs, collection: ep?.topLevelClassificationCategoryName ?? null, primaryCategoryId: ep?.primaryCategoryId ?? null, staticUrl: ep?.staticURL ?? null,
    description, details: bulletList(ep?.longDescription), material: str(group.material) ?? ep?.material ?? null, priceType: ep?.price?.type ?? null,
    images: groupImages, variants, variantNames, missing,
  };
  if (!st.description) missing.push("description");
  if (!variants.some((v) => v.images.length) && !groupImages.length) missing.push("images");
  if (variants.some((v) => v.priceUsd == null)) missing.push("price (some variants)");
  missing.push("weight (not published by Tory Burch)");
  return st;
}

export function parseProductPage(html: string, url: string, imagePreset?: string): TbStyle {
  const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/)?.[1] ?? null;
  return parseTbPage(ldBlocks(html), flightText(html), url, canonical, imagePreset);
}

export interface FetchedPage { gone: boolean; style: TbStyle | null; finalUrl: string }

export async function fetchTbProduct(http: Fetcher, url: string, imagePreset?: string): Promise<FetchedPage> {
  const r = await http.get(url);
  if (r.status === 404 || r.status === 410) return { gone: true, style: null, finalUrl: r.url };
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`);
  if (!/\.html$/i.test(new URL(r.url).pathname)) return { gone: true, style: null, finalUrl: r.url }; // redirected to a category
  try {
    return { gone: false, style: parseProductPage(r.body, url, imagePreset), finalUrl: r.url };
  } catch (e) {
    if (e instanceof NotAProductPage) return { gone: true, style: null, finalUrl: r.url };
    throw e;
  }
}

// ---------- feed mode ----------

/** Reads FEED_DIR: *.html saved product pages. */
export function readFeed(dir: string, log: Logger, imagePreset?: string): { styles: TbStyle[]; files: number; errors: { file: string; message: string }[] } {
  const abs = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
  if (!fs.existsSync(abs)) throw new Error(`feed folder not found: ${abs}`);
  const styles: TbStyle[] = [];
  const errors: { file: string; message: string }[] = [];
  const files = fs.readdirSync(abs).filter((f) => /\.html?$/i.test(f)).sort();
  for (const f of files) {
    const body = fs.readFileSync(path.join(abs, f), "utf8");
    try {
      const url = body.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/)?.[1] ?? `${TB_SOURCE.origin}/feed/${f}`;
      styles.push(parseProductPage(body, url, imagePreset));
    } catch (e) {
      errors.push({ file: f, message: e instanceof Error ? e.message : String(e) });
    }
  }
  log.info("discover", `feed ${abs}: ${files.length} file(s), ${styles.length} product page(s), ${errors.length} unreadable`);
  return { styles, files: files.length, errors };
}
