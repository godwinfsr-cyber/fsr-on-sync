import * as cheerio from "cheerio";
import type { Logger } from "../logger.ts";
import type { PoliteHttp } from "../politeHttp.ts";
import { RHODE_SOURCE } from "./config.ts";

// rhodeskin.com is a public Shopify storefront. Everything here is robots.txt-allowed and read-only:
//   /products.json?limit=250&page=N        whole live catalog (every shade is its own Rhode product), USD
//   /collections.json                      Rhode's collections (categories are discovered, not hard-coded)
//   /collections/<handle>/products.json    which products sit in Skincare / Lip + Cheek / Sets ...
//   /products/<handle>.json                price currency (health check)
//   /products/<handle>                     product page: Benefits / Application / Key Ingredients tabs + full ingredients

export interface RhodeRawVariant {
  id: number;
  title: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  sku: string | null;
  available: boolean;
  price: string;
  compare_at_price: string | null;
  grams: number | null;
  featured_image: { src: string } | null;
}
export interface RhodeRawImage { id: number; src: string; position: number; width: number | null; height: number | null; variant_ids: number[]; alt?: string | null }
export interface RhodeRawProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string | null;
  published_at: string | null;
  updated_at: string | null;
  vendor: string;
  product_type: string;
  tags: string[];
  variants: RhodeRawVariant[];
  images: RhodeRawImage[];
  options: { name: string; position: number; values: string[] }[];
}

type Json = Record<string, unknown>;
const ACCEPT_JSON = "application/json";

async function pagedProducts(http: PoliteHttp, log: Logger, path: string, label: string): Promise<{ products: RhodeRawProduct[]; pages: number; complete: boolean; reason?: string }> {
  const products: RhodeRawProduct[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= RHODE_SOURCE.maxPages; page++) {
    const r = await http.get(`${RHODE_SOURCE.origin}${path}${path.includes("?") ? "&" : "?"}limit=${RHODE_SOURCE.pageSize}&page=${page}`, ACCEPT_JSON);
    if (r.status !== 200) return { products, pages: page - 1, complete: false, reason: `${label} page ${page} returned HTTP ${r.status}` };
    let batch: RhodeRawProduct[];
    try {
      const j = JSON.parse(r.body) as { products?: RhodeRawProduct[] };
      if (!Array.isArray(j.products)) throw new Error("no products array");
      batch = j.products;
    } catch (e) {
      return { products, pages: page - 1, complete: false, reason: `${label} page ${page} is not valid product JSON (${e instanceof Error ? e.message : e}) - possibly a bot-protection page` };
    }
    if (!batch.length) return { products, pages: page - 1, complete: true };
    let fresh = 0;
    for (const p of batch) if (!seen.has(p.id)) { seen.add(p.id); products.push(p); fresh++; }
    if (!fresh) return { products, pages: page, complete: false, reason: `${label} page ${page} repeated earlier products (pagination loop)` };
    if (batch.length < RHODE_SOURCE.pageSize) return { products, pages: page, complete: true }; // last page: saves one request
    log.debug("discover", `${label} page ${page}: ${batch.length} products`);
  }
  return { products, pages: RHODE_SOURCE.maxPages, complete: false, reason: `${label}: stopped after ${RHODE_SOURCE.maxPages} pages (safety limit)` };
}

export interface Catalog { products: RhodeRawProduct[]; pages: number; complete: boolean; reason?: string }

/** Every page of /products.json. Nothing is hard-coded: the catalog size is whatever Rhode lists today. */
export async function fetchRhodeCatalog(http: PoliteHttp, log: Logger): Promise<Catalog> {
  const r = await pagedProducts(http, log, "/products.json", "catalog");
  log.info("discover", `catalog: ${r.products.length} Rhode products on ${r.pages} page(s)${r.complete ? "" : ` (INCOMPLETE: ${r.reason})`}`);
  return r;
}

export interface RhodeCollection { handle: string; title: string; productsCount: number | null }

/** /collections.json: all of Rhode's collections (the storefront categories plus merchandising lists). */
export async function fetchRhodeCollections(http: PoliteHttp): Promise<RhodeCollection[]> {
  const r = await http.get(`${RHODE_SOURCE.origin}/collections.json?limit=250`, ACCEPT_JSON);
  if (r.status !== 200) throw new Error(`collections.json HTTP ${r.status}`);
  const j = JSON.parse(r.body) as { collections?: Json[] };
  return (j.collections ?? []).map((c) => ({ handle: String(c.handle), title: String(c.title ?? c.handle), productsCount: typeof c.products_count === "number" ? c.products_count : null }));
}

/** Product ids in one collection (null when Rhode has retired the collection). */
export async function fetchCollectionMembers(http: PoliteHttp, log: Logger, handle: string): Promise<Set<number> | null> {
  const r = await pagedProducts(http, log, `/collections/${encodeURIComponent(handle)}/products.json`, `collection ${handle}`);
  if (!r.complete && !r.products.length) return null;
  return new Set(r.products.map((p) => p.id));
}

/** Price currency of one product (the formula is only valid for USD source prices). */
export async function fetchCurrency(http: PoliteHttp, handle: string): Promise<string | null> {
  const r = await http.get(`${RHODE_SOURCE.origin}/products/${encodeURIComponent(handle)}.json`, ACCEPT_JSON);
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${handle}.json`);
  const p = (JSON.parse(r.body) as { product?: { variants?: { price_currency?: string | null }[] } }).product;
  return p?.variants?.find((v) => v.price_currency)?.price_currency ?? null;
}

// ---------- product page ----------

export interface PageDetails {
  tabs: Record<string, string[]>;        // "Benefits" -> lines, "Application" -> lines, "Key Ingredients" -> lines
  ingredients: string | null;            // full INCI list as Rhode prints it
  currency: string | null;               // JSON-LD offer currency
}

const clean = (s: string) => s.replace(/ /g, " ").replace(/[ \t]+/g, " ").trim();

/** Benefits / Application / Key Ingredients tabs and the full ingredient list. Only what the page states. */
export function parseProductPage(html: string): PageDetails {
  const $ = cheerio.load(html);
  const tabs: Record<string, string[]> = {};
  $(".Product-tab").each((_i, el) => {
    const name = clean($(el).find(".js-product-tab-toggle span").first().text());
    const content = $(el).find(".Product-tab-content").first();
    if (!name || !content.length) return;
    content.find(".Button-container,script,style,button").remove();
    content.find("br").replaceWith("\n");
    content.find("p,li,div").each((_j, x) => { $(x).append("\n"); });
    const lines = content.text().split("\n").map((l) => clean(l).replace(/^[•·\-–]\s*/, "")).filter(Boolean);
    if (lines.length && !tabs[name]) tabs[name] = lines;
  });
  const ing = clean($(".Highlights-ingredients-content").first().text());
  let currency: string | null = null;
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const j = JSON.parse($(el).text()) as Json;
      const offers = j.offers as Json | Json[] | undefined;
      const o = Array.isArray(offers) ? offers[0] : offers;
      if (!currency && j["@type"] === "Product" && typeof o?.priceCurrency === "string") currency = o.priceCurrency;
    } catch { /* malformed JSON-LD block: ignored */ }
  });
  return { tabs, ingredients: ing || null, currency };
}

export async function fetchPageDetails(http: PoliteHttp, handle: string): Promise<PageDetails | null> {
  const r = await http.get(`${RHODE_SOURCE.origin}/products/${encodeURIComponent(handle)}`);
  if (r.status === 404 || r.status === 410) return null;
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for product page ${handle}`);
  return parseProductPage(r.body);
}

// ---------- images ----------

/** Stable identity of a Rhode CDN image: path without the cache-busting ?v= query. */
export function imageKey(url: string): string {
  return url.replace(/^https?:/, "").split("?")[0].toLowerCase();
}

/** Full-resolution original: https, keep ?v= (current file), drop resize / tracking params. */
export function normalizeImageUrl(url: string): string {
  const u = new URL(url.startsWith("//") ? `https:${url}` : url);
  u.protocol = "https:";
  const v = u.searchParams.get("v");
  u.search = "";
  if (v) u.searchParams.set("v", v);
  u.pathname = u.pathname.replace(/_(\d+x\d*|\d*x\d+|small|medium|large|grande|master)(?=\.(jpe?g|png|webp|gif)$)/i, "");
  return u.toString();
}

/** A real image: image file extension plus the pixel size Shopify reports for images (never for videos / files). */
export function isImage(im: Pick<RhodeRawImage, "src" | "width" | "height">): boolean {
  return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(im.src) && (im.width ?? 0) > 0 && (im.height ?? 0) > 0;
}
