// COACH one-time import CLI (runs in the cloud: .github/workflows/coach-import.yml, manual trigger only).
//   node src/coach/cli.ts import --dry-run [--limit 50]      evaluate everything, write nothing
//   node src/coach/cli.ts import --limit 5 | --limit 25      create the first N missing products (test runs, DRAFT by default)
//   node src/coach/cli.ts import --full                      create every missing eligible product
//   node src/coach/cli.ts feed-import <export-chunk.json ...> save a browser harvest (harvest.browser.js) as data/coach-feed
import { cdb, setState } from "./db.ts";
import { writeFeed } from "./feed.ts";
import { formatReport, runCoachImport, type Mode } from "./importer.ts";
import { coachSettings } from "./config.ts";

const [cmd = "help", ...args] = process.argv.slice(2);
const flag = (n: string) => args.includes(n) || args.some((a) => a.startsWith(`${n}=`));
const opt = (n: string) => { const eq = args.find((a) => a.startsWith(`${n}=`)); if (eq) return eq.slice(n.length + 1); const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  switch (cmd) {
    case "import": {
      const limit = opt("--limit") != null ? Number(opt("--limit")) : undefined;
      if (limit != null && !(limit > 0)) throw new Error("--limit must be a positive number");
      const mode: Mode = flag("--dry-run") ? "dry-run" : flag("--full") ? "full" : limit != null ? "test" : (() => { throw new Error("choose --dry-run, --limit N or --full"); })();
      if (mode === "full" && limit != null) throw new Error("--full imports everything; use --limit N for a test run");
      const status = (opt("--status") as "ACTIVE" | "DRAFT" | undefined) ?? (mode === "test" ? "DRAFT" : undefined);
      const keys = opt("--keys")?.split(",").map((k) => k.trim()).filter(Boolean);
      const r = await runCoachImport({ mode, limit, status, keys, trigger: opt("--trigger") ?? "manual" });
      process.stdout.write(formatReport(r) + "\n");
      process.exitCode = r.status === "failed" || r.status === "aborted" ? 1 : 0;
      break;
    }
    case "feed-import": {
      const files = args.filter((a) => !a.startsWith("--"));
      if (!files.length) throw new Error("usage: feed-import <chunk.json> [...]");
      const r = writeFeed(files, coachSettings().FEED_DIR);
      console.log(`feed ${r.manifest.run}: ${r.entries} entries written to ${r.dir} (complete=${r.manifest.complete}, failed=${r.manifest.failed})`);
      break;
    }
    case "report": {
      const row = cdb.prepare("SELECT report_json FROM runs WHERE report_json IS NOT NULL ORDER BY started_at DESC LIMIT 1").get() as { report_json: string } | undefined;
      console.log(row ? formatReport(JSON.parse(row.report_json)) : "no runs yet");
      break;
    }
    case "status": console.table(cdb.prepare("SELECT status, COUNT(*) AS n FROM items GROUP BY status").all()); break;
    case "runs": console.table(cdb.prepare("SELECT id, mode, status, started_at, finished_at FROM runs ORDER BY started_at DESC LIMIT 20").all()); break;
    case "unlock": setState("lock", null); console.log("lock cleared"); break;
    case "checkpoint": cdb.exec("PRAGMA wal_checkpoint(TRUNCATE)"); console.log("database checkpointed"); break;
    default:
      console.log(`coach import (one-time, no scheduler) - node src/coach/cli.ts <cmd>
  import --dry-run [--limit N]     evaluate the whole catalog (or N products); no Shopify writes
  import --limit 5 | --limit 25    test run: create N missing products (DRAFT unless --status ACTIVE)
  import --full                    create every missing eligible product (ACTIVE, published)
         [--keys CV933-IMXAQ,...]  restrict to these Coach product references
  feed-import <chunk.json ...>     store a browser harvest as the feed (data/coach-feed)
  report | status | runs | unlock | checkpoint`);
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
