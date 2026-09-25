import { Logger } from "../logger.ts";
import { getExchangeRate } from "../gymshark/fx.ts";
import { ALO_KEYS, effectiveLimit, type AloSettings } from "./config.ts";
import { ALO_FX_STORE, adb, currentALock, getAloSettings, releaseALock, setAloSetting } from "./db.ts";
import { formatAloReport, nextAloScheduledAt, runAloSync } from "./sync.ts";

const [cmd = "help", ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  switch (cmd) {
    case "sync": {
      const dryRun = flag("--dry-run") ? true : flag("--live") ? false : undefined;
      const limit = opt("--limit") != null ? Number(opt("--limit")) : undefined;
      if (limit === 0 && !flag("--full")) throw new Error("--limit 0 means the whole catalog: add --full to confirm (or set ALO_FULL_SYNC=true and ALO_TEST_MODE=false)");
      const styles = opt("--styles")?.split(",").map((x) => x.trim()).filter(Boolean);
      const s = await runAloSync({ dryRun, limit, styles, trigger: opt("--trigger") ?? "manual" });
      process.stdout.write(formatAloReport(s));
      process.exitCode = s.status === "failed" || s.status === "aborted" ? 1 : 0;
      break;
    }
    case "tick": {
      // OS scheduler entry: syncs only when due, not paused and not already running.
      const settings = getAloSettings();
      if (settings.SYNC_PAUSED) return console.log("tick: ALO sync is paused");
      if (currentALock()) return console.log("tick: an ALO sync is already running");
      const next = nextAloScheduledAt(settings);
      if (next && new Date(next).getTime() > Date.now()) return console.log(`tick: next ALO sync due ${next}`);
      const s = await runAloSync({ trigger: "scheduler" });
      console.log(`tick: ${s.syncId} ${s.status} (${s.mode}, limit ${s.limit || "none"})`);
      break;
    }
    case "fx": {
      const r = await getExchangeRate(getAloSettings(), new Logger(null, { db: adb, name: "alo-fx" }), { store: ALO_FX_STORE });
      console.log(JSON.stringify(r, null, 2));
      console.table(adb.prepare("SELECT provider, rate, provider_updated_at, fetched_at, ok, error FROM fx_rates ORDER BY fetched_at DESC LIMIT 10").all());
      break;
    }
    case "status": {
      const settings = getAloSettings();
      const last = adb.prepare("SELECT id, started_at, status, mode FROM sync_runs ORDER BY started_at DESC LIMIT 1").get();
      const lastOk = adb.prepare("SELECT id, started_at FROM sync_runs WHERE status IN ('success','partial') AND mode = 'live' ORDER BY started_at DESC LIMIT 1").get();
      const counts = adb.prepare("SELECT last_sync_status AS s, COUNT(*) AS n FROM products GROUP BY last_sync_status").all();
      const fx = adb.prepare("SELECT provider, rate, fetched_at FROM fx_rates WHERE ok = 1 ORDER BY fetched_at DESC LIMIT 1").get();
      console.log(JSON.stringify({
        paused: settings.SYNC_PAUSED, dryRun: settings.DRY_RUN, testMode: settings.TEST_MODE, fullSync: settings.FULL_SYNC, stylesPerRun: effectiveLimit(settings) || "full catalog",
        running: currentALock(), lastRun: last ?? null, lastSuccessfulLiveSync: lastOk ?? null, nextScheduledSync: nextAloScheduledAt(settings), lastValidExchangeRate: fx ?? null, productStatuses: counts,
      }, null, 2));
      break;
    }
    case "pause": setAloSetting("SYNC_PAUSED", true); console.log("ALO sync paused"); break;
    case "resume": setAloSetting("SYNC_PAUSED", false); console.log("ALO sync resumed"); break;
    case "set": {
      const [key, value] = args;
      if (!key || value === undefined || !(ALO_KEYS as string[]).includes(key)) throw new Error(`usage: set <${ALO_KEYS.join("|")}> <value>`);
      setAloSetting(key as keyof AloSettings, value);
      console.log(`${key} = ${getAloSettings()[key as keyof AloSettings]}`);
      break;
    }
    case "settings": console.log(JSON.stringify(getAloSettings(), null, 2)); break;
    case "unlock": releaseALock(); console.log("lock cleared"); break;
    case "checkpoint": adb.exec("PRAGMA wal_checkpoint(TRUNCATE)"); console.log("database checkpointed"); break;
    case "runs": console.table(adb.prepare("SELECT id, mode, trigger, status, started_at, duration_ms FROM sync_runs ORDER BY started_at DESC LIMIT 20").all()); break;
    case "prices": console.table(adb.prepare("SELECT * FROM price_history ORDER BY changed_at DESC LIMIT 50").all()); break;
    default:
      console.log(`alo-sync commands (node src/alo/cli.ts <cmd>):
  sync [--dry-run|--live] [--limit N] [--styles W54234R,...]
                               run now (defaults: ALO_DRY_RUN; styles per run = ALO_TEST_PRODUCT_LIMIT
                               unless ALO_FULL_SYNC=true and ALO_TEST_MODE=false). --limit 0 --full = whole catalog
  tick                         scheduler entry: syncs only when due / not paused
  fx                           fetch + validate the USD/INR rate now, show recent rates
  status | settings | runs | prices
  pause | resume
  set <KEY> <VALUE>            change a setting (stored in the database)`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
