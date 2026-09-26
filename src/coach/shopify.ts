// Shopify side of the Coach import - reuses the project's Admin GraphQL client and product ops (../shopify/client.ts via
// ../gymshark/ops.ts); no second Shopify integration. The importer only ever CREATES products it has confirmed are
// missing; it never updates, archives or deletes anything already in the store.
import { GymsharkOps } from "../gymshark/ops.ts";
import type { Logger } from "../logger.ts";
import { CNS } from "./config.ts";
import { StoreIndex, normGtin, type StoreProduct } from "./dedupe.ts";

interface RawProduct {
  id: string; title: string; status: string; vendor: string; handle: string;
  pid: { value: string } | null; url: { value: string } | null;
  variants: { nodes: { sku: string | null; barcode: string | null }[] };
}
const toStore = (p: RawProduct): StoreProduct => ({
  id: p.id, title: p.title, status: p.status, vendor: p.vendor, sourceProductId: p.pid?.value ?? null, sourceUrl: p.url?.value ?? null,
  skus: p.variants.nodes.map((v) => v.sku).filter(Boolean) as string[], barcodes: p.variants.nodes.map((v) => v.barcode).filter(Boolean) as string[],
});
const FIELDS = `id title status vendor handle pid: metafield(namespace: "${CNS}", key: "source_product_id") { value } url: metafield(namespace: "${CNS}", key: "source_url") { value } variants(first: 40) { nodes { sku barcode } }`;

export class CoachShopify extends GymsharkOps {
  constructor(log: Logger) { super(log, { ns: CNS, idName: "Coach product reference", skuMatches: (sku, key) => sku === key || sku.startsWith(`${key}-`) }); }

  /** Every Coach product already in Shopify (any status, created by any tool), for the duplicate check. */
  async loadIndex(): Promise<StoreIndex> {
    const idx = new StoreIndex();
    let after: string | null = null;
    do {
      const r: { products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: RawProduct[] } } = await this.client.graphql(
        `query Coach($after: String) { products(first: 25, after: $after, query: "vendor:Coach OR tag:coach-sync OR tag:coach-import") { pageInfo { hasNextPage endCursor } nodes { ${FIELDS} } } }`,
        { after },
      );
      for (const p of r.products.nodes) idx.add(toStore(p));
      after = r.products.pageInfo.hasNextPage ? r.products.pageInfo.endCursor : null;
    } while (after);
    return idx;
  }

  /** Store-wide check right before a create (any vendor): same SKU family, same barcode or same handle. */
  async liveDuplicate(key: string, gtins: string[], handle: string): Promise<{ id: string; title: string; by: string } | null> {
    // a quoted sku: term prefix-matches (validated on this store): finds "CV933-IMXAQ" and "CV933-IMXAQ-7.5" alike
    const terms = [`sku:${JSON.stringify(key)}`, ...gtins.map(normGtin).filter(Boolean).slice(0, 8).map((g) => `barcode:${g}`)];
    const r = await this.client.graphql<{ products: { nodes: RawProduct[] }; productByIdentifier: { id: string; title: string } | null }>(
      `query Dup($q: String!, $handle: String!) { products(first: 10, query: $q) { nodes { ${FIELDS} } } productByIdentifier(identifier: { handle: $handle }) { id title } }`,
      { q: terms.join(" OR "), handle },
    );
    const k = key.toUpperCase();
    for (const p of r.products.nodes) {
      const sp = toStore(p);
      if (sp.sourceProductId?.toUpperCase() === k) return { id: p.id, title: p.title, by: "source_product_id" };
      if (sp.skus.some((s) => s.toUpperCase() === k || s.toUpperCase().startsWith(`${k}-`))) return { id: p.id, title: p.title, by: "sku" };
      const g = new Set(gtins.map(normGtin));
      if (sp.barcodes.some((b) => g.has(normGtin(b)))) return { id: p.id, title: p.title, by: "gtin" };
    }
    if (r.productByIdentifier) return { id: r.productByIdentifier.id, title: r.productByIdentifier.title, by: "handle" };
    return null;
  }

  async byHandle(handle: string): Promise<{ id: string; status: string; title: string; pid: string | null } | null> {
    const r = await this.client.graphql<{ productByIdentifier: RawProduct | null }>(`query H($h: String!) { productByIdentifier(identifier: { handle: $h }) { ${FIELDS} } }`, { h: handle });
    const p = r.productByIdentifier;
    return p ? { id: p.id, status: p.status, title: p.title, pid: p.pid?.value ?? null } : null;
  }

  async mediaStatus(productId: string): Promise<{ total: number; failed: number; ready: number }> {
    const r = await this.client.graphql<{ product: { media: { nodes: { status: string }[] } } | null }>(`query M($id: ID!) { product(id: $id) { media(first: 50) { nodes { status } } } }`, { id: productId });
    const n = r.product?.media.nodes ?? [];
    return { total: n.length, failed: n.filter((m) => m.status === "FAILED").length, ready: n.filter((m) => m.status === "READY").length };
  }
}
