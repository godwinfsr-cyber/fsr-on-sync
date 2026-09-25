import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR, SETTING_KEYS, coerce, envSettings, validateSetting, type Settings } from "./config.ts";

const DB_PATH = path.join(DATA_DIR, "on-sync.sqlite");
export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  source_product_id TEXT PRIMARY KEY,      -- ON colorway SKU, e.g. 3MF30742143
  source_url TEXT,
  source_sku TEXT,
  source_style_code TEXT,                  -- ON productGroupID, e.g. 3MF3074
  title TEXT,
  gender TEXT,
  shopify_product_id TEXT,
  shopify_status TEXT,
  last_source_price REAL,
  last_source_list_price REAL,
  last_source_currency TEXT,
  last_fsr_price REAL,
  first_seen_at TEXT,
  last_seen_at TEXT,
  last_synced_at TEXT,
  last_detail_at TEXT,
  last_sync_status TEXT,                   -- created | updated | unchanged | failed | skipped | missing | archived | planned_*
  missing_scans INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  image_hash TEXT,
  availability_hash TEXT,
  price_hash TEXT,
  written_title TEXT,                      -- last values WE wrote to Shopify; used to detect manual edits
  written_desc_hash TEXT,
  written_seo_hash TEXT,
  written_eta TEXT,
  written_price TEXT,
  error_message TEXT,
  snapshot_json TEXT                       -- last normalized source record
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  mode TEXT NOT NULL,                      -- dry_run | live
  trigger TEXT,
  status TEXT NOT NULL,                    -- running | success | partial | failed | aborted
  summary_json TEXT,
  errors_json TEXT
);
CREATE TABLE IF NOT EXISTS sync_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id TEXT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  stage TEXT,
  source_product_id TEXT,
  message TEXT,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_sync ON sync_events(sync_id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
`);

// migrations for databases created by earlier versions
for (const [col, ddl] of [["published", "INTEGER NOT NULL DEFAULT 0"]] as const) {
  const cols = db.prepare("PRAGMA table_info(products)").all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE products ADD COLUMN ${col} ${ddl}`);
}

export interface ProductRow {
  source_product_id: string;
  source_url: string | null;
  source_sku: string | null;
  source_style_code: string | null;
  title: string | null;
  gender: string | null;
  shopify_product_id: string | null;
  shopify_status: string | null;
  last_source_price: number | null;
  last_source_list_price: number | null;
  last_source_currency: string | null;
  last_fsr_price: number | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  last_synced_at: string | null;
  last_detail_at: string | null;
  last_sync_status: string | null;
  missing_scans: number;
  content_hash: string | null;
  image_hash: string | null;
  availability_hash: string | null;
  price_hash: string | null;
  written_title: string | null;
  written_desc_hash: string | null;
  written_seo_hash: string | null;
  written_eta: string | null;
  written_price: string | null;
  error_message: string | null;
  snapshot_json: string | null;
  published: number;               // 1 = published to the configured sales channels
}

export function getProduct(id: string): ProductRow | undefined {
  return db.prepare("SELECT * FROM products WHERE source_product_id = ?").get(id) as unknown as ProductRow | undefined;
}

export function allProducts(): ProductRow[] {
  return db.prepare("SELECT * FROM products ORDER BY title").all() as unknown as ProductRow[];
}

export function upsertProduct(row: Partial<ProductRow> & { source_product_id: string }) {
  const existing = getProduct(row.source_product_id);
  const merged = { ...(existing ?? { missing_scans: 0 }), ...row } as Record<string, unknown>;
  const cols = Object.keys(merged);
  db.prepare(
    `INSERT INTO products (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})
     ON CONFLICT(source_product_id) DO UPDATE SET ${cols.filter((c) => c !== "source_product_id").map((c) => `${c}=excluded.${c}`).join(",")}`,
  ).run(...(cols.map((c) => (merged[c] ?? null) as string | number | null)));
}

// ---- settings: .env defaults overlaid with dashboard overrides ----
export function getSettings(): Settings {
  const s = envSettings() as unknown as Record<string, unknown>;
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  for (const r of rows) if ((SETTING_KEYS as string[]).includes(r.key)) s[r.key] = coerce(r.key as keyof Settings, r.value);
  return s as unknown as Settings;
}

export function setSetting(key: keyof Settings, value: unknown) {
  if (!SETTING_KEYS.includes(key)) throw new Error(`Unknown setting ${key}`);
  const v = coerce(key, value);
  validateSetting(key, v);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(v));
}

export function getState(key: string): string | null {
  const r = db.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
export function setState(key: string, value: string | null) {
  db.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// ---- run lock (prevents overlapping syncs from scheduler + dashboard) ----
const LOCK_STALE_MS = 3 * 60 * 60 * 1000;
export function acquireLock(syncId: string): boolean {
  const cur = getState("lock");
  if (cur) {
    const { id, at, pid } = JSON.parse(cur) as { id: string; at: string; pid: number };
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive && Date.now() - new Date(at).getTime() < LOCK_STALE_MS) return false;
    void id;
  }
  setState("lock", JSON.stringify({ id: syncId, at: new Date().toISOString(), pid: process.pid }));
  return true;
}
export function releaseLock() { setState("lock", null); }
export function currentLock(): { id: string; at: string; pid: number } | null {
  const cur = getState("lock");
  return cur ? JSON.parse(cur) : null;
}

export function nextSyncId(): string {
  const day = new Date().toISOString().slice(0, 10);
  const r = db.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE id LIKE ?").get(`SYNC-${day}-%`) as { n: number };
  return `SYNC-${day}-${String(r.n + 1).padStart(3, "0")}`;
}
