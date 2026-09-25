import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../config.ts";
import { GYMSHARK_KEYS, coerceGymshark, gymsharkEnvSettings, validateGymsharkSetting, type GymsharkSettings } from "./config.ts";

// Separate database from the other sources so they never share ids, locks or run numbering.
const DB_PATH = path.join(DATA_DIR, "gymshark-sync.sqlite");
export const gdb = new DatabaseSync(DB_PATH);
gdb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

gdb.exec(`
CREATE TABLE IF NOT EXISTS products (
  style_code TEXT PRIMARY KEY,             -- Gymshark style code shared by all colours, e.g. A5A2Z = one FSR product
  source_product_ids TEXT,                 -- JSON {colour: Gymshark product id}
  source_url TEXT,
  canonical_url TEXT,
  handle TEXT,
  title TEXT,
  gender TEXT,
  category TEXT,
  subcategory TEXT,
  division TEXT,
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
  availability TEXT,                       -- in_stock | low_stock | out_of_stock
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
  source_key TEXT NOT NULL,                -- Gymshark CDN path without ?v= (stable per photo)
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

export interface GymsharkRow {
  style_code: string;
  source_product_ids: string | null;
  source_url: string | null;
  canonical_url: string | null;
  handle: string | null;
  title: string | null;
  gender: string | null;
  category: string | null;
  subcategory: string | null;
  division: string | null;
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
  availability: string | null;
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

export function getRow(style: string): GymsharkRow | undefined {
  return gdb.prepare("SELECT * FROM products WHERE style_code = ?").get(style) as unknown as GymsharkRow | undefined;
}

export function allRows(): GymsharkRow[] {
  return gdb.prepare("SELECT * FROM products ORDER BY title, style_code").all() as unknown as GymsharkRow[];
}

export function upsertRow(row: Partial<GymsharkRow> & { style_code: string }) {
  const existing = getRow(row.style_code);
  const merged = { ...(existing ?? { missing_scans: 0, published: 0 }), ...row } as Record<string, unknown>;
  const cols = Object.keys(merged);
  gdb.prepare(
    `INSERT INTO products (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})
     ON CONFLICT(style_code) DO UPDATE SET ${cols.filter((c) => c !== "style_code").map((c) => `${c}=excluded.${c}`).join(",")}`,
  ).run(...(cols.map((c) => (merged[c] ?? null) as string | number | null)));
}

export interface ImageRow { style_code: string; source_key: string; colour: string | null; media_id: string | null; uploaded_at: string | null }
export function imagesFor(style: string): ImageRow[] {
  return gdb.prepare("SELECT * FROM images WHERE style_code = ?").all(style) as unknown as ImageRow[];
}
export function replaceImages(style: string, rows: Omit<ImageRow, "style_code">[]) {
  gdb.prepare("DELETE FROM images WHERE style_code = ?").run(style);
  const ins = gdb.prepare("INSERT INTO images (style_code, source_key, colour, media_id, uploaded_at) VALUES (?,?,?,?,?)");
  for (const r of rows) ins.run(style, r.source_key, r.colour, r.media_id, r.uploaded_at);
}

export function recordPriceChange(p: { style: string; colour: string; at: string; oldUsd: number | null; newUsd: number; oldRegular: number | null; newRegular: number | null; oldFsr: number | null; newFsr: number; rate: number; syncId: string }) {
  gdb.prepare("INSERT INTO price_history (style_code, colour, changed_at, old_usd, new_usd, old_regular_usd, new_regular_usd, old_fsr, new_fsr, exchange_rate, sync_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(p.style, p.colour, p.at, p.oldUsd, p.newUsd, p.oldRegular, p.newRegular, p.oldFsr, p.newFsr, p.rate, p.syncId);
}

export function getGymsharkSettings(): GymsharkSettings {
  const s = gymsharkEnvSettings() as unknown as Record<string, unknown>;
  const rows = gdb.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  for (const r of rows) if ((GYMSHARK_KEYS as string[]).includes(r.key)) s[r.key] = coerceGymshark(r.key as keyof GymsharkSettings, r.value);
  return s as unknown as GymsharkSettings;
}

export function setGymsharkSetting(key: keyof GymsharkSettings, value: unknown) {
  if (!GYMSHARK_KEYS.includes(key)) throw new Error(`Unknown setting ${key}`);
  const v = coerceGymshark(key, value);
  validateGymsharkSetting(key, v);
  gdb.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(v));
  // saving a manual exchange rate (even the same value) is the owner re-confirming it: restarts its age clock
  if (key === "MANUAL_EXCHANGE_RATE" && Number(v) > 0) setGState("manual_rate_confirmed_at", new Date().toISOString());
}

export function getGState(key: string): string | null {
  const r = gdb.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
export function setGState(key: string, value: string | null) {
  gdb.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

const LOCK_STALE_MS = 4 * 60 * 60 * 1000; // a full Gymshark crawl takes ~1-2 h
export function acquireGLock(syncId: string): boolean {
  const cur = getGState("lock");
  if (cur) {
    const { at, pid } = JSON.parse(cur) as { at: string; pid: number };
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive && Date.now() - new Date(at).getTime() < LOCK_STALE_MS) return false;
  }
  setGState("lock", JSON.stringify({ id: syncId, at: new Date().toISOString(), pid: process.pid }));
  return true;
}
export function releaseGLock() { setGState("lock", null); }
export function currentGLock(): { id: string; at: string; pid: number } | null {
  const cur = getGState("lock");
  return cur ? JSON.parse(cur) : null;
}

/** GYMSHARK-SYNC-2026-09-26-001 */
export function nextGymsharkSyncId(): string {
  const day = new Date().toISOString().slice(0, 10);
  const r = gdb.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE id LIKE ?").get(`GYMSHARK-SYNC-${day}-%`) as { n: number };
  return `GYMSHARK-SYNC-${day}-${String(r.n + 1).padStart(3, "0")}`;
}
