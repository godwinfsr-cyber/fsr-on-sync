import type { Logger } from "../logger.ts";
import { ShopifyClient } from "../shopify/client.ts";
import { errMsg } from "../util.ts";
import { currentGLock, getGymsharkSettings, gdb } from "./db.ts";
import { OOS_TAG } from "./plan.ts";

export interface ActivateResult { found: number; activated: number; keptSoldOut: number; published: number; failed: { id: string; error: string }[]; dryRun: boolean }

/**
 * One-off go-live: every DRAFT Gymshark product becomes ACTIVE and is published to PUBLISH_CHANNELS.
 * Products hidden because every size is sold out (tag auto-oos-hidden) stay DRAFT - the store's out-of-stock
 * policy; the sync restores them automatically when Gymshark restocks.
 */
export async function activateGymsharkDrafts(log: Logger, opts: { dryRun?: boolean } = {}): Promise<ActivateResult> {
  if (currentGLock()) throw new Error("A Gymshark sync is running - wait for it to finish");
  const dryRun = opts.dryRun ?? false;
  const settings = getGymsharkSettings();
  const c = new ShopifyClient(log);

  const drafts: { id: string; title: string; tags: string[] }[] = [];
  for (let after: string | null = null; ;) {
    const r: { products: { nodes: { id: string; title: string; tags: string[] }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } = await c.graphql(
      `query D($q: String!, $after: String) { products(first: 250, after: $after, query: $q) { nodes { id title tags } pageInfo { hasNextPage endCursor } } }`,
      { q: `vendor:"${settings.VENDOR}" status:draft`, after },
    );
    drafts.push(...r.products.nodes);
    if (!r.products.pageInfo.hasNextPage) break;
    after = r.products.pageInfo.endCursor;
  }
  // only products this sync owns (by the local map) - never a hand-made draft that happens to share the vendor
  const ours = new Set((gdb.prepare("SELECT shopify_product_id AS id FROM products WHERE shopify_product_id IS NOT NULL").all() as { id: string }[]).map((x) => x.id));
  const owned = drafts.filter((p) => ours.has(p.id));
  const soldOut = owned.filter((p) => p.tags.includes(OOS_TAG));
  const todo = owned.filter((p) => !p.tags.includes(OOS_TAG));
  const res: ActivateResult = { found: owned.length, activated: 0, keptSoldOut: soldOut.length, published: 0, failed: [], dryRun };
  log.info("activate", `${owned.length} Gymshark draft(s): ${todo.length} to activate, ${soldOut.length} kept as DRAFT (sold out)${drafts.length - owned.length ? `, ${drafts.length - owned.length} not created by the sync - untouched` : ""}`);
  if (dryRun) return res;

  const pubs = (await c.graphql<{ publications: { nodes: { id: string; name: string }[] } }>(`{ publications(first: 20) { nodes { id name } } }`)).publications.nodes;
  const wanted = new Set(settings.PUBLISH_CHANNELS.split(",").map((x) => x.trim().toLowerCase()));
  const pubIds = pubs.filter((p) => wanted.has(p.name.toLowerCase())).map((p) => ({ publicationId: p.id }));
  const mark = gdb.prepare("UPDATE products SET shopify_status = 'ACTIVE', published = ? WHERE shopify_product_id = ?");

  // aliased batches keep this to ~2 calls per 20 products
  for (let i = 0; i < todo.length; i += 20) {
    const batch = todo.slice(i, i + 20);
    const body = batch.map((p, k) => `a${k}: productUpdate(product: { id: "${p.id}", status: ACTIVE }) { product { id } userErrors { message } }`).join("\n");
    try {
      const r = await c.graphql<Record<string, { userErrors: { message: string }[] }>>(`mutation { ${body} }`);
      batch.forEach((p, k) => {
        const errs = r[`a${k}`].userErrors;
        if (errs.length) res.failed.push({ id: p.id, error: errs.map((e) => e.message).join("; ") });
        else { res.activated++; mark.run(0, p.id); }
      });
    } catch (e) { batch.forEach((p) => res.failed.push({ id: p.id, error: errMsg(e) })); continue; }
    const ok = batch.filter((p) => !res.failed.some((f) => f.id === p.id));
    if (!ok.length || !pubIds.length) continue;
    const pubBody = ok.map((p, k) => `p${k}: publishablePublish(id: "${p.id}", input: $pubs) { userErrors { message } }`).join("\n");
    try {
      const r = await c.graphql<Record<string, { userErrors: { message: string }[] }>>(`mutation P($pubs: [PublicationInput!]!) { ${pubBody} }`, { pubs: pubIds });
      ok.forEach((p, k) => {
        const errs = r[`p${k}`].userErrors;
        if (errs.length) res.failed.push({ id: p.id, error: `publish: ${errs.map((e) => e.message).join("; ")}` });
        else { res.published++; mark.run(1, p.id); }
      });
    } catch (e) { ok.forEach((p) => res.failed.push({ id: p.id, error: `publish: ${errMsg(e)}` })); }
    if ((i / 20) % 10 === 0) log.info("activate", `${Math.min(i + 20, todo.length)}/${todo.length} processed`);
  }
  log.info("activate", `activated ${res.activated}, published ${res.published}, kept ${res.keptSoldOut} sold-out as DRAFT, ${res.failed.length} failed`);
  return res;
}
