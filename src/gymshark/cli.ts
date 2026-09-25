import { Logger } from "../logger.ts";
import { activateGymsharkDrafts } from "./activate.ts";
import { GYMSHARK_KEYS, type GymsharkSettings } from "./config.ts";
import { currentGLock, gdb, getGymsharkSettings, releaseGLock, setGymsharkSetting } from "./db.ts";
import { getExchangeRate } from "./fx.ts";
import { formatGymsharkReport, nextGymsharkScheduledAt, runGymsharkSync } from "./sync.ts";

const [cmd = "help", ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  switch (cmd) {
    case "sync": {
      const dryRun = flag("--dry-run") ? true : flag("--live") ? false : undefined;
      const limit = opt("--limit") != null ? Number(opt("--limit")) : undefined;
      const handles = opt("--handles")?.split(",").map((x) => x.trim()).filter(Boolean);
      const s = await runGymsharkSync({ dryRun, limit, handles, trigger: opt("--trigger") ?? "manual" });
      process.stdout.write(formatGymsharkReport(s));
      process.exitCode = s.status === "failed" || s.status === "aborted" ? 1 : 0;
      break;
    }
    case "tick": {
      // OS / CI scheduler entry: syncs only when due, not paused and not already running.
      const settings = getGymsharkSettings();
      if (settings.SYNC_PAUSED) return console.log("tick: Gymshark sync is paused");
      if (currentGLock()) return console.log("tick: a Gymshark sync is already running");
      const next = nextGymsharkScheduledAt(settings);
      if (next && new Date(next).getTime() > Date.now()) return console.log(`tick: next Gymshark sync due ${next}`);
      const s = await runGymsharkSync({ trigger: "scheduler" });
      console.log(`tick: ${s.syncId} ${s.status} (${s.mode})`);
      break;
    }
    case "fx": {
      // fetch + validate the current rate now (recorded in fx_rates) and show recent history
      const r = await getExchangeRate(getGymsharkSettings(), new Logger(null, { db: gdb, name: "gymshark-fx" }));
      console.log(JSON.stringify(r, null, 2));
      console.table(gdb.prepare("SELECT provider, rate, provider_updated_at, fetched_at, ok, error FROM fx_rates ORDER BY fetched_at DESC LIMIT 10").all());
      break;
    }
    case "status": {
      const settings = getGymsharkSettings();
      const last = gdb.prepare("SELECT id, started_at, status, mode FROM sync_runs ORDER BY started_at DESC LIMIT 1").get();
      const lastOk = gdb.prepare("SELECT id, started_at FROM sync_runs WHERE status IN ('success','partial') AND mode = 'live' ORDER BY started_at DESC LIMIT 1").get();
      const counts = gdb.prepare("SELECT last_sync_status AS s, COUNT(*) AS n FROM products GROUP BY last_sync_status").all();
      const fx = gdb.prepare("SELECT provider, rate, fetched_at FROM fx_rates WHERE ok = 1 ORDER BY fetched_at DESC LIMIT 1").get();
      console.log(JSON.stringify({ paused: settings.SYNC_PAUSED, dryRun: settings.DRY_RUN, limit: settings.SYNC_LIMIT, running: currentGLock(), lastRun: last ?? null, lastSuccessfulLiveSync: lastOk ?? null, nextScheduledSync: nextGymsharkScheduledAt(settings), lastValidExchangeRate: fx ?? null, productStatuses: counts }, null, 2));
      break;
    }
    case "activate-drafts": {
      // one-off go-live: DRAFT -> ACTIVE + publish (sold-out products stay hidden); --dry-run only counts
      const r = await activateGymsharkDrafts(new Logger(null, { db: gdb, name: "gymshark-activate" }), { dryRun: flag("--dry-run") });
      console.log(JSON.stringify({ ...r, failed: r.failed.slice(0, 20), failedCount: r.failed.length }, null, 2));
      process.exitCode = r.failed.length ? 1 : 0;
      break;
    }
    case "pause": setGymsharkSetting("SYNC_PAUSED", true); console.log("Gymshark sync paused"); break;
    case "resume": setGymsharkSetting("SYNC_PAUSED", false); console.log("Gymshark sync resumed"); break;
    case "set": {
      const [key, value] = args;
      if (!key || value === undefined || !(GYMSHARK_KEYS as string[]).includes(key)) throw new Error(`usage: set <${GYMSHARK_KEYS.join("|")}> <value>`);
      setGymsharkSetting(key as keyof GymsharkSettings, value);
      console.log(`${key} = ${getGymsharkSettings()[key as keyof GymsharkSettings]}`);
      break;
    }
    case "settings": console.log(JSON.stringify(getGymsharkSettings(), null, 2)); break;
    case "unlock": releaseGLock(); console.log("lock cleared"); break;
    case "checkpoint": gdb.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)"); console.log("database checkpointed + compacted"); break;
    case "runs": console.table(gdb.prepare("SELECT id, mode, trigger, status, started_at, duration_ms FROM sync_runs ORDER BY started_at DESC LIMIT 20").all()); break;
    case "prices": console.table(gdb.prepare("SELECT * FROM price_history ORDER BY changed_at DESC LIMIT 50").all()); break;
    default:
      console.log(`gymshark-sync commands (node src/gymshark/cli.ts <cmd>):
  sync [--dry-run|--live] [--limit N] [--handles gymshark-legacy-t-shirt-black-aw23,...]
                               run now (defaults: GYMSHARK_DRY_RUN, GYMSHARK_SYNC_LIMIT; N counts styles)
  tick                         scheduler entry: syncs only when due / not paused
  fx                           fetch + validate the USD/INR rate now, show recent rates
  status | settings | runs | prices
  activate-drafts [--dry-run]  make every Gymshark DRAFT (except sold-out) ACTIVE + publish it
  pause | resume
  set <KEY> <VALUE>            change a setting (stored in the database)`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
