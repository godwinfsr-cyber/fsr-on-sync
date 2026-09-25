import { calculateAloPrice } from "../alo/pricing.ts";
import type { FxRate } from "../gymshark/fx.ts";
import type { RhodeSettings } from "./config.ts";

type PriceSettings = Pick<RhodeSettings, "SOURCE_PRICE_BASIS" | "COMPARE_AT_MODE" | "PRICING_ADJUSTMENT_INR" | "PRICE_ROUNDING_MODE">;

export interface RhodePrice {
  ok: boolean;
  sourcePriceUsd: number | null;          // the Rhode price used (per SOURCE_PRICE_BASIS; default = current selling price)
  sourceRegularPriceUsd: number | null;   // Rhode's regular / original price
  sourceSalePriceUsd: number | null;      // Rhode's sale price, only when it is below the regular price
  exchangeRate: number | null;
  convertedPriceInr: number | null;       // sourcePriceUsd x rate (unrounded)
  pricingAdjustmentInr: number;           // ₹2,000 by default, added exactly once
  fsrPrice: number | null;                // Shopify price
  compareAtPrice: number | null;          // only with COMPARE_AT_MODE=SOURCE_REGULAR while Rhode shows a sale
  reason?: string;
}

/**
 * Full Size Run price, always recalculated from the CURRENT Rhode USD price (never from an earlier Shopify price):
 *   converted_price_inr = source_price_usd x live_usd_inr_rate
 *   final_fsr_price     = converted_price_inr + PRICING_ADJUSTMENT_INR       (rounded only if PRICE_ROUNDING_MODE says so)
 * Same one-application formula as the ALO sync (calculateAloPrice + its formula guard); no discount is combined with
 * a Rhode sale - the sale price simply becomes the source price.
 */
export function calculateRhodePrice(
  src: { currentUsd: number | null; regularUsd: number | null; currency: string | null },
  fx: Pick<FxRate, "ok" | "rate" | "base">,
  s: PriceSettings,
): RhodePrice {
  const p = calculateAloPrice(src, fx, { ...s, FLAT_ADJUSTMENT_INR: s.PRICING_ADJUSTMENT_INR });
  const { flatAdjustmentInr, ...rest } = p;
  return { ...rest, pricingAdjustmentInr: flatAdjustmentInr };
}
