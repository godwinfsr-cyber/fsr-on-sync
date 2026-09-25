import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "../logger.ts";
import { errMsg } from "../util.ts";
import type { FxProvider, GymsharkSettings } from "./config.ts";
import { gdb, getGState } from "./db.ts";

export interface FxRate {
  ok: boolean;
  rate: number | null;              // TARGET per 1 SOURCE (e.g. INR per USD)
  base: string;
  quote: string;
  provider: string | null;
  providerUpdatedAt: string | null; // provider's own timestamp for the rate
  fetchedAt: string | null;         // when this service obtained / confirmed it (the rate's age is measured from here)
  origin: "live" | "cached" | "manual" | "none";
  reason?: string;                  // why ok=false, or why a cached rate was used
}

type Settings = Pick<GymsharkSettings, "FX_PROVIDER" | "MANUAL_EXCHANGE_RATE" | "MAX_EXCHANGE_RATE_AGE_HOURS" | "SOURCE_CURRENCY" | "TARGET_CURRENCY">;
type Fetcher = (url: string) => Promise<unknown>;
/** Where rates are recorded: any source database with the fx_rates + state tables (default: the Gymshark one). */
export interface FxStore { db: DatabaseSync; getState: (key: string) => string | null }
const GYMSHARK_STORE: FxStore = { get db() { return gdb; }, getState: getGState };

const SANE: Record<string, [number, number]> = { "USD/INR": [40, 250] };   // reject obviously broken provider data
const MAX_JUMP_PCT = 10;            // a move bigger than this vs the last good rate is held for review, never applied silently
const MAX_PROVIDER_LAG_HOURS = 96;  // providers publish once per (working) day; older provider data is not trusted

const defaultFetch: Fetcher = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/** Provider adapters: return the rate and the provider's timestamp. No API keys needed for either. */
export async function fetchProviderRate(provider: Exclude<FxProvider, "manual">, base: string, quote: string, fetcher: Fetcher = defaultFetch): Promise<{ rate: number; providerUpdatedAt: string | null }> {
  if (provider === "open.er-api.com") {
    const j = (await fetcher(`https://open.er-api.com/v6/latest/${base}`)) as { result?: string; base_code?: string; time_last_update_unix?: number; rates?: Record<string, number> };
    if (j.result !== "success" || j.base_code !== base) throw new Error(`unexpected response (result=${j.result}, base=${j.base_code})`);
    const rate = j.rates?.[quote];
    if (typeof rate !== "number") throw new Error(`${quote} missing from response`);
    return { rate, providerUpdatedAt: j.time_last_update_unix ? new Date(j.time_last_update_unix * 1000).toISOString() : null };
  }
  const j = (await fetcher(`https://api.frankfurter.dev/v1/latest?base=${base}&symbols=${quote}`)) as { base?: string; date?: string; rates?: Record<string, number> };
  const rate = j.rates?.[quote];
  if (j.base !== base || typeof rate !== "number") throw new Error(`unexpected response (base=${j.base})`);
  return { rate, providerUpdatedAt: j.date ? `${j.date}T16:00:00.000Z` : null }; // ECB reference rates are set ~16:00 CET
}

interface FxRow { provider: string; rate: number; provider_updated_at: string | null; fetched_at: string }
function lastGood(store: FxStore, base: string, quote: string): FxRow | undefined {
  return store.db.prepare("SELECT provider, rate, provider_updated_at, fetched_at FROM fx_rates WHERE ok = 1 AND base = ? AND quote = ? ORDER BY fetched_at DESC LIMIT 1").get(base, quote) as FxRow | undefined;
}
function record(store: FxStore, provider: string, base: string, quote: string, rate: number | null, providerUpdatedAt: string | null, fetchedAt: string, ok: boolean, error: string | null) {
  store.db.prepare("INSERT INTO fx_rates (provider, base, quote, rate, provider_updated_at, fetched_at, ok, error) VALUES (?,?,?,?,?,?,?,?)")
    .run(provider, base, quote, rate, providerUpdatedAt, fetchedAt, ok ? 1 : 0, error);
}

export function validateRate(pair: string, rate: number, previous: number | null): string | null {
  const [lo, hi] = SANE[pair] ?? [0, Number.POSITIVE_INFINITY];
  if (!(rate > 0) || !Number.isFinite(rate)) return `rate ${rate} is not a positive number`;
  if (rate < lo || rate > hi) return `rate ${rate} is outside the plausible ${pair} range ${lo}–${hi}`;
  if (previous && Math.abs(rate / previous - 1) * 100 > MAX_JUMP_PCT) {
    return `rate moved ${((rate / previous - 1) * 100).toFixed(1)}% vs the last good rate ${previous} (limit ${MAX_JUMP_PCT}%) - held for review; set FX_PROVIDER=manual with a confirmed MANUAL_EXCHANGE_RATE to accept it`;
  }
  return null;
}

/**
 * Current exchange rate for pricing. Never guesses:
 *  1. live provider rate (validated: plausible range, no >10% jump) -> stored with provider + timestamps
 *  2. provider down / invalid -> the last good rate, ONLY if it was obtained within MAX_EXCHANGE_RATE_AGE_HOURS
 *  3. otherwise ok=false: the caller pauses price updates (products are still synced, prices are left as they are)
 * FX_PROVIDER=manual uses MANUAL_EXCHANGE_RATE; its age counts from when it was last saved (or first used), so a
 * manual rate also expires after MAX_EXCHANGE_RATE_AGE_HOURS unless it is re-confirmed (re-saved).
 */
export async function getExchangeRate(s: Settings, log: Logger, opts: { persist?: boolean; fetcher?: Fetcher; now?: Date; store?: FxStore } = {}): Promise<FxRate> {
  const store = opts.store ?? GYMSHARK_STORE;
  const persist = opts.persist ?? true;
  const now = opts.now ?? new Date();
  const base = s.SOURCE_CURRENCY;
  const quote = s.TARGET_CURRENCY;
  const pair = `${base}/${quote}`;
  const maxAgeMs = s.MAX_EXCHANGE_RATE_AGE_HOURS * 3600_000;
  const none = (reason: string): FxRate => ({ ok: false, rate: null, base, quote, provider: null, providerUpdatedAt: null, fetchedAt: null, origin: "none", reason });
  const prev = lastGood(store, base, quote);

  if (s.FX_PROVIDER === "manual") {
    const rate = s.MANUAL_EXCHANGE_RATE;
    if (!(rate > 0)) return none("FX_PROVIDER=manual but MANUAL_EXCHANGE_RATE is not set");
    const [lo, hi] = SANE[pair] ?? [0, Number.POSITIVE_INFINITY];
    if (rate < lo || rate > hi) return none(`MANUAL_EXCHANGE_RATE ${rate} is outside the plausible ${pair} range ${lo}–${hi}`);
    // the clock starts when the owner last saved the rate (dashboard / CLI), else at this value's first use
    const confirmed = store.getState("manual_rate_confirmed_at");
    const firstUse = prev && prev.provider === "manual" && prev.rate === rate ? prev.fetched_at : now.toISOString();
    const since = confirmed && confirmed > firstUse ? confirmed : firstUse;
    if (persist && firstUse === now.toISOString()) record(store, "manual", base, quote, rate, now.toISOString(), since, true, null);
    if (now.getTime() - new Date(since).getTime() > maxAgeMs) {
      return none(`manual rate ${rate} was set ${since} - older than MAX_EXCHANGE_RATE_AGE_HOURS (${s.MAX_EXCHANGE_RATE_AGE_HOURS}); re-confirm it in the dashboard`);
    }
    return { ok: true, rate, base, quote, provider: "manual", providerUpdatedAt: since, fetchedAt: since, origin: "manual" };
  }

  let failure: string;
  try {
    const r = await fetchProviderRate(s.FX_PROVIDER, base, quote, opts.fetcher);
    const lagOk = !r.providerUpdatedAt || now.getTime() - new Date(r.providerUpdatedAt).getTime() <= MAX_PROVIDER_LAG_HOURS * 3600_000;
    const invalid = !lagOk ? `provider data is from ${r.providerUpdatedAt} (older than ${MAX_PROVIDER_LAG_HOURS}h)` : validateRate(pair, r.rate, prev?.rate ?? null);
    if (!invalid) {
      if (persist) record(store, s.FX_PROVIDER, base, quote, r.rate, r.providerUpdatedAt, now.toISOString(), true, null);
      log.info("fx", `${pair} = ${r.rate} from ${s.FX_PROVIDER} (provider time ${r.providerUpdatedAt ?? "n/a"})`);
      return { ok: true, rate: r.rate, base, quote, provider: s.FX_PROVIDER, providerUpdatedAt: r.providerUpdatedAt, fetchedAt: now.toISOString(), origin: "live" };
    }
    failure = invalid;
    if (persist) record(store, s.FX_PROVIDER, base, quote, r.rate, r.providerUpdatedAt, now.toISOString(), false, invalid);
  } catch (e) {
    failure = `${s.FX_PROVIDER} unavailable: ${errMsg(e)}`;
    if (persist) record(store, s.FX_PROVIDER, base, quote, null, null, now.toISOString(), false, failure);
  }
  log.warn("fx", failure);

  if (prev && prev.provider !== "manual" && now.getTime() - new Date(prev.fetched_at).getTime() <= maxAgeMs) {
    const reason = `${failure}; using last valid rate ${prev.rate} from ${prev.provider} obtained ${prev.fetched_at} (within ${s.MAX_EXCHANGE_RATE_AGE_HOURS}h)`;
    log.warn("fx", reason);
    return { ok: true, rate: prev.rate, base, quote, provider: prev.provider, providerUpdatedAt: prev.provider_updated_at, fetchedAt: prev.fetched_at, origin: "cached", reason };
  }
  return none(`${failure}; no valid rate obtained within the last ${s.MAX_EXCHANGE_RATE_AGE_HOURS}h - price updates paused`);
}
