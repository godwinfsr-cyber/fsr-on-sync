import fs from "node:fs";
import path from "node:path";

// Secrets and deployment settings come from .env / the process environment.
// Business settings (pricing, ETA, interval...) also default from .env, but can be
// overridden from the dashboard; overrides are stored in the SQLite `settings` table.
export const ROOT = path.resolve(import.meta.dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
if (fs.existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
export const LOG_DIR = path.join(ROOT, "logs");
for (const d of [DATA_DIR, LOG_DIR]) fs.mkdirSync(d, { recursive: true });

export type MarkupType = "percentage" | "fixed";
export type RoundingRule = "none" | "nearest_10" | "nearest_100" | "ceil_100" | "ceil_500" | "ceil_1000" | "end_99" | "end_999";
export type MissingAction = "archive" | "draft" | "unavailable";
export type CompareAtMode = "source_list" | "none";

export interface Settings {
  SYNC_INTERVAL_HOURS: number;
  SYNC_PAUSED: boolean;
  DRY_RUN: boolean;
  SYNC_LIMIT: number; // 0 = whole catalog
  DEFAULT_ETA: string;
  SOURCE_CURRENCY: string;
  TARGET_CURRENCY: string;
  EXCHANGE_RATE: number; // TARGET per 1 SOURCE; 0 = not configured
  EXCHANGE_RATE_BUFFER_PCT: number;
  MARKUP_TYPE: MarkupType;
  MARKUP_VALUE: number;
  MIN_PROFIT: number; // in target currency
  ROUNDING_RULE: RoundingRule;
  COMPARE_AT_MODE: CompareAtMode;
  PRODUCT_MISSING_CONFIRMATION_SCANS: number;
  MISSING_ACTION: MissingAction;
  NEW_PRODUCT_STATUS: "ACTIVE" | "DRAFT";
  CONTENT_REUSE_CONFIRMED: boolean;
  ADOPT_EXISTING_PRODUCTS: boolean;
  VENDOR: string;
  PRODUCT_TYPE: string;
  BASE_TAGS: string;
  TITLE_TEMPLATE: string;
  SIZE_OPTION_NAME: string;
  INCLUDE_KIDS: boolean;             // false = kids' shoes are not imported
  PUBLISH_CHANNELS: string;          // sales channels ACTIVE products are published to (comma-separated names)
  SIZE_SYSTEM: "UK" | "US";          // UK = convert ON's US sizes for the storefront
  MEN_US_TO_UK_OFFSET: number;       // UK = US - offset (men / unisex)
  WOMEN_US_TO_UK_OFFSET: number;     // UK = US - offset (women)
  REQUEST_DELAY_MS: number;
  SOURCE_CONCURRENCY: number;
}

export const SETTING_KEYS: (keyof Settings)[] = [
  "SYNC_INTERVAL_HOURS", "SYNC_PAUSED", "DRY_RUN", "SYNC_LIMIT", "DEFAULT_ETA", "SOURCE_CURRENCY", "TARGET_CURRENCY",
  "EXCHANGE_RATE", "EXCHANGE_RATE_BUFFER_PCT", "MARKUP_TYPE", "MARKUP_VALUE", "MIN_PROFIT", "ROUNDING_RULE",
  "COMPARE_AT_MODE", "PRODUCT_MISSING_CONFIRMATION_SCANS", "MISSING_ACTION", "NEW_PRODUCT_STATUS",
  "CONTENT_REUSE_CONFIRMED", "ADOPT_EXISTING_PRODUCTS", "VENDOR", "PRODUCT_TYPE", "BASE_TAGS", "TITLE_TEMPLATE",
  "SIZE_OPTION_NAME", "INCLUDE_KIDS", "PUBLISH_CHANNELS", "SIZE_SYSTEM", "MEN_US_TO_UK_OFFSET", "WOMEN_US_TO_UK_OFFSET", "REQUEST_DELAY_MS", "SOURCE_CONCURRENCY",
];

const DEFAULTS: Settings = {
  SYNC_INTERVAL_HOURS: 5,
  SYNC_PAUSED: false,
  DRY_RUN: true, // safe default: nothing is written to Shopify until explicitly switched off
  SYNC_LIMIT: 0,
  DEFAULT_ETA: "7–14 Days",
  SOURCE_CURRENCY: "USD",
  TARGET_CURRENCY: "INR",
  EXCHANGE_RATE: 0,
  EXCHANGE_RATE_BUFFER_PCT: 0,
  MARKUP_TYPE: "percentage",
  MARKUP_VALUE: 0,
  MIN_PROFIT: 0,
  ROUNDING_RULE: "none",
  COMPARE_AT_MODE: "source_list",
  PRODUCT_MISSING_CONFIRMATION_SCANS: 2,
  MISSING_ACTION: "archive",
  NEW_PRODUCT_STATUS: "DRAFT",
  CONTENT_REUSE_CONFIRMED: false,
  ADOPT_EXISTING_PRODUCTS: false,
  VENDOR: "On Running",        // "On Running" brand collection = vendor "On Running" AND type "Sneakers"
  PRODUCT_TYPE: "Sneakers",    // "Sneakers" nav collection keys on product type
  BASE_TAGS: "On,On Running,ETA,DS,Sneakers,On Last Season,on-sync",
  TITLE_TEMPLATE: "On Running {model} - {color} ({gender})",
  SIZE_OPTION_NAME: "Size",
  INCLUDE_KIDS: false,
  PUBLISH_CHANNELS: "Online Store,Point of Sale,Inbox",
  SIZE_SYSTEM: "UK",
  MEN_US_TO_UK_OFFSET: 0.5,
  WOMEN_US_TO_UK_OFFSET: 2,
  REQUEST_DELAY_MS: 2500,
  SOURCE_CONCURRENCY: 1,
};

export function coerce<K extends keyof Settings>(key: K, raw: unknown): Settings[K] {
  const def = DEFAULTS[key];
  if (raw === undefined || raw === null || raw === "") return def;
  if (typeof def === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Setting ${key} must be a non-negative number (got "${raw}")`);
    return n as Settings[K];
  }
  if (typeof def === "boolean") return (raw === true || /^(true|1|yes|on)$/i.test(String(raw))) as Settings[K];
  return String(raw) as Settings[K];
}

const ENUMS: Partial<Record<keyof Settings, string[]>> = {
  MARKUP_TYPE: ["percentage", "fixed"],
  ROUNDING_RULE: ["none", "nearest_10", "nearest_100", "ceil_100", "ceil_500", "ceil_1000", "end_99", "end_999"],
  MISSING_ACTION: ["archive", "draft", "unavailable"],
  COMPARE_AT_MODE: ["source_list", "none"],
  NEW_PRODUCT_STATUS: ["ACTIVE", "DRAFT"],
  SIZE_SYSTEM: ["UK", "US"],
};

export function validateSetting(key: keyof Settings, value: unknown) {
  const allowed = ENUMS[key];
  if (allowed && !allowed.includes(String(value))) throw new Error(`Setting ${key} must be one of ${allowed.join(", ")}`);
  if (key === "SYNC_INTERVAL_HOURS" && Number(value) < 1) throw new Error("SYNC_INTERVAL_HOURS must be at least 1");
  if (key === "PRODUCT_MISSING_CONFIRMATION_SCANS" && Number(value) < 1) throw new Error("PRODUCT_MISSING_CONFIRMATION_SCANS must be at least 1");
  if (key === "REQUEST_DELAY_MS" && Number(value) < 1000) throw new Error("REQUEST_DELAY_MS must be at least 1000 (politeness floor)");
  if (key === "SOURCE_CONCURRENCY" && (Number(value) < 1 || Number(value) > 2)) throw new Error("SOURCE_CONCURRENCY must be 1 or 2");
}

export function envSettings(): Settings {
  const s = {} as Record<string, unknown>;
  for (const k of SETTING_KEYS) s[k] = coerce(k, process.env[k]);
  return s as unknown as Settings;
}

export const shopifyEnv = {
  storeDomain: process.env.SHOPIFY_STORE_DOMAIN || "va9wah-fx.myshopify.com",
  apiVersion: process.env.SHOPIFY_API_VERSION || "2026-07",
  accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "",
  clientId: process.env.SHOPIFY_CLIENT_ID || "",
  clientSecret: process.env.SHOPIFY_CLIENT_SECRET || "",
  locationId: process.env.SHOPIFY_LOCATION_ID || "",
};

export function hasShopifyCredentials() {
  return Boolean(shopifyEnv.accessToken || (shopifyEnv.clientId && shopifyEnv.clientSecret));
}

export const SOURCE = {
  listingUrl: process.env.SOURCE_LISTING_URL || "https://www.on.com/en-us/shop/classics/shoes",
  origin: "https://www.on.com",
};

export const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 3100);
