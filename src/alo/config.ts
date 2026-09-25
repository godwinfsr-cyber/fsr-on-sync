// ALO Yoga (aloyoga.com, USD) -> Full Size Run settings. Shares ROOT/.env loading and Shopify credentials with the
// other sources (../config.ts); every business setting reads ALO_<KEY> from .env and can be overridden from the
// dashboard (stored in the ALO SQLite `settings` table).
import "../config.ts";
import { parseMap, type CompareAtMode, type FxProvider, type MissingAction, type PriceRoundingMode, type SourcePriceBasis } from "../gymshark/config.ts";

export { parseMap };

export interface AloSettings {
  SYNC_INTERVAL_HOURS: number;
  SYNC_PAUSED: boolean;
  DRY_RUN: boolean;
  // Catalog size guard: unless FULL_SYNC=true AND TEST_MODE=false, a run processes at most TEST_PRODUCT_LIMIT styles.
  TEST_MODE: boolean;
  TEST_PRODUCT_LIMIT: number;
  FULL_SYNC: boolean;
  DEFAULT_ETA: string;
  PRICING_MODE: "USD_TO_INR_PLUS_FLAT";
  SOURCE_CURRENCY: string;
  TARGET_CURRENCY: string;
  SOURCE_PRICE_BASIS: SourcePriceBasis;   // CURRENT_SELLING = what ALO charges now (the sale price when on sale)
  COMPARE_AT_MODE: CompareAtMode;         // SOURCE_REGULAR = while ALO shows a sale, compare-at = regular price through the same formula
  FX_PROVIDER: FxProvider;
  MANUAL_EXCHANGE_RATE: number;           // only for FX_PROVIDER=manual; 0 = not set
  MAX_EXCHANGE_RATE_AGE_HOURS: number;
  FLAT_ADJUSTMENT_INR: number;            // fixed ₹ added once, after conversion (never compounded)
  PRICE_ROUNDING_MODE: PriceRoundingMode;
  PRODUCT_MISSING_CONFIRMATION_SCANS: number;
  MISSING_ACTION: MissingAction;
  NEW_PRODUCT_STATUS: "ACTIVE" | "DRAFT";
  OUT_OF_STOCK_STATUS: "ARCHIVED" | "DRAFT";  // fully sold out at ALO -> this status (+ auto-oos-hidden tag); restored when back
  AUTHORIZATION_CONFIRMED: boolean;       // FSR is authorised to reuse ALO images + product text (store owner confirmation)
  OVERWRITE_MANUAL_DESCRIPTION: boolean;
  ADOPT_EXISTING_PRODUCTS: boolean;
  FETCH_DETAILS: boolean;                 // per-colourway product JSON (barcodes) + one page per style (fabric / fit)
  DETAILS_MAX_AGE_HOURS: number;          // cached details are re-read after this (ALO updated_at changes every few minutes, so it is no cache key)
  IMPORT_CATEGORIES: string;              // "" = everything; else ALO product-type segments, e.g. "Women,Men,Accessories"
  EXCLUDED_PRODUCT_TYPES: string;         // ALO product types never imported (loyalty rewards, gift cards, dummies)
  EXCLUDED_VENDORS: string;
  EXCLUDED_TAGS: string;
  MAX_IMAGES_PER_COLOUR: number;          // 0 = all (a Shopify product holds at most 250 media in total)
  VENDOR: string;
  PRODUCT_TYPE_MAP: string;               // ALO product-type segment -> Shopify product type ("leggings:Leggings,...")
  DEFAULT_APPAREL_TYPE: string;
  DEFAULT_OTHER_TYPE: string;
  BASE_TAGS: string;
  TITLE_TEMPLATE: string;                 // {title} {gender} {style}
  SIZE_SYSTEM: "UK" | "US";               // UK = convert ALO's US shoe sizes (store rule: men/unisex UK = US - 0.5, women UK = US - 2)
  MEN_US_TO_UK_OFFSET: number;
  WOMEN_US_TO_UK_OFFSET: number;
  PUBLISH_CHANNELS: string;
  MAX_CONCURRENT_PRODUCTS: number;
  REQUEST_DELAY_MS: number;
}

export const ALO_KEYS: (keyof AloSettings)[] = [
  "SYNC_INTERVAL_HOURS", "SYNC_PAUSED", "DRY_RUN", "TEST_MODE", "TEST_PRODUCT_LIMIT", "FULL_SYNC", "DEFAULT_ETA", "PRICING_MODE", "SOURCE_CURRENCY",
  "TARGET_CURRENCY", "SOURCE_PRICE_BASIS", "COMPARE_AT_MODE", "FX_PROVIDER", "MANUAL_EXCHANGE_RATE", "MAX_EXCHANGE_RATE_AGE_HOURS", "FLAT_ADJUSTMENT_INR",
  "PRICE_ROUNDING_MODE", "PRODUCT_MISSING_CONFIRMATION_SCANS", "MISSING_ACTION", "NEW_PRODUCT_STATUS", "OUT_OF_STOCK_STATUS", "AUTHORIZATION_CONFIRMED", "OVERWRITE_MANUAL_DESCRIPTION",
  "ADOPT_EXISTING_PRODUCTS", "FETCH_DETAILS", "DETAILS_MAX_AGE_HOURS", "IMPORT_CATEGORIES", "EXCLUDED_PRODUCT_TYPES", "EXCLUDED_VENDORS", "EXCLUDED_TAGS", "MAX_IMAGES_PER_COLOUR", "VENDOR",
  "PRODUCT_TYPE_MAP", "DEFAULT_APPAREL_TYPE", "DEFAULT_OTHER_TYPE", "BASE_TAGS", "TITLE_TEMPLATE", "SIZE_SYSTEM", "MEN_US_TO_UK_OFFSET", "WOMEN_US_TO_UK_OFFSET",
  "PUBLISH_CHANNELS", "MAX_CONCURRENT_PRODUCTS", "REQUEST_DELAY_MS",
];

const DEFAULTS: AloSettings = {
  SYNC_INTERVAL_HOURS: 5,
  SYNC_PAUSED: false,
  DRY_RUN: true, // nothing is written to Shopify until explicitly switched off
  TEST_MODE: true,
  TEST_PRODUCT_LIMIT: 5,
  FULL_SYNC: false,
  DEFAULT_ETA: "15–20 Days",
  PRICING_MODE: "USD_TO_INR_PLUS_FLAT",
  SOURCE_CURRENCY: "USD",
  TARGET_CURRENCY: "INR",
  SOURCE_PRICE_BASIS: "CURRENT_SELLING",
  COMPARE_AT_MODE: "SOURCE_REGULAR",
  FX_PROVIDER: "open.er-api.com",
  MANUAL_EXCHANGE_RATE: 0,
  MAX_EXCHANGE_RATE_AGE_HOURS: 24,
  FLAT_ADJUSTMENT_INR: 3000,
  PRICE_ROUNDING_MODE: "NONE",
  PRODUCT_MISSING_CONFIRMATION_SCANS: 2,
  MISSING_ACTION: "archive",
  NEW_PRODUCT_STATUS: "DRAFT",
  OUT_OF_STOCK_STATUS: "DRAFT",
  AUTHORIZATION_CONFIRMED: false,
  OVERWRITE_MANUAL_DESCRIPTION: false,
  ADOPT_EXISTING_PRODUCTS: false,
  FETCH_DETAILS: true,
  DETAILS_MAX_AGE_HOURS: 168,
  IMPORT_CATEGORIES: "",
  EXCLUDED_PRODUCT_TYPES: "Internal,DNU,E Gift Card,Gift Card,Accessories:Ultimate Gift Sets",
  EXCLUDED_VENDORS: "Fake,Alo Moves",
  EXCLUDED_TAGS: "LoyaltyPointsRedemption",
  MAX_IMAGES_PER_COLOUR: 0,
  VENDOR: "ALO Yoga",
  // Matched against ALO's product-type path from the most specific segment up ("Women:Bottoms:Leggings" -> leggings).
  // All footwear -> "Sneakers": the store's Sneakers tab keys on that product type.
  PRODUCT_TYPE_MAP: [
    "leggings:Leggings", "bras:Sports Bras", "shorts:Shorts", "sweatpants:Sweatpants", "pants:Pants", "trousers:Trousers", "skirts:Skirts",
    "tanks:Tops", "long sleeves:Tops", "short sleeves:T-Shirts", "hoodies:Hoodies", "pullovers:Sweatshirts", "sweatshirts:Sweatshirts",
    "sweaters:Sweaters", "jackets:Jackets", "vests:Jackets", "dresses:Dresses", "onesies:Onesies", "bodysuits:Onesies", "underwear:Underwear",
    "socks:Socks", "caps:Hats", "visors:Hats", "beanies:Hats", "hats:Hats", "bag:Bags", "bags:Bags", "small leather goods:Wallets",
    "shoes:Sneakers", "mats:Yoga Equipment", "equipment:Yoga Equipment", "beauty:Beauty", "wellness:Wellness", "books:Books",
  ].join(","),
  DEFAULT_APPAREL_TYPE: "Apparel",
  DEFAULT_OTHER_TYPE: "Accessories",
  BASE_TAGS: "ALO Yoga,alo,alo-yoga,ETA,alo-sync",
  TITLE_TEMPLATE: "ALO Yoga {title}",
  SIZE_SYSTEM: "UK",
  MEN_US_TO_UK_OFFSET: 0.5,
  WOMEN_US_TO_UK_OFFSET: 2,
  PUBLISH_CHANNELS: "Online Store,Point of Sale,Inbox",
  MAX_CONCURRENT_PRODUCTS: 3,
  REQUEST_DELAY_MS: 1500,
};

const ENUMS: Partial<Record<keyof AloSettings, string[]>> = {
  PRICING_MODE: ["USD_TO_INR_PLUS_FLAT"],
  SOURCE_PRICE_BASIS: ["CURRENT_SELLING", "REGULAR"],
  COMPARE_AT_MODE: ["SOURCE_REGULAR", "NONE"],
  FX_PROVIDER: ["open.er-api.com", "frankfurter", "manual"],
  PRICE_ROUNDING_MODE: ["NONE", "NEAREST_10", "NEAREST_50", "NEAREST_100"],
  MISSING_ACTION: ["archive", "draft"],
  NEW_PRODUCT_STATUS: ["ACTIVE", "DRAFT"],
  OUT_OF_STOCK_STATUS: ["ARCHIVED", "DRAFT"],
  SIZE_SYSTEM: ["UK", "US"],
};

export function coerceAlo<K extends keyof AloSettings>(key: K, raw: unknown): AloSettings[K] {
  const def = DEFAULTS[key];
  if (raw === undefined || raw === null || raw === "") return def;
  if (typeof def === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Setting ${key} must be a non-negative number (got "${raw}")`);
    return n as AloSettings[K];
  }
  if (typeof def === "boolean") return (raw === true || /^(true|1|yes|on)$/i.test(String(raw))) as AloSettings[K];
  return String(raw) as AloSettings[K];
}

export function validateAloSetting(key: keyof AloSettings, value: unknown) {
  const allowed = ENUMS[key];
  if (allowed && !allowed.includes(String(value))) throw new Error(`Setting ${key} must be one of ${allowed.join(", ")}`);
  if (key === "SYNC_INTERVAL_HOURS" && Number(value) < 1) throw new Error("SYNC_INTERVAL_HOURS must be at least 1");
  if (key === "PRODUCT_MISSING_CONFIRMATION_SCANS" && Number(value) < 1) throw new Error("PRODUCT_MISSING_CONFIRMATION_SCANS must be at least 1");
  if (key === "REQUEST_DELAY_MS" && Number(value) < 1000) throw new Error("REQUEST_DELAY_MS must be at least 1000 (politeness floor)");
  if (key === "MAX_CONCURRENT_PRODUCTS" && (Number(value) < 1 || Number(value) > 5)) throw new Error("MAX_CONCURRENT_PRODUCTS must be between 1 and 5");
  if (key === "TEST_PRODUCT_LIMIT" && Number(value) < 1) throw new Error("TEST_PRODUCT_LIMIT must be at least 1");
  if (key === "MAX_EXCHANGE_RATE_AGE_HOURS" && !(Number(value) > 0)) throw new Error("MAX_EXCHANGE_RATE_AGE_HOURS must be greater than 0");
  if (key === "PRODUCT_TYPE_MAP") parseMap(String(value));
  if ((key === "SOURCE_CURRENCY" || key === "TARGET_CURRENCY") && !/^[A-Z]{3}$/.test(String(value))) throw new Error(`${key} must be a 3-letter currency code`);
}

export function aloEnvSettings(): AloSettings {
  const s = {} as Record<string, unknown>;
  for (const k of ALO_KEYS) s[k] = coerceAlo(k, process.env[`ALO_${k}`]);
  return s as unknown as AloSettings;
}

/** Styles a run may process: the whole catalog only when FULL_SYNC=true and TEST_MODE=false. */
export function effectiveLimit(s: Pick<AloSettings, "TEST_MODE" | "TEST_PRODUCT_LIMIT" | "FULL_SYNC">): number {
  return s.FULL_SYNC && !s.TEST_MODE ? 0 : s.TEST_PRODUCT_LIMIT;
}

export const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

export const ALO_SOURCE = {
  // US storefront: prices are USD here. The /en-in/ locale shows ALO's own INR prices, which the FSR formula must not use.
  origin: process.env.ALO_SOURCE_ORIGIN || "https://www.aloyoga.com",
  // agents.md lists /products.json, /products/{handle}.json and product pages as read-only browsing endpoints;
  // robots.txt allows them. 250 is Shopify's page-size maximum.
  pageSize: 250,
  maxPages: 200, // hard stop far above today's catalog (a safety net against a pagination loop, not a product count)
  userAgent: "Mozilla/5.0 (compatible; FullSizeRunCatalogSync/1.0; +https://fullsizerun.in)",
};
