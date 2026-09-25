// Gymshark (gymshark.com, USD) -> Full Size Run settings. Shares ROOT/.env loading and Shopify credentials with
// the other sources (../config.ts); every business setting reads GYMSHARK_<KEY> from .env and can be overridden
// from the dashboard (stored in the Gymshark SQLite `settings` table).
import "../config.ts";

export type PriceRoundingMode = "NONE" | "NEAREST_10" | "NEAREST_50" | "NEAREST_100";
export type SourcePriceBasis = "CURRENT_SELLING" | "REGULAR";
export type CompareAtMode = "SOURCE_REGULAR" | "NONE";
export type FxProvider = "open.er-api.com" | "frankfurter" | "manual";
export type MissingAction = "archive" | "draft";

export interface WeightBand { maxKg: number | null; surchargeInr: number } // maxKg null = open-ended top band

export interface GymsharkSettings {
  SYNC_INTERVAL_HOURS: number;
  SYNC_PAUSED: boolean;
  DRY_RUN: boolean;
  SYNC_LIMIT: number;                  // 0 = whole catalog (limit counts styles = FSR products)
  DEFAULT_ETA: string;
  PRICING_MODE: "USD_TO_INR_PLUS_WEIGHT_SURCHARGE";
  SOURCE_CURRENCY: string;
  TARGET_CURRENCY: string;
  SOURCE_PRICE_BASIS: SourcePriceBasis; // which Gymshark price is FSR's purchase price (default: what Gymshark currently charges)
  COMPARE_AT_MODE: CompareAtMode;       // SOURCE_REGULAR: when Gymshark shows a sale, compare-at = regular price through the same formula
  FX_PROVIDER: FxProvider;
  MANUAL_EXCHANGE_RATE: number;         // only for FX_PROVIDER=manual; 0 = not set
  MAX_EXCHANGE_RATE_AGE_HOURS: number;
  WEIGHT_SURCHARGE_ENABLED: boolean;
  WEIGHT_SURCHARGE_FALLBACK_INR: number;
  WEIGHT_BANDS: string;                 // "0.5:1000,1:1500,2:2000,3:2500,+:3000"  (upper bound kg : INR)
  FSR_PROFIT_INR: number;               // fixed FSR profit added after the weight surcharge
  PRICE_ROUNDING_MODE: PriceRoundingMode;
  PRODUCT_MISSING_CONFIRMATION_SCANS: number;
  MISSING_ACTION: MissingAction;
  NEW_PRODUCT_STATUS: "ACTIVE" | "DRAFT";
  CONTENT_REUSE_CONFIRMED: boolean;     // Gymshark images + description text may be copied (confirmed by the store owner)
  OVERWRITE_MANUAL_DESCRIPTION: boolean;
  ADOPT_EXISTING_PRODUCTS: boolean;
  VENDOR: string;
  PRODUCT_TYPE_MAP: string;             // Gymshark category or division -> Shopify product type, "bags:Bags,apparel:Apparel"
  DEFAULT_PRODUCT_TYPE: string;
  BASE_TAGS: string;
  TITLE_TEMPLATE: string;               // {title} {gender} {style}
  PUBLISH_CHANNELS: string;
  REQUEST_DELAY_MS: number;
}

export const GYMSHARK_KEYS: (keyof GymsharkSettings)[] = [
  "SYNC_INTERVAL_HOURS", "SYNC_PAUSED", "DRY_RUN", "SYNC_LIMIT", "DEFAULT_ETA", "PRICING_MODE", "SOURCE_CURRENCY", "TARGET_CURRENCY",
  "SOURCE_PRICE_BASIS", "COMPARE_AT_MODE", "FX_PROVIDER", "MANUAL_EXCHANGE_RATE", "MAX_EXCHANGE_RATE_AGE_HOURS", "WEIGHT_SURCHARGE_ENABLED",
  "WEIGHT_SURCHARGE_FALLBACK_INR", "WEIGHT_BANDS", "FSR_PROFIT_INR", "PRICE_ROUNDING_MODE", "PRODUCT_MISSING_CONFIRMATION_SCANS", "MISSING_ACTION",
  "NEW_PRODUCT_STATUS", "CONTENT_REUSE_CONFIRMED", "OVERWRITE_MANUAL_DESCRIPTION", "ADOPT_EXISTING_PRODUCTS", "VENDOR", "PRODUCT_TYPE_MAP",
  "DEFAULT_PRODUCT_TYPE", "BASE_TAGS", "TITLE_TEMPLATE", "PUBLISH_CHANNELS", "REQUEST_DELAY_MS",
];

const DEFAULTS: GymsharkSettings = {
  SYNC_INTERVAL_HOURS: 5,
  SYNC_PAUSED: false,
  DRY_RUN: true, // nothing is written to Shopify until explicitly switched off
  SYNC_LIMIT: 0,
  DEFAULT_ETA: "15–20 Days",
  PRICING_MODE: "USD_TO_INR_PLUS_WEIGHT_SURCHARGE",
  SOURCE_CURRENCY: "USD",
  TARGET_CURRENCY: "INR",
  SOURCE_PRICE_BASIS: "CURRENT_SELLING",
  COMPARE_AT_MODE: "SOURCE_REGULAR",
  FX_PROVIDER: "open.er-api.com",
  MANUAL_EXCHANGE_RATE: 0,
  MAX_EXCHANGE_RATE_AGE_HOURS: 24,
  WEIGHT_SURCHARGE_ENABLED: true,
  WEIGHT_SURCHARGE_FALLBACK_INR: 2000,
  WEIGHT_BANDS: "0.5:1000,1:1500,2:2000,3:2500,+:3000",
  FSR_PROFIT_INR: 1500,
  PRICE_ROUNDING_MODE: "NONE",
  PRODUCT_MISSING_CONFIRMATION_SCANS: 2,
  MISSING_ACTION: "archive",
  NEW_PRODUCT_STATUS: "DRAFT",
  CONTENT_REUSE_CONFIRMED: false,
  OVERWRITE_MANUAL_DESCRIPTION: false,
  ADOPT_EXISTING_PRODUCTS: false,
  VENDOR: "Gymshark",
  // the store's nav collections key on product type (Apparel / Accessories / Bags ...); the Gymshark category
  // (Leggings, Sports Bras ...) goes into tags + gymshark_sync.category instead
  PRODUCT_TYPE_MAP: "bags:Bags,apparel:Apparel,accessories:Accessories,footwear:Sneakers",
  DEFAULT_PRODUCT_TYPE: "Apparel",
  BASE_TAGS: "Gymshark,ETA,gymshark-sync",
  TITLE_TEMPLATE: "Gymshark {title} ({gender})", // Gymshark reuses titles across men's and women's styles
  PUBLISH_CHANNELS: "Online Store,Point of Sale,Inbox",
  REQUEST_DELAY_MS: 2500,
};

const ENUMS: Partial<Record<keyof GymsharkSettings, string[]>> = {
  PRICING_MODE: ["USD_TO_INR_PLUS_WEIGHT_SURCHARGE"],
  SOURCE_PRICE_BASIS: ["CURRENT_SELLING", "REGULAR"],
  COMPARE_AT_MODE: ["SOURCE_REGULAR", "NONE"],
  FX_PROVIDER: ["open.er-api.com", "frankfurter", "manual"],
  PRICE_ROUNDING_MODE: ["NONE", "NEAREST_10", "NEAREST_50", "NEAREST_100"],
  MISSING_ACTION: ["archive", "draft"],
  NEW_PRODUCT_STATUS: ["ACTIVE", "DRAFT"],
};

export function coerceGymshark<K extends keyof GymsharkSettings>(key: K, raw: unknown): GymsharkSettings[K] {
  const def = DEFAULTS[key];
  if (raw === undefined || raw === null || raw === "") return def;
  if (typeof def === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Setting ${key} must be a non-negative number (got "${raw}")`);
    return n as GymsharkSettings[K];
  }
  if (typeof def === "boolean") return (raw === true || /^(true|1|yes|on)$/i.test(String(raw))) as GymsharkSettings[K];
  return String(raw) as GymsharkSettings[K];
}

export function validateGymsharkSetting(key: keyof GymsharkSettings, value: unknown) {
  const allowed = ENUMS[key];
  if (allowed && !allowed.includes(String(value))) throw new Error(`Setting ${key} must be one of ${allowed.join(", ")}`);
  if (key === "SYNC_INTERVAL_HOURS" && Number(value) < 1) throw new Error("SYNC_INTERVAL_HOURS must be at least 1");
  if (key === "PRODUCT_MISSING_CONFIRMATION_SCANS" && Number(value) < 1) throw new Error("PRODUCT_MISSING_CONFIRMATION_SCANS must be at least 1");
  if (key === "REQUEST_DELAY_MS" && Number(value) < 1000) throw new Error("REQUEST_DELAY_MS must be at least 1000 (politeness floor)");
  if (key === "MAX_EXCHANGE_RATE_AGE_HOURS" && !(Number(value) > 0)) throw new Error("MAX_EXCHANGE_RATE_AGE_HOURS must be greater than 0");
  if (key === "WEIGHT_BANDS") parseWeightBands(String(value));
  if (key === "PRODUCT_TYPE_MAP") parseMap(String(value));
  if ((key === "SOURCE_CURRENCY" || key === "TARGET_CURRENCY") && !/^[A-Z]{3}$/.test(String(value))) throw new Error(`${key} must be a 3-letter currency code`);
}

/** "0.5:1000,1:1500,2:2000,3:2500,+:3000" -> ascending bands; the last band must be open-ended ("+"). */
export function parseWeightBands(spec: string): WeightBand[] {
  const bands = spec.split(",").map((x) => x.trim()).filter(Boolean).map((part) => {
    const [kg, inr] = part.split(":").map((x) => x.trim());
    const surchargeInr = Number(inr);
    if (!Number.isFinite(surchargeInr) || surchargeInr < 0) throw new Error(`WEIGHT_BANDS: bad surcharge in "${part}"`);
    if (kg === "+") return { maxKg: null, surchargeInr };
    const maxKg = Number(kg);
    if (!(maxKg > 0)) throw new Error(`WEIGHT_BANDS: bad weight in "${part}"`);
    return { maxKg, surchargeInr };
  });
  if (!bands.length) throw new Error("WEIGHT_BANDS is empty");
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (b.maxKg == null && i !== bands.length - 1) throw new Error('WEIGHT_BANDS: the open-ended "+" band must be last');
    if (i > 0 && b.maxKg != null && !(b.maxKg > bands[i - 1].maxKg!)) throw new Error("WEIGHT_BANDS: upper bounds must increase");
  }
  if (bands[bands.length - 1].maxKg != null) throw new Error('WEIGHT_BANDS: add an open-ended top band, e.g. "+:3000"');
  return bands;
}

export function parseMap(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of spec.split(",").map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    if (i <= 0) throw new Error(`bad map entry "${part}" (expected key:value)`);
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

export function gymsharkEnvSettings(): GymsharkSettings {
  const s = {} as Record<string, unknown>;
  for (const k of GYMSHARK_KEYS) s[k] = coerceGymshark(k, process.env[`GYMSHARK_${k}`]);
  return s as unknown as GymsharkSettings;
}

export const GYMSHARK_SOURCE = {
  origin: "https://www.gymshark.com",
  // robots.txt lists this sitemap index; the products sitemap covers the whole live US catalog
  sitemapIndex: process.env.GYMSHARK_SITEMAP_INDEX || "https://www.gymshark.com/sitemap.xml",
  userAgent: "Mozilla/5.0 (compatible; FullSizeRunCatalogSync/1.0; +https://fullsizerun.in)",
  // never imported: the e-gift card is not a physical product
  excludedHandles: ["gift-card"],
  excludedSkus: ["GSGFTCRD"],
};
