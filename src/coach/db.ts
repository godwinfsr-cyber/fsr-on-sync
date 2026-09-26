import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../config.ts";

// Checkpoint database for the one-time Coach import (committed back to the repo after every cloud run, so a later manual
// run continues where the previous one stopped and never creates a product twice).
export const cdb = new DatabaseSync(path.join(DATA_DIR, "coach-import.sqlite"));
cdb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
cdb.exec(`
CREATE TABLE IF NOT EXISTS items (
  source_product_id TEXT PRIMARY KEY,      -- Coach style + colour, e.g. CV933-IMXAQ
  style TEXT, colour TEXT, title TEXT, handle TEXT,
  status TEXT NOT NULL,                    -- DISCOVERED | VALIDATED | DUPLICATE | WATCH_EXCLUDED | SKIPPED | PRICED | CREATING | IMPORTED | ALREADY_EXISTS | FAILED
  stage TEXT,                              -- last stage reached / failed at
  shopify_product_id TEXT,
  matched_by TEXT,                         -- ALREADY_EXISTS: which duplicate rule matched
  source_url TEXT, source_mainline_url TEXT, source_outlet_url TEXT,
  sku TEXT, source_price_usd REAL, exchange_rate REAL, shipping_inr REAL, landed_cost_inr REAL, profit_inr REAL, fsr_price REAL, compare_at REAL,
  image_count INTEGER, variant_count INTEGER,
  error TEXT, run_id TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, mode TEXT, started_at TEXT, finished_at TEXT, status TEXT, report_json TEXT);
CREATE TABLE IF NOT EXISTS fx_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, base TEXT NOT NULL, quote TEXT NOT NULL, rate REAL,
  provider_updated_at TEXT, fetched_at TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sync_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sync_id TEXT, ts TEXT NOT NULL, level TEXT NOT NULL, stage TEXT,
  source_product_id TEXT, message TEXT, data_json TEXT
);
`);

export interface ItemRow {
  source_product_id: string; style: string | null; colour: string | null; title: string | null; handle: string | null; status: string; stage: string | null;
  shopify_product_id: string | null; matched_by: string | null; source_url: string | null; source_mainline_url: string | null; source_outlet_url: string | null;
  sku: string | null; source_price_usd: number | null; exchange_rate: number | null; shipping_inr: number | null; landed_cost_inr: number | null; profit_inr: number | null;
  fsr_price: number | null; compare_at: number | null; image_count: number | null; variant_count: number | null; error: string | null; run_id: string | null; updated_at: string | null;
}

export function getItem(id: string): ItemRow | undefined {
  return cdb.prepare("SELECT * FROM items WHERE source_product_id = ?").get(id) as unknown as ItemRow | undefined;
}
export function upsertItem(row: Partial<ItemRow> & { source_product_id: string; status: string }) {
  const merged = { ...(getItem(row.source_product_id) ?? {}), ...row, updated_at: new Date().toISOString() } as Record<string, unknown>;
  const cols = Object.keys(merged);
  cdb.prepare(`INSERT INTO items (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")}) ON CONFLICT(source_product_id) DO UPDATE SET ${cols.filter((c) => c !== "source_product_id").map((c) => `${c}=excluded.${c}`).join(",")}`)
    .run(...cols.map((c) => (merged[c] ?? null) as string | number | null));
}
export function getState(key: string): string | null {
  return (cdb.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
}
export function setState(key: string, value: string | null) {
  cdb.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
