import type { Logger } from "../logger.ts";
import { GymsharkOps, type GShopifyProduct, type GVariant } from "../gymshark/ops.ts";

export const SNS = "stanley_sync";

export interface SkuOwner { id: string; title: string; status: string; sourceId: string | null }

/**
 * Same authenticated Admin GraphQL client, productSet upsert, metafield, media and publish operations as the Gymshark /
 * ALO syncs, keyed on the unique stanley_sync.source_product_id. Stanley SKUs are plain numbers (100000147719) with no
 * style prefix, so SKU matching is exact and looks every SKU of the product up.
 */
export class StanleyOps extends GymsharkOps {
  constructor(log: Logger) {
    super(log, { ns: SNS, idName: "Stanley product id", skuMatches: (sku, s) => sku === s.toUpperCase() });
  }

  override async byCustomId(key: string): Promise<GShopifyProduct | null> {
    return this.complete(await super.byCustomId(key));
  }

  override async byId(id: string): Promise<GShopifyProduct | null> {
    return this.complete(await super.byId(id));
  }

  /** Every Shopify product (ours or hand-made) whose variants use any of these exact SKUs. */
  async productsWithSkus(skus: string[]): Promise<SkuOwner[]> {
    const want = new Set(skus.map((x) => x.toUpperCase()));
    const out = new Map<string, SkuOwner>();
    for (let i = 0; i < skus.length; i += 20) {
      const q = skus.slice(i, i + 20).map((k) => `sku:"${k.replace(/"/g, "")}"`).join(" OR ");
      const r = await this.client.graphql<{ products: { nodes: { id: string; title: string; status: string; sourceId: { value: string } | null; variants: { nodes: { sku: string | null }[] } }[] } }>(
        `query BySku($q: String!) { products(first: 25, query: $q) { nodes { id title status sourceId: metafield(namespace: "${SNS}", key: "source_product_id") { value } variants(first: 250) { nodes { sku } } } } }`,
        { q },
      );
      for (const p of r.products.nodes) {
        if (p.variants.nodes.some((v) => want.has((v.sku ?? "").toUpperCase()))) out.set(p.id, { id: p.id, title: p.title, status: p.status, sourceId: p.sourceId?.value ?? null });
      }
    }
    return [...out.values()];
  }

  private async complete(p: GShopifyProduct | null): Promise<GShopifyProduct | null> {
    if (!p || p.variants.nodes.length < 250) return p;
    const nodes: GVariant[] = [];
    let after: string | null = null;
    for (;;) {
      const r: { product: { variants: { nodes: GVariant[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null } = await this.client.graphql(
        `query V($id: ID!, $after: String) { product(id: $id) { variants(first: 250, after: $after) { nodes { id sku barcode price compareAtPrice inventoryPolicy selectedOptions { name value } media(first: 1) { nodes { id } } } pageInfo { hasNextPage endCursor } } } }`,
        { id: p.id, after },
      );
      if (!r.product) break;
      nodes.push(...r.product.variants.nodes);
      if (!r.product.variants.pageInfo.hasNextPage) break;
      after = r.product.variants.pageInfo.endCursor;
    }
    return { ...p, variants: { nodes } };
  }
}
