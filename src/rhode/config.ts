// Rhode (rhodeskin.com, USD) -> Full Size Run settings. Shares ROOT/.env loading and Shopify credentials with the
// other sources (../config.ts); every business setting reads RHODE_<KEY> from .env and can be overridden with
// `node src/rhode/cli.ts set KEY VALUE` or the /rhode dashboard (stored in the Rhode SQLite `settings` table).
import "../config.ts";
import { parseMap, type CompareAtMode, type FxProvider, type MissingAction, type PriceRoundingMode, type SourcePriceBasis } from "../gymshark/config.ts";

export { parseMap };

export interface RhodeSettings {
  ENABLED: boolean;                       // RHODE_ENABLED: false = the scheduler never syncs Rhode
  SYNC_INTERVAL_HOURS: number;
  SYNC_PAUSED: boolean;
  DRY_RUN: boolean;
  SYNC_LIMIT: number;                     // 0 = whole catalog (counts FSR products, i.e. shade families + single products)
  ETA: string;                            // custom.eta on every Rhode product
  PRICING_MODE: "USD_TO_INR_PLUS_ADJUSTMENT";
  PRICING_ADJUSTMENT_INR: number;         // fixed ₹ added once, after conversion (never compounded)
  SOURCE_CURRENCY: string;
  TARGET_CURRENCY: string;
  SOURCE_PRICE_BASIS: SourcePriceBasis;   // CURRENT_SELLING = what Rhode charges now (the sale price when on sale)
  COMPARE_AT_MODE: CompareAtMode;         // NONE = Rhode's regular price is kept as metadata only; SOURCE_REGULAR = also shown as compare-at
  FX_PROVIDER: FxProvider;
  MANUAL_EXCHANGE_RATE: number;           // only for FX_PROVIDER=manual; 0 = not set
  MAX_EXCHANGE_RATE_AGE_HOURS: number;    // also read from USD_INR_RATE_MAX_AGE_HOURS
  PRICE_ROUNDING_MODE: PriceRoundingMode;
  PRODUCT_MISSING_CONFIRMATION_SCANS: number;
  MISSING_ACTION: MissingAction;
  MIN_CATALOG_SIZE: number;               // a scan listing fewer products is SOURCE_SCAN_UNRELIABLE
  MIN_CATALOG_RATIO: number;              // ... or fewer than this share of the last complete scan
  NEW_PRODUCT_STATUS: "ACTIVE" | "DRAFT";
  CONTENT_REUSE_CONFIRMED: boolean;       // FSR may reuse Rhode images + product text (store owner confirmation)
  OVERWRITE_MANUAL_DESCRIPTION: boolean;
  ADOPT_EXISTING_PRODUCTS: boolean;
  GROUP_SHADES: boolean;                  // Rhode lists each shade as its own product: group them into one FSR product
  FETCH_DETAILS: boolean;                 // product pages: benefits, application, key + full ingredients
  DETAILS_MAX_AGE_HOURS: number;          // re-read a product page after this long (or at once when Rhode's description changes)
  EXCLUDED_HANDLES: string;
  EXCLUDED_PRODUCT_TYPES: string;
  CATEGORY_COLLECTIONS: string;           // Rhode collection handle -> FSR category, checked in order
  NAV_COLLECTIONS: string;                // Rhode collections recorded as rhode_sync.collection
  PRODUCT_TYPE_MAP: string;               // Rhode product type (fallback when no category collection matches)
  DEFAULT_PRODUCT_TYPE: string;
  VENDOR: string;
  BASE_TAGS: string;
  TITLE_TEMPLATE: string;                 // {title}
  PUBLISH_CHANNELS: string;
  REQUEST_DELAY_MS: number;
}

export const RHODE_KEYS: (keyof RhodeSettings)[] = [
  "ENABLED", "SYNC_INTERVAL_HOURS", "SYNC_PAUSED", "DRY_RUN", "SYNC_LIMIT", "ETA", "PRICING_MODE", "PRICING_ADJUSTMENT_INR", "SOURCE_CURRENCY", "TARGET_CURRENCY",
  "SOURCE_PRICE_BASIS", "COMPARE_AT_MODE", "FX_PROVIDER", "MANUAL_EXCHANGE_RATE", "MAX_EXCHANGE_RATE_AGE_HOURS", "PRICE_ROUNDING_MODE",
  "PRODUCT_MISSING_CONFIRMATION_SCANS", "MISSING_ACTION", "MIN_CATALOG_SIZE", "MIN_CATALOG_RATIO", "NEW_PRODUCT_STATUS", "CONTENT_REUSE_CONFIRMED",
  "OVERWRITE_MANUAL_DESCRIPTION", "ADOPT_EXISTING_PRODUCTS", "GROUP_SHADES", "FETCH_DETAILS", "DETAILS_MAX_AGE_HOURS", "EXCLUDED_HANDLES", "EXCLUDED_PRODUCT_TYPES", "CATEGORY_COLLECTIONS",
  "NAV_COLLECTIONS", "PRODUCT_TYPE_MAP", "DEFAULT_PRODUCT_TYPE", "VENDOR", "BASE_TAGS", "TITLE_TEMPLATE", "PUBLISH_CHANNELS", "REQUEST_DELAY_MS",
];

const DEFAULTS: RhodeSettings = {
  ENABLED: true,
  SYNC_INTERVAL_HOURS: 5,
  SYNC_PAUSED: false,
  DRY_RUN: false,
  SYNC_LIMIT: 0,
  ETA: "15–20 Days",
  PRICING_MODE: "USD_TO_INR_PLUS_ADJUSTMENT",
  PRICING_ADJUSTMENT_INR: 2000,
  SOURCE_CURRENCY: "USD",
  TARGET_CURRENCY: "INR",
  SOURCE_PRICE_BASIS: "CURRENT_SELLING",
  COMPARE_AT_MODE: "NONE",
  FX_PROVIDER: "open.er-api.com",
  MANUAL_EXCHANGE_RATE: 0,
  MAX_EXCHANGE_RATE_AGE_HOURS: 24,
  PRICE_ROUNDING_MODE: "NONE",
  PRODUCT_MISSING_CONFIRMATION_SCANS: 2,
  MISSING_ACTION: "archive",
  MIN_CATALOG_SIZE: 20,
  MIN_CATALOG_RATIO: 0.5,
  NEW_PRODUCT_STATUS: "DRAFT",
  CONTENT_REUSE_CONFIRMED: false,
  OVERWRITE_MANUAL_DESCRIPTION: false,
  ADOPT_EXISTING_PRODUCTS: false,
  GROUP_SHADES: true,
  FETCH_DETAILS: true,
  DETAILS_MAX_AGE_HOURS: 24,
  // gift wrap / gift cards are services, not products FSR can import
  EXCLUDED_HANDLES: "diy-gift-wrap,gift-card,e-gift-card,rhode-gift-card",
  EXCLUDED_PRODUCT_TYPES: "Gift Card,E-Gift Card,Gift Wrap",
  // first match wins: a set is a set even when it also sits in Lip + Cheek
  CATEGORY_COLLECTIONS: "sets:Sets,lip-cheek:Makeup,skincare:Skincare",
  NAV_COLLECTIONS: "skincare,lip-cheek,sets,on-the-go,featured,shop-all",
  PRODUCT_TYPE_MAP: [
    "skin care set:Sets", "color set:Sets", "cheek + lip set:Sets", "set:Sets", "lip treatment:Makeup", "lip makeup:Makeup", "blush:Makeup", "bronzer:Makeup",
    "skin care:Skincare", "moisturizer:Skincare", "cleanser:Skincare", "serum:Skincare", "essence:Skincare", "facial spray:Skincare",
    "merch:Accessories", "mirror:Accessories", "phone case:Accessories", "brush:Accessories",
  ].join(","),
  DEFAULT_PRODUCT_TYPE: "Beauty",
  VENDOR: "Rhode",
  BASE_TAGS: "Rhode,Beauty,ETA,rhode-sync",
  TITLE_TEMPLATE: "Rhode {title}",
  PUBLISH_CHANNELS: "Online Store,Point of Sale,Inbox",
  REQUEST_DELAY_MS: 2000,
};

const ENUMS: Partial<Record<keyof RhodeSettings, string[]>> = {
  PRICING_MODE: ["USD_TO_INR_PLUS_ADJUSTMENT"],
  SOURCE_PRICE_BASIS: ["CURRENT_SELLING", "REGULAR"],
  COMPARE_AT_MODE: ["SOURCE_REGULAR", "NONE"],
  FX_PROVIDER: ["open.er-api.com", "frankfurter", "manual"],
  PRICE_ROUNDING_MODE: ["NONE", "NEAREST_10", "NEAREST_50", "NEAREST_100"],
  MISSING_ACTION: ["archive", "draft"],
  NEW_PRODUCT_STATUS: ["ACTIVE", "DRAFT"],
};

// the user-facing names from the importer spec that don't follow the RHODE_<KEY> pattern
const ENV_ALIASES: Partial<Record<keyof RhodeSettings, string[]>> = {
  MAX_EXCHANGE_RATE_AGE_HOURS: ["RHODE_MAX_EXCHANGE_RATE_AGE_HOURS", "USD_INR_RATE_MAX_AGE_HOURS"],
};

export function coerceRhode<K extends keyof RhodeSettings>(key: K, raw: unknown): RhodeSettings[K] {
  const def = DEFAULTS[key];
  if (raw === undefined || raw === null || raw === "") return def;
  if (typeof def === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Setting ${key} must be a non-negative number (got "${raw}")`);
    return n as RhodeSettings[K];
  }
  if (typeof def === "boolean") return (raw === true || /^(true|1|yes|on)$/i.test(String(raw))) as RhodeSettings[K];
  return String(raw).replace(/^"(.*)"$/, "$1") as RhodeSettings[K];
}

export function validateRhodeSetting(key: keyof RhodeSettings, value: unknown) {
  const allowed = ENUMS[key];
  if (allowed && !allowed.includes(String(value))) throw new Error(`Setting ${key} must be one of ${allowed.join(", ")}`);
  if (key === "SYNC_INTERVAL_HOURS" && Number(value) < 1) throw new Error("SYNC_INTERVAL_HOURS must be at least 1");
  if (key === "PRODUCT_MISSING_CONFIRMATION_SCANS" && Number(value) < 2) throw new Error("PRODUCT_MISSING_CONFIRMATION_SCANS must be at least 2 (one failed scan never removes a product)");
  if (key === "REQUEST_DELAY_MS" && Number(value) < 1000) throw new Error("REQUEST_DELAY_MS must be at least 1000 (politeness floor)");
  if (key === "MAX_EXCHANGE_RATE_AGE_HOURS" && !(Number(value) > 0)) throw new Error("MAX_EXCHANGE_RATE_AGE_HOURS must be greater than 0");
  if (key === "MIN_CATALOG_RATIO" && !(Number(value) > 0 && Number(value) <= 1)) throw new Error("MIN_CATALOG_RATIO must be between 0 and 1");
  if (key === "PRODUCT_TYPE_MAP" || key === "CATEGORY_COLLECTIONS") parseMap(String(value));
  if ((key === "SOURCE_CURRENCY" || key === "TARGET_CURRENCY") && !/^[A-Z]{3}$/.test(String(value))) throw new Error(`${key} must be a 3-letter currency code`);
}

export function rhodeEnvSettings(): RhodeSettings {
  const s = {} as Record<string, unknown>;
  for (const k of RHODE_KEYS) {
    const names = ENV_ALIASES[k] ?? [`RHODE_${k}`];
    s[k] = coerceRhode(k, names.map((n) => process.env[n]).find((v) => v != null && v !== ""));
  }
  return s as unknown as RhodeSettings;
}

export const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

/** Ordered [collection handle, FSR category] pairs. */
export function categoryCollections(s: Pick<RhodeSettings, "CATEGORY_COLLECTIONS">): [string, string][] {
  return list(s.CATEGORY_COLLECTIONS).map((p) => { const i = p.indexOf(":"); return [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()] as [string, string]; });
}

export const RHODE_SOURCE = {
  // US storefront (USD). rhodeskin.com is a public Shopify storefront: robots.txt allows /products.json,
  // /collections.json, /collections/<h>/products.json, /products/<h>.json and product pages.
  origin: process.env.RHODE_SOURCE_ORIGIN || "https://www.rhodeskin.com",
  pageSize: 250,  // Shopify's page-size maximum
  maxPages: 40,   // safety net against a pagination loop, not a product count
  userAgent: "Mozilla/5.0 (compatible; FullSizeRunCatalogSync/1.0; +https://fullsizerun.in)",
};
