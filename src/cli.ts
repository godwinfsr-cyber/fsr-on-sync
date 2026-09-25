import { SETTING_KEYS, type Settings } from "./config.ts";
import { currentLock, db, getSettings, releaseLock, setSetting } from "./db.ts";
import { formatReport, nextScheduledAt, runSync } from "./sync.ts";

const [cmd = "help", ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  switch (cmd) {
    case "sync": {
      const dryRun = flag("--dry-run") ? true : flag("--live") ? false : undefined;
      const limit = opt("--limit") != null ? Number(opt("--limit")) : undefined;
      const skus = opt("--skus")?.split(",").map((x) => x.trim()).filter(Boolean);
      const s = await runSync({ dryRun, limit, skus, trigger: opt("--trigger") ?? "manual" });
      process.stdout.write(formatReport(s));
      process.exitCode = s.status === "failed" || s.status === "aborted" ? 1 : 0;
      break;
    }
    case "tick": {
      // Called by the OS scheduler (e.g. hourly). Runs a sync only if due, not paused, and not already running.
      const settings = getSettings();
      if (settings.SYNC_PAUSED) return console.log("tick: sync is paused");
      if (currentLock()) return console.log("tick: a sync is already running");
      const next = nextScheduledAt(settings);
      if (next && new Date(next).getTime() > Date.now()) return console.log(`tick: next sync due ${next}`);
      const s = await runSync({ trigger: "scheduler" });
      console.log(`tick: ${s.syncId} ${s.status} (${s.mode})`);
      break;
    }
    case "status": {
      const settings = getSettings();
      const last = db.prepare("SELECT id, started_at, status, mode, summary_json FROM sync_runs ORDER BY started_at DESC LIMIT 1").get() as { id: string; started_at: string; status: string; mode: string } | undefined;
      const lastOk = db.prepare("SELECT id, started_at FROM sync_runs WHERE status IN ('success','partial') AND mode = 'live' ORDER BY started_at DESC LIMIT 1").get();
      const counts = db.prepare("SELECT last_sync_status AS s, COUNT(*) AS n FROM products GROUP BY last_sync_status").all();
      console.log(JSON.stringify({ paused: settings.SYNC_PAUSED, dryRun: settings.DRY_RUN, running: currentLock(), lastRun: last ?? null, lastSuccessfulLiveSync: lastOk ?? null, nextScheduledSync: nextScheduledAt(settings), productStatuses: counts }, null, 2));
      break;
    }
    case "pause": setSetting("SYNC_PAUSED", true); console.log("sync paused"); break;
    case "resume": setSetting("SYNC_PAUSED", false); console.log("sync resumed"); break;
    case "set": {
      const [key, value] = args;
      if (!key || value === undefined || !(SETTING_KEYS as string[]).includes(key)) throw new Error(`usage: set <${SETTING_KEYS.join("|")}> <value>`);
      setSetting(key as keyof Settings, value);
      console.log(`${key} = ${getSettings()[key as keyof Settings]}`);
      break;
    }
    case "settings": console.log(JSON.stringify(getSettings(), null, 2)); break;
    case "pin-settings": {
      // Store every effective setting in the database, so a machine without .env (e.g. the cloud runner) behaves identically.
      const cur = getSettings();
      for (const k of SETTING_KEYS) setSetting(k, cur[k]);
      console.log(`pinned ${SETTING_KEYS.length} settings in the database`);
      break;
    }
    case "unlock": {
      // Only for runners that already guarantee a single run at a time (GitHub Actions concurrency group).
      releaseLock();
      console.log("lock cleared");
      break;
    }
    case "checkpoint": {
      // Fold the SQLite write-ahead log into the main file so the single .sqlite file can be committed.
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      console.log("database checkpointed");
      break;
    }
    case "runs": {
      console.table(db.prepare("SELECT id, mode, trigger, status, started_at, duration_ms FROM sync_runs ORDER BY started_at DESC LIMIT 20").all());
      break;
    }
    default:
      console.log(`on-sync commands:
  sync [--dry-run|--live] [--limit N] [--skus A,B]   run a sync now (defaults from settings: DRY_RUN, SYNC_LIMIT)
  tick                                  scheduler entry point: syncs only when due / not paused
  status | settings | runs              inspect state
  pause | resume                        stop / restart scheduled syncs
  set <KEY> <VALUE>                     change a setting (stored in the database)`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
