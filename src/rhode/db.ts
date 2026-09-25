import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../config.ts";
import type { FxStore } from "../gymshark/fx.ts";
import { RHODE_KEYS, coerceRhode, rhodeEnvSettings, validateRhodeSetting, type RhodeSettings } from "./config.ts";

// Separate database from the other sources so they never share ids, locks or run numbering.
const DB_PATH = path.join(DATA_DIR, "rhode-sync.sqlite");
export const rdb = new DatabaseSync(DB_PATH);
rdb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

rdb.exec(`
CREATE TABLE IF NOT EXISTS products (
  group_key TEXT PRIMARY KEY,              -- FSR product identity: "family:peptide-lip-tint" (shades grouped) or the Rhode product id
  source_product_ids TEXT,                 -- JSON {shade or "product": Rhode product id}
  source_handles TEXT,                     -- JSON list of Rhode handles in this FSR product
  source_skus TEXT,                        -- JSON list of Rhode variant SKUs
  source_url TEXT,
  canonical_url TEXT,
  title TEXT,
  category TEXT,
  subcategory TEXT,
  collection TEXT,
  product_type TEXT,                       -- Rhode's product type
  fsr_product_type TEXT,
  shades TEXT,                             -- JSON list of option values
  shopify_product_id TEXT,
  shopify_status TEXT,
  source_price_usd REAL,                   -- lowest current selling price across variants
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
  group_key TEXT NOT NULL,
  source_key TEXT NOT NULL,                -- Rhode CDN path without ?v= (stable per photo)
  colour TEXT,                             -- shade / option value the photo belongs to
  media_id TEXT,                           -- Shopify MediaImage id once uploaded
  uploaded_at TEXT,
  PRIMARY KEY (group_key, source_key)
);
CREATE TABLE IF NOT EXISTS page_details (
  handle TEXT PRIMARY KEY,                 -- Rhode product handle
  source_updated_at TEXT,                  -- hash of Rhode's title + description when fetched (re-read when it changes)
  details TEXT,                            -- JSON: benefits, application, key + full ingredients
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
  id INTEGER PRIMARY KEY AUTOINCREMENT, group_key TEXT NOT NULL, sku TEXT, changed_at TEXT NOT NULL,
  old_usd REAL, new_usd REAL, old_fsr REAL, new_fsr REAL, exchange_rate REAL, sync_id TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
`);

export interface RhodeRow {
  group_key: string;
  source_product_ids: string | null;
  source_handles: string | null;
  source_skus: string | null;
  source_url: string | null;
  canonical_url: string | null;
  title: string | null;
  category: string | null;
  subcategory: string | null;
  collection: string | null;
  product_type: string | null;
  fsr_product_type: string | null;
  shades: string | null;
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

export function getRow(key: string): RhodeRow | undefined {
  return rdb.prepare("SELECT * FROM products WHERE group_key = ?").get(key) as unknown as RhodeRow | undefined;
}

export function allRows(): RhodeRow[] {
  return rdb.prepare("SELECT * FROM products ORDER BY title, group_key").all() as unknown as RhodeRow[];
}

export function upsertRow(row: Partial<RhodeRow> & { group_key: string }) {
  const existing = getRow(row.group_key);
  const merged = { ...(existing ?? { missing_scans: 0, published: 0 }), ...row } as Record<string, unknown>;
  const cols = Object.keys(merged);
  rdb.prepare(
    `INSERT INTO products (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})
     ON CONFLICT(group_key) DO UPDATE SET ${cols.filter((c) => c !== "group_key").map((c) => `${c}=excluded.${c}`).join(",")}`,
  ).run(...(cols.map((c) => (merged[c] ?? null) as string | number | null)));
}

/** A group whose identity changed (e.g. a single product that joined a shade family) keeps its Shopify link. */
export function findRowBySourceHandle(handle: string): RhodeRow | undefined {
  return allRows().find((r) => (JSON.parse(r.source_handles ?? "[]") as string[]).includes(handle));
}

export interface ImageRow { group_key: string; source_key: string; colour: string | null; media_id: string | null; uploaded_at: string | null }
export function imagesFor(key: string): ImageRow[] {
  return rdb.prepare("SELECT * FROM images WHERE group_key = ?").all(key) as unknown as ImageRow[];
}
export function replaceImages(key: string, rows: Omit<ImageRow, "group_key">[]) {
  rdb.prepare("DELETE FROM images WHERE group_key = ?").run(key);
  const ins = rdb.prepare("INSERT INTO images (group_key, source_key, colour, media_id, uploaded_at) VALUES (?,?,?,?,?)");
  for (const r of rows) ins.run(key, r.source_key, r.colour, r.media_id, r.uploaded_at);
}

export interface PageDetailRow { handle: string; source_updated_at: string | null; details: string | null; fetched_at: string | null }
export function pageDetail(handle: string): PageDetailRow | undefined {
  return rdb.prepare("SELECT * FROM page_details WHERE handle = ?").get(handle) as unknown as PageDetailRow | undefined;
}
export function savePageDetail(r: PageDetailRow) {
  rdb.prepare("INSERT INTO page_details (handle, source_updated_at, details, fetched_at) VALUES (?,?,?,?) ON CONFLICT(handle) DO UPDATE SET source_updated_at=excluded.source_updated_at, details=excluded.details, fetched_at=excluded.fetched_at")
    .run(r.handle, r.source_updated_at, r.details, r.fetched_at);
}

export function recordPriceChange(p: { key: string; sku: string; at: string; oldUsd: number | null; newUsd: number; oldFsr: number | null; newFsr: number; rate: number; syncId: string }) {
  rdb.prepare("INSERT INTO price_history (group_key, sku, changed_at, old_usd, new_usd, old_fsr, new_fsr, exchange_rate, sync_id) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(p.key, p.sku, p.at, p.oldUsd, p.newUsd, p.oldFsr, p.newFsr, p.rate, p.syncId);
}

export function getRhodeSettings(): RhodeSettings {
  const s = rhodeEnvSettings() as unknown as Record<string, unknown>;
  const rows = rdb.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  for (const r of rows) if ((RHODE_KEYS as string[]).includes(r.key)) s[r.key] = coerceRhode(r.key as keyof RhodeSettings, r.value);
  return s as unknown as RhodeSettings;
}

export function setRhodeSetting(key: keyof RhodeSettings, value: unknown) {
  if (!RHODE_KEYS.includes(key)) throw new Error(`Unknown setting ${key}`);
  const v = coerceRhode(key, value);
  validateRhodeSetting(key, v);
  rdb.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(v));
  // saving a manual exchange rate (even the same value) is the owner re-confirming it: restarts its age clock
  if (key === "MANUAL_EXCHANGE_RATE" && Number(v) > 0) setRState("manual_rate_confirmed_at", new Date().toISOString());
}

export function getRState(key: string): string | null {
  const r = rdb.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
export function setRState(key: string, value: string | null) {
  rdb.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** The shared exchange-rate service records Rhode rates in this database. */
export const RHODE_FX_STORE: FxStore = { db: rdb, getState: getRState };

const LOCK_STALE_MS = 3 * 60 * 60 * 1000;
export function acquireRLock(syncId: string): boolean {
  const cur = getRState("lock");
  if (cur) {
    const { at, pid } = JSON.parse(cur) as { at: string; pid: number };
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive && Date.now() - new Date(at).getTime() < LOCK_STALE_MS) return false;
  }
  setRState("lock", JSON.stringify({ id: syncId, at: new Date().toISOString(), pid: process.pid }));
  return true;
}
export function releaseRLock() { setRState("lock", null); }
export function currentRLock(): { id: string; at: string; pid: number } | null {
  const cur = getRState("lock");
  return cur ? JSON.parse(cur) : null;
}

/** RHODE-SYNC-2026-09-26-001 */
export function nextRhodeSyncId(): string {
  const day = new Date().toISOString().slice(0, 10);
  const r = rdb.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE id LIKE ?").get(`RHODE-SYNC-${day}-%`) as { n: number };
  return `RHODE-SYNC-${day}-${String(r.n + 1).padStart(3, "0")}`;
}

/** Moves a product's local record (and its image map) to a new group key, e.g. when a single Rhode product becomes a
 * shade of a family. The Shopify product stays the same one. */
export function renameGroup(oldKey: string, newKey: string) {
  if (oldKey === newKey || getRow(newKey)) return;
  rdb.prepare("UPDATE products SET group_key = ? WHERE group_key = ?").run(newKey, oldKey);
  rdb.prepare("UPDATE images SET group_key = ? WHERE group_key = ?").run(newKey, oldKey);
}
