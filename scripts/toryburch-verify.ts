// Read-only check of products created by the Tory Burch sync: status, media, variants, prices, ETA + tory_burch_sync metafields.
//   node scripts/toryburch-verify.ts [gid://shopify/Product/..., ...]   (default: every product linked in data/toryburch-sync.sqlite)
import { Logger } from "../src/logger.ts";
import { ShopifyClient } from "../src/shopify/client.ts";
import { allRows } from "../src/toryburch/db.ts";

const ids = process.argv.slice(2).length ? process.argv.slice(2) : allRows().filter((r) => r.shopify_product_id).map((r) => r.shopify_product_id!);
const client = new ShopifyClient(new Logger(null, { name: "toryburch-verify" }));
for (const id of ids) {
  const r = await client.graphql<{ product: { title: string; status: string; handle: string; vendor: string; productType: string; tags: string[]; media: { nodes: { status: string; mediaContentType: string; alt: string | null; image?: { width: number; height: number } | null }[] }; variants: { nodes: { sku: string; barcode: string | null; price: string; inventoryPolicy: string; selectedOptions: { name: string; value: string }[]; media: { nodes: { id: string }[] } }[] }; eta: { value: string } | null; metafields: { nodes: { key: string; value: string }[] } } | null }>(
    `query V($id: ID!) { product(id: $id) { title status handle vendor productType tags
      media(first: 50) { nodes { status mediaContentType alt ... on MediaImage { image { width height } } } }
      variants(first: 100) { nodes { sku barcode price inventoryPolicy selectedOptions { name value } media(first: 1) { nodes { id } } } }
      eta: metafield(namespace: "custom", key: "eta") { value }
      metafields(first: 60, namespace: "tory_burch_sync") { nodes { key value } } } }`, { id },
  );
  const p = r.product;
  if (!p) { console.log(`${id}: NOT FOUND`); continue; }
  const mf = Object.fromEntries(p.metafields.nodes.map((m) => [m.key, m.value]));
  const ready = p.media.nodes.filter((m) => m.status === "READY");
  console.log(`\n${p.title}  ${id}  [${p.status}]  /products/${p.handle}  vendor=${p.vendor} type=${p.productType}`);
  console.log(`  media: ${p.media.nodes.length} (${ready.length} READY; ${[...new Set(p.media.nodes.map((m) => m.status))].join("/")}) sizes: ${[...new Set(ready.map((m) => m.image ? `${m.image.width}x${m.image.height}` : "?"))].join(", ")}`);
  console.log(`  variants: ${p.variants.nodes.length}, with image: ${p.variants.nodes.filter((v) => v.media.nodes.length).length}, e.g. ${p.variants.nodes.slice(0, 3).map((v) => `${v.sku} ₹${v.price} ${v.inventoryPolicy} barcode=${v.barcode}`).join(" | ")}`);
  console.log(`  custom.eta = ${p.eta?.value}   tags: ${p.tags.join(", ")}`);
  console.log(`  tory_burch_sync: source_product_id=${mf.source_product_id} source_price_usd=${mf.source_price_usd} regular=${mf.source_regular_price_usd} sale=${mf.source_sale_price_usd ?? "-"} rate=${mf.exchange_rate} converted=${mf.converted_price_inr} shipping=${mf.shipping_adjustment_inr} landed=${mf.landed_cost_inr} profit=${mf.profit_adjustment_inr} fsr=${mf.fsr_selling_price} import_status=${mf.import_status} (${Object.keys(mf).length} fields)`);
}
