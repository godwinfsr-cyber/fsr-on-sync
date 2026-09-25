// Sets Stanley products ACTIVE and publishes them to the configured sales channels (Online Store, POS, Inbox).
// Default: only products Stanley has in stock (the store hides sold-out products). --limit N for a trial batch.
import { Logger } from "../src/logger.ts";
import { allRows, getStanleySettings, upsertRow } from "../src/stanley/db.ts";
import { StanleyOps } from "../src/stanley/ops.ts";
import { errMsg } from "../src/util.ts";

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
const log = new Logger(null);
const ops = new StanleyOps(log);
const pubs = await ops.resolvePublications(getStanleySettings().PUBLISH_CHANNELS.split(","));
if (!pubs) throw new Error("cannot resolve sales channels");
const rows = allRows().filter((r) => r.shopify_product_id && r.availability === "in_stock" && (r.shopify_status !== "ACTIVE" || !r.published)).slice(0, limit);
let ok = 0;
for (const r of rows) {
  try {
    if (r.shopify_status !== "ACTIVE") await ops.setStatus(r.shopify_product_id!, "ACTIVE");
    await ops.publish(r.shopify_product_id!, pubs);
    upsertRow({ product_key: r.product_key, shopify_status: "ACTIVE", published: 1 });
    ok++;
  } catch (e) { console.error(`FAILED ${r.product_key} ${r.title}: ${errMsg(e)}`); }
}
console.log(`activated + published ${ok}/${rows.length}`);
