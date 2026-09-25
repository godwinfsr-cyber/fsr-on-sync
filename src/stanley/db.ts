import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../config.ts";
import type { FxStore } from "../gymshark/fx.ts";
import { STANLEY_KEYS, coerceStanley, stanleyEnvSettings, validateStanleySetting, type StanleySettings } from "./config.ts";

// Separate database from the other sources so they never share ids, locks or run numbering.
const DB_PATH = path.join(DATA_DIR, "stanley-sync.sqlite");
export const sdb = new DatabaseSync(DB_PATH);
sdb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

sdb.exec(`
CREATE TABLE IF NOT EXISTS products (
  product_key TEXT PRIMARY KEY,            -- FSR identity = Stanley product id of the primary listing when first seen (never reassigned)
  title_key TEXT,                          -- normalised Stanley title (listings sharing it are one FSR product)
  source_product_ids TEXT,                 -- JSON {handle: Stanley product id} of every listing merged into this product
  source_handles TEXT,                     -- JSON list
  source_skus TEXT,                        -- JSON list of every Stanley variant SKU on this product
  source_url TEXT,
  canonical_url TEXT,
  title TEXT,
  category TEXT,
  collection TEXT,
  product_type TEXT,
  colours TEXT,                            -- JSON list
  capacity TEXT,
  shopify_product_id TEXT,
  shopify_status TEXT,
  source_price_usd REAL,                   -- lowest current selling price across variants (dashboard)
  source_regular_price_usd REAL,
  source_sale_price_usd REAL,
  converted_price_inr REAL,
  pricing_adjustment_inr REAL,
  fsr_selling_price REAL,                  -- lowest FSR price across variants
  exchange_rate REAL,
  exchange_rate_timestamp TEXT,
  exchange_rate_provider TEXT,
  availability TEXT,                       -- in_stock | out_of_stock
  first_seen_at TEXT,
  last_seen_at TEXT,
  last_synced_at TEXT,
  last_sync_status TEXT,                   -- created | updated | unchanged | failed | needs_review | missing | archived
  missing_scans INTEGER NOT NULL DEFAULT 0,
  source_updated_at TEXT,
  content_hash TEXT,
  image_hash TEXT,
  specification_hash TEXT,
  price_hash TEXT,                         -- source USD prices only
  fsr_price_hash TEXT,                     -- final INR prices (changes with the exchange rate / settings)
  variant_hash TEXT,
  availability_hash TEXT,
  written_title TEXT,                      -- last values WE wrote to Shopify; used to detect manual edits
  written_desc_hash TEXT,
  written_seo_hash TEXT,
  written_eta TEXT,
  written_prices TEXT,                     -- JSON {variant sku: price we wrote}
  published INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  snapshot_json TEXT
);
CREATE TABLE IF NOT EXISTS images (
  product_key TEXT NOT NULL,
  source_key TEXT NOT NULL,                -- Stanley CDN path without ?v= (stable per photo)
  colour TEXT,
  media_id TEXT,                           -- Shopify MediaImage id once uploaded
  uploaded_at TEXT,
  PRIMARY KEY (product_key, source_key)
);
CREATE TABLE IF NOT EXISTS listing_details (
  handle TEXT PRIMARY KEY,                 -- Stanley listing handle
  currency TEXT,
  barcodes TEXT,                           -- JSON {sku: barcode}
  weights TEXT,                            -- JSON {sku: "1.4 lb"}
  fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS page_details (
  handle TEXT PRIMARY KEY,                 -- primary listing's handle
  specs TEXT,                              -- JSON: Stanley's own specification list (Capacity, Material, Dimensions ...)
  care TEXT,
  breadcrumb TEXT,                         -- JSON list (category path)
  fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS fx_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL, base TEXT NOT NULL, quote TEXT NOT NULL, rate REAL,
  provider_updated_at TEXT, fetched_at TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER, mode TEXT NOT NULL,
  trigger TEXT, status TEXT NOT NULL, summary_json TEXT, errors_json TEXT
);
CREATE TABLE IF NOT EXISTS sync_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sync_id TEXT, ts TEXT NOT NULL, level TEXT NOT NULL, stage TEXT,
  source_product_id TEXT, message TEXT, data_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_sync ON sync_events(sync_id);
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_key TEXT NOT NULL, colour TEXT, changed_at TEXT NOT NULL,
  old_usd REAL, new_usd REAL, new_regular_usd REAL, old_fsr REAL, new_fsr REAL, exchange_rate REAL, sync_id TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
`);

export interface StanleyRow {
  product_key: string;
  title_key: string | null;
  source_product_ids: string | null;
  source_handles: string | null;
  source_skus: string | null;
  source_url: string | null;
  canonical_url: string | null;
  title: string | null;
  category: string | null;
  collection: string | null;
  product_type: string | null;
  colours: string | null;
  capacity: string | null;
  shopify_product_id: string | null;
  shopify_status: string | null;
  source_price_usd: number | null;
  source_regular_price_usd: number | null;
  source_sale_price_usd: number | null;
  converted_price_inr: number | null;
  pricing_adjustment_inr: number | null;
  fsr_selling_price: number | null;
  exchange_rate: number | null;
  exchange_rate_timestamp: string | null;
  exchange_rate_provider: string | null;
  availability: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  last_synced_at: string | null;
  last_sync_status: string | null;
  missing_scans: number;
  source_updated_at: string | null;
  content_hash: string | null;
  image_hash: string | null;
  specification_hash: string | null;
  price_hash: string | null;
  fsr_price_hash: string | null;
  variant_hash: string | null;
  availability_hash: string | null;
  written_title: string | null;
  written_desc_hash: string | null;
  written_seo_hash: string | null;
  written_eta: string | null;
  written_prices: string | null;
  published: number;
  error_message: string | null;
  snapshot_json: string | null;
}

export function getRow(key: string): StanleyRow | undefined {
  return sdb.prepare("SELECT * FROM products WHERE product_key = ?").get(key) as unknown as StanleyRow | undefined;
}

export function allRows(): StanleyRow[] {
  return sdb.prepare("SELECT * FROM products ORDER BY title, product_key").all() as unknown as StanleyRow[];
}

export function upsertRow(row: Partial<StanleyRow> & { product_key: string }) {
  const existing = getRow(row.product_key);
  const merged = { ...(existing ?? { missing_scans: 0, published: 0 }), ...row } as Record<string, unknown>;
  const cols = Object.keys(merged);
  sdb.prepare(
    `INSERT INTO products (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})
     ON CONFLICT(product_key) DO UPDATE SET ${cols.filter((c) => c !== "product_key").map((c) => `${c}=excluded.${c}`).join(",")}`,
  ).run(...(cols.map((c) => (merged[c] ?? null) as string | number | null)));
}

export interface ImageRow { product_key: string; source_key: string; colour: string | null; media_id: string | null; uploaded_at: string | null }
export function imagesFor(key: string): ImageRow[] {
  return sdb.prepare("SELECT * FROM images WHERE product_key = ?").all(key) as unknown as ImageRow[];
}
export function replaceImages(key: string, rows: Omit<ImageRow, "product_key">[]) {
  sdb.prepare("DELETE FROM images WHERE product_key = ?").run(key);
  const ins = sdb.prepare("INSERT INTO images (product_key, source_key, colour, media_id, uploaded_at) VALUES (?,?,?,?,?)");
  for (const r of rows) ins.run(key, r.source_key, r.colour, r.media_id, r.uploaded_at);
}

export interface ListingDetailRow { handle: string; currency: string | null; barcodes: string | null; weights: string | null; fetched_at: string | null }
export function listingDetail(handle: string): ListingDetailRow | undefined {
  return sdb.prepare("SELECT * FROM listing_details WHERE handle = ?").get(handle) as unknown as ListingDetailRow | undefined;
}
export function saveListingDetail(r: ListingDetailRow) {
  sdb.prepare("INSERT INTO listing_details (handle, currency, barcodes, weights, fetched_at) VALUES (?,?,?,?,?) ON CONFLICT(handle) DO UPDATE SET currency=excluded.currency, barcodes=excluded.barcodes, weights=excluded.weights, fetched_at=excluded.fetched_at")
    .run(r.handle, r.currency, r.barcodes, r.weights, r.fetched_at);
}
export interface PageDetailRow { handle: string; specs: string | null; care: string | null; breadcrumb: string | null; fetched_at: string | null }
export function pageDetail(handle: string): PageDetailRow | undefined {
  return sdb.prepare("SELECT * FROM page_details WHERE handle = ?").get(handle) as unknown as PageDetailRow | undefined;
}
export function savePageDetail(r: PageDetailRow) {
  sdb.prepare("INSERT INTO page_details (handle, specs, care, breadcrumb, fetched_at) VALUES (?,?,?,?,?) ON CONFLICT(handle) DO UPDATE SET specs=excluded.specs, care=excluded.care, breadcrumb=excluded.breadcrumb, fetched_at=excluded.fetched_at")
    .run(r.handle, r.specs, r.care, r.breadcrumb, r.fetched_at);
}

export function recordPriceChange(p: { key: string; colour: string; at: string; oldUsd: number | null; newUsd: number; newRegular: number | null; oldFsr: number | null; newFsr: number; rate: number; syncId: string }) {
  sdb.prepare("INSERT INTO price_history (product_key, colour, changed_at, old_usd, new_usd, new_regular_usd, old_fsr, new_fsr, exchange_rate, sync_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(p.key, p.colour, p.at, p.oldUsd, p.newUsd, p.newRegular, p.oldFsr, p.newFsr, p.rate, p.syncId);
}

export function getStanleySettings(): StanleySettings {
  const s = stanleyEnvSettings() as unknown as Record<string, unknown>;
  const rows = sdb.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  for (const r of rows) if ((STANLEY_KEYS as string[]).includes(r.key)) s[r.key] = coerceStanley(r.key as keyof StanleySettings, r.value);
  return s as unknown as StanleySettings;
}

export function setStanleySetting(key: keyof StanleySettings, value: unknown) {
  if (!STANLEY_KEYS.includes(key)) throw new Error(`Unknown setting ${key}`);
  const v = coerceStanley(key, value);
  validateStanleySetting(key, v);
  sdb.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(v));
  // saving a manual exchange rate (even the same value) is the owner re-confirming it: restarts its age clock
  if (key === "MANUAL_EXCHANGE_RATE" && Number(v) > 0) setSState("manual_rate_confirmed_at", new Date().toISOString());
}

export function getSState(key: string): string | null {
  const r = sdb.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
export function setSState(key: string, value: string | null) {
  sdb.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** The shared exchange-rate service records Stanley rates in this database. */
export const STANLEY_FX_STORE: FxStore = { db: sdb, getState: getSState };

const LOCK_STALE_MS = 4 * 60 * 60 * 1000;
export function acquireSLock(syncId: string): boolean {
  const cur = getSState("lock");
  if (cur) {
    const { at, pid } = JSON.parse(cur) as { at: string; pid: number };
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive && Date.now() - new Date(at).getTime() < LOCK_STALE_MS) return false;
  }
  setSState("lock", JSON.stringify({ id: syncId, at: new Date().toISOString(), pid: process.pid }));
  return true;
}
export function releaseSLock() { setSState("lock", null); }
export function currentSLock(): { id: string; at: string; pid: number } | null {
  const cur = getSState("lock");
  return cur ? JSON.parse(cur) : null;
}

/** STANLEY-SYNC-2026-09-26-001 */
export function nextStanleySyncId(): string {
  const day = new Date().toISOString().slice(0, 10);
  const r = sdb.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE id LIKE ?").get(`STANLEY-SYNC-${day}-%`) as { n: number };
  return `STANLEY-SYNC-${day}-${String(r.n + 1).padStart(3, "0")}`;
}
