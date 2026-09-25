import type { FxRate } from "../gymshark/fx.ts";
import { assertFormula, roundPrice } from "../gymshark/pricing.ts";
import type { StanleySettings } from "./config.ts";

type PriceSettings = Pick<StanleySettings, "SOURCE_PRICE_BASIS" | "COMPARE_AT_MODE" | "PRICING_ADJUSTMENT_INR" | "PRICE_ROUNDING_MODE">;

export interface StanleyPrice {
  ok: boolean;
  sourcePriceUsd: number | null;          // the Stanley price used as FSR's purchase price (per SOURCE_PRICE_BASIS)
  sourceRegularPriceUsd: number | null;   // Stanley's regular / original price
  sourceSalePriceUsd: number | null;      // Stanley's sale price, only when it is below the regular price
  exchangeRate: number | null;
  convertedPriceInr: number | null;       // sourcePriceUsd x rate (unrounded)
  pricingAdjustmentInr: number;           // ₹3,000 by default
  fsrPrice: number | null;                // Shopify price
  compareAtPrice: number | null;          // Shopify compare-at (converted regular price + the same flat ₹), or null
  reason?: string;
}

/**
 * FSR price, always recalculated from the CURRENT Stanley USD price (never from a previous Shopify price):
 *   converted_price_inr = source_price_usd x live_usd_inr_rate
 *   final_fsr_price     = converted_price_inr + PRICING_ADJUSTMENT_INR          (₹3,000, added exactly once)
 * No shipping / weight band, profit band or percentage markup exists for Stanley. A sale is reflected only through
 * Stanley's displayed selling price; cart-level promotions ("spend $75, save $15") are never applied.
 */
export function calculateStanleyPrice(
  src: { currentUsd: number | null; regularUsd: number | null; currency: string | null },
  fx: Pick<FxRate, "ok" | "rate" | "base">,
  s: PriceSettings,
): StanleyPrice {
  const flat = s.PRICING_ADJUSTMENT_INR;
  // Stanley sometimes leaves a compare-at BELOW the price (e.g. $31 vs $30): that is not a sale
  const regular = src.regularUsd != null && src.regularUsd > 0 ? Math.max(src.regularUsd, src.currentUsd ?? 0) : null;
  const onSale = regular != null && src.currentUsd != null && src.currentUsd < regular;
  const base: StanleyPrice = {
    ok: false, sourcePriceUsd: null, sourceRegularPriceUsd: regular ?? src.currentUsd, sourceSalePriceUsd: onSale ? src.currentUsd : null,
    exchangeRate: fx.rate, convertedPriceInr: null, pricingAdjustmentInr: flat, fsrPrice: null, compareAtPrice: null,
  };
  const fail = (reason: string): StanleyPrice => ({ ...base, reason });
  if (src.currentUsd == null || !(src.currentUsd > 0)) return fail("missing price: no positive USD price on the Stanley product");
  if (src.currency && fx.base && src.currency !== fx.base) return fail(`source currency is ${src.currency}, exchange rate is for ${fx.base}`);
  if (!fx.ok || !fx.rate) return fail("no valid exchange rate - price update paused");

  const sourcePriceUsd = s.SOURCE_PRICE_BASIS === "REGULAR" ? regular ?? src.currentUsd : src.currentUsd;
  const convertedPriceInr = sourcePriceUsd * fx.rate;
  const fsrPrice = roundPrice(convertedPriceInr + flat, s.PRICE_ROUNDING_MODE);
  const check = assertFormula(sourcePriceUsd, fx.rate, flat, fsrPrice);
  if (check) return fail(check);

  let compareAtPrice: number | null = null;
  if (s.COMPARE_AT_MODE === "SOURCE_REGULAR" && regular != null && regular > sourcePriceUsd) {
    const c = roundPrice(regular * fx.rate + flat, s.PRICE_ROUNDING_MODE);
    if (c > fsrPrice) compareAtPrice = c;
  }
  return { ...base, ok: true, sourcePriceUsd, convertedPriceInr, fsrPrice, compareAtPrice };
}
