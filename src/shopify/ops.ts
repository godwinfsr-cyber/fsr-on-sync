import { shopifyEnv } from "../config.ts";
import type { Logger } from "../logger.ts";
import { ShopifyClient, ShopifyError } from "./client.ts";

export const NS = "on_sync";

export interface ShopifyProduct {
  id: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED" | "UNLISTED";
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  descriptionHtml: string;
  tags: string[];
  seo: { title: string | null; description: string | null };
  media: { nodes: { id: string; mediaContentType: string; image?: { url: string } | null }[] };
  variants: { nodes: { id: string; sku: string | null; price: string; compareAtPrice: string | null; inventoryPolicy: "DENY" | "CONTINUE"; selectedOptions: { name: string; value: string }[] }[] };
  sourceId: { value: string } | null;
  eta: { value: string } | null;
}

const PRODUCT_FRAGMENT = `fragment SyncProduct on Product { id status title handle vendor productType descriptionHtml tags seo { title description } media(first: 50) { nodes { id mediaContentType ... on MediaImage { image { url } } } } variants(first: 100) { nodes { id sku price compareAtPrice inventoryPolicy selectedOptions { name value } } } sourceId: metafield(namespace: "${NS}", key: "source_product_id") { value } eta: metafield(namespace: "custom", key: "eta") { value } }`;

export class ShopifyOps {
  client: ShopifyClient;
  private log: Logger;
  locationId: string | null = null;
  constructor(log: Logger) {
    this.log = log;
    this.client = new ShopifyClient(log);
  }

  /** Metafield definitions: unique source id (server-side duplicate guard) + custom.eta for the theme. */
  async ensureDefinitions(dryRun: boolean) {
    const want = [
      // Shopify custom IDs require a definition of type "id" (unique values are enforced automatically).
      { namespace: NS, key: "source_product_id", name: "ON source product ID", type: "id", capabilities: { adminFilterable: { enabled: true } } },
      { namespace: "custom", key: "eta", name: "ETA", type: "single_line_text_field", capabilities: undefined },
    ];
    for (const d of want) {
      const r = await this.client.graphql<{ metafieldDefinitions: { nodes: { key: string; type: { name: string }; capabilities: { uniqueValues: { enabled: boolean } } }[] } }>(
        `query Defs($ns: String!) { metafieldDefinitions(first: 50, ownerType: PRODUCT, namespace: $ns) { nodes { id namespace key type { name } capabilities { uniqueValues { enabled } } } } }`,
        { ns: d.namespace },
      );
      const found = r.metafieldDefinitions.nodes.find((n) => n.key === d.key);
      if (found) {
        if (d.key === "source_product_id" && found.type.name !== "id") {
          throw new ShopifyError(`Metafield definition ${NS}.source_product_id must be of type "id" to be used as a custom ID (found "${found.type.name}").`);
        }
        continue;
      }
      if (dryRun) { this.log.info("shopify", `[dry-run] would create metafield definition ${d.namespace}.${d.key}`); continue; }
      const c = await this.client.graphql<{ metafieldDefinitionCreate: { userErrors: { message: string }[] } }>(
        `mutation DefCreate($definition: MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition: $definition) { createdDefinition { id namespace key } userErrors { field message code } } }`,
        { definition: { name: d.name, namespace: d.namespace, key: d.key, type: d.type, ownerType: "PRODUCT", ...(d.capabilities ? { capabilities: d.capabilities } : {}) } },
      );
      if (c.metafieldDefinitionCreate.userErrors.length) throw new ShopifyError(`metafieldDefinitionCreate ${d.key}: ${c.metafieldDefinitionCreate.userErrors.map((e) => e.message).join("; ")}`);
      this.log.info("shopify", `created metafield definition ${d.namespace}.${d.key}`);
    }
  }

  async resolveLocation(): Promise<string> {
    if (shopifyEnv.locationId) return (this.locationId = shopifyEnv.locationId);
    const r = await this.client.graphql<{ locations: { nodes: { id: string; name: string; isActive: boolean }[] } }>(`query Locs { locations(first: 5) { nodes { id name isActive } } }`);
    const loc = r.locations.nodes.find((l) => l.isActive);
    if (!loc) throw new ShopifyError("No active Shopify location found");
    this.log.info("shopify", `inventory location: ${loc.name}`);
    return (this.locationId = loc.id);
  }

  async byCustomId(sourceId: string): Promise<ShopifyProduct | null> {
    const r = await this.client.graphql<{ productByIdentifier: ShopifyProduct | null }>(
      `${PRODUCT_FRAGMENT}\nquery ByCustomId($value: String!) { productByIdentifier(identifier: { customId: { namespace: "${NS}", key: "source_product_id", value: $value } }) { ...SyncProduct } }`,
      { value: sourceId },
    );
    return r.productByIdentifier;
  }

  async byId(id: string): Promise<ShopifyProduct | null> {
    const r = await this.client.graphql<{ product: ShopifyProduct | null }>(`${PRODUCT_FRAGMENT}\nquery ById($id: ID!) { product(id: $id) { ...SyncProduct } }`, { id });
    return r.product;
  }

  /** Pre-existing (non-synced) products that already carry this colorway SKU, e.g. manual Instant Ship listings. */
  async skuCollisions(sku: string): Promise<{ id: string; title: string; status: string }[]> {
    const r = await this.client.graphql<{ products: { nodes: { id: string; title: string; status: string; sourceId: { value: string } | null; variants: { nodes: { sku: string | null }[] } }[] } }>(
      `query BySku($q: String!) { products(first: 10, query: $q) { nodes { id title status sourceId: metafield(namespace: "${NS}", key: "source_product_id") { value } variants(first: 5) { nodes { sku } } } } }`,
      { q: `sku:"${sku}"` },
    );
    return r.products.nodes
      .filter((p) => !p.sourceId && p.variants.nodes.some((v) => (v.sku ?? "").toUpperCase().startsWith(sku.toUpperCase())))
      .map((p) => ({ id: p.id, title: p.title, status: p.status }));
  }

  async productSet(input: Record<string, unknown>, identifier: Record<string, unknown>) {
    const r = await this.client.graphql<{ productSet: { product: { id: string; status: string; handle: string; descriptionHtml: string; variants: { nodes: { id: string; sku: string; price: string }[] } } | null; userErrors: { field: string[] | null; message: string; code: string | null }[] } }>(
      `mutation Set($input: ProductSetInput!, $identifier: ProductSetIdentifiers) { productSet(input: $input, identifier: $identifier, synchronous: true) { product { id status handle descriptionHtml variants(first: 100) { nodes { id sku price } } } userErrors { field message code } } }`,
      { input, identifier },
    );
    if (r.productSet.userErrors.length) {
      throw new ShopifyError(`productSet: ${r.productSet.userErrors.map((e) => `${(e.field ?? []).join(".")} ${e.message}`).join("; ")}`);
    }
    return r.productSet.product!;
  }

  /**
   * Sales-channel publication ids for the configured channel names. Returns null (with a warning) when the
   * app lacks read_publications/write_publications, so a sync still runs and publishing waits for the scope.
   */
  async resolvePublications(names: string[]): Promise<string[] | null> {
    try {
      const r = await this.client.graphql<{ publications: { nodes: { id: string; name: string }[] } }>(`query Pubs { publications(first: 20) { nodes { id name } } }`);
      const wanted = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
      const ids = r.publications.nodes.filter((p) => wanted.has(p.name.toLowerCase())).map((p) => p.id);
      return ids.length ? ids : null;
    } catch (e) {
      this.log.warn("shopify", `cannot read sales channels (add read_publications + write_publications to the app to auto-publish): ${e instanceof Error ? e.message : e}`);
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

  /** Merge-semantics metafield write (never deletes other metafields). */
  async metafieldsSet(ownerId: string, metafields: Record<string, string>[]) {
    for (let i = 0; i < metafields.length; i += 25) {
      const batch = metafields.slice(i, i + 25).map((m) => ({ ownerId, ...m, type: m.type ?? (m.key === "source_product_id" ? "id" : "single_line_text_field") }));
      const r = await this.client.graphql<{ metafieldsSet: { userErrors: { field: string[] | null; message: string }[] } }>(
        `mutation MfSet($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { key namespace } userErrors { field message code } } }`,
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
}
