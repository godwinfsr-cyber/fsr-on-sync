import type { FxRate } from "../gymshark/fx.ts";
import { assertFormula, roundPrice } from "../gymshark/pricing.ts";
import type { AloSettings } from "./config.ts";

type PriceSettings = Pick<AloSettings, "SOURCE_PRICE_BASIS" | "COMPARE_AT_MODE" | "FLAT_ADJUSTMENT_INR" | "PRICE_ROUNDING_MODE">;

export interface AloPrice {
  ok: boolean;
  sourcePriceUsd: number | null;          // the ALO price used as FSR's purchase price (per SOURCE_PRICE_BASIS)
  sourceRegularPriceUsd: number | null;   // ALO's regular / original price
  sourceSalePriceUsd: number | null;      // ALO's sale price, only when it is below the regular price
  exchangeRate: number | null;
  convertedPriceInr: number | null;       // sourcePriceUsd x rate (unrounded)
  flatAdjustmentInr: number;
  fsrPrice: number | null;                // Shopify price
  compareAtPrice: number | null;          // Shopify compare-at (converted regular price + the same flat ₹), or null
  reason?: string;
}

/**
 * FSR price, always recalculated from the CURRENT ALO USD price (never from a previous FSR price):
 *   converted_price_inr = source_price_usd x usd_inr_rate
 *   fsr_selling_price   = round( converted_price_inr + FLAT_ADJUSTMENT_INR )        (₹3,000 by default, added once)
 *   compare_at          = round( source_regular_price_usd x rate + FLAT_ADJUSTMENT_INR ), only while ALO shows a sale
 * No percentage discount or markup is applied. ALO's own sale is reflected only through the source price.
 */
export function calculateAloPrice(
  src: { currentUsd: number | null; regularUsd: number | null; currency: string | null },
  fx: Pick<FxRate, "ok" | "rate" | "base">,
  s: PriceSettings,
): AloPrice {
  const flat = s.FLAT_ADJUSTMENT_INR;
  const regular = src.regularUsd != null && src.regularUsd > 0 ? Math.max(src.regularUsd, src.currentUsd ?? 0) : null;
  const onSale = regular != null && src.currentUsd != null && src.currentUsd < regular;
  const base: AloPrice = {
    ok: false, sourcePriceUsd: null, sourceRegularPriceUsd: regular ?? src.currentUsd, sourceSalePriceUsd: onSale ? src.currentUsd : null,
    exchangeRate: fx.rate, convertedPriceInr: null, flatAdjustmentInr: flat, fsrPrice: null, compareAtPrice: null,
  };
  const fail = (reason: string): AloPrice => ({ ...base, reason });
  if (src.currentUsd == null || !(src.currentUsd > 0)) return fail("missing price: no positive USD price on the ALO product");
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
