import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../config.ts";
import type { FxStore } from "../gymshark/fx.ts";
import { ALO_KEYS, aloEnvSettings, coerceAlo, validateAloSetting, type AloSettings } from "./config.ts";

// Separate database from the other sources so they never share ids, locks or run numbering.
const DB_PATH = path.join(DATA_DIR, "alo-sync.sqlite");
export const adb = new DatabaseSync(DB_PATH);
adb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

adb.exec(`
CREATE TABLE IF NOT EXISTS products (
  style_id TEXT PRIMARY KEY,               -- ALO StyleId shared by every colourway, e.g. W54234R = one FSR product
  source_product_ids TEXT,                 -- JSON {colour: ALO (Shopify) product id}
  source_handles TEXT,                     -- JSON list of every ALO handle listing this style (incl. men's/women's duplicates)
  source_url TEXT,
  canonical_url TEXT,
  title TEXT,
  gender TEXT,
  category TEXT,
  subcategory TEXT,
  collection TEXT,
  product_type TEXT,
  colours TEXT,                            -- JSON list
  shopify_product_id TEXT,
  shopify_status TEXT,
  source_price_usd REAL,                   -- lowest current selling price across variants (dashboard)
  source_regular_price_usd REAL,
  source_sale_price_usd REAL,
  converted_price_inr REAL,
  flat_adjustment_inr REAL,
  fsr_selling_price REAL,                  -- lowest FSR price across variants
  exchange_rate REAL,
  exchange_rate_timestamp TEXT,
  exchange_rate_provider TEXT,
  availability TEXT,                       -- in_stock | low_stock | out_of_stock | coming_soon
  first_seen_at TEXT,
  last_seen_at TEXT,
  last_synced_at TEXT,
  last_sync_status TEXT,                   -- created | updated | unchanged | failed | needs_review | missing | archived
  missing_scans INTEGER NOT NULL DEFAULT 0,
  source_updated_at TEXT,                  -- newest ALO updated_at across colourways
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
  style_id TEXT NOT NULL,
  source_key TEXT NOT NULL,                -- ALO CDN path without ?v= (stable per photo)
  colour TEXT,
  media_id TEXT,                           -- Shopify MediaImage id once uploaded
  uploaded_at TEXT,
  PRIMARY KEY (style_id, source_key)
);
CREATE TABLE IF NOT EXISTS colour_details (
  handle TEXT PRIMARY KEY,                 -- ALO colourway handle
  source_updated_at TEXT,                  -- ALO updated_at when fetched (re-fetched only when it changes)
  currency TEXT,
  barcodes TEXT,                           -- JSON {sku: barcode}
  fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS style_details (
  style_id TEXT PRIMARY KEY,
  source_updated_at TEXT,
  attribs TEXT,                            -- JSON: ALO's own product attributes (fabrication, fit ...)
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
  id INTEGER PRIMARY KEY AUTOINCREMENT, style_id TEXT NOT NULL, colour TEXT, changed_at TEXT NOT NULL,
  old_usd REAL, new_usd REAL, old_regular_usd REAL, new_regular_usd REAL, old_fsr REAL, new_fsr REAL, exchange_rate REAL, sync_id TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
`);

export interface AloRow {
  style_id: string;
  source_product_ids: string | null;
  source_handles: string | null;
  source_url: string | null;
  canonical_url: string | null;
  title: string | null;
  gender: string | null;
  category: string | null;
  subcategory: string | null;
  collection: string | null;
  product_type: string | null;
  colours: string | null;
  shopify_product_id: string | null;
  shopify_status: string | null;
  source_price_usd: number | null;
  source_regular_price_usd: number | null;
  source_sale_price_usd: number | null;
  converted_price_inr: number | null;
  flat_adjustment_inr: number | null;
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

export function getRow(style: string): AloRow | undefined {
  return adb.prepare("SELECT * FROM products WHERE style_id = ?").get(style) as unknown as AloRow | undefined;
}

export function allRows(): AloRow[] {
  return adb.prepare("SELECT * FROM products ORDER BY title, style_id").all() as unknown as AloRow[];
}

export function upsertRow(row: Partial<AloRow> & { style_id: string }) {
  const existing = getRow(row.style_id);
  const merged = { ...(existing ?? { missing_scans: 0, published: 0 }), ...row } as Record<string, unknown>;
  const cols = Object.keys(merged);
  adb.prepare(
    `INSERT INTO products (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})
     ON CONFLICT(style_id) DO UPDATE SET ${cols.filter((c) => c !== "style_id").map((c) => `${c}=excluded.${c}`).join(",")}`,
  ).run(...(cols.map((c) => (merged[c] ?? null) as string | number | null)));
}

export interface ImageRow { style_id: string; source_key: string; colour: string | null; media_id: string | null; uploaded_at: string | null }
export function imagesFor(style: string): ImageRow[] {
  return adb.prepare("SELECT * FROM images WHERE style_id = ?").all(style) as unknown as ImageRow[];
}
export function replaceImages(style: string, rows: Omit<ImageRow, "style_id">[]) {
  adb.prepare("DELETE FROM images WHERE style_id = ?").run(style);
  const ins = adb.prepare("INSERT INTO images (style_id, source_key, colour, media_id, uploaded_at) VALUES (?,?,?,?,?)");
  for (const r of rows) ins.run(style, r.source_key, r.colour, r.media_id, r.uploaded_at);
}

export interface ColourDetailRow { handle: string; source_updated_at: string | null; currency: string | null; barcodes: string | null; fetched_at: string | null }
export function colourDetail(handle: string): ColourDetailRow | undefined {
  return adb.prepare("SELECT * FROM colour_details WHERE handle = ?").get(handle) as unknown as ColourDetailRow | undefined;
}
export function saveColourDetail(r: ColourDetailRow) {
  adb.prepare("INSERT INTO colour_details (handle, source_updated_at, currency, barcodes, fetched_at) VALUES (?,?,?,?,?) ON CONFLICT(handle) DO UPDATE SET source_updated_at=excluded.source_updated_at, currency=excluded.currency, barcodes=excluded.barcodes, fetched_at=excluded.fetched_at")
    .run(r.handle, r.source_updated_at, r.currency, r.barcodes, r.fetched_at);
}
export interface StyleDetailRow { style_id: string; source_updated_at: string | null; attribs: string | null; fetched_at: string | null }
export function styleDetail(style: string): StyleDetailRow | undefined {
  return adb.prepare("SELECT * FROM style_details WHERE style_id = ?").get(style) as unknown as StyleDetailRow | undefined;
}
export function saveStyleDetail(r: StyleDetailRow) {
  adb.prepare("INSERT INTO style_details (style_id, source_updated_at, attribs, fetched_at) VALUES (?,?,?,?) ON CONFLICT(style_id) DO UPDATE SET source_updated_at=excluded.source_updated_at, attribs=excluded.attribs, fetched_at=excluded.fetched_at")
    .run(r.style_id, r.source_updated_at, r.attribs, r.fetched_at);
}

export function recordPriceChange(p: { style: string; colour: string; at: string; oldUsd: number | null; newUsd: number; oldRegular: number | null; newRegular: number | null; oldFsr: number | null; newFsr: number; rate: number; syncId: string }) {
  adb.prepare("INSERT INTO price_history (style_id, colour, changed_at, old_usd, new_usd, old_regular_usd, new_regular_usd, old_fsr, new_fsr, exchange_rate, sync_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(p.style, p.colour, p.at, p.oldUsd, p.newUsd, p.oldRegular, p.newRegular, p.oldFsr, p.newFsr, p.rate, p.syncId);
}

export function getAloSettings(): AloSettings {
  const s = aloEnvSettings() as unknown as Record<string, unknown>;
  const rows = adb.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  for (const r of rows) if ((ALO_KEYS as string[]).includes(r.key)) s[r.key] = coerceAlo(r.key as keyof AloSettings, r.value);
  return s as unknown as AloSettings;
}

export function setAloSetting(key: keyof AloSettings, value: unknown) {
  if (!ALO_KEYS.includes(key)) throw new Error(`Unknown setting ${key}`);
  const v = coerceAlo(key, value);
  validateAloSetting(key, v);
  adb.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(v));
  // saving a manual exchange rate (even the same value) is the owner re-confirming it: restarts its age clock
  if (key === "MANUAL_EXCHANGE_RATE" && Number(v) > 0) setAState("manual_rate_confirmed_at", new Date().toISOString());
}

export function getAState(key: string): string | null {
  const r = adb.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
export function setAState(key: string, value: string | null) {
  adb.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** The shared exchange-rate service records ALO rates in this database. */
export const ALO_FX_STORE: FxStore = { db: adb, getState: getAState };

const LOCK_STALE_MS = 4 * 60 * 60 * 1000; // a first full import with details takes ~2 h
export function acquireALock(syncId: string): boolean {
  const cur = getAState("lock");
  if (cur) {
    const { at, pid } = JSON.parse(cur) as { at: string; pid: number };
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive && Date.now() - new Date(at).getTime() < LOCK_STALE_MS) return false;
  }
  setAState("lock", JSON.stringify({ id: syncId, at: new Date().toISOString(), pid: process.pid }));
  return true;
}
export function releaseALock() { setAState("lock", null); }
export function currentALock(): { id: string; at: string; pid: number } | null {
  const cur = getAState("lock");
  return cur ? JSON.parse(cur) : null;
}

/** ALO-SYNC-2026-09-26-001 */
export function nextAloSyncId(): string {
  const day = new Date().toISOString().slice(0, 10);
  const r = adb.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE id LIKE ?").get(`ALO-SYNC-${day}-%`) as { n: number };
  return `ALO-SYNC-${day}-${String(r.n + 1).padStart(3, "0")}`;
}
