// Cross-source deduplication. The same Coach product can be read from several pages: its own style page, a mainline URL
// and an Outlet URL, or another style's page that lists it as a variant. They are ONE product when they share (in order):
//   1. source product id / Coach style number + colour (Coach's product reference, e.g. "CV933-IMXAQ")
//   2. SKU (Coach variant ids start with the same style + colour)
//   3. UPC / GTIN (any shared barcode)
//   4. normalized canonical URL (mainline and /outlet/ forms, tracking params and colour suffixes removed)
//   5. title + colour (only for the Shopify-side check below, where a hand-made listing may carry no ids at all)
// URL alone or title alone never creates a new product.
import { normalizeUrl, productKey, type Listing, type ListingVariant } from "./normalize.ts";

export interface CoachItem extends Listing {
  orphan: boolean;                        // seen only as a variant on ANOTHER style's page: its own page must be read first
  listings: number;                       // how many source listings were merged into this product
  sourceUrls: string[];
  mainlineUrls: string[];
  outletUrls: string[];
  mergeReasons: string[];                 // "same style+colour" | "shared GTIN ..." | "same canonical URL"
  onMainline: boolean;
  onOutlet: boolean;
}

export const normKey = (s: string) => s.toUpperCase().replace(/%2F/g, "/").replace(/\s+/g, "").replace(/_/g, "-");
export const normGtin = (g: string | null | undefined) => (g ? g.replace(/\D/g, "").replace(/^0+/, "") || null : null);
export const normTitle = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[®™]/g, "").replace(/\bcoach\b/g, "").replace(/[^a-z0-9/]+/g, " ").replace(/\s+/g, " ").trim();
const variantKey = (v: ListingVariant) => normKey(v.sourceSku);

function rank(l: Listing): number { return (l.ownPage ? 2 : 0) + (l.isMainColour ? 1 : 0); }

/** Merges listings that represent the same product. Returns one item per unique product + merge statistics. */
export function dedupeListings(listings: Listing[]): { items: CoachItem[]; duplicates: number; byReason: Record<string, number> } {
  const byReason: Record<string, number> = {};
  const count = (r: string) => { byReason[r] = (byReason[r] ?? 0) + 1; };
  // union-find over listing indexes
  const parent = listings.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const joins: [number, string][] = [];
  const union = (a: number, b: number, reason: string) => { const ra = find(a), rb = find(b); if (ra !== rb) { parent[rb] = ra; count(reason); joins.push([a, reason]); } };
  const seen = (m: Map<string, number>, k: string | null, i: number, reason: string) => {
    if (!k) return;
    const j = m.get(k);
    if (j == null) m.set(k, i); else union(j, i, reason);
  };
  const byId = new Map<string, number>(), bySku = new Map<string, number>(), byGtin = new Map<string, number>(), byUrl = new Map<string, number>();
  listings.forEach((l, i) => {
    seen(byId, normKey(productKey(l.style, l.colourCode)), i, "style_colour");
    for (const v of l.variants) seen(bySku, variantKey(v), i, "sku");
    for (const v of l.variants) seen(byGtin, normGtin(v.gtin), i, "gtin");
    // a canonical URL identifies a product only when it names the colour (STYLE-COLOUR.html); a style URL covers all colours
    const cu = l.isMainColour && l.ownPage && l.canonicalUrl && /\/[A-Za-z0-9]+-[A-Za-z0-9%]+\.html$/i.test(l.canonicalUrl) ? `${normalizeUrl(l.canonicalUrl)}#${l.colourCode}` : null;
    seen(byUrl, cu, i, "canonical_url");
  });
  // last resort (spec rule 8/9): own-page listings identical to a shopper - same title, colour, material and price - are one
  // product even under two Coach style numbers (e.g. the alligator Rogue bag listed as 41892 and C6497)
  const byLook = new Map<string, number>();
  listings.forEach((l, i) => {
    if (!l.ownPage || !l.colourName) return;
    const prices = l.variants.map((v) => v.priceUsd).filter((x): x is number => x != null);
    if (!prices.length) return;
    const look = [normTitle(l.name), normTitle(l.colourName), normTitle(l.material ?? ""), Math.min(...prices), l.variants.map((v) => v.size ?? "").sort().join(",")].join("|");
    seen(byLook, look, i, "title_colour_material_price");
  });
  const groups = new Map<number, Listing[]>();
  listings.forEach((l, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), l]); });

  const items: CoachItem[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => rank(b) - rank(a));
    const p = sorted[0];
    const variants = new Map<string, ListingVariant>();
    for (const l of sorted) for (const v of l.variants) if (!variants.has(variantKey(v))) variants.set(variantKey(v), v);
    const uniq = (xs: (string | null)[]) => [...new Set(xs.filter(Boolean) as string[])];
    const outletUrls = uniq(sorted.map((l) => l.outletUrl));
    const mainlineUrls = uniq(sorted.map((l) => l.mainlineUrl));
    const root = find(listings.indexOf(p));
    const reasons = [...new Set(joins.filter(([a]) => find(a) === root).map(([, r]) => r))];
    // descriptive fields may only come from the product's own page
    const own = sorted.filter((l) => l.ownPage);
    const src = own.length ? own : sorted;
    const pick = <K extends keyof Listing>(k: K): Listing[K] => (src.find((l) => l[k] != null && !(Array.isArray(l[k]) && !(l[k] as unknown[]).length))?.[k] ?? p[k]);
    items.push({
      ...p, orphan: !own.length,
      colourName: pick("colourName"), gender: pick("gender"), category: pick("category"), subcategory: pick("subcategory"), filterCategory: pick("filterCategory"),
      material: pick("material"), dimensions: pick("dimensions"), descriptionText: pick("descriptionText"), details: pick("details"), features: pick("features"),
      regularUsd: own.find((l) => l.regularUsd != null)?.regularUsd ?? null,
      images: uniq(src.flatMap((l) => l.images)), imageSuffixHints: uniq(src.flatMap((l) => l.imageSuffixHints)),
      variants: [...variants.values()],
      isOutlet: sorted.some((l) => l.isOutlet),
      listings: group.length, sourceUrls: uniq(sorted.map((l) => l.sourceUrl)), mainlineUrls, outletUrls, mergeReasons: reasons,
      onMainline: sorted.some((l) => !l.isOutlet || l.reach === "multi" || l.reach === "retail"),
      onOutlet: sorted.some((l) => l.isOutlet || l.reach === "multi"),
    });
  }
  return { items, duplicates: listings.length - items.length, byReason };
}

// ---------------- Shopify-side duplicate protection ----------------

export interface StoreProduct {
  id: string;
  title: string;
  status: string;
  vendor: string;
  sourceProductId: string | null;          // coach_sync.source_product_id
  sourceUrl: string | null;                // coach_sync.source_url / canonical_url
  skus: string[];
  barcodes: string[];
}

export interface StoreMatch { product: StoreProduct; by: "source_product_id" | "sku" | "gtin" | "canonical_url" | "title_colour" }

/** In-memory index of every Coach product already in Shopify (built at the start of the run, updated after each create). */
export class StoreIndex {
  private byId = new Map<string, StoreProduct>();
  private bySku = new Map<string, StoreProduct>();
  private byGtin = new Map<string, StoreProduct>();
  private byUrl = new Map<string, StoreProduct>();
  private byTitle = new Map<string, StoreProduct>();
  size = 0;

  add(p: StoreProduct) {
    this.size++;
    if (p.sourceProductId) this.byId.set(normKey(p.sourceProductId), p);
    for (const s of p.skus) {
      const k = normKey(s);
      this.bySku.set(k, p);
      const base = skuBase(k);
      if (base) this.bySku.set(base, p);
    }
    for (const b of p.barcodes) { const g = normGtin(b); if (g) this.byGtin.set(g, p); }
    const u = p.sourceUrl ? normalizeUrl(p.sourceUrl) : null;
    if (u && p.sourceProductId) this.byUrl.set(`${u}#${normKey(p.sourceProductId).split("-").slice(1).join("-")}`, p);
    // title + colour only identifies a listing that carries no Coach reference at all (hand-made): two products with
    // DIFFERENT Coach style numbers may share a name and colour (e.g. Long Zip Around Wallet C4451 / CEC19 / CT083)
    if (!p.sourceProductId && !p.skus.some((x) => skuBase(x))) this.byTitle.set(normTitle(p.title), p);
  }

  /** Runs the matching hierarchy for one product about to be created. */
  match(item: { key: string; variants: ListingVariant[]; canonicalUrl: string | null; colourCode: string }, title: string): StoreMatch | null {
    const id = this.byId.get(normKey(item.key));
    if (id) return { product: id, by: "source_product_id" };
    const bySku = this.bySku.get(normKey(item.key));
    if (bySku) return { product: bySku, by: "sku" };
    for (const v of item.variants) { const g = normGtin(v.gtin); const hit = g ? this.byGtin.get(g) : undefined; if (hit) return { product: hit, by: "gtin" }; }
    const u = item.canonicalUrl ? normalizeUrl(item.canonicalUrl) : null;
    const byUrl = u ? this.byUrl.get(`${u}#${normKey(item.colourCode)}`) : undefined;
    if (byUrl) return { product: byUrl, by: "canonical_url" };
    const t = this.byTitle.get(normTitle(title));
    if (t) return { product: t, by: "title_colour" };
    return null;
  }
}

/** "CDS58-B4/BK-7.5" -> "CDS58-B4/BK"; "CV933-IMXAQ" -> "CV933-IMXAQ"; "COACH-OS" -> null */
export function skuBase(sku: string): string | null {
  const parts = normKey(sku).split("-");
  if (parts.length < 2 || !/^[A-Z0-9]{3,6}$/.test(parts[0]) || !/\d/.test(parts[0])) return null;
  return `${parts[0]}-${parts[1]}`;
}
