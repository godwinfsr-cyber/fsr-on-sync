// Michael Kors (michaelkors.com, USD) -> Full Size Run settings. Shares ROOT/.env loading and Shopify credentials
// with the other sources (../config.ts); every business setting reads MK_<KEY> from .env and can be overridden with
// `node src/michaelkors/cli.ts set KEY VALUE` (stored in the Michael Kors SQLite `settings` table).
import "../config.ts";
import { parseMap, parseWeightBands, type CompareAtMode, type FxProvider, type MissingAction, type PriceRoundingMode, type SourcePriceBasis } from "../gymshark/config.ts";

/** NEAREST_1 = whole rupees (owner decision 2026-09-26); the others are the shared modes. */
export type MkRoundingMode = PriceRoundingMode | "NEAREST_1";

export { parseMap, parseWeightBands };

// ---------------------------------------------------------------------------------------------------------------
// BRAND AUTHORIZATION (business fact stated by the store owner, 2026-09-26)
//
// Full Size Run is the OFFICIAL AUTHORIZED IMPORTER of Michael Kors products in India, with permission to import and
// commercially use Michael Kors product information, images, descriptions and specifications for authorized products.
// Therefore this importer copies Michael Kors photos and descriptions; there is deliberately NO copyright blocker here.
//
// Scope: Michael Kors ONLY. This constant is not read by any other source and must not be generalised to other brands.
// It does NOT authorise bypassing technical protection: no CAPTCHA solving, bot-protection evasion, stealth browsers,
// proxies, credential use or rate-limit circumvention (see ../politeHttp.ts - a 403 / challenge stops the crawl).
// ---------------------------------------------------------------------------------------------------------------
export const BRAND_AUTHORIZATION = Object.freeze({
  brand: "Michael Kors",
  authorized: true,
  importer: "Full Size Run",
  territory: "India",
  authorization_type: "Official Authorized Importer",
  product_content_usage_authorized: true,
  image_usage_authorized: true,
  description_usage_authorized: true,
  specification_usage_authorized: true,
});

/** MICHAEL_KORS_AUTHORIZED_IMPORTER=true (default) - set to false in .env only if the authorization ever lapses. */
export const MICHAEL_KORS_AUTHORIZED_IMPORTER = !/^(false|0|no|off)$/i.test(process.env.MICHAEL_KORS_AUTHORIZED_IMPORTER ?? "true");

export type SourceMode = "http" | "feed";

export interface MkSettings {
  SYNC_INTERVAL_HOURS: number;
  SYNC_PAUSED: boolean;
  DRY_RUN: boolean;
  SYNC_LIMIT: number;                  // 0 = whole eligible catalog (counts styles = FSR products)
  SOURCE_MODE: SourceMode;             // http = michaelkors.com sitemap + pages; feed = files in FEED_DIR
  FEED_DIR: string;                    // saved product pages (.html) / JSON-LD (.json) supplied under the authorization
  DEFAULT_ETA: string;
  SOURCE_CURRENCY: string;
  TARGET_CURRENCY: string;
  SOURCE_PRICE_BASIS: SourcePriceBasis;
  COMPARE_AT_MODE: CompareAtMode;
  FX_PROVIDER: FxProvider;
  MANUAL_EXCHANGE_RATE: number;
  MAX_EXCHANGE_RATE_AGE_HOURS: number;
  WEIGHT_SURCHARGE_ENABLED: boolean;
  WEIGHT_SURCHARGE_FALLBACK_INR: number;
  WEIGHT_BANDS: string;                // "0.5:1000,1:1500,2:2500,3:3500,5:4250,+:5000"  (upper bound kg : INR shipping)
  CATEGORY_WEIGHT_KG: string;          // optional owner-supplied shipping weights per category, "handbags:1.2,shoes:1.5" (empty = none)
  PROFIT_BANDS: string;                // "5000:1000,10000:1500,...,+:4000" (landed-cost upper bound ₹ : profit ₹); "+:1500" = flat
  PRICE_ROUNDING_MODE: MkRoundingMode;
  PRODUCT_MISSING_CONFIRMATION_SCANS: number;
  MIN_CATALOG_SIZE: number;            // a scan finding fewer eligible styles than this is SOURCE_SCAN_UNRELIABLE
  MISSING_ACTION: MissingAction;
  NEW_PRODUCT_STATUS: "ACTIVE" | "DRAFT";
  OVERWRITE_MANUAL_DESCRIPTION: boolean;
  ADOPT_EXISTING_PRODUCTS: boolean;
  EXCLUDED_CATEGORIES: string;         // extra (non-watch) categories never imported; watches are excluded in code, always
  VENDOR: string;
  PRODUCT_TYPE_MAP: string;            // category keyword -> store product type (first match wins)
  DEFAULT_PRODUCT_TYPE: string;
  BASE_TAGS: string;
  PUBLISH_CHANNELS: string;
  REQUEST_DELAY_MS: number;
}

export const MK_KEYS: (keyof MkSettings)[] = [
  "SYNC_INTERVAL_HOURS", "SYNC_PAUSED", "DRY_RUN", "SYNC_LIMIT", "SOURCE_MODE", "FEED_DIR", "DEFAULT_ETA", "SOURCE_CURRENCY", "TARGET_CURRENCY",
  "SOURCE_PRICE_BASIS", "COMPARE_AT_MODE", "FX_PROVIDER", "MANUAL_EXCHANGE_RATE", "MAX_EXCHANGE_RATE_AGE_HOURS", "WEIGHT_SURCHARGE_ENABLED",
  "WEIGHT_SURCHARGE_FALLBACK_INR", "WEIGHT_BANDS", "CATEGORY_WEIGHT_KG", "PROFIT_BANDS", "PRICE_ROUNDING_MODE", "PRODUCT_MISSING_CONFIRMATION_SCANS",
  "MIN_CATALOG_SIZE", "MISSING_ACTION", "NEW_PRODUCT_STATUS", "OVERWRITE_MANUAL_DESCRIPTION", "ADOPT_EXISTING_PRODUCTS", "EXCLUDED_CATEGORIES", "VENDOR",
  "PRODUCT_TYPE_MAP", "DEFAULT_PRODUCT_TYPE", "BASE_TAGS", "PUBLISH_CHANNELS", "REQUEST_DELAY_MS",
];

const DEFAULTS: MkSettings = {
  SYNC_INTERVAL_HOURS: 5,
  SYNC_PAUSED: false,
  DRY_RUN: true, // nothing is written to Shopify until explicitly switched off
  SYNC_LIMIT: 0,
  SOURCE_MODE: "http",
  FEED_DIR: "data/michaelkors-feed",
  DEFAULT_ETA: "15–20 Days",
  SOURCE_CURRENCY: "USD",
  TARGET_CURRENCY: "INR",
  SOURCE_PRICE_BASIS: "CURRENT_SELLING",
  COMPARE_AT_MODE: "NONE", // michaelkors.com's structured data carries only the current price, never a "was" price
  FX_PROVIDER: "open.er-api.com",
  MANUAL_EXCHANGE_RATE: 0,
  MAX_EXCHANGE_RATE_AGE_HOURS: 24,
  WEIGHT_SURCHARGE_ENABLED: true,
  WEIGHT_SURCHARGE_FALLBACK_INR: 2500, // UNKNOWN_WEIGHT_SHIPPING_INR
  WEIGHT_BANDS: "0.5:1000,1:1500,2:2500,3:3500,5:4250,+:5000", // kg upper bound : ₹ shipping (₹1,000–₹5,000)
  CATEGORY_WEIGHT_KG: "",
  PROFIT_BANDS: "5000:1000,10000:1500,20000:2000,35000:3000,50000:3500,+:4000", // landed-cost upper bound ₹ : profit ₹ (₹1,000–₹4,000)
  PRICE_ROUNDING_MODE: "NEAREST_1", // final price rounded to the nearest rupee
  PRODUCT_MISSING_CONFIRMATION_SCANS: 2,
  MIN_CATALOG_SIZE: 100,
  MISSING_ACTION: "archive",
  NEW_PRODUCT_STATUS: "DRAFT",
  OVERWRITE_MANUAL_DESCRIPTION: false,
  ADOPT_EXISTING_PRODUCTS: false,
  // gift cards are not products; fragrance and product-care sprays are flammable liquids / aerosols (restricted air cargo)
  EXCLUDED_CATEGORIES: "gift card,fragrance,eau de parfum,eau de toilette,cologne,product care",
  VENDOR: "Michael Kors",
  // the store's nav collections key on product type: shoes -> Sneakers tab, bags/wallets -> Bags column
  PRODUCT_TYPE_MAP: "clothing:Apparel,wallet:Wallets,handbag:Bags,bag:Bags,shoe:Sneakers,sneaker:Sneakers,boot:Sneakers,sandal:Sneakers,jewelry:Accessories,sunglass:Accessories,accessor:Accessories",
  DEFAULT_PRODUCT_TYPE: "Accessories",
  BASE_TAGS: "Michael Kors,ETA,michael-kors-sync",
  PUBLISH_CHANNELS: "Online Store,Point of Sale,Inbox",
  REQUEST_DELAY_MS: 2000,
};

const ENUMS: Partial<Record<keyof MkSettings, string[]>> = {
  SOURCE_MODE: ["http", "feed"],
  SOURCE_PRICE_BASIS: ["CURRENT_SELLING", "REGULAR"],
  COMPARE_AT_MODE: ["SOURCE_REGULAR", "NONE"],
  FX_PROVIDER: ["open.er-api.com", "frankfurter", "manual"],
  PRICE_ROUNDING_MODE: ["NEAREST_1", "NONE", "NEAREST_10", "NEAREST_50", "NEAREST_100"],
  MISSING_ACTION: ["archive", "draft"],
  NEW_PRODUCT_STATUS: ["ACTIVE", "DRAFT"],
};

export function coerceMk<K extends keyof MkSettings>(key: K, raw: unknown): MkSettings[K] {
  const def = DEFAULTS[key];
  if (raw === undefined || raw === null || (raw === "" && key !== "CATEGORY_WEIGHT_KG" && key !== "EXCLUDED_CATEGORIES")) return def;
  if (typeof def === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Setting ${key} must be a non-negative number (got "${raw}")`);
    return n as MkSettings[K];
  }
  if (typeof def === "boolean") return (raw === true || /^(true|1|yes|on)$/i.test(String(raw))) as MkSettings[K];
  return String(raw) as MkSettings[K];
}

export function validateMkSetting(key: keyof MkSettings, value: unknown) {
  const allowed = ENUMS[key];
  if (allowed && !allowed.includes(String(value))) throw new Error(`Setting ${key} must be one of ${allowed.join(", ")}`);
  if (key === "SYNC_INTERVAL_HOURS" && Number(value) < 1) throw new Error("SYNC_INTERVAL_HOURS must be at least 1");
  if (key === "PRODUCT_MISSING_CONFIRMATION_SCANS" && Number(value) < 2) throw new Error("PRODUCT_MISSING_CONFIRMATION_SCANS must be at least 2");
  if (key === "REQUEST_DELAY_MS" && Number(value) < 1000) throw new Error("REQUEST_DELAY_MS must be at least 1000 (politeness floor)");
  if (key === "MAX_EXCHANGE_RATE_AGE_HOURS" && !(Number(value) > 0)) throw new Error("MAX_EXCHANGE_RATE_AGE_HOURS must be greater than 0");
  if (key === "WEIGHT_BANDS") parseWeightBands(String(value));
  if (key === "PROFIT_BANDS") parseProfitBands(String(value));
  if (key === "PRODUCT_TYPE_MAP" || key === "CATEGORY_WEIGHT_KG") parseMap(String(value));
  if ((key === "SOURCE_CURRENCY" || key === "TARGET_CURRENCY") && !/^[A-Z]{3}$/.test(String(value))) throw new Error(`${key} must be a 3-letter currency code`);
}

export interface ProfitBand { maxInr: number | null; profitInr: number }
/** "5000:1000,15000:1500,+:2500" -> ascending bands on the landed cost; the last band must be open-ended ("+"). */
export function parseProfitBands(spec: string): ProfitBand[] {
  const bands = parseWeightBands(spec); // same grammar: "<upper bound>:<INR>" ... "+:<INR>"
  return bands.map((b) => ({ maxInr: b.maxKg, profitInr: b.surchargeInr }));
}

export function mkEnvSettings(): MkSettings {
  const s = {} as Record<string, unknown>;
  // MICHAEL_KORS_<KEY> (e.g. MICHAEL_KORS_DEFAULT_ETA, MICHAEL_KORS_SYNC_INTERVAL_HOURS) or the short MK_<KEY>
  for (const k of MK_KEYS) s[k] = coerceMk(k, process.env[`MICHAEL_KORS_${k}`] ?? process.env[`MK_${k}`]);
  return s as unknown as MkSettings;
}

export const MK_SOURCE = {
  origin: "https://www.michaelkors.com",
  // robots.txt (User-agent: *) allows product pages and lists this sitemap index
  sitemapIndex: process.env.MK_SITEMAP_INDEX || "https://www.michaelkors.com/sitemap_index.xml",
  userAgent: "Mozilla/5.0 (compatible; FullSizeRunCatalogSync/1.0; +https://fullsizerun.in; authorized-importer)",
  // non-English mirrors list the same products
  mirrorPath: /\/(us\/es|ca\/en|ca\/fr)\//i,
};
