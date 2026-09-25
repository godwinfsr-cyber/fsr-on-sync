import * as cheerio from "cheerio";
import type { Logger } from "../logger.ts";
import type { PoliteHttp } from "../politeHttp.ts";
import { STANLEY_SOURCE } from "./config.ts";

// stanley1913.com is a public Shopify storefront. robots.txt allows these read-only endpoints (it disallows cart,
// checkout, account, search, sorted/filtered collections - none of which are used):
//   /products.json?limit=250&page=N   whole live catalog, USD on the US store (every Stanley listing, all collections)
//   /products/{handle}.json           one listing incl. per-variant barcodes, weight and price_currency
//   /products/{handle}                product page: Stanley's specification list, care text and category breadcrumb

export interface StanleyRawVariant {
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
  featured_image: { id: number; src: string; alt?: string | null } | null;
}
export interface StanleyRawImage { id: number; src: string; position: number; width: number | null; height: number | null; variant_ids: number[]; alt?: string | null }
export interface StanleyRawProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string | null;
  published_at: string | null;
  updated_at: string | null;
  vendor: string;
  product_type: string;
  tags: string[];
  variants: StanleyRawVariant[];
  images: StanleyRawImage[];
  options: { name: string; position: number; values: string[] }[];
}

export interface Catalog { products: StanleyRawProduct[]; pages: number; complete: boolean; reason?: string }

/** Every page of /products.json until an empty page. Nothing is hard-coded: the catalog size is whatever Stanley lists. */
export async function fetchStanleyCatalog(http: PoliteHttp, log: Logger): Promise<Catalog> {
  const products: StanleyRawProduct[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= STANLEY_SOURCE.maxPages; page++) {
    const r = await http.get(`${STANLEY_SOURCE.origin}/products.json?limit=${STANLEY_SOURCE.pageSize}&page=${page}`, "application/json");
    if (r.status !== 200) return { products, pages: page - 1, complete: false, reason: `catalog page ${page} returned HTTP ${r.status}` };
    let batch: StanleyRawProduct[];
    try {
      const j = JSON.parse(r.body) as { products?: StanleyRawProduct[] };
      if (!Array.isArray(j.products)) throw new Error("no products array");
      batch = j.products;
    } catch (e) {
      return { products, pages: page - 1, complete: false, reason: `catalog page ${page} is not valid product JSON (${e instanceof Error ? e.message : e})` };
    }
    if (!batch.length) {
      log.info("discover", `catalog: ${products.length} Stanley listings on ${page - 1} page(s)`);
      return { products, pages: page - 1, complete: true };
    }
    let fresh = 0;
    for (const p of batch) if (!seen.has(p.id)) { seen.add(p.id); products.push(p); fresh++; }
    if (!fresh) return { products, pages: page, complete: false, reason: `catalog page ${page} repeated earlier products (pagination loop)` };
    log.debug("discover", `catalog page ${page}: ${batch.length} listings`);
  }
  return { products, pages: STANLEY_SOURCE.maxPages, complete: false, reason: `stopped after ${STANLEY_SOURCE.maxPages} pages (safety limit)` };
}

export interface ListingDetail { gone: boolean; currency: string | null; barcodes: Record<string, string>; weights: Record<string, string> }

/** /products/{handle}.json: per-variant barcodes, weights and the price currency (health check: must be USD). */
export async function fetchListingDetail(http: PoliteHttp, handle: string): Promise<ListingDetail> {
  const r = await http.get(`${STANLEY_SOURCE.origin}/products/${encodeURIComponent(handle)}.json`, "application/json");
  if (r.status === 404 || r.status === 410) return { gone: true, currency: null, barcodes: {}, weights: {} };
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${handle}.json`);
  return parseListingDetail(r.body);
}

export function parseListingDetail(body: string): ListingDetail {
  type V = { sku?: string | null; barcode?: string | null; price_currency?: string | null; weight?: number | null; weight_unit?: string | null };
  const p = (JSON.parse(body) as { product?: { variants?: V[] } }).product;
  if (!p?.variants) throw new Error("product JSON has no variants");
  const barcodes: Record<string, string> = {};
  const weights: Record<string, string> = {};
  for (const v of p.variants) {
    const sku = (v.sku ?? "").trim().toUpperCase();
    if (!sku) continue;
    const bc = (v.barcode ?? "").trim();
    barcodes[sku] = /^\d{8,14}$/.test(bc) ? bc : ""; // only real GTIN/UPC/EAN values; "" = SKU seen, no barcode
    if (v.weight != null && v.weight > 0 && v.weight_unit) weights[sku] = `${v.weight} ${v.weight_unit}`;
  }
  return { gone: false, currency: p.variants.find((v) => v.price_currency)?.price_currency ?? null, barcodes, weights };
}

export interface PageDetail { specs: Record<string, string>; care: string | null; breadcrumb: string[] }

/** Stanley's own product facts from the product page (Capacity, Material, Insulation, Weight, Dimensions ...). */
export async function fetchPageDetail(http: PoliteHttp, handle: string): Promise<PageDetail | null> {
  const r = await http.get(`${STANLEY_SOURCE.origin}/products/${encodeURIComponent(handle)}`);
  if (r.status === 404 || r.status === 410) return null;
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for product page ${handle}`);
  return parsePageDetail(r.body);
}

const clean = (s: string) => s.replace(/\s+/g, " ").replace(/\s*:\s*$/, "").trim();

export function parsePageDetail(html: string): PageDetail {
  const $ = cheerio.load(html);
  const specs: Record<string, string> = {};
  $("ul.c-details__list li").each((_i, el) => {
    const label = clean($(el).find("strong").first().text());
    const value = clean($(el).clone().children("strong").remove().end().text());
    if (label && value && label.length <= 60) specs[label] = value;
  });
  $(".c-details__specs .c-details__spec").each((_i, el) => {
    const label = clean($(el).find(".c-details__label").text());
    const value = clean($(el).find(".c-details__detail").text());
    if (label && value) specs[label] = value;
  });
  let care: string | null = null;
  $("p").each((_i, el) => {
    if (care) return;
    const strong = clean($(el).find("strong").first().text());
    if (/^care$/i.test(strong)) care = clean($(el).clone().children("strong").remove().end().text()) || null;
  });
  const breadcrumb: string[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const j = JSON.parse($(el).text()) as { "@type"?: string; itemListElement?: { position: number; name: string }[] };
      if (j["@type"] === "BreadcrumbList" && Array.isArray(j.itemListElement)) {
        const items = [...j.itemListElement].sort((a, b) => a.position - b.position).map((x) => x.name);
        breadcrumb.push(...items.slice(1, -1)); // drop "home" and the product itself
      }
    } catch { /* not JSON we understand */ }
  });
  return { specs, care, breadcrumb };
}

/** Stable identity of a Stanley CDN image: path without the cache-busting ?v= query / width. */
export function imageKey(url: string): string {
  return url.replace(/^https?:/, "").split("?")[0].toLowerCase();
}
