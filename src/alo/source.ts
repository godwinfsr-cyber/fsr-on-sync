import type { Logger } from "../logger.ts";
import type { PoliteHttp } from "../politeHttp.ts";
import { ALO_SOURCE } from "./config.ts";

// ALO Yoga runs a public Shopify storefront. Its agents.md lists these read-only endpoints and robots.txt allows them:
//   /products.json?limit=250&page=N   whole live catalog (every colourway is its own ALO product), USD on the US store
//   /products/{handle}.json           one colourway incl. per-variant barcodes and price_currency
//   /products/{handle}                product page; its server_pdp_data carries ALO's attributes (fabrication, fit)

export interface AloRawVariant {
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
export interface AloRawImage { id: number; src: string; position: number; width: number | null; height: number | null; variant_ids: number[] }
export interface AloRawProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string | null;
  published_at: string | null;
  updated_at: string | null;
  vendor: string;
  product_type: string;
  tags: string[];
  variants: AloRawVariant[];
  images: AloRawImage[];
  options: { name: string; position: number; values: string[] }[];
}

export interface Catalog { products: AloRawProduct[]; pages: number; complete: boolean; reason?: string }

/** Every page of /products.json until an empty page. Nothing is hard-coded: the catalog size is whatever ALO lists. */
export async function fetchAloCatalog(http: PoliteHttp, log: Logger): Promise<Catalog> {
  const products: AloRawProduct[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= ALO_SOURCE.maxPages; page++) {
    const r = await http.get(`${ALO_SOURCE.origin}/products.json?limit=${ALO_SOURCE.pageSize}&page=${page}`, "application/json");
    if (r.status !== 200) return { products, pages: page - 1, complete: false, reason: `catalog page ${page} returned HTTP ${r.status}` };
    let batch: AloRawProduct[];
    try {
      const j = JSON.parse(r.body) as { products?: AloRawProduct[] };
      if (!Array.isArray(j.products)) throw new Error("no products array");
      batch = j.products;
    } catch (e) {
      return { products, pages: page - 1, complete: false, reason: `catalog page ${page} is not valid product JSON (${e instanceof Error ? e.message : e})` };
    }
    if (!batch.length) {
      log.info("discover", `catalog: ${products.length} ALO products on ${page - 1} page(s)`);
      return { products, pages: page - 1, complete: true };
    }
    let fresh = 0;
    for (const p of batch) if (!seen.has(p.id)) { seen.add(p.id); products.push(p); fresh++; }
    if (!fresh) return { products, pages: page, complete: false, reason: `catalog page ${page} repeated earlier products (pagination loop)` };
    log.debug("discover", `catalog page ${page}: ${batch.length} products`);
  }
  return { products, pages: ALO_SOURCE.maxPages, complete: false, reason: `stopped after ${ALO_SOURCE.maxPages} pages (safety limit)` };
}

export interface ColourDetail { gone: boolean; currency: string | null; barcodes: Record<string, string> }

/** /products/{handle}.json: per-variant barcodes and the price currency (health check: must be USD). */
export async function fetchColourDetail(http: PoliteHttp, handle: string): Promise<ColourDetail> {
  const r = await http.get(`${ALO_SOURCE.origin}/products/${encodeURIComponent(handle)}.json`, "application/json");
  if (r.status === 404 || r.status === 410) return { gone: true, currency: null, barcodes: {} };
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${handle}.json`);
  return parseColourDetail(r.body);
}

export function parseColourDetail(body: string): ColourDetail {
  const p = (JSON.parse(body) as { product?: { variants?: { sku?: string | null; barcode?: string | null; price_currency?: string | null }[] } }).product;
  if (!p?.variants) throw new Error("product JSON has no variants");
  const barcodes: Record<string, string> = {};
  for (const v of p.variants) {
    const sku = (v.sku ?? "").trim().toUpperCase();
    const bc = (v.barcode ?? "").trim();
    if (sku) barcodes[sku] = /^\d{8,14}$/.test(bc) ? bc : ""; // only real GTIN/UPC/EAN values; "" = SKU seen, no barcode
  }
  return { gone: false, currency: p.variants.find((v) => v.price_currency)?.price_currency ?? null, barcodes };
}

/** ALO's own product attributes from the page's server_pdp_data (fabrication incl. composition, fit incl. inseam). */
export async function fetchStyleAttribs(http: PoliteHttp, handle: string): Promise<Record<string, string> | null> {
  const r = await http.get(`${ALO_SOURCE.origin}/products/${encodeURIComponent(handle)}`);
  if (r.status === 404 || r.status === 410) return null;
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for product page ${handle}`);
  return parseStyleAttribs(r.body);
}

const UI_ONLY_ATTRIBS = /^(getthelook|quick|sizeselector|video|sets?)/i; // widget config, not product facts

export function parseStyleAttribs(html: string): Record<string, string> {
  const m = html.match(/\battribs:\s*(\{[^\n]*\})\s*,\s*\n/);
  if (!m) return {};
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(m[1]) as Record<string, unknown>; } catch { return {}; }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (UI_ONLY_ATTRIBS.test(k) || typeof v !== "string" || !v.trim() || /^[\d,\s]+$/.test(v)) continue;
    out[k] = v.trim();
  }
  return out;
}

/** Stable identity of an ALO CDN image: path without the cache-busting ?v= query. */
export function imageKey(url: string): string {
  return url.replace(/^https?:/, "").split("?")[0].toLowerCase();
}
