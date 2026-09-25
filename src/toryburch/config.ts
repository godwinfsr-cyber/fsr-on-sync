// Tory Burch (toryburch.com/en-us, USD) -> Full Size Run settings. Shares ROOT/.env loading and the Shopify credentials
// with the other sources (../config.ts). Every business setting reads TORY_BURCH_<KEY> from .env and can be overridden with
// `node src/toryburch/cli.ts set KEY VALUE` (stored in the Tory Burch SQLite `settings` table).
// Pricing works exactly like the Michael Kors importer (../michaelkors/pricing.ts is reused); only the default bands live here.
import "../config.ts";
import { parseMap, parseWeightBands, type CompareAtMode, type FxProvider, type MissingAction, type PriceRoundingMode, type SourcePriceBasis } from "../gymshark/config.ts";
import { parseProfitBands } from "../michaelkors/config.ts";

export { parseMap, parseProfitBands, parseWeightBands };

// ---------------------------------------------------------------------------------------------------------------
// BRAND AUTHORIZATION (business fact stated by the store owner, 2026-09-26)
//
// Full Size Run is an OFFICIAL / AUTHORIZED IMPORTER of Tory Burch products in India, with permission to import and
// commercially use Tory Burch product content for its authorized products - explicitly including downloading product
// images from toryburch.com and uploading them to the Full Size Run Shopify catalog. There is deliberately NO copyright
// blocker in this importer.
//
// Scope: Tory Burch ONLY. This constant is not read by any other source and must not be generalised to other brands.
// It does NOT authorise bypassing technical protection: no CAPTCHA solving, bot-protection evasion, stealth browsers,
// proxies, credential use or rate-limit circumvention (see ../politeHttp.ts - a 403 / challenge stops the crawl).
// ---------------------------------------------------------------------------------------------------------------
export const BRAND_AUTHORIZATION = Object.freeze({
  brand: "Tory Burch",
  authorized_importer: true,
  importer: "Full Size Run",
  territory: "India",
  image_download_authorized: true,
  product_content_usage_authorized: true,
  product_description_usage_authorized: true,
  product_specification_usage_authorized: true,
});

/** TORY_BURCH_AUTHORIZED_IMPORTER=true (default) - set to false in .env only if the authorization ever lapses. */
export const TORY_BURCH_AUTHORIZED_IMPORTER = !/^(false|0|no|off)$/i.test(process.env.TORY_BURCH_AUTHORIZED_IMPORTER ?? "true");

export type SourceMode = "http" | "feed";

export interface TbSettings {
  ENABLED: boolean;                    // TORY_BURCH_ENABLED - false stops scheduled syncs
  SYNC_INTERVAL_HOURS: number;
  SYNC_PAUSED: boolean;
  DRY_RUN: boolean;
  SYNC_LIMIT: number;                  // 0 = whole eligible catalog (counts styles = FSR products)
  SOURCE_MODE: SourceMode;             // http = toryburch.com sitemap + pages; feed = files in FEED_DIR
  FEED_DIR: string;
  DEFAULT_ETA: string;                 // TORY_BURCH_ETA
  SOURCE_CURRENCY: string;
  TARGET_CURRENCY: string;
  SOURCE_PRICE_BASIS: SourcePriceBasis;
  COMPARE_AT_MODE: CompareAtMode;
  FX_PROVIDER: FxProvider;
  MANUAL_EXCHANGE_RATE: number;
  MAX_EXCHANGE_RATE_AGE_HOURS: number; // USD_INR_RATE_MAX_AGE_HOURS
  WEIGHT_SURCHARGE_ENABLED: boolean;
  WEIGHT_SURCHARGE_FALLBACK_INR: number;
  WEIGHT_BANDS: string;                // "<upper bound kg>:<INR shipping>,...,+:<INR>"
  CATEGORY_WEIGHT_KG: string;          // optional owner-supplied shipping weights per category, "handbags:1.2,shoes:1.5"
  PROFIT_BANDS: string;                // "<landed-cost upper bound ₹>:<profit ₹>,...,+:<profit ₹>"
  PRICE_ROUNDING_MODE: PriceRoundingMode;
  PRODUCT_MISSING_CONFIRMATION_SCANS: number;
  MIN_CATALOG_SIZE: number;            // a scan finding fewer eligible styles than this is SOURCE_SCAN_UNRELIABLE
  MISSING_ACTION: MissingAction;
  NEW_PRODUCT_STATUS: "ACTIVE" | "DRAFT";
  OVERWRITE_MANUAL_DESCRIPTION: boolean;
  ADOPT_EXISTING_PRODUCTS: boolean;
  EXCLUDED_CATEGORIES: string;         // extra (non-watch) departments never imported; watches are excluded in code, always
  VENDOR: string;
  PRODUCT_TYPE_MAP: string;            // department/class keyword -> store product type (first match wins)
  DEFAULT_PRODUCT_TYPE: string;
  BASE_TAGS: string;
  PUBLISH_CHANNELS: string;
  IMAGE_PRESET: string;                // Tory Burch image-server preset, e.g. pdp-2000x2000 (largest square rendition)
  REQUEST_DELAY_MS: number;
}

export const TB_KEYS: (keyof TbSettings)[] = [
  "ENABLED", "SYNC_INTERVAL_HOURS", "SYNC_PAUSED", "DRY_RUN", "SYNC_LIMIT", "SOURCE_MODE", "FEED_DIR", "DEFAULT_ETA", "SOURCE_CURRENCY", "TARGET_CURRENCY",
  "SOURCE_PRICE_BASIS", "COMPARE_AT_MODE", "FX_PROVIDER", "MANUAL_EXCHANGE_RATE", "MAX_EXCHANGE_RATE_AGE_HOURS", "WEIGHT_SURCHARGE_ENABLED",
  "WEIGHT_SURCHARGE_FALLBACK_INR", "WEIGHT_BANDS", "CATEGORY_WEIGHT_KG", "PROFIT_BANDS", "PRICE_ROUNDING_MODE", "PRODUCT_MISSING_CONFIRMATION_SCANS",
  "MIN_CATALOG_SIZE", "MISSING_ACTION", "NEW_PRODUCT_STATUS", "OVERWRITE_MANUAL_DESCRIPTION", "ADOPT_EXISTING_PRODUCTS", "EXCLUDED_CATEGORIES", "VENDOR",
  "PRODUCT_TYPE_MAP", "DEFAULT_PRODUCT_TYPE", "BASE_TAGS", "PUBLISH_CHANNELS", "IMAGE_PRESET", "REQUEST_DELAY_MS",
];

// ---- CENTRALIZED TORY BURCH PRICING CONFIGURATION (store owner, 2026-09-26). Change here or via `set`, nowhere else. ----
export const TB_PRICING_DEFAULTS = Object.freeze({
  // 0–0.5 kg ₹1,000 · 0.501–1 kg ₹1,500 · 1.001–2 kg ₹2,500 · 2.001–3 kg ₹3,500 · 3.001–5 kg ₹4,250 · 5.001 kg+ ₹5,000
  WEIGHT_BANDS: "0.5:1000,1:1500,2:2500,3:3500,5:4250,+:5000",
  WEIGHT_SURCHARGE_FALLBACK_INR: 2500, // unknown weight (toryburch.com publishes no weights)
  // landed ₹0–5,000 → ₹1,000 · ₹5,001–10,000 → ₹1,500 · ₹10,001–20,000 → ₹2,000 · ₹20,001–35,000 → ₹3,000 · ₹35,001–50,000 → ₹3,500 · ₹50,001+ → ₹4,000
  PROFIT_BANDS: "5000:1000,10000:1500,20000:2000,35000:3000,50000:3500,+:4000",
});

const DEFAULTS: TbSettings = {
  ENABLED: true,
  SYNC_INTERVAL_HOURS: 5,
  SYNC_PAUSED: false,
  DRY_RUN: false,
  SYNC_LIMIT: 0,
  SOURCE_MODE: "http",
  FEED_DIR: "data/toryburch-feed",
  DEFAULT_ETA: "15–20 Days",
  SOURCE_CURRENCY: "USD",
  TARGET_CURRENCY: "INR",
  SOURCE_PRICE_BASIS: "CURRENT_SELLING", // a genuine sale price is the purchase price; the original is stored separately
  COMPARE_AT_MODE: "NONE",
  FX_PROVIDER: "open.er-api.com",
  MANUAL_EXCHANGE_RATE: 0,
  MAX_EXCHANGE_RATE_AGE_HOURS: 24,
  WEIGHT_SURCHARGE_ENABLED: true,
  WEIGHT_SURCHARGE_FALLBACK_INR: TB_PRICING_DEFAULTS.WEIGHT_SURCHARGE_FALLBACK_INR,
  WEIGHT_BANDS: TB_PRICING_DEFAULTS.WEIGHT_BANDS,
  CATEGORY_WEIGHT_KG: "",
  PROFIT_BANDS: TB_PRICING_DEFAULTS.PROFIT_BANDS,
  PRICE_ROUNDING_MODE: "NONE",
  PRODUCT_MISSING_CONFIRMATION_SCANS: 2,
  MIN_CATALOG_SIZE: 500,
  MISSING_ACTION: "archive",
  NEW_PRODUCT_STATUS: "DRAFT",
  OVERWRITE_MANUAL_DESCRIPTION: false,
  ADOPT_EXISTING_PRODUCTS: false,
  // gift cards are not products; fragrance is flammable liquid (restricted as air cargo to India, same as Michael Kors);
  // home = glassware / linens / candles, not fashion. Change with `set EXCLUDED_CATEGORIES ...` (watches can't be enabled).
  EXCLUDED_CATEGORIES: "gift card,fragrance,home",
  VENDOR: "Tory Burch",
  // the store's nav collections key on product type: shoes -> Sneakers tab, bags/wallets -> Bags column
  // (checked against "Department > Class" in this order: "Accessories > Bag Charms" is an accessory, not a bag)
  PRODUCT_TYPE_MAP: "wallets:Wallets,card case:Wallets,coin purse:Wallets,wristlet:Wallets,accessor:Accessories,jewelry:Accessories,handbag:Bags,bag:Bags,shoe:Sneakers,clothing:Apparel,ready-to-wear:Apparel,swim:Apparel",
  DEFAULT_PRODUCT_TYPE: "Accessories",
  BASE_TAGS: "Tory Burch,ETA,tory-burch-sync",
  PUBLISH_CHANNELS: "Online Store,Point of Sale,Inbox",
  IMAGE_PRESET: "pdp-2000x2000",
  REQUEST_DELAY_MS: 2000, // politeness floor: one sequential request every 2 s (~1.8 h per full crawl, inside the 5 h cadence)
};

const ENUMS: Partial<Record<keyof TbSettings, string[]>> = {
  SOURCE_MODE: ["http", "feed"],
  SOURCE_PRICE_BASIS: ["CURRENT_SELLING", "REGULAR"],
  COMPARE_AT_MODE: ["SOURCE_REGULAR", "NONE"],
  FX_PROVIDER: ["open.er-api.com", "frankfurter", "manual"],
  PRICE_ROUNDING_MODE: ["NONE", "NEAREST_10", "NEAREST_50", "NEAREST_100"],
  MISSING_ACTION: ["archive", "draft"],
  NEW_PRODUCT_STATUS: ["ACTIVE", "DRAFT"],
};

export function coerceTb<K extends keyof TbSettings>(key: K, raw: unknown): TbSettings[K] {
  const def = DEFAULTS[key];
  if (raw === undefined || raw === null || (raw === "" && key !== "CATEGORY_WEIGHT_KG" && key !== "EXCLUDED_CATEGORIES")) return def;
  if (typeof def === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Setting ${key} must be a non-negative number (got "${raw}")`);
    return n as TbSettings[K];
  }
  if (typeof def === "boolean") return (raw === true || /^(true|1|yes|on)$/i.test(String(raw))) as TbSettings[K];
  return String(raw) as TbSettings[K];
}

export function validateTbSetting(key: keyof TbSettings, value: unknown) {
  const allowed = ENUMS[key];
  if (allowed && !allowed.includes(String(value))) throw new Error(`Setting ${key} must be one of ${allowed.join(", ")}`);
  if (key === "SYNC_INTERVAL_HOURS" && Number(value) < 1) throw new Error("SYNC_INTERVAL_HOURS must be at least 1");
  if (key === "PRODUCT_MISSING_CONFIRMATION_SCANS" && Number(value) < 2) throw new Error("PRODUCT_MISSING_CONFIRMATION_SCANS must be at least 2");
  if (key === "REQUEST_DELAY_MS" && Number(value) < 2000) throw new Error("REQUEST_DELAY_MS must be at least 2000 (politeness floor)");
  if (key === "MAX_EXCHANGE_RATE_AGE_HOURS" && !(Number(value) > 0)) throw new Error("MAX_EXCHANGE_RATE_AGE_HOURS must be greater than 0");
  if (key === "WEIGHT_BANDS") parseWeightBands(String(value));
  if (key === "PROFIT_BANDS") parseProfitBands(String(value));
  if (key === "PRODUCT_TYPE_MAP" || key === "CATEGORY_WEIGHT_KG") parseMap(String(value));
  if (key === "IMAGE_PRESET" && !/^[a-z0-9-]+$/i.test(String(value))) throw new Error("IMAGE_PRESET must look like pdp-2000x2000");
  if ((key === "SOURCE_CURRENCY" || key === "TARGET_CURRENCY") && !/^[A-Z]{3}$/.test(String(value))) throw new Error(`${key} must be a 3-letter currency code`);
}

/** The owner-facing names from the spec, mapped onto settings keys (TORY_BURCH_<KEY> also works for every key). */
const ENV_ALIASES: Partial<Record<keyof TbSettings, string[]>> = {
  DEFAULT_ETA: ["TORY_BURCH_ETA"],
  MAX_EXCHANGE_RATE_AGE_HOURS: ["USD_INR_RATE_MAX_AGE_HOURS"],
};

export function tbEnvSettings(env: NodeJS.ProcessEnv = process.env): TbSettings {
  const s = {} as Record<string, unknown>;
  for (const k of TB_KEYS) {
    const names = [`TORY_BURCH_${k}`, ...(ENV_ALIASES[k] ?? [])];
    const raw = names.map((n) => env[n]).find((v) => v !== undefined);
    s[k] = coerceTb(k, raw);
  }
  return s as unknown as TbSettings;
}

export const TB_SOURCE = {
  origin: "https://www.toryburch.com",
  locale: "en-us",
  // robots.txt (User-agent: *) allows product pages and lists this sitemap index (only ?q= search and favorites are disallowed)
  sitemapIndex: process.env.TORY_BURCH_SITEMAP_INDEX || "https://www.toryburch.com/sitemap_index.xml",
  userAgent: "Mozilla/5.0 (compatible; FullSizeRunCatalogSync/1.0; +https://fullsizerun.in; authorized-importer)",
};
