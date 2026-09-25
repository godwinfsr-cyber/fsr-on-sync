import { parseWeightBands, type GymsharkSettings, type PriceRoundingMode } from "./config.ts";
import type { FxRate } from "./fx.ts";

type PriceSettings = Pick<GymsharkSettings, "SOURCE_PRICE_BASIS" | "COMPARE_AT_MODE" | "WEIGHT_SURCHARGE_ENABLED" | "WEIGHT_SURCHARGE_FALLBACK_INR" | "WEIGHT_BANDS" | "FSR_PROFIT_INR" | "PRICE_ROUNDING_MODE">;

export interface WeightSurcharge { weightKg: number | null; surchargeInr: number; reason: string }

export interface GymsharkPrice {
  ok: boolean;
  sourcePriceUsd: number | null;          // the Gymshark price used as FSR's purchase price (per SOURCE_PRICE_BASIS)
  sourceRegularPriceUsd: number | null;   // Gymshark's regular / original price
  sourceSalePriceUsd: number | null;      // Gymshark's sale price, only when it is below the regular price
  exchangeRate: number | null;
  convertedPriceInr: number | null;       // sourcePriceUsd x rate (unrounded)
  weight: WeightSurcharge;
  profitInr: number;
  fsrPrice: number | null;                // Shopify price
  compareAtPrice: number | null;          // Shopify compare-at (converted regular price + same adjustments), or null
  reason?: string;
}

export function roundPrice(v: number, mode: PriceRoundingMode): number {
  switch (mode) {
    case "NONE": return Math.round(v * 100) / 100;   // paise precision only - no business rounding
    case "NEAREST_10": return Math.round(v / 10) * 10;
    case "NEAREST_50": return Math.round(v / 50) * 50;
    case "NEAREST_100": return Math.round(v / 100) * 100;
  }
}

/** Deterministic weight band -> INR surcharge. Unknown weight uses the configured fallback (never an invented weight). */
export function weightSurcharge(weightKg: number | null, s: Pick<PriceSettings, "WEIGHT_SURCHARGE_ENABLED" | "WEIGHT_SURCHARGE_FALLBACK_INR" | "WEIGHT_BANDS">): WeightSurcharge {
  if (!s.WEIGHT_SURCHARGE_ENABLED) return { weightKg, surchargeInr: 0, reason: "weight_surcharge_disabled" };
  if (weightKg == null || !(weightKg > 0)) return { weightKg: null, surchargeInr: s.WEIGHT_SURCHARGE_FALLBACK_INR, reason: "fallback_weight_unknown" };
  const bands = parseWeightBands(s.WEIGHT_BANDS);
  let lower = 0;
  for (const b of bands) {
    if (b.maxKg == null || weightKg <= b.maxKg) {
      return { weightKg, surchargeInr: b.surchargeInr, reason: b.maxKg == null ? `weight_band_over_${lower}kg` : `weight_band_${lower}-${b.maxKg}kg` };
    }
    lower = b.maxKg;
  }
  throw new Error("unreachable: WEIGHT_BANDS has an open-ended top band");
}

/**
 * FSR price, always recalculated from CURRENT source data (never from a previous FSR price):
 *   converted_price_inr = source_price_usd x usd_inr_rate
 *   final_fsr_price     = round( converted_price_inr + weight_surcharge_inr + FSR_PROFIT_INR )
 * No percentage discount is applied. Gymshark's own sale is reflected only through the source price.
 */
export function calculateGymsharkPrice(
  src: { currentUsd: number | null; regularUsd: number | null; currency: string | null; weightKg: number | null },
  fx: Pick<FxRate, "ok" | "rate" | "base">,
  s: PriceSettings,
): GymsharkPrice {
  const weight = weightSurcharge(src.weightKg, s);
  const regular = src.regularUsd != null && src.regularUsd > 0 ? src.regularUsd : null;
  const onSale = regular != null && src.currentUsd != null && src.currentUsd < regular;
  const base: GymsharkPrice = {
    ok: false, sourcePriceUsd: null, sourceRegularPriceUsd: regular ?? src.currentUsd, sourceSalePriceUsd: onSale ? src.currentUsd : null,
    exchangeRate: fx.rate, convertedPriceInr: null, weight, profitInr: s.FSR_PROFIT_INR, fsrPrice: null, compareAtPrice: null,
  };
  const fail = (reason: string): GymsharkPrice => ({ ...base, reason });
  if (src.currentUsd == null || !(src.currentUsd > 0)) return fail("source price not found on the product page");
  if (src.currency && fx.base && src.currency !== fx.base) return fail(`source currency is ${src.currency}, exchange rate is for ${fx.base}`);
  if (!fx.ok || !fx.rate) return fail("no valid exchange rate - price update paused");

  const sourcePriceUsd = s.SOURCE_PRICE_BASIS === "REGULAR" ? regular ?? src.currentUsd : src.currentUsd;
  const convertedPriceInr = sourcePriceUsd * fx.rate;
  const fsrPrice = roundPrice(convertedPriceInr + weight.surchargeInr + s.FSR_PROFIT_INR, s.PRICE_ROUNDING_MODE);
  const check = assertFormula(sourcePriceUsd, fx.rate, weight.surchargeInr + s.FSR_PROFIT_INR, fsrPrice);
  if (check) return fail(check);

  let compareAtPrice: number | null = null;
  if (s.COMPARE_AT_MODE === "SOURCE_REGULAR" && regular != null && regular > sourcePriceUsd) {
    const c = roundPrice(regular * fx.rate + weight.surchargeInr + s.FSR_PROFIT_INR, s.PRICE_ROUNDING_MODE);
    if (c > fsrPrice) compareAtPrice = c;
  }
  return { ...base, ok: true, sourcePriceUsd, convertedPriceInr, fsrPrice, compareAtPrice };
}

/** Guards against the price being built from anything but one application of the formula (rounding tolerance ₹100). */
export function assertFormula(usd: number, rate: number, adders: number, price: number): string | null {
  const expected = usd * rate + adders;
  if (Math.abs(price - expected) > 100) return `price safety check failed: ₹${price} ≠ $${usd} × ${rate} + ₹${adders} (≈ ₹${expected.toFixed(2)})`;
  if (!(price > 0)) return `price safety check failed: ₹${price}`;
  return null;
}
