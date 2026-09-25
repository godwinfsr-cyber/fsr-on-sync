// Stanley 1913 (stanley1913.com, USD) -> Full Size Run settings. Shares ROOT/.env loading and Shopify credentials with
// the other sources (../config.ts); every business setting reads STANLEY_<KEY> from .env and can be overridden from the
// dashboard (stored in the Stanley SQLite `settings` table).
import "../config.ts";
import { parseMap, type CompareAtMode, type FxProvider, type MissingAction, type PriceRoundingMode, type SourcePriceBasis } from "../gymshark/config.ts";

export { parseMap };

export interface StanleySettings {
  ENABLED: boolean;                       // false = the scheduler never starts a Stanley sync (manual CLI runs still work)
  SYNC_INTERVAL_HOURS: number;
  SYNC_PAUSED: boolean;
  DRY_RUN: boolean;
  // Catalog size guard: unless FULL_SYNC=true AND TEST_MODE=false, a run processes at most TEST_PRODUCT_LIMIT products.
  TEST_MODE: boolean;
  TEST_PRODUCT_LIMIT: number;
  FULL_SYNC: boolean;
  ETA: string;                            // custom.eta
  PRICING_MODE: "USD_TO_INR_PLUS_FLAT";
  SOURCE_CURRENCY: string;
  TARGET_CURRENCY: string;
  SOURCE_PRICE_BASIS: SourcePriceBasis;   // CURRENT_SELLING = what Stanley charges now (the sale price when on sale)
  COMPARE_AT_MODE: CompareAtMode;         // SOURCE_REGULAR = while Stanley shows a sale, compare-at = regular price through the same formula
  FX_PROVIDER: FxProvider;
  MANUAL_EXCHANGE_RATE: number;           // only for FX_PROVIDER=manual; 0 = not set
  MAX_EXCHANGE_RATE_AGE_HOURS: number;
  PRICING_ADJUSTMENT_INR: number;         // THE one central setting: fixed ₹ added once, after conversion (never compounded)
  PRICE_ROUNDING_MODE: PriceRoundingMode;
  PRODUCT_MISSING_CONFIRMATION_SCANS: number;
  MISSING_ACTION: MissingAction;
  NEW_PRODUCT_STATUS: "ACTIVE" | "DRAFT";
  AUTHORIZED_IMPORTER: boolean;           // FSR is the authorised Stanley importer for India: images + product text may be copied
  OVERWRITE_MANUAL_DESCRIPTION: boolean;
  ADOPT_EXISTING_PRODUCTS: boolean;
  FETCH_DETAILS: boolean;                 // per-listing product JSON (barcodes, weight) + one product page per product (specifications)
  DETAILS_MAX_AGE_HOURS: number;
  EXCLUDED_PRODUCT_TYPES: string;         // Stanley product types never imported (service fees, free stickers)
  EXCLUDED_TAGS: string;                  // e.g. stanley_create = personalised "Stanley Create" copies of regular products
  EXCLUDED_TITLE_PATTERNS: string;        // case-insensitive substrings, e.g. "Stanley Create,Gift Card"
  VENDOR: string;
  PRODUCT_TYPE_MAP: string;               // Stanley product type / tag (lower-case) -> Shopify product type
  DEFAULT_PRODUCT_TYPE: string;
  BASE_TAGS: string;
  TITLE_TEMPLATE: string;                 // {title}
  PUBLISH_CHANNELS: string;
  MAX_CONCURRENT_PRODUCTS: number;
  REQUEST_DELAY_MS: number;
}

export const STANLEY_KEYS: (keyof StanleySettings)[] = [
  "ENABLED", "SYNC_INTERVAL_HOURS", "SYNC_PAUSED", "DRY_RUN", "TEST_MODE", "TEST_PRODUCT_LIMIT", "FULL_SYNC", "ETA", "PRICING_MODE", "SOURCE_CURRENCY",
  "TARGET_CURRENCY", "SOURCE_PRICE_BASIS", "COMPARE_AT_MODE", "FX_PROVIDER", "MANUAL_EXCHANGE_RATE", "MAX_EXCHANGE_RATE_AGE_HOURS", "PRICING_ADJUSTMENT_INR",
  "PRICE_ROUNDING_MODE", "PRODUCT_MISSING_CONFIRMATION_SCANS", "MISSING_ACTION", "NEW_PRODUCT_STATUS", "AUTHORIZED_IMPORTER", "OVERWRITE_MANUAL_DESCRIPTION",
  "ADOPT_EXISTING_PRODUCTS", "FETCH_DETAILS", "DETAILS_MAX_AGE_HOURS", "EXCLUDED_PRODUCT_TYPES", "EXCLUDED_TAGS", "EXCLUDED_TITLE_PATTERNS", "VENDOR",
  "PRODUCT_TYPE_MAP", "DEFAULT_PRODUCT_TYPE", "BASE_TAGS", "TITLE_TEMPLATE", "PUBLISH_CHANNELS", "MAX_CONCURRENT_PRODUCTS", "REQUEST_DELAY_MS",
];

/** Env names that differ from STANLEY_<KEY> (the spec's own names). */
const ENV_NAME: Partial<Record<keyof StanleySettings, string>> = { MAX_EXCHANGE_RATE_AGE_HOURS: "USD_INR_RATE_MAX_AGE_HOURS" };

const DEFAULTS: StanleySettings = {
  ENABLED: true,
  SYNC_INTERVAL_HOURS: 5,
  SYNC_PAUSED: false,
  DRY_RUN: true, // nothing is written to Shopify until explicitly switched off
  TEST_MODE: true,
  TEST_PRODUCT_LIMIT: 5,
  FULL_SYNC: false,
  ETA: "15–20 Days",
  PRICING_MODE: "USD_TO_INR_PLUS_FLAT",
  SOURCE_CURRENCY: "USD",
  TARGET_CURRENCY: "INR",
  SOURCE_PRICE_BASIS: "CURRENT_SELLING",
  COMPARE_AT_MODE: "SOURCE_REGULAR",
  FX_PROVIDER: "open.er-api.com",
  MANUAL_EXCHANGE_RATE: 0,
  MAX_EXCHANGE_RATE_AGE_HOURS: 24,
  PRICING_ADJUSTMENT_INR: 3000,
  PRICE_ROUNDING_MODE: "NONE",
  PRODUCT_MISSING_CONFIRMATION_SCANS: 2,
  MISSING_ACTION: "archive",
  NEW_PRODUCT_STATUS: "DRAFT",
  AUTHORIZED_IMPORTER: false,
  OVERWRITE_MANUAL_DESCRIPTION: false,
  ADOPT_EXISTING_PRODUCTS: false,
  FETCH_DETAILS: true,
  DETAILS_MAX_AGE_HOURS: 72,
  EXCLUDED_PRODUCT_TYPES: "Service Fee,Sticker,Gift Card,E Gift Card",
  EXCLUDED_TAGS: "stanley_create,engraving-fee",
  EXCLUDED_TITLE_PATTERNS: "Stanley Create,Engraving Fee,Gift Card",
  VENDOR: "Stanley 1913",
  // Matched against Stanley's product type first, then its category breadcrumb (most specific first). The store's Shop tab
  // (collection `others`) lists every non-Sneakers type, so these all appear there.
  PRODUCT_TYPE_MAP: [
    "soft cooler:Coolers", "coolers:Coolers", "coolers + jugs:Coolers", "hard coolers:Coolers", "soft coolers:Coolers",
    "lunch boxes & totes:Lunch Boxes", "lunch boxes:Lunch Boxes", "food jars + storage:Food Storage", "food storage:Food Storage",
    "backpack:Bags", "bags:Bags", "camp cookware:Cookware", "cookware:Cookware", "cook sets:Cookware",
    "ornament:Accessories", "accessories:Accessories", "replacement parts:Accessories", "pet bowls:Accessories",
  ].join(","),
  DEFAULT_PRODUCT_TYPE: "Drinkware",
  BASE_TAGS: "Stanley,Stanley 1913,ETA,stanley-sync",
  TITLE_TEMPLATE: "Stanley 1913 {title}",
  PUBLISH_CHANNELS: "Online Store,Point of Sale,Inbox",
  MAX_CONCURRENT_PRODUCTS: 3,
  REQUEST_DELAY_MS: 1500,
};

const ENUMS: Partial<Record<keyof StanleySettings, string[]>> = {
  PRICING_MODE: ["USD_TO_INR_PLUS_FLAT"],
  SOURCE_PRICE_BASIS: ["CURRENT_SELLING", "REGULAR"],
  COMPARE_AT_MODE: ["SOURCE_REGULAR", "NONE"],
  FX_PROVIDER: ["open.er-api.com", "frankfurter", "manual"],
  PRICE_ROUNDING_MODE: ["NONE", "NEAREST_10", "NEAREST_50", "NEAREST_100"],
  MISSING_ACTION: ["archive", "draft"],
  NEW_PRODUCT_STATUS: ["ACTIVE", "DRAFT"],
};

export function coerceStanley<K extends keyof StanleySettings>(key: K, raw: unknown): StanleySettings[K] {
  const def = DEFAULTS[key];
  if (raw === undefined || raw === null || raw === "") return def;
  if (typeof def === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Setting ${key} must be a non-negative number (got "${raw}")`);
    return n as StanleySettings[K];
  }
  if (typeof def === "boolean") return (raw === true || /^(true|1|yes|on)$/i.test(String(raw))) as StanleySettings[K];
  return String(raw).replace(/^"(.*)"$/, "$1") as StanleySettings[K];
}

export function validateStanleySetting(key: keyof StanleySettings, value: unknown) {
  const allowed = ENUMS[key];
  if (allowed && !allowed.includes(String(value))) throw new Error(`Setting ${key} must be one of ${allowed.join(", ")}`);
  if (key === "SYNC_INTERVAL_HOURS" && Number(value) < 1) throw new Error("SYNC_INTERVAL_HOURS must be at least 1");
  if (key === "PRODUCT_MISSING_CONFIRMATION_SCANS" && Number(value) < 2) throw new Error("PRODUCT_MISSING_CONFIRMATION_SCANS must be at least 2");
  if (key === "REQUEST_DELAY_MS" && Number(value) < 1000) throw new Error("REQUEST_DELAY_MS must be at least 1000 (politeness floor)");
  if (key === "MAX_CONCURRENT_PRODUCTS" && (Number(value) < 1 || Number(value) > 5)) throw new Error("MAX_CONCURRENT_PRODUCTS must be between 1 and 5");
  if (key === "TEST_PRODUCT_LIMIT" && Number(value) < 1) throw new Error("TEST_PRODUCT_LIMIT must be at least 1");
  if (key === "MAX_EXCHANGE_RATE_AGE_HOURS" && !(Number(value) > 0 && Number(value) <= 24)) throw new Error("MAX_EXCHANGE_RATE_AGE_HOURS must be between 0 and 24");
  if (key === "PRODUCT_TYPE_MAP") parseMap(String(value));
  if ((key === "SOURCE_CURRENCY" || key === "TARGET_CURRENCY") && !/^[A-Z]{3}$/.test(String(value))) throw new Error(`${key} must be a 3-letter currency code`);
}

export function stanleyEnvSettings(): StanleySettings {
  const s = {} as Record<string, unknown>;
  for (const k of STANLEY_KEYS) s[k] = coerceStanley(k, process.env[`STANLEY_${k}`] ?? (ENV_NAME[k] ? process.env[ENV_NAME[k]!] : undefined));
  // the spec's names for two settings
  if (process.env.STANLEY_AUTHORIZED_IMPORTER === undefined && process.env.STANLEY_AUTHORIZATION_CONFIRMED !== undefined) s.AUTHORIZED_IMPORTER = coerceStanley("AUTHORIZED_IMPORTER", process.env.STANLEY_AUTHORIZATION_CONFIRMED);
  return s as unknown as StanleySettings;
}

/** Products a run may process: the whole catalog only when FULL_SYNC=true and TEST_MODE=false. */
export function effectiveLimit(s: Pick<StanleySettings, "TEST_MODE" | "TEST_PRODUCT_LIMIT" | "FULL_SYNC">): number {
  return s.FULL_SYNC && !s.TEST_MODE ? 0 : s.TEST_PRODUCT_LIMIT;
}

export const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

/**
 * Brand-specific content authorisation (stated by the store owner). Applies to the Stanley importer ONLY - it is not
 * read by, and must not be copied into, any other brand's importer.
 */
export const STANLEY_AUTHORIZATION = {
  brand: "Stanley 1913",
  importer: "Full Size Run",
  territory: "India",
  // image_download_authorized / product_content_usage_authorized / description / specification usage all follow
  // the single AUTHORIZED_IMPORTER setting (STANLEY_AUTHORIZED_IMPORTER=true in .env).
} as const;

export const STANLEY_SOURCE = {
  // US storefront: prices are USD here. Stanley's India site / INR prices are never used by the FSR formula.
  origin: process.env.STANLEY_SOURCE_ORIGIN || "https://www.stanley1913.com",
  // robots.txt allows /products.json, /products/{handle}.json and product pages. 250 is Shopify's page-size maximum.
  pageSize: 250,
  maxPages: 100, // hard stop far above today's catalog (a safety net against a pagination loop, not a product count)
  userAgent: "Mozilla/5.0 (compatible; FullSizeRunCatalogSync/1.0; +https://fullsizerun.in)",
};
