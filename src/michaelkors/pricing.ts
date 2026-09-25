import { roundPrice as roundShared, weightSurcharge, type WeightSurcharge } from "../gymshark/pricing.ts";
import type { FxRate } from "../gymshark/fx.ts";
import { parseProfitBands, type MkRoundingMode, type MkSettings } from "./config.ts";

export function roundPrice(v: number, mode: MkRoundingMode): number {
  return mode === "NEAREST_1" ? Math.round(v) : roundShared(v, mode);
}

type PriceSettings = Pick<MkSettings, "SOURCE_PRICE_BASIS" | "COMPARE_AT_MODE" | "WEIGHT_SURCHARGE_ENABLED" | "WEIGHT_SURCHARGE_FALLBACK_INR" | "WEIGHT_BANDS" | "PROFIT_BANDS" | "PRICE_ROUNDING_MODE">;

export interface MkPrice {
  ok: boolean;
  sourcePriceUsd: number | null;      // source_price_usd - Michael Kors' price, stored separately and never altered
  sourceRegularPriceUsd: number | null; // "was" price when Michael Kors shows one
  sourceSalePriceUsd: number | null;    // current price, only while it is below the regular price
  exchangeRate: number | null;        // exchange_rate
  convertedPriceInr: number | null;   // converted_price_inr = source_price_usd x exchange_rate
  weight: WeightSurcharge;            // source_weight_kg + shipping_adjustment_inr (weight band)
  landedCostInr: number | null;       // landed_cost_inr = converted + shipping
  profitInr: number | null;           // profit_adjustment_inr (profit band on the landed cost)
  profitBand: string | null;
  fsrPrice: number | null;            // fsr_selling_price
  compareAtPrice: number | null;
  reason?: string;
}

/** Profit band for a landed cost: the first band whose upper bound (₹) is >= the landed cost. */
export function profitFor(landedInr: number, spec: string): { profitInr: number; band: string } {
  let lower = 0;
  for (const b of parseProfitBands(spec)) {
    if (b.maxInr == null || landedInr <= b.maxInr) return { profitInr: b.profitInr, band: b.maxInr == null ? `over ₹${lower}` : `₹${lower}–₹${b.maxInr}` };
    lower = b.maxInr;
  }
  throw new Error("unreachable: PROFIT_BANDS has an open-ended top band");
}

/**
 * SOURCE USD PRICE -> LIVE USD->INR -> + WEIGHT-BASED SHIPPING -> + PROFIT BAND -> FINAL FSR PRICE.
 * No discount or extra markup is ever applied; the price is always recomputed from current source data.
 */
export function calculateMkPrice(
  src: { currentUsd: number | null; regularUsd: number | null; currency: string | null; weightKg: number | null },
  fx: Pick<FxRate, "ok" | "rate" | "base">,
  s: PriceSettings,
): MkPrice {
  const w = weightSurcharge(src.weightKg, s);
  const weight = w.reason === "fallback_weight_unknown" ? { ...w, reason: "weight_unknown_fallback" } : w;
  const regular = src.regularUsd != null && src.regularUsd > 0 ? src.regularUsd : null;
  const base: MkPrice = {
    ok: false, sourcePriceUsd: null, sourceRegularPriceUsd: regular ?? src.currentUsd,
    sourceSalePriceUsd: regular != null && src.currentUsd != null && src.currentUsd < regular ? src.currentUsd : null, exchangeRate: fx.rate, convertedPriceInr: null, weight,
    landedCostInr: null, profitInr: null, profitBand: null, fsrPrice: null, compareAtPrice: null,
  };
  const fail = (reason: string): MkPrice => ({ ...base, reason });
  if (src.currentUsd == null || !(src.currentUsd > 0)) return fail("source price not found on the product page");
  if (src.currency && fx.base && src.currency !== fx.base) return fail(`source currency is ${src.currency}, exchange rate is for ${fx.base}`);
  if (!fx.ok || !fx.rate) return fail("no valid exchange rate - price update paused");

  const sourcePriceUsd = s.SOURCE_PRICE_BASIS === "REGULAR" ? regular ?? src.currentUsd : src.currentUsd;
  const convertedPriceInr = sourcePriceUsd * fx.rate;
  const landedCostInr = convertedPriceInr + weight.surchargeInr;
  const { profitInr, band } = profitFor(landedCostInr, s.PROFIT_BANDS);
  const fsrPrice = roundPrice(landedCostInr + profitInr, s.PRICE_ROUNDING_MODE);
  if (!(fsrPrice > 0) || Math.abs(fsrPrice - (sourcePriceUsd * fx.rate + weight.surchargeInr + profitInr)) > 100) {
    return fail(`price safety check failed: ₹${fsrPrice} vs $${sourcePriceUsd} × ${fx.rate} + ₹${weight.surchargeInr} + ₹${profitInr}`);
  }
  let compareAtPrice: number | null = null;
  if (s.COMPARE_AT_MODE === "SOURCE_REGULAR" && regular != null && regular > sourcePriceUsd) {
    const landedRegular = regular * fx.rate + weight.surchargeInr;
    const c = roundPrice(landedRegular + profitFor(landedRegular, s.PROFIT_BANDS).profitInr, s.PRICE_ROUNDING_MODE);
    if (c > fsrPrice) compareAtPrice = c;
  }
  return { ...base, ok: true, sourcePriceUsd, convertedPriceInr, landedCostInr, profitInr, profitBand: band, fsrPrice, compareAtPrice };
}
