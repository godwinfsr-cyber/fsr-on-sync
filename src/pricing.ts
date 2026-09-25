import type { Settings, RoundingRule } from "./config.ts";

export interface PriceResult {
  ok: boolean;
  price: number | null;          // Full Size Run selling price in target currency
  compareAtPrice: number | null;
  converted: number | null;      // source price converted (incl. buffer), before markup
  reason?: string;
}

type PricingSettings = Pick<Settings,
  "EXCHANGE_RATE" | "EXCHANGE_RATE_BUFFER_PCT" | "MARKUP_TYPE" | "MARKUP_VALUE" | "MIN_PROFIT" | "ROUNDING_RULE" | "COMPARE_AT_MODE">;

export function applyRounding(v: number, rule: RoundingRule): number {
  switch (rule) {
    case "none": return Math.round(v * 100) / 100;
    case "nearest_10": return Math.round(v / 10) * 10;
    case "nearest_100": return Math.round(v / 100) * 100;
    case "ceil_100": return Math.ceil(v / 100) * 100;
    case "ceil_500": return Math.ceil(v / 500) * 500;
    case "ceil_1000": return Math.ceil(v / 1000) * 1000;
    case "end_99": return Math.ceil((v + 1) / 100) * 100 - 1;   // 12,340 -> 12,399
    case "end_999": return Math.ceil((v + 1) / 1000) * 1000 - 1; // 12,340 -> 12,999
  }
}

function sell(sourcePrice: number, s: PricingSettings): { converted: number; price: number } {
  const converted = sourcePrice * s.EXCHANGE_RATE * (1 + s.EXCHANGE_RATE_BUFFER_PCT / 100);
  let price = s.MARKUP_TYPE === "percentage" ? converted * (1 + s.MARKUP_VALUE / 100) : converted + s.MARKUP_VALUE;
  if (s.MIN_PROFIT > 0) price = Math.max(price, converted + s.MIN_PROFIT);
  return { converted, price: applyRounding(price, s.ROUNDING_RULE) };
}

/** Source price -> Full Size Run price. Pure function; the scraper never decides prices. */
export function calculatePrice(sourcePrice: number | null, sourceListPrice: number | null, s: PricingSettings): PriceResult {
  if (sourcePrice == null || !(sourcePrice > 0)) return { ok: false, price: null, compareAtPrice: null, converted: null, reason: "source price unavailable" };
  if (!(s.EXCHANGE_RATE > 0)) return { ok: false, price: null, compareAtPrice: null, converted: null, reason: "EXCHANGE_RATE is not configured" };
  const { converted, price } = sell(sourcePrice, s);
  let compareAtPrice: number | null = null;
  if (s.COMPARE_AT_MODE === "source_list" && sourceListPrice != null && sourceListPrice > sourcePrice) {
    const c = sell(sourceListPrice, s).price;
    compareAtPrice = c > price ? c : null;
  }
  return { ok: true, price, compareAtPrice, converted: Math.round(converted * 100) / 100 };
}
