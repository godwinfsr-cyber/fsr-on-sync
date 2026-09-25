import type { Logger } from "../logger.ts";
import { GymsharkOps, type GShopifyProduct, type GVariant } from "../gymshark/ops.ts";
import { skuBelongsTo } from "./normalize.ts";

export const ANS = "alo_sync";

/** ALO SKUs are the style id followed by digits only (W54234R + 081940). A bare prefix match would also claim
 * U3032RG066620 for style U3032R, so the remainder must be all digits. */
export const aloSkuMatches = (sku: string, style: string) => skuBelongsTo(sku, style.toUpperCase());

/**
 * Same authenticated Admin GraphQL operations as the Gymshark sync, keyed on alo_sync.source_product_id. ALO styles
 * can exceed one GraphQL page of variants (the ALO Runner has 300+), so existing products are read completely.
 */
export class AloOps extends GymsharkOps {
  constructor(log: Logger) {
    super(log, { ns: ANS, idName: "ALO style id", skuMatches: aloSkuMatches });
  }

  override async byCustomId(styleId: string): Promise<GShopifyProduct | null> {
    return this.complete(await super.byCustomId(styleId));
  }

  override async byId(id: string): Promise<GShopifyProduct | null> {
    return this.complete(await super.byId(id));
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
