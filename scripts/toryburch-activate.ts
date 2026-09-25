// Activates + publishes the in-stock Tory Burch products this sync created as DRAFT.
// A product is activated only if, in Shopify right now, it is DRAFT, carries the tory_burch_sync id, is NOT tagged
// auto-oos-hidden (the store's out-of-stock rule) and at least one variant is orderable (inventoryPolicy CONTINUE).
//   node scripts/toryburch-activate.ts [--dry-run]
import { Logger } from "../src/logger.ts";
import { OOS_TAG } from "../src/toryburch/plan.ts";
import { allRows, getTbSettings, upsertRow } from "../src/toryburch/db.ts";
import { TbOps } from "../src/toryburch/sync.ts";

const dryRun = process.argv.includes("--dry-run");
const log = new Logger(null, { name: "toryburch-activate" });
const ops = new TbOps(log);
const settings = getTbSettings();
const rows = allRows().filter((r) => r.shopify_product_id && r.availability === "in_stock");
let activated = 0, published = 0, skipped = 0, failed = 0;
const pubs = await ops.resolvePublications(settings.PUBLISH_CHANNELS.split(","));
if (!pubs) console.log("NOTE: this app cannot publish to sales channels (missing publications scope) - activating only");

for (const r of rows) {
  try {
    const p = await ops.byId(r.shopify_product_id!);
    if (!p || p.sourceId?.value !== r.style_code) { skipped++; continue; }
    const orderable = p.variants.nodes.some((v) => v.inventoryPolicy === "CONTINUE");
    if (p.tags.includes(OOS_TAG) || !orderable) { skipped++; continue; }
    if (p.status === "DRAFT") {
      if (!dryRun) await ops.setStatus(p.id, "ACTIVE");
      activated++;
    } else if (p.status !== "ACTIVE") { skipped++; continue; }
    if (!dryRun) upsertRow({ style_code: r.style_code, shopify_status: "ACTIVE" });
    if (pubs && !r.published) {
      if (!dryRun) { await ops.publish(p.id, pubs); upsertRow({ style_code: r.style_code, published: 1 }); }
      published++;
    }
  } catch (e) {
    failed++;
    console.log(`FAILED ${r.style_code}: ${e instanceof Error ? e.message : e}`);
  }
}
console.log(JSON.stringify({ dryRun, candidates: rows.length, activated, published, skipped, failed, channels: settings.PUBLISH_CHANNELS, publishable: !!pubs }));
