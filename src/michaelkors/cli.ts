import { Logger } from "../logger.ts";
import { getExchangeRate } from "../gymshark/fx.ts";
import { BRAND_AUTHORIZATION, MICHAEL_KORS_AUTHORIZED_IMPORTER, MK_KEYS, type MkSettings } from "./config.ts";
import { currentMLock, getMkSettings, getMState, mdb, releaseMLock, setMkSetting } from "./db.ts";
import { importBrowserHarvest } from "./feed-import.ts";
import { activateImported, formatMkReport, nextMkScheduledAt, runMkSync } from "./sync.ts";

const [cmd = "help", ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  switch (cmd) {
    case "sync": {
      const dryRun = flag("--dry-run") ? true : flag("--live") ? false : undefined;
      const limit = opt("--limit") != null ? Number(opt("--limit")) : undefined;
      const styles = opt("--styles")?.split(",").map((x) => x.trim()).filter(Boolean);
      const s = await runMkSync({ dryRun, limit, styles, trigger: opt("--trigger") ?? "manual" });
      process.stdout.write(formatMkReport(s));
      process.exitCode = s.status === "failed" || s.status === "aborted" ? 1 : 0;
      break;
    }
    case "tick": {
      // OS / CI scheduler entry: syncs only when due, not paused and not already running.
      const settings = getMkSettings();
      if (settings.SYNC_PAUSED) return console.log("tick: Michael Kors sync is paused");
      if (currentMLock()) return console.log("tick: a Michael Kors sync is already running");
      const next = nextMkScheduledAt(settings);
      if (next && new Date(next).getTime() > Date.now()) return console.log(`tick: next Michael Kors sync due ${next}`);
      const s = await runMkSync({ trigger: "scheduler" });
      console.log(`tick: ${s.syncId} ${s.status} (${s.mode})`);
      break;
    }
    case "fx": {
      // fetch + validate the current rate now (recorded in fx_rates) and show recent history
      const r = await getExchangeRate(getMkSettings(), new Logger(null, { db: mdb, name: "michaelkors-fx" }), { store: { db: mdb, getState: getMState } });
      console.log(JSON.stringify(r, null, 2));
      console.table(mdb.prepare("SELECT provider, rate, provider_updated_at, fetched_at, ok, error FROM fx_rates ORDER BY fetched_at DESC LIMIT 10").all());
      break;
    }
    case "status": {
      const settings = getMkSettings();
      const last = mdb.prepare("SELECT id, started_at, status, mode FROM sync_runs ORDER BY started_at DESC LIMIT 1").get();
      const lastOk = mdb.prepare("SELECT id, started_at FROM sync_runs WHERE status IN ('success','partial') AND mode = 'live' ORDER BY started_at DESC LIMIT 1").get();
      const counts = mdb.prepare("SELECT last_sync_status AS s, COUNT(*) AS n FROM products GROUP BY last_sync_status").all();
      const fx = mdb.prepare("SELECT provider, rate, fetched_at FROM fx_rates WHERE ok = 1 ORDER BY fetched_at DESC LIMIT 1").get();
      console.log(JSON.stringify({ paused: settings.SYNC_PAUSED, dryRun: settings.DRY_RUN, limit: settings.SYNC_LIMIT, running: currentMLock(), lastRun: last ?? null, lastSuccessfulLiveSync: lastOk ?? null, nextScheduledSync: nextMkScheduledAt(settings), lastValidExchangeRate: fx ?? null, productStatuses: counts }, null, 2));
      break;
    }
    case "pause": setMkSetting("SYNC_PAUSED", true); console.log("Michael Kors sync paused"); break;
    case "resume": setMkSetting("SYNC_PAUSED", false); console.log("Michael Kors sync resumed"); break;
    case "set": {
      const [key, value] = args;
      if (!key || value === undefined || !(MK_KEYS as string[]).includes(key)) throw new Error(`usage: set <${MK_KEYS.join("|")}> <value>`);
      setMkSetting(key as keyof MkSettings, value);
      console.log(`${key} = ${getMkSettings()[key as keyof MkSettings]}`);
      break;
    }
    case "feed-import": {
      const file = args[0];
      if (!file) throw new Error("usage: feed-import <saved mkHarvestExport() result file>");
      const r = importBrowserHarvest(file, getMkSettings().FEED_DIR);
      console.log(JSON.stringify({ applied: r.applied, dir: r.dir, manifest: r.manifest }, null, 2));
      if (!r.applied) process.exitCode = 1;
      break;
    }
    case "activate": console.log(JSON.stringify(await activateImported(), null, 2)); break;
    case "authorization": console.log(JSON.stringify({ MICHAEL_KORS_AUTHORIZED_IMPORTER, BRAND_AUTHORIZATION }, null, 2)); break;
    case "excluded": console.table(mdb.prepare("SELECT style_code, title, import_status, exclusion_level, skip_reason, source_url FROM products WHERE import_status IN ('watch_excluded','skipped') ORDER BY import_status, style_code").all()); break;
    case "settings": console.log(JSON.stringify(getMkSettings(), null, 2)); break;
    case "unlock": releaseMLock(); console.log("lock cleared"); break;
    case "checkpoint": mdb.exec("PRAGMA wal_checkpoint(TRUNCATE)"); console.log("database checkpointed"); break;
    case "runs": console.table(mdb.prepare("SELECT id, mode, trigger, status, started_at, duration_ms FROM sync_runs ORDER BY started_at DESC LIMIT 20").all()); break;
    case "prices": console.table(mdb.prepare("SELECT * FROM price_history ORDER BY changed_at DESC LIMIT 50").all()); break;
    default:
      console.log(`michaelkors-sync commands (node src/michaelkors/cli.ts <cmd>):
  sync [--dry-run|--live] [--limit N] [--styles 40R5KAHE6L,32F1GJ6E7B]
                               run now (defaults: MK_DRY_RUN, MK_SYNC_LIMIT; N counts eligible styles)
  feed-import <file>           load a finished in-app-browser harvest into FEED_DIR (see harvest.browser.js)
  excluded                     products excluded as watches / other rules, with the reason
  authorization                show the Michael Kors brand authorization configuration
  tick                         scheduler entry: syncs only when due / not paused
  fx                           fetch + validate the USD/INR rate now, show recent rates
  status | settings | runs | prices
  pause | resume
  set <KEY> <VALUE>            change a setting (stored in the database)`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
