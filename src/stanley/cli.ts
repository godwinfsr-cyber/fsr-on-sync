import { Logger } from "../logger.ts";
import { getExchangeRate } from "../gymshark/fx.ts";
import { STANLEY_KEYS, effectiveLimit, type StanleySettings } from "./config.ts";
import { STANLEY_FX_STORE, currentSLock, getStanleySettings, releaseSLock, sdb, setStanleySetting } from "./db.ts";
import { formatStanleyReport, nextStanleyScheduledAt, runStanleySync } from "./sync.ts";

const [cmd = "help", ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  switch (cmd) {
    case "sync": {
      const dryRun = flag("--dry-run") ? true : flag("--live") ? false : undefined;
      const limit = opt("--limit") != null ? Number(opt("--limit")) : undefined;
      if (limit === 0 && !flag("--full")) throw new Error("--limit 0 means the whole catalog: add --full to confirm (or set STANLEY_FULL_SYNC=true and STANLEY_TEST_MODE=false)");
      const products = opt("--products")?.split(",").map((x) => x.trim()).filter(Boolean);
      const s = await runStanleySync({ dryRun, limit, products, trigger: opt("--trigger") ?? "manual" });
      process.stdout.write(formatStanleyReport(s));
      process.exitCode = s.status === "failed" || s.status === "aborted" ? 1 : 0;
      break;
    }
    case "tick": {
      // OS scheduler entry: syncs only when enabled, due, not paused and not already running.
      const settings = getStanleySettings();
      if (!settings.ENABLED) return console.log("tick: Stanley sync is disabled (STANLEY_ENABLED=false)");
      if (settings.SYNC_PAUSED) return console.log("tick: Stanley sync is paused");
      if (currentSLock()) return console.log("tick: a Stanley sync is already running");
      const next = nextStanleyScheduledAt(settings);
      if (next && new Date(next).getTime() > Date.now()) return console.log(`tick: next Stanley sync due ${next}`);
      const s = await runStanleySync({ trigger: "scheduler" });
      console.log(`tick: ${s.syncId} ${s.status} (${s.mode}, limit ${s.limit || "none"})`);
      break;
    }
    case "fx": {
      const r = await getExchangeRate(getStanleySettings(), new Logger(null, { db: sdb, name: "stanley-fx" }), { store: STANLEY_FX_STORE });
      console.log(JSON.stringify(r, null, 2));
      console.table(sdb.prepare("SELECT provider, rate, provider_updated_at, fetched_at, ok, error FROM fx_rates ORDER BY fetched_at DESC LIMIT 10").all());
      break;
    }
    case "status": {
      const settings = getStanleySettings();
      const last = sdb.prepare("SELECT id, started_at, status, mode FROM sync_runs ORDER BY started_at DESC LIMIT 1").get();
      const lastOk = sdb.prepare("SELECT id, started_at FROM sync_runs WHERE status IN ('success','partial') AND mode = 'live' ORDER BY started_at DESC LIMIT 1").get();
      const counts = sdb.prepare("SELECT last_sync_status AS s, COUNT(*) AS n FROM products GROUP BY last_sync_status").all();
      const fx = sdb.prepare("SELECT provider, rate, fetched_at FROM fx_rates WHERE ok = 1 ORDER BY fetched_at DESC LIMIT 1").get();
      console.log(JSON.stringify({
        enabled: settings.ENABLED, paused: settings.SYNC_PAUSED, dryRun: settings.DRY_RUN, testMode: settings.TEST_MODE, fullSync: settings.FULL_SYNC, productsPerRun: effectiveLimit(settings) || "full catalog",
        pricingAdjustmentInr: settings.PRICING_ADJUSTMENT_INR, authorizedImporter: settings.AUTHORIZED_IMPORTER, eta: settings.ETA,
        running: currentSLock(), lastRun: last ?? null, lastSuccessfulLiveSync: lastOk ?? null, nextScheduledSync: nextStanleyScheduledAt(settings), lastValidExchangeRate: fx ?? null, productStatuses: counts,
      }, null, 2));
      break;
    }
    case "pause": setStanleySetting("SYNC_PAUSED", true); console.log("Stanley sync paused"); break;
    case "resume": setStanleySetting("SYNC_PAUSED", false); console.log("Stanley sync resumed"); break;
    case "set": {
      const [key, value] = args;
      if (!key || value === undefined || !(STANLEY_KEYS as string[]).includes(key)) throw new Error(`usage: set <${STANLEY_KEYS.join("|")}> <value>`);
      setStanleySetting(key as keyof StanleySettings, value);
      console.log(`${key} = ${getStanleySettings()[key as keyof StanleySettings]}`);
      break;
    }
    case "settings": console.log(JSON.stringify(getStanleySettings(), null, 2)); break;
    case "unlock": releaseSLock(); console.log("lock cleared"); break;
    case "checkpoint": sdb.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)"); console.log("database checkpointed + compacted"); break;
    case "runs": console.table(sdb.prepare("SELECT id, mode, trigger, status, started_at, duration_ms FROM sync_runs ORDER BY started_at DESC LIMIT 20").all()); break;
    case "prices": console.table(sdb.prepare("SELECT * FROM price_history ORDER BY changed_at DESC LIMIT 50").all()); break;
    default:
      console.log(`stanley-sync commands (node src/stanley/cli.ts <cmd>):
  sync [--dry-run|--live] [--limit N] [--products <handle|stanley id|title key>,...]
                               run now (defaults: STANLEY_DRY_RUN; products per run = STANLEY_TEST_PRODUCT_LIMIT
                               unless STANLEY_FULL_SYNC=true and STANLEY_TEST_MODE=false). --limit 0 --full = whole catalog
  tick                         scheduler entry: syncs only when enabled / due / not paused
  fx                           fetch + validate the USD/INR rate now, show recent rates
  status | settings | runs | prices
  pause | resume
  set <KEY> <VALUE>            change a setting (stored in the database)`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
