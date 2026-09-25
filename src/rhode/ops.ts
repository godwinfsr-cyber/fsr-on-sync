import type { Logger } from "../logger.ts";
import { GymsharkOps } from "../gymshark/ops.ts";

export const RNS = "rhode_sync";

export interface Candidate { id: string; title: string; status: string; handle: string; via: string }

/**
 * Same authenticated Admin GraphQL client + product operations as the Gymshark / ALO syncs, keyed on
 * rhode_sync.source_product_id (a unique "id" metafield definition). Adds the Rhode duplicate lookups for products
 * NOT created by this sync: source SKU -> Shopify handle -> normalized title.
 */
export class RhodeOps extends GymsharkOps {
  constructor(log: Logger) {
    super(log, { ns: RNS, idName: "Rhode source product id", skuMatches: (sku, s) => sku === s.toUpperCase() });
  }

  async findUnsynced(p: { skus: string[]; handle: string; title: string }): Promise<Candidate[]> {
    const out = new Map<string, Candidate>();
    type Node = { id: string; title: string; status: string; handle: string; sourceId: { value: string } | null; variants: { nodes: { sku: string | null }[] } };
    const q = async (query: string) => (await this.client.graphql<{ products: { nodes: Node[] } }>(
      `query Find($q: String!) { products(first: 20, query: $q) { nodes { id title status handle sourceId: metafield(namespace: "${RNS}", key: "source_product_id") { value } variants(first: 100) { nodes { sku } } } } }`,
      { q: query },
    )).products.nodes.filter((n) => !n.sourceId);
    const want = new Set(p.skus.map((x) => x.toUpperCase()));
    for (let i = 0; i < p.skus.length; i += 10) {
      const part = p.skus.slice(i, i + 10).map((x) => `sku:"${x.replace(/"/g, "")}"`).join(" OR ");
      for (const n of await q(part)) if (n.variants.nodes.some((v) => want.has((v.sku ?? "").toUpperCase()))) out.set(n.id, { ...n, via: "source SKU" });
    }
    for (const n of await q(`handle:"${p.handle}"`)) if (n.handle === p.handle && !out.has(n.id)) out.set(n.id, { ...n, via: "product handle" });
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    for (const n of await q(`title:"${p.title.replace(/"/g, "")}"`)) if (norm(n.title) === norm(p.title) && !out.has(n.id)) out.set(n.id, { ...n, via: "normalized title" });
    return [...out.values()].map(({ id, title, status, handle, via }) => ({ id, title, status, handle, via }));
  }
}
