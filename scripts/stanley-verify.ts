// Read-only check of Stanley products in Shopify: variants, prices, media, key metafields, duplicate SKUs.
import { Logger } from "../src/logger.ts";
import { ShopifyClient } from "../src/shopify/client.ts";
import { allRows } from "../src/stanley/db.ts";

const c = new ShopifyClient(new Logger(null));
const rows = allRows().filter((r) => r.shopify_product_id);
let media = 0, variants = 0, bad = 0;
const skuSeen = new Map<string, string>();
for (const r of rows) {
  const q = await c.graphql<any>(`query P($id: ID!) { product(id: $id) { title status vendor productType tags mediaCount { count } variants(first: 250) { nodes { sku price compareAtPrice inventoryPolicy barcode selectedOptions { value } image { id } } }
    eta: metafield(namespace: "custom", key: "eta") { value } adj: metafield(namespace: "stanley_sync", key: "pricing_adjustment_inr") { value } rate: metafield(namespace: "stanley_sync", key: "exchange_rate") { value }
    usd: metafield(namespace: "stanley_sync", key: "source_price_usd") { value } fsr: metafield(namespace: "stanley_sync", key: "fsr_selling_price") { value } id2: metafield(namespace: "stanley_sync", key: "source_product_id") { value } } }`, { id: r.shopify_product_id });
  const p = q.product;
  media += p.mediaCount.count; variants += p.variants.nodes.length;
  const rate = Number(p.rate?.value);
  const issues: string[] = [];
  if (p.eta?.value !== "15–20 Days") issues.push("eta");
  if (p.adj?.value !== "3000.0" && p.adj?.value !== "3000") issues.push(`adj=${p.adj?.value}`);
  if (Math.abs(Number(p.usd.value) * rate + 3000 - Number(p.fsr.value)) > 0.02) issues.push("fsr formula");
  for (const v of p.variants.nodes) { if (skuSeen.has(v.sku)) issues.push(`dup sku ${v.sku}`); skuSeen.set(v.sku, p.title); }
  if (!p.mediaCount.count) issues.push("no media");
  if (issues.length) bad++;
  if (process.argv.includes("-v") || issues.length) console.log(`${p.status.padEnd(6)} ${p.title} | ${p.productType} | ${p.variants.nodes.length} var | ${p.mediaCount.count} media | $${p.usd.value}×${rate}+${p.adj?.value}=₹${p.fsr.value} | ETA ${p.eta?.value} | id ${p.id2.value} | first: ${p.variants.nodes[0].selectedOptions[0].value} ${p.variants.nodes[0].sku} ₹${p.variants.nodes[0].price} ${p.variants.nodes[0].inventoryPolicy} bc=${p.variants.nodes[0].barcode} img=${!!p.variants.nodes[0].image} ${issues.length ? "ISSUES: " + issues.join(",") : ""}`);
}
console.log(`products ${rows.length}, variants ${variants}, media ${media}, with issues ${bad}`);
