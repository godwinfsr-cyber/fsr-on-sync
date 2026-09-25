import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../config.ts";
import { MK_KEYS, coerceMk, mkEnvSettings, validateMkSetting, type MkSettings } from "./config.ts";

// Separate database from the other sources so they never share ids, locks or run numbering.
const DB_PATH = path.join(DATA_DIR, "michaelkors-sync.sqlite");
export const mdb = new DatabaseSync(DB_PATH);
mdb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

mdb.exec(`
CREATE TABLE IF NOT EXISTS products (
  style_code TEXT PRIMARY KEY,             -- Michael Kors style number, e.g. 40R5KAHE6L = one FSR product (all colours/sizes)
  source_product_ids TEXT,                 -- JSON {FSR variant sku: Michael Kors variant id}
  source_url TEXT,
  canonical_url TEXT,
  handle TEXT,
  title TEXT,
  gender TEXT,
  category TEXT,
  source_category TEXT,                    -- full Michael Kors path, e.g. "Women > Shoes > Boots"
  channel TEXT,                            -- Outlet | Sale | New
  colours TEXT,                            -- JSON list
  shopify_product_id TEXT,
  shopify_status TEXT,
  source_price_usd REAL,                   -- lowest current selling price across colours (for the dashboard)
  source_regular_price_usd REAL,
  fsr_selling_price REAL,                  -- lowest FSR price across colours
  exchange_rate REAL,
  exchange_rate_timestamp TEXT,
  exchange_rate_provider TEXT,
  source_weight_kg REAL,
  weight_surcharge_inr REAL,
  weight_surcharge_reason TEXT,
  landed_cost_inr REAL,
  profit_adjustment_inr REAL,
  availability TEXT,                       -- in_stock | out_of_stock
  import_status TEXT,                      -- imported | updated | skipped | watch_excluded | error
  skip_reason TEXT,
  exclusion_level TEXT,                    -- category | url | product | specification
  first_seen_at TEXT,
  last_seen_at TEXT,
  last_synced_at TEXT,
  last_sync_status TEXT,                   -- created | updated | unchanged | failed | needs_review | missing | archived
  missing_scans INTEGER NOT NULL DEFAULT 0,
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
  style_code TEXT NOT NULL,
  source_key TEXT NOT NULL,                -- assets.michaelkors.com path (stable per photo)
  colour TEXT,
  media_id TEXT,                           -- Shopify MediaImage id once uploaded
  uploaded_at TEXT,
  PRIMARY KEY (style_code, source_key)
);
CREATE TABLE IF NOT EXISTS fx_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL, base TEXT NOT NULL, quote TEXT NOT NULL, rate REAL,
  provider_updated_at TEXT,                -- the provider's own timestamp for the rate
  fetched_at TEXT NOT NULL,                -- when this service obtained it
  ok INTEGER NOT NULL, error TEXT
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
  id INTEGER PRIMARY KEY AUTOINCREMENT, style_code TEXT NOT NULL, colour TEXT, changed_at TEXT NOT NULL,
  old_usd REAL, new_usd REAL, old_regular_usd REAL, new_regular_usd REAL, old_fsr REAL, new_fsr REAL, exchange_rate REAL, sync_id TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
`);

export interface MkRow {
  style_code: string;
  source_product_ids: string | null;
  source_url: string | null;
  canonical_url: string | null;
  handle: string | null;
  title: string | null;
  gender: string | null;
  category: string | null;
  source_category: string | null;
  channel: string | null;
  colours: string | null;
  shopify_product_id: string | null;
  shopify_status: string | null;
  source_price_usd: number | null;
  source_regular_price_usd: number | null;
  fsr_selling_price: number | null;
  exchange_rate: number | null;
  exchange_rate_timestamp: string | null;
  exchange_rate_provider: string | null;
  source_weight_kg: number | null;
  weight_surcharge_inr: number | null;
  weight_surcharge_reason: string | null;
  landed_cost_inr: number | null;
  profit_adjustment_inr: number | null;
  availability: string | null;
  import_status: string | null;
  skip_reason: string | null;
  exclusion_level: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  last_synced_at: string | null;
  last_sync_status: string | null;
  missing_scans: number;
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

export function getRow(style: string): MkRow | undefined {
  return mdb.prepare("SELECT * FROM products WHERE style_code = ?").get(style) as unknown as MkRow | undefined;
}

export function allRows(): MkRow[] {
  return mdb.prepare("SELECT * FROM products ORDER BY title, style_code").all() as unknown as MkRow[];
}

export function upsertRow(row: Partial<MkRow> & { style_code: string }) {
  const existing = getRow(row.style_code);
  const merged = { ...(existing ?? { missing_scans: 0, published: 0 }), ...row } as Record<string, unknown>;
  const cols = Object.keys(merged);
  mdb.prepare(
    `INSERT INTO products (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})
     ON CONFLICT(style_code) DO UPDATE SET ${cols.filter((c) => c !== "style_code").map((c) => `${c}=excluded.${c}`).join(",")}`,
  ).run(...(cols.map((c) => (merged[c] ?? null) as string | number | null)));
}

export interface ImageRow { style_code: string; source_key: string; colour: string | null; media_id: string | null; uploaded_at: string | null }
export function imagesFor(style: string): ImageRow[] {
  return mdb.prepare("SELECT * FROM images WHERE style_code = ?").all(style) as unknown as ImageRow[];
}
export function replaceImages(style: string, rows: Omit<ImageRow, "style_code">[]) {
  mdb.prepare("DELETE FROM images WHERE style_code = ?").run(style);
  const ins = mdb.prepare("INSERT INTO images (style_code, source_key, colour, media_id, uploaded_at) VALUES (?,?,?,?,?)");
  for (const r of rows) ins.run(style, r.source_key, r.colour, r.media_id, r.uploaded_at);
}

export function recordPriceChange(p: { style: string; colour: string; at: string; oldUsd: number | null; newUsd: number; oldRegular: number | null; newRegular: number | null; oldFsr: number | null; newFsr: number; rate: number; syncId: string }) {
  mdb.prepare("INSERT INTO price_history (style_code, colour, changed_at, old_usd, new_usd, old_regular_usd, new_regular_usd, old_fsr, new_fsr, exchange_rate, sync_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(p.style, p.colour, p.at, p.oldUsd, p.newUsd, p.oldRegular, p.newRegular, p.oldFsr, p.newFsr, p.rate, p.syncId);
}

export function getMkSettings(): MkSettings {
  const s = mkEnvSettings() as unknown as Record<string, unknown>;
  const rows = mdb.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  for (const r of rows) if ((MK_KEYS as string[]).includes(r.key)) s[r.key] = coerceMk(r.key as keyof MkSettings, r.value);
  return s as unknown as MkSettings;
}

export function setMkSetting(key: keyof MkSettings, value: unknown) {
  if (!MK_KEYS.includes(key)) throw new Error(`Unknown setting ${key}`);
  const v = coerceMk(key, value);
  validateMkSetting(key, v);
  mdb.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(v));
  // saving a manual exchange rate (even the same value) is the owner re-confirming it: restarts its age clock
  if (key === "MANUAL_EXCHANGE_RATE" && Number(v) > 0) setMState("manual_rate_confirmed_at", new Date().toISOString());
}

export function getMState(key: string): string | null {
  const r = mdb.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
export function setMState(key: string, value: string | null) {
  mdb.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

const LOCK_STALE_MS = 4 * 60 * 60 * 1000; // a full Michael Kors crawl (~700 pages at 3 s) takes ~40-60 min
export function acquireMLock(syncId: string): boolean {
  const cur = getMState("lock");
  if (cur) {
    const { at, pid } = JSON.parse(cur) as { at: string; pid: number };
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive && Date.now() - new Date(at).getTime() < LOCK_STALE_MS) return false;
  }
  setMState("lock", JSON.stringify({ id: syncId, at: new Date().toISOString(), pid: process.pid }));
  return true;
}
export function releaseMLock() { setMState("lock", null); }
export function currentMLock(): { id: string; at: string; pid: number } | null {
  const cur = getMState("lock");
  return cur ? JSON.parse(cur) : null;
}

/** MICHAELKORS-SYNC-2026-09-26-001 */
export function nextMkSyncId(): string {
  const day = new Date().toISOString().slice(0, 10);
  const r = mdb.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE id LIKE ?").get(`MICHAELKORS-SYNC-${day}-%`) as { n: number };
  return `MICHAELKORS-SYNC-${day}-${String(r.n + 1).padStart(3, "0")}`;
}
