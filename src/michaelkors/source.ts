import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { FetchResult } from "../politeHttp.ts";
import { SourceBlockedError } from "../util.ts";
import { MK_SOURCE } from "./config.ts";
import { isWatchUrl } from "./exclusion.ts";

// ---------- transport ----------
// "http": michaelkors.com through ../politeHttp.ts (honest User-Agent, sequential, 403 / challenge = stop).
// "feed": files in FEED_DIR - saved product pages (.html) or JSON-LD exports (.json) supplied under the
// authorization (e.g. by Michael Kors / the distributor). Both produce the same parsed pages.

export interface Fetcher { get(url: string, accept?: string): Promise<FetchResult> }

export interface DiscoveredUrl { style: string; url: string }
export interface Discovery {
  urls: DiscoveredUrl[];
  watchUrls: DiscoveredUrl[];        // excluded at URL level during discovery (never fetched)
  duplicates: number;                // same style listed more than once (mirrors, sale + regular routes ...)
  sitemaps: string[];
  complete: boolean;
}

const locs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));

/** Style number from a product route: /kasia-leather-boot/40R5KAHE6L.html -> 40R5KAHE6L */
export function styleFromUrl(u: string): string | null {
  try {
    const m = new URL(u).pathname.match(/\/([^/]+)\/([A-Za-z0-9][A-Za-z0-9._-]*)\.html$/);
    return m ? decodeURIComponent(m[2]).toUpperCase() : null;
  } catch { return null; }
}

export function parseSitemapIndex(xml: string): string[] {
  return locs(xml).filter((u) => /sitemap_\d+-product\.xml$/i.test(u) && !MK_SOURCE.mirrorPath.test(u));
}

/** English US product routes, one per style (the same style can appear under several routes). */
export function parseProductSitemap(xml: string): { urls: DiscoveredUrl[]; duplicates: number } {
  const seen = new Map<string, DiscoveredUrl>();
  let duplicates = 0;
  for (const u of locs(xml)) {
    if (MK_SOURCE.mirrorPath.test(u)) continue;
    const style = styleFromUrl(u);
    if (!style) continue;
    if (seen.has(style)) { duplicates++; continue; }
    seen.set(style, { style, url: u });
  }
  return { urls: [...seen.values()], duplicates };
}

export async function discoverMk(http: Fetcher, log: Logger): Promise<Discovery> {
  const idx = await http.get(MK_SOURCE.sitemapIndex, "application/xml,text/xml;q=0.9,*/*;q=0.5");
  if (new URL(idx.url).host !== new URL(MK_SOURCE.sitemapIndex).host) {
    // michaelkors.com sends visitors from India to its India store (INR prices). That geo restriction is respected, not evaded.
    throw new SourceBlockedError(`MICHAEL KORS SOURCE HEALTH CHECK FAILED: ${MK_SOURCE.sitemapIndex} geo-redirected this server to ${idx.url} - the US (USD) catalog is not served to this location`);
  }
  if (idx.status !== 200) throw new Error(`sitemap index HTTP ${idx.status}`);
  const sitemaps = parseSitemapIndex(idx.body);
  if (!sitemaps.length) throw new Error("no product sitemap listed in the sitemap index");
  const all = new Map<string, DiscoveredUrl>();
  let duplicates = 0;
  let complete = true;
  for (const sm of sitemaps) {
    const r = await http.get(sm, "application/xml,text/xml;q=0.9,*/*;q=0.5");
    if (r.status !== 200) { complete = false; log.warn("discover", `product sitemap ${sm} returned HTTP ${r.status} - scan marked incomplete`); continue; }
    const parsed = parseProductSitemap(r.body);
    duplicates += parsed.duplicates;
    for (const u of parsed.urls) { if (all.has(u.style)) duplicates++; else all.set(u.style, u); }
  }
  const urls: DiscoveredUrl[] = [];
  const watchUrls: DiscoveredUrl[] = [];
  for (const u of all.values()) (isWatchUrl(u.url) ? watchUrls : urls).push(u);
  log.info("discover", `${all.size} styles in ${sitemaps.length} product sitemap(s): ${urls.length} to read, ${watchUrls.length} watches excluded by URL, ${duplicates} duplicate listings merged${complete ? "" : " (INCOMPLETE)"}`);
  return { urls, watchUrls, duplicates, sitemaps, complete };
}

// ---------- product page: schema.org JSON-LD (ProductGroup / Product + BreadcrumbList) ----------

export interface MkVariant {
  sourceSku: string;             // Michael Kors variant id, e.g. 810268129 (single products: the style number)
  colour: string;                // as listed, e.g. "BLACK"
  colourCode: string | null;     // "001" from the image name 40R5KAHE6L-001-0001_1
  size: string;                  // raw, e.g. "5_dot_0", "XS", "NS"
  priceUsd: number | null;       // current selling price
  regularUsd: number | null;     // "was" / list price when the offer states one (schema.org priceSpecification)
  currency: string | null;
  inStock: boolean;
  availability: string;          // schema.org value as given: InStock, OutOfStock, PreOrder, LimitedAvailability ...
  image: string | null;
  url: string | null;
}

export interface MkStyle {
  styleCode: string;
  url: string;
  canonicalUrl: string | null;
  name: string;
  category: string | null;       // "Women > Shoes > Boots"
  breadcrumbs: string[];
  description: string;
  images: string[];              // group images (the default colour's gallery)
  variants: MkVariant[];
  mpn: string | null;
  detailsHtml: string | null;    // the page's own Details section (narrative + bullets), when captured
  listPriceUsd: number | null;   // page-level "Was" price of the product's own price block
  salePriceUsd: number | null;   // page-level "Now" price shown next to it
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
    } catch { /* malformed block (e.g. review widget) - ignored */ }
  }
  return out;
}

export function colourCodeOf(image: string | null, style: string): string | null {
  if (!image) return null;
  const esc = style.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return image.match(new RegExp(`/${esc}-([A-Z0-9]{3,4})-`, "i"))?.[1]?.toUpperCase() ?? null;
}

function offerOf(v: unknown): Json | null {
  return arr<Json>(v)[0] ?? null;
}

/** A "was" price stated in the offer itself (StrikethroughPrice / ListPrice). Never inferred from promotions. */
function regularOf(o: Json | null): number | null {
  for (const ps of arr<Json>(o?.priceSpecification)) {
    if (/StrikethroughPrice|ListPrice|SRP|MSRP/i.test(String(ps.priceType ?? ""))) {
      const p = num(ps.price);
      if (p != null && p > (num(o?.price) ?? 0)) return p;
    }
  }
  return null;
}

/** Parses the structured data of one product page. Everything comes from Michael Kors' own markup - nothing is inferred. */
export interface PageExtras { detailsHtml?: string | null; listPrice?: number | null; salePrice?: number | null }

export function parseMkLd(ld: Json[], url: string, canonical: string | null, extras: PageExtras = {}): MkStyle {
  const group = ld.find((x) => x["@type"] === "ProductGroup") ?? ld.find((x) => x["@type"] === "Product");
  if (!group) throw new NotAProductPage("no Product / ProductGroup structured data on page");
  const crumbsLd = ld.find((x) => x["@type"] === "BreadcrumbList");
  const breadcrumbs = arr<Json>(crumbsLd?.itemListElement).sort((a, b) => (num(a.position) ?? 0) - (num(b.position) ?? 0)).map((i) => str(i.name) ?? "").filter(Boolean);
  const idUrl = str(group["@id"]) ?? canonical ?? url;
  const styleCode = (styleFromUrl(idUrl) ?? str(group.sku) ?? str(group.mpn) ?? "").toUpperCase();
  if (!styleCode) throw new Error("product has no style number");
  const images = arr<unknown>(group.image).map((x) => (typeof x === "string" ? x : str((x as Json)?.url) ?? "")).filter(Boolean);

  const variants: MkVariant[] = [];
  const vs = arr<Json>(group.hasVariant);
  const list = vs.length ? vs : [group]; // a single Product carries its own offer
  for (const v of list) {
    const o = offerOf(v.offers);
    const own = typeof v.image === "string" ? v.image : arr<string>(v.image)[0] ?? null;
    const image = own ?? images[0] ?? null;
    variants.push({
      sourceSku: String(str(v.sku) ?? styleCode).toUpperCase(),
      colour: str(v.color) ?? "Default",
      // only the variant's OWN photo names its colour; the gallery fallback belongs to the default colour
      colourCode: colourCodeOf(own ?? (vs.length ? null : image), styleCode),
      size: str(v.size) ?? "NS",
      priceUsd: num(o?.price),
      regularUsd: regularOf(o),
      availability: String(o?.availability ?? "").replace(/^https?:\/\/schema\.org\//, "") || "unknown",
      currency: /^[A-Z]{3}$/.test(String(o?.priceCurrency ?? "")) ? String(o!.priceCurrency) : null, // sold-out sizes can say "N/A"
      inStock: /InStock|LimitedAvailability|PreOrder|BackOrder/i.test(String(o?.availability ?? "")),
      image,
      url: str(o?.url) ?? str(v["@id"]),
    });
  }
  const st: MkStyle = {
    styleCode, url, canonicalUrl: canonical, name: str(group.name) ?? styleCode, category: str(group.category), breadcrumbs,
    description: (str(group.description) ?? "").replace(/\s+/g, " ").trim(), images, variants, mpn: str(group.mpn),
    detailsHtml: extras.detailsHtml?.trim() || null, listPriceUsd: num(extras.listPrice), salePriceUsd: num(extras.salePrice), missing: [],
  };
  if (!st.description) st.missing.push("description");
  if (!images.length) st.missing.push("images");
  if (variants.some((v) => v.priceUsd == null)) st.missing.push("price (some variants)");
  return st;
}

export function parseProductPage(html: string, url: string): MkStyle {
  const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/)?.[1] ?? null;
  return parseMkLd(ldBlocks(html), url, canonical);
}

export interface FetchedPage { gone: boolean; style: MkStyle | null; finalUrl: string }

export async function fetchMkProduct(http: Fetcher, url: string): Promise<FetchedPage> {
  const r = await http.get(url);
  if (r.status === 404 || r.status === 410) return { gone: true, style: null, finalUrl: r.url };
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`);
  if (!/\.html$/i.test(new URL(r.url).pathname)) return { gone: true, style: null, finalUrl: r.url }; // redirected to a category
  try {
    return { gone: false, style: parseProductPage(r.body, url), finalUrl: r.url };
  } catch (e) {
    if (e instanceof NotAProductPage) return { gone: true, style: null, finalUrl: r.url };
    throw e;
  }
}

// ---------- feed mode ----------

export interface FeedEntry { url: string; canonical?: string | null; ld: Json[]; detailsHtml?: string | null; listPrice?: number | null; salePrice?: number | null }

export interface FeedManifest { run: string; harvestedAt: string; complete: boolean; listed: number | null; fetched: number | null; failed: number | null; watchUrls: number | null; entries: number }

/** Reads FEED_DIR: *.html (saved product pages) and *.json ({url, canonical, ld} or an array of them). */
export function readFeed(dir: string, log: Logger): { styles: MkStyle[]; files: number; errors: { file: string; message: string }[]; manifest: FeedManifest | null } {
  const abs = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
  if (!fs.existsSync(abs)) throw new Error(`feed folder not found: ${abs}`);
  const styles: MkStyle[] = [];
  const errors: { file: string; message: string }[] = [];
  const files = fs.readdirSync(abs).filter((f) => /\.(html?|json)$/i.test(f) && f !== "manifest.json").sort();
  const mf = path.join(abs, "manifest.json");
  const manifest = fs.existsSync(mf) ? (JSON.parse(fs.readFileSync(mf, "utf8")) as FeedManifest) : null;
  for (const f of files) {
    const body = fs.readFileSync(path.join(abs, f), "utf8");
    try {
      if (/\.json$/i.test(f)) {
        for (const e of arr<FeedEntry>(JSON.parse(body))) {
          try { styles.push(parseMkLd(e.ld, e.url, e.canonical ?? null, e)); }
          catch (x) { if (!(x instanceof NotAProductPage)) errors.push({ file: `${f}: ${e.url}`, message: x instanceof Error ? x.message : String(x) }); }
        }
      } else {
        const url = body.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/)?.[1] ?? `${MK_SOURCE.origin}/feed/${f}`;
        styles.push(parseProductPage(body, url));
      }
    } catch (e) {
      errors.push({ file: f, message: e instanceof Error ? e.message : String(e) });
    }
  }
  log.info("discover", `feed ${abs}: ${files.length} file(s), ${styles.length} product page(s), ${errors.length} unreadable`);
  return { styles, files: files.length, errors, manifest };
}
