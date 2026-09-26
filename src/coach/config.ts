// COACH + COACH OUTLET -> Full Size Run: ONE-TIME catalog import (no scheduler, no recurring sync, no source monitoring).
// Runs in the cloud (GitHub Actions, .github/workflows/coach-import.yml, manual trigger only). Shares ROOT/.env loading and
// the Shopify credentials with the other sources (../config.ts). Every setting reads COACH_<KEY> from the environment.
import "../config.ts";
import { parseWeightBands, type FxProvider } from "../gymshark/config.ts";
import { parseProfitBands, type MkRoundingMode } from "../michaelkors/config.ts";

export { parseProfitBands, parseWeightBands };

// ---------------------------------------------------------------------------------------------------------------
// BRAND AUTHORIZATION (business fact stated by the store owner, 2026-09-26)
//
// Full Size Run is an OFFICIAL / AUTHORIZED IMPORTER of COACH products in India, with permission to download, use and
// import COACH (mainline + Outlet) product images and product information into the Full Size Run Shopify catalog.
// There is deliberately NO copyright blocker in this importer. Scope: COACH only.
// It does NOT authorise bypassing technical protection: coach.com answers scripted requests with an Akamai 403, so the
// product pages are collected once through an ordinary browser session (harvest.browser.js) - never with stealth
// tooling, proxies, CAPTCHA solving or rate-limit circumvention.
// ---------------------------------------------------------------------------------------------------------------
export const BRAND_AUTHORIZATION = Object.freeze({
  brand: "COACH",
  authorized_importer: true,
  importer: "Full Size Run",
  territory: "India",
  image_download_authorized: true,
  product_content_usage_authorized: true,
});

export interface CoachSettings {
  DEFAULT_ETA: string;                 // custom.eta on every imported product
  SOURCE_CURRENCY: string;
  TARGET_CURRENCY: string;
  FX_PROVIDER: FxProvider;             // live USD/INR provider (no API key); manual only with MANUAL_EXCHANGE_RATE
  MANUAL_EXCHANGE_RATE: number;
  MAX_EXCHANGE_RATE_AGE_HOURS: number; // a rate older than this is never used
  WEIGHT_SURCHARGE_ENABLED: boolean;
  WEIGHT_SURCHARGE_FALLBACK_INR: number;
  WEIGHT_BANDS: string;                // "<upper bound kg>:<INR shipping>,...,+:<INR>"
  PROFIT_BANDS: string;                // "<landed-cost upper bound ₹>:<profit ₹>,...,+:<profit ₹>"
  PRICE_ROUNDING_MODE: MkRoundingMode;
  NEW_PRODUCT_STATUS: "ACTIVE" | "DRAFT";
  PUBLISH_CHANNELS: string;
  VENDOR: string;
  BASE_TAGS: string;
  EXCLUDED_CATEGORIES: string;         // non-watch exclusions (watches are excluded in code, always)
  INCLUDE_RESTORED: boolean;           // Coach (Re)Loved / Restored = refurbished pre-owned pieces
  SIZE_SYSTEM: "UK" | "US";            // store rule: shoes are listed in UK sizes
  IMAGE_SIZE: number;                  // scene7 rendition (native masters are 2400 px)
  IMAGE_QUALITY: number;
  MAX_IMAGES: number;
  SHOPIFY_CONCURRENCY: number;         // products written in parallel (controlled; Shopify throttling is handled by the client)
  IMAGE_PROBE_CONCURRENCY: number;     // scene7 existence checks in parallel
  FEED_DIR: string;
}

// ---- CENTRALIZED COACH PRICING CONFIGURATION (store owner, 2026-09-26) - the same system as the Michael Kors importer ----
export const COACH_PRICING_DEFAULTS = Object.freeze({
  // 0–0.5 kg ₹1,000 · 0.501–1 kg ₹1,500 · 1.001–2 kg ₹2,500 · 2.001–3 kg ₹3,500 · 3.001–5 kg ₹4,250 · 5.001 kg+ ₹5,000
  WEIGHT_BANDS: "0.5:1000,1:1500,2:2500,3:3500,5:4250,+:5000",
  WEIGHT_SURCHARGE_FALLBACK_INR: 2500, // coach.com publishes no weights
  // landed ₹0–5,000 → ₹1,000 · ₹5,001–10,000 → ₹1,500 · ₹10,001–20,000 → ₹2,000 · ₹20,001–35,000 → ₹3,000 · ₹35,001–50,000 → ₹3,500 · ₹50,001+ → ₹4,000
  PROFIT_BANDS: "5000:1000,10000:1500,20000:2000,35000:3000,50000:3500,+:4000",
});

const DEFAULTS: CoachSettings = {
  DEFAULT_ETA: "15–20 Days",
  SOURCE_CURRENCY: "USD",
  TARGET_CURRENCY: "INR",
  FX_PROVIDER: "open.er-api.com",
  MANUAL_EXCHANGE_RATE: 0,
  MAX_EXCHANGE_RATE_AGE_HOURS: 24,
  WEIGHT_SURCHARGE_ENABLED: true,
  WEIGHT_SURCHARGE_FALLBACK_INR: COACH_PRICING_DEFAULTS.WEIGHT_SURCHARGE_FALLBACK_INR,
  WEIGHT_BANDS: COACH_PRICING_DEFAULTS.WEIGHT_BANDS,
  PROFIT_BANDS: COACH_PRICING_DEFAULTS.PROFIT_BANDS,
  PRICE_ROUNDING_MODE: "NEAREST_1",
  NEW_PRODUCT_STATUS: "ACTIVE",
  PUBLISH_CHANNELS: "Online Store,Point of Sale,Inbox",
  VENDOR: "Coach",
  BASE_TAGS: "Coach,ETA,DS,coach-import",
  // fragrance = flammable liquid (restricted as air cargo, same as Michael Kors); leather cleaner / moisturizer = product
  // care; gift cards are not products. Change with COACH_EXCLUDED_CATEGORIES (watches can never be enabled).
  EXCLUDED_CATEGORIES: "gift card,fragrance,eau de parfum,eau de toilette,parfum,cologne,leather cleaner,leather moisturizer,moisturizer,product care",
  INCLUDE_RESTORED: false, // store owner, 2026-09-26: refurbished pieces are not sold as new
  SIZE_SYSTEM: "UK",
  IMAGE_SIZE: 2400,
  IMAGE_QUALITY: 90,
  MAX_IMAGES: 12,
  SHOPIFY_CONCURRENCY: 2,
  IMAGE_PROBE_CONCURRENCY: 4,
  FEED_DIR: "data/coach-feed",
};

const ENUMS: Partial<Record<keyof CoachSettings, string[]>> = {
  FX_PROVIDER: ["open.er-api.com", "frankfurter", "manual"],
  PRICE_ROUNDING_MODE: ["NONE", "NEAREST_1", "NEAREST_10", "NEAREST_50", "NEAREST_100"],
  NEW_PRODUCT_STATUS: ["ACTIVE", "DRAFT"],
  SIZE_SYSTEM: ["UK", "US"],
};

function coerce<K extends keyof CoachSettings>(key: K, raw: string | undefined): CoachSettings[K] {
  const def = DEFAULTS[key];
  if (raw === undefined || raw === "") return def;
  if (typeof def === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`COACH_${key} must be a non-negative number (got "${raw}")`);
    return n as CoachSettings[K];
  }
  if (typeof def === "boolean") return /^(true|1|yes|on)$/i.test(raw) as CoachSettings[K];
  const allowed = ENUMS[key];
  if (allowed && !allowed.includes(raw)) throw new Error(`COACH_${key} must be one of ${allowed.join(", ")}`);
  return raw as CoachSettings[K];
}

export function coachSettings(env: NodeJS.ProcessEnv = process.env): CoachSettings {
  const s = {} as Record<string, unknown>;
  for (const k of Object.keys(DEFAULTS) as (keyof CoachSettings)[]) s[k] = coerce(k, env[`COACH_${k}`] ?? (k === "MAX_EXCHANGE_RATE_AGE_HOURS" ? env.USD_INR_RATE_MAX_AGE_HOURS : undefined));
  const out = s as unknown as CoachSettings;
  parseWeightBands(out.WEIGHT_BANDS);
  parseProfitBands(out.PROFIT_BANDS);
  if (!(out.MAX_EXCHANGE_RATE_AGE_HOURS > 0) || out.MAX_EXCHANGE_RATE_AGE_HOURS > 24) throw new Error("COACH_MAX_EXCHANGE_RATE_AGE_HOURS must be > 0 and at most 24");
  return out;
}

export const COACH_SOURCE = {
  origin: "https://www.coach.com",
  // robots.txt-listed sitemap: every mainline AND Outlet style (Outlet lives on coach.com under /products/outlet/)
  productSitemap: "https://www.coach.com/sitemap_0-product.xml",
  imageHost: "https://coach.scene7.com/is/image/Coach/",
  userAgent: "Mozilla/5.0 (compatible; FullSizeRunCatalogSync/1.0; +https://fullsizerun.in; authorized-importer)",
};

export const CNS = "coach_sync"; // metafield namespace (already used by the store's existing Coach products)
