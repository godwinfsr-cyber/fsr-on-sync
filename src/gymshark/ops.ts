import { shopifyEnv } from "../config.ts";
import type { Logger } from "../logger.ts";
import { ShopifyClient, ShopifyError } from "../shopify/client.ts";

export const GNS = "gymshark_sync";

export interface GVariant {
  id: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  compareAtPrice: string | null;
  inventoryPolicy: "DENY" | "CONTINUE";
  selectedOptions: { name: string; value: string }[];
  media: { nodes: { id: string }[] };
}

export interface GShopifyProduct {
  id: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED" | "UNLISTED";
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  descriptionHtml: string;
  tags: string[];
  seo: { title: string | null; description: string | null };
  media: { nodes: { id: string; alt: string | null; mediaContentType: string }[] };
  variants: { nodes: GVariant[] };
  sourceId: { value: string } | null;
  eta: { value: string } | null;
}

const fragment = (ns: string) => `fragment GymsharkProduct on Product { id status title handle vendor productType descriptionHtml tags seo { title description } media(first: 250) { nodes { id alt mediaContentType } } variants(first: 250) { nodes { id sku barcode price compareAtPrice inventoryPolicy selectedOptions { name value } media(first: 1) { nodes { id } } } } sourceId: metafield(namespace: "${ns}", key: "source_product_id") { value } eta: metafield(namespace: "custom", key: "eta") { value } }`;

export interface SourceOpsOptions {
  ns: string;                                              // namespace of source_product_id (unique "id" definition)
  idName: string;                                          // definition name shown in Shopify admin
  skuMatches: (sku: string, styleCode: string) => boolean; // does an (upper-cased) variant SKU belong to this style?
}
const GYMSHARK_OPTS: SourceOpsOptions = {
  ns: GNS, idName: "Gymshark style code",
  skuMatches: (sku, style) => sku === style.toUpperCase() || sku.startsWith(`${style.toUpperCase()}-`),
};

/** Admin GraphQL operations for the Gymshark sync (same authenticated client as the other sources). Other
 * style-code sources (ALO) reuse it with their own namespace and SKU rule. */
export class GymsharkOps {
  client: ShopifyClient;
  private log: Logger;
  private o: SourceOpsOptions;
  locationId: string | null = null;
  customIdReady = false; // false only in a dry run before the definition exists: no product can carry the id yet
  constructor(log: Logger, opts: SourceOpsOptions = GYMSHARK_OPTS) {
    this.log = log;
    this.o = opts;
    this.client = new ShopifyClient(log);
  }

  /** gymshark_sync.source_product_id as a unique "id" definition (Shopify-side duplicate guard) + custom.eta. */
  async ensureDefinitions(dryRun: boolean) {
    const want = [
      { namespace: this.o.ns, key: "source_product_id", name: this.o.idName, type: "id", capabilities: { adminFilterable: { enabled: true } } },
      { namespace: "custom", key: "eta", name: "ETA", type: "single_line_text_field", capabilities: undefined },
    ];
    for (const d of want) {
      const r = await this.client.graphql<{ metafieldDefinitions: { nodes: { key: string; type: { name: string } }[] } }>(
        `query Defs($ns: String!) { metafieldDefinitions(first: 50, ownerType: PRODUCT, namespace: $ns) { nodes { id key type { name } } } }`,
        { ns: d.namespace },
      );
      const found = r.metafieldDefinitions.nodes.find((n) => n.key === d.key);
      if (found) {
        if (d.type === "id" && found.type.name !== "id") throw new ShopifyError(`Metafield definition ${d.namespace}.${d.key} must be of type "id" (found "${found.type.name}")`);
        if (d.type === "id") this.customIdReady = true;
        continue;
      }
      if (dryRun) { this.log.info("shopify", `[dry-run] would create metafield definition ${d.namespace}.${d.key}`); continue; }
      const c = await this.client.graphql<{ metafieldDefinitionCreate: { userErrors: { message: string }[] } }>(
        `mutation DefCreate($definition: MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition: $definition) { createdDefinition { id } userErrors { field message code } } }`,
        { definition: { name: d.name, namespace: d.namespace, key: d.key, type: d.type, ownerType: "PRODUCT", ...(d.capabilities ? { capabilities: d.capabilities } : {}) } },
      );
      if (c.metafieldDefinitionCreate.userErrors.length) throw new ShopifyError(`metafieldDefinitionCreate ${d.key}: ${c.metafieldDefinitionCreate.userErrors.map((e) => e.message).join("; ")}`);
      this.log.info("shopify", `created metafield definition ${d.namespace}.${d.key}`);
      if (d.type === "id") this.customIdReady = true;
    }
  }

  async resolveLocation(): Promise<string> {
    if (shopifyEnv.locationId) return (this.locationId = shopifyEnv.locationId);
    const r = await this.client.graphql<{ locations: { nodes: { id: string; name: string; isActive: boolean }[] } }>(`query Locs { locations(first: 5) { nodes { id name isActive } } }`);
    const loc = r.locations.nodes.find((l) => l.isActive);
    if (!loc) throw new ShopifyError("No active Shopify location found");
    return (this.locationId = loc.id);
  }

  async byCustomId(styleCode: string): Promise<GShopifyProduct | null> {
    if (!this.customIdReady) return null;
    const r = await this.client.graphql<{ productByIdentifier: GShopifyProduct | null }>(
      `${fragment(this.o.ns)}\nquery ByCustomId($value: String!) { productByIdentifier(identifier: { customId: { namespace: "${this.o.ns}", key: "source_product_id", value: $value } }) { ...GymsharkProduct } }`,
      { value: styleCode },
    );
    return r.productByIdentifier;
  }

  async byId(id: string): Promise<GShopifyProduct | null> {
    const r = await this.client.graphql<{ product: GShopifyProduct | null }>(`${fragment(this.o.ns)}\nquery ById($id: ID!) { product(id: $id) { ...GymsharkProduct } }`, { id });
    return r.product;
  }

  /** Products NOT created by this sync whose variants already use this Gymshark style's SKUs (e.g. listed by hand). */
  async skuCollisions(styleCode: string): Promise<{ id: string; title: string; status: string }[]> {
    const r = await this.client.graphql<{ products: { nodes: { id: string; title: string; status: string; sourceId: { value: string } | null; variants: { nodes: { sku: string | null }[] } }[] } }>(
      `query BySku($q: String!) { products(first: 10, query: $q) { nodes { id title status sourceId: metafield(namespace: "${this.o.ns}", key: "source_product_id") { value } variants(first: 100) { nodes { sku } } } } }`,
      { q: `sku:${styleCode}*` },
    );
    return r.products.nodes
      .filter((p) => !p.sourceId && p.variants.nodes.some((v) => this.o.skuMatches((v.sku ?? "").toUpperCase(), styleCode)))
      .map((p) => ({ id: p.id, title: p.title, status: p.status }));
  }

  async productSet(input: Record<string, unknown>, identifier: Record<string, unknown>) {
    const r = await this.client.graphql<{ productSet: { product: { id: string; status: string; handle: string; descriptionHtml: string; media: { nodes: { id: string; alt: string | null }[] }; variants: { nodes: { id: string; sku: string | null; selectedOptions: { name: string; value: string }[] }[] } } | null; userErrors: { field: string[] | null; message: string }[] } }>(
      `mutation Set($input: ProductSetInput!, $identifier: ProductSetIdentifiers) { productSet(input: $input, identifier: $identifier, synchronous: true) { product { id status handle descriptionHtml media(first: 250) { nodes { id alt } } variants(first: 250) { nodes { id sku selectedOptions { name value } } } } userErrors { field message code } } }`,
      { input, identifier },
    );
    if (r.productSet.userErrors.length) throw new ShopifyError(`productSet: ${r.productSet.userErrors.map((e) => `${(e.field ?? []).join(".")} ${e.message}`).join("; ")}`);
    return r.productSet.product!;
  }

  /** Attach one image per variant (its colourway's first photo). Existing media only - nothing is uploaded. */
  async setVariantMedia(productId: string, pairs: { id: string; mediaId: string }[]) {
    for (let i = 0; i < pairs.length; i += 100) {
      const r = await this.client.graphql<{ productVariantsBulkUpdate: { userErrors: { field: string[] | null; message: string }[] } }>(
        `mutation VarMedia($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: true) { userErrors { field message } } }`,
        { productId, variants: pairs.slice(i, i + 100).map((p) => ({ id: p.id, mediaId: p.mediaId })) },
      );
      if (r.productVariantsBulkUpdate.userErrors.length) this.log.warn("shopify", `variant images: ${r.productVariantsBulkUpdate.userErrors.map((e) => e.message).join("; ")}`);
    }
  }

  /** Merge-semantics metafield write (never deletes other metafields). */
  async metafieldsSet(ownerId: string, metafields: Record<string, string>[]) {
    for (let i = 0; i < metafields.length; i += 25) {
      const batch = metafields.slice(i, i + 25).map((m) => ({ ownerId, ...m }));
      const r = await this.client.graphql<{ metafieldsSet: { userErrors: { field: string[] | null; message: string }[] } }>(
        `mutation MfSet($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { key } userErrors { field message code } } }`,
        { metafields: batch },
      );
      if (r.metafieldsSet.userErrors.length) throw new ShopifyError(`metafieldsSet: ${r.metafieldsSet.userErrors.map((e) => e.message).join("; ")}`);
    }
  }

  async setStatus(id: string, status: "ACTIVE" | "DRAFT" | "ARCHIVED") {
    const r = await this.client.graphql<{ productUpdate: { userErrors: { message: string }[] } }>(
      `mutation Status($id: ID!, $status: ProductStatus!) { productUpdate(product: { id: $id, status: $status }) { product { id status } userErrors { field message } } }`,
      { id, status },
    );
    if (r.productUpdate.userErrors.length) throw new ShopifyError(`productUpdate: ${r.productUpdate.userErrors.map((e) => e.message).join("; ")}`);
  }

  async resolvePublications(names: string[]): Promise<string[] | null> {
    try {
      const r = await this.client.graphql<{ publications: { nodes: { id: string; name: string }[] } }>(`query Pubs { publications(first: 20) { nodes { id name } } }`);
      const wanted = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
      const ids = r.publications.nodes.filter((p) => wanted.has(p.name.toLowerCase())).map((p) => p.id);
      return ids.length ? ids : null;
    } catch (e) {
      this.log.warn("shopify", `cannot read sales channels (the app needs read_publications + write_publications to auto-publish): ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  async publish(productId: string, publicationIds: string[]) {
    const r = await this.client.graphql<{ publishablePublish: { userErrors: { message: string }[] } }>(
      `mutation Pub($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`,
      { id: productId, input: publicationIds.map((publicationId) => ({ publicationId })) },
    );
    if (r.publishablePublish.userErrors.length) throw new ShopifyError(`publishablePublish: ${r.publishablePublish.userErrors.map((e) => e.message).join("; ")}`);
  }
}
