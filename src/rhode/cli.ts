import { Logger } from "../logger.ts";
import { getExchangeRate } from "../gymshark/fx.ts";
import { RHODE_KEYS, type RhodeSettings } from "./config.ts";
import { RHODE_FX_STORE, currentRLock, getRState, getRhodeSettings, rdb, releaseRLock, setRhodeSetting } from "./db.ts";
import { formatRhodeReport, nextRhodeScheduledAt, runRhodeSync } from "./sync.ts";

const [cmd = "help", ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  switch (cmd) {
    case "sync": {
      const dryRun = flag("--dry-run") ? true : flag("--live") ? false : undefined;
      const limit = opt("--limit") != null ? Number(opt("--limit")) : undefined;
      const handles = opt("--handles")?.split(",").map((x) => x.trim()).filter(Boolean);
      const s = await runRhodeSync({ dryRun, limit, handles, trigger: opt("--trigger") ?? "manual" });
      process.stdout.write(formatRhodeReport(s));
      process.exitCode = s.status === "failed" || s.status === "aborted" ? 1 : 0;
      break;
    }
    case "tick": {
      // Windows Task Scheduler entry (hourly): syncs only when enabled, due, not paused and not already running.
      const settings = getRhodeSettings();
      if (!settings.ENABLED) return console.log("tick: Rhode sync is disabled (RHODE_ENABLED=false)");
      if (settings.SYNC_PAUSED) return console.log("tick: Rhode sync is paused");
      if (currentRLock()) return console.log("tick: a Rhode sync is already running");
      const next = nextRhodeScheduledAt(settings);
      if (next && new Date(next).getTime() > Date.now()) return console.log(`tick: next Rhode sync due ${next}`);
      const s = await runRhodeSync({ trigger: "scheduler" });
      console.log(`tick: ${s.syncId} ${s.status} (${s.mode})`);
      break;
    }
    case "scheduled": {
      // Cloud (GitHub Actions) cron entry: the cron itself sets the 5-hour cadence, so no interval check here
      // (GitHub often starts runs a few minutes late); still honours RHODE_ENABLED and pause.
      const settings = getRhodeSettings();
      if (!settings.ENABLED) return console.log("scheduled: Rhode sync is disabled (RHODE_ENABLED=false)");
      if (settings.SYNC_PAUSED) return console.log("scheduled: Rhode sync is paused");
      const s = await runRhodeSync({ trigger: "scheduler" });
      process.stdout.write(formatRhodeReport(s));
      process.exitCode = s.status === "failed" || s.status === "aborted" ? 1 : 0;
      break;
    }
    case "fx": {
      const r = await getExchangeRate(getRhodeSettings(), new Logger(null, { db: rdb, name: "rhode-fx" }), { store: RHODE_FX_STORE });
      console.log(JSON.stringify(r, null, 2));
      console.table(rdb.prepare("SELECT provider, rate, provider_updated_at, fetched_at, ok, error FROM fx_rates ORDER BY fetched_at DESC LIMIT 10").all());
      break;
    }
    case "status": {
      const settings = getRhodeSettings();
      const last = rdb.prepare("SELECT id, started_at, status, mode FROM sync_runs ORDER BY started_at DESC LIMIT 1").get();
      const counts = rdb.prepare("SELECT last_sync_status AS s, COUNT(*) AS n FROM products GROUP BY last_sync_status").all();
      const fx = rdb.prepare("SELECT provider, rate, fetched_at FROM fx_rates WHERE ok = 1 ORDER BY fetched_at DESC LIMIT 1").get();
      console.log(JSON.stringify({
        enabled: settings.ENABLED, paused: settings.SYNC_PAUSED, dryRun: settings.DRY_RUN, limit: settings.SYNC_LIMIT || "full catalog", running: currentRLock(),
        lastRun: last ?? null, lastSuccessfulLiveSync: getRState("last_sync_at"), nextScheduledSync: nextRhodeScheduledAt(settings), lastValidExchangeRate: fx ?? null, productStatuses: counts,
      }, null, 2));
      break;
    }
    case "pause": setRhodeSetting("SYNC_PAUSED", true); console.log("Rhode sync paused"); break;
    case "resume": setRhodeSetting("SYNC_PAUSED", false); console.log("Rhode sync resumed"); break;
    case "set": {
      const [key, value] = args;
      if (!key || value === undefined || !(RHODE_KEYS as string[]).includes(key)) throw new Error(`usage: set <${RHODE_KEYS.join("|")}> <value>`);
      setRhodeSetting(key as keyof RhodeSettings, value);
      console.log(`${key} = ${getRhodeSettings()[key as keyof RhodeSettings]}`);
      break;
    }
    case "settings": console.log(JSON.stringify(getRhodeSettings(), null, 2)); break;
    case "unlock": releaseRLock(); console.log("lock cleared"); break;
    case "checkpoint": rdb.exec("PRAGMA wal_checkpoint(TRUNCATE)"); console.log("database checkpointed"); break;
    case "runs": console.table(rdb.prepare("SELECT id, mode, trigger, status, started_at, duration_ms FROM sync_runs ORDER BY started_at DESC LIMIT 20").all()); break;
    case "prices": console.table(rdb.prepare("SELECT * FROM price_history ORDER BY changed_at DESC LIMIT 50").all()); break;
    default:
      console.log(`rhode-sync commands (node src/rhode/cli.ts <cmd>):
  sync [--dry-run|--live] [--limit N] [--handles peptide-lip-tint-ribbon,...]
                               run now (defaults: RHODE_DRY_RUN, RHODE_SYNC_LIMIT; N counts FSR products)
  tick                         scheduler entry: syncs only when enabled / due / not paused
  fx                           fetch + validate the USD/INR rate now, show recent rates
  status | settings | runs | prices
  pause | resume
  set <KEY> <VALUE>            change a setting (stored in the database, overrides .env)`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
