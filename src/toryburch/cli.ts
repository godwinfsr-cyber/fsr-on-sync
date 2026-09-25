import { Logger } from "../logger.ts";
import { getExchangeRate } from "../gymshark/fx.ts";
import { BRAND_AUTHORIZATION, TB_KEYS, TB_PRICING_DEFAULTS, TORY_BURCH_AUTHORIZED_IMPORTER, type TbSettings } from "./config.ts";
import { currentTLock, getTbSettings, getTState, releaseTLock, setTbSetting, tdb } from "./db.ts";
import { formatTbReport, nextTbScheduledAt, runTbSync } from "./sync.ts";

const [cmd = "help", ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  switch (cmd) {
    case "sync": {
      const dryRun = flag("--dry-run") ? true : flag("--live") ? false : undefined;
      const limit = opt("--limit") != null ? Number(opt("--limit")) : undefined;
      const styles = opt("--styles")?.split(",").map((x) => x.trim()).filter(Boolean);
      const s = await runTbSync({ dryRun, limit, styles, trigger: opt("--trigger") ?? "manual" });
      process.stdout.write(formatTbReport(s));
      process.exitCode = s.status === "failed" || s.status === "aborted" ? 1 : 0;
      break;
    }
    case "tick": {
      // OS scheduler entry (scripts/install-scheduler.ps1, hourly): syncs only when due, enabled, not paused and not already running.
      const settings = getTbSettings();
      if (!settings.ENABLED) return console.log("tick: Tory Burch sync is disabled (TORY_BURCH_ENABLED=false)");
      if (settings.SYNC_PAUSED) return console.log("tick: Tory Burch sync is paused");
      if (currentTLock()) return console.log("tick: a Tory Burch sync is already running");
      const next = nextTbScheduledAt(settings);
      if (next && new Date(next).getTime() > Date.now()) return console.log(`tick: next Tory Burch sync due ${next}`);
      const s = await runTbSync({ trigger: "scheduler" });
      console.log(`tick: ${s.syncId} ${s.status} (${s.mode})`);
      break;
    }
    case "fx": {
      const r = await getExchangeRate(getTbSettings(), new Logger(null, { db: tdb, name: "toryburch-fx" }), { store: { db: tdb, getState: getTState } });
      console.log(JSON.stringify(r, null, 2));
      console.table(tdb.prepare("SELECT provider, rate, provider_updated_at, fetched_at, ok, error FROM fx_rates ORDER BY fetched_at DESC LIMIT 10").all());
      break;
    }
    case "status": {
      const settings = getTbSettings();
      const last = tdb.prepare("SELECT id, started_at, status, mode FROM sync_runs ORDER BY started_at DESC LIMIT 1").get();
      const lastOk = tdb.prepare("SELECT id, started_at FROM sync_runs WHERE status IN ('success','partial') AND mode = 'live' ORDER BY started_at DESC LIMIT 1").get();
      const counts = tdb.prepare("SELECT last_sync_status AS s, COUNT(*) AS n FROM products GROUP BY last_sync_status").all();
      const fx = tdb.prepare("SELECT provider, rate, fetched_at FROM fx_rates WHERE ok = 1 ORDER BY fetched_at DESC LIMIT 1").get();
      console.log(JSON.stringify({ enabled: settings.ENABLED, paused: settings.SYNC_PAUSED, dryRun: settings.DRY_RUN, limit: settings.SYNC_LIMIT, running: currentTLock(), lastRun: last ?? null, lastSuccessfulLiveSync: lastOk ?? null, nextScheduledSync: nextTbScheduledAt(settings), lastValidExchangeRate: fx ?? null, productStatuses: counts }, null, 2));
      break;
    }
    case "pause": setTbSetting("SYNC_PAUSED", true); console.log("Tory Burch sync paused"); break;
    case "resume": setTbSetting("SYNC_PAUSED", false); console.log("Tory Burch sync resumed"); break;
    case "set": {
      const [key, value] = args;
      if (!key || value === undefined || !(TB_KEYS as string[]).includes(key)) throw new Error(`usage: set <${TB_KEYS.join("|")}> <value>`);
      setTbSetting(key as keyof TbSettings, value);
      console.log(`${key} = ${getTbSettings()[key as keyof TbSettings]}`);
      break;
    }
    case "pricing": {
      const s = getTbSettings();
      console.log(JSON.stringify({ defaults: TB_PRICING_DEFAULTS, active: { WEIGHT_BANDS: s.WEIGHT_BANDS, WEIGHT_SURCHARGE_FALLBACK_INR: s.WEIGHT_SURCHARGE_FALLBACK_INR, PROFIT_BANDS: s.PROFIT_BANDS, SOURCE_PRICE_BASIS: s.SOURCE_PRICE_BASIS, FX_PROVIDER: s.FX_PROVIDER, MAX_EXCHANGE_RATE_AGE_HOURS: s.MAX_EXCHANGE_RATE_AGE_HOURS } }, null, 2));
      break;
    }
    case "authorization": console.log(JSON.stringify({ TORY_BURCH_AUTHORIZED_IMPORTER, BRAND_AUTHORIZATION }, null, 2)); break;
    case "excluded": console.table(tdb.prepare("SELECT style_code, title, import_status, exclusion_level, skip_reason, source_url FROM products WHERE import_status IN ('watch_excluded','skipped') ORDER BY import_status, style_code").all()); break;
    case "settings": console.log(JSON.stringify(getTbSettings(), null, 2)); break;
    case "unlock": releaseTLock(); console.log("lock cleared"); break;
    case "checkpoint": tdb.exec("PRAGMA wal_checkpoint(TRUNCATE)"); console.log("database checkpointed"); break;
    case "runs": console.table(tdb.prepare("SELECT id, mode, trigger, status, started_at, duration_ms FROM sync_runs ORDER BY started_at DESC LIMIT 20").all()); break;
    case "prices": console.table(tdb.prepare("SELECT * FROM price_history ORDER BY changed_at DESC LIMIT 50").all()); break;
    default:
      console.log(`toryburch-sync commands (node src/toryburch/cli.ts <cmd>):
  sync [--dry-run|--live] [--limit N] [--styles 135634,141183]
                               run now (defaults: TORY_BURCH_DRY_RUN, TORY_BURCH_SYNC_LIMIT; N counts eligible styles)
  excluded                     products excluded as watches / other rules, with the reason
  authorization                show the Tory Burch importer authorization configuration
  pricing                      show the shipping + profit bands in use
  tick                         scheduler entry: syncs only when due / enabled / not paused
  fx                           fetch + validate the USD/INR rate now, show recent rates
  status | settings | runs | prices
  pause | resume
  set <KEY> <VALUE>            change a setting (stored in the database)`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
