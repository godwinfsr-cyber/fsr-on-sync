import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.ts";
import type { FeedEntry, FeedManifest } from "./source.ts";

/**
 * Moves a finished in-app-browser harvest (the saved result of `mkHarvestExport()`, see harvest.browser.js) into
 * FEED_DIR. A complete harvest replaces the previous feed in one step; an incomplete one is kept aside in
 * FEED_DIR/incomplete/<run> and the previous feed stays in use.
 */
export function importBrowserHarvest(file: string, feedDir: string): { applied: boolean; manifest: FeedManifest; dir: string } {
  const raw = fs.readFileSync(file, "utf8");
  let text = raw;
  // the browser tool saves [{type:"text", text:"<JSON string literal>\n\n(captured at origin ...)"}, ...]
  if (/^\s*\[\s*\{\s*"type"/.test(raw)) text = (JSON.parse(raw) as { text: string }[])[0].text.replace(/\n\n\(captured at origin[^)]*\)\s*$/, "");
  let v: unknown = JSON.parse(text);
  if (typeof v === "string") v = JSON.parse(v);
  const { manifest, entries, error } = v as { manifest?: FeedManifest; entries?: FeedEntry[]; error?: string };
  if (error) throw new Error(`harvest export: ${error}`);
  if (!manifest || !Array.isArray(entries)) throw new Error("not a Michael Kors harvest export (expected {manifest, entries})");
  for (const e of entries) {
    if (typeof e.url !== "string" || !/^https:\/\/(www\.)?michaelkors\.com\//.test(e.url) || !Array.isArray(e.ld)) throw new Error(`bad entry ${String(e.url)}`);
  }
  const abs = path.isAbsolute(feedDir) ? feedDir : path.join(ROOT, feedDir);
  fs.mkdirSync(abs, { recursive: true });
  const write = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i * 100 < entries.length; i++) fs.writeFileSync(path.join(dir, `part-${String(i).padStart(5, "0")}.json`), JSON.stringify(entries.slice(i * 100, i * 100 + 100)));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ ...manifest, entries: entries.length }, null, 2));
  };
  if (!manifest.complete) {
    const dir = path.join(abs, "incomplete", manifest.run);
    write(dir);
    return { applied: false, manifest, dir };
  }
  const staging = path.join(abs, `.staging-${manifest.run}`);
  write(staging);
  for (const f of fs.readdirSync(abs)) if (/^(part-\d+|manifest)\.json$/.test(f)) fs.rmSync(path.join(abs, f));
  for (const f of fs.readdirSync(staging)) fs.renameSync(path.join(staging, f), path.join(abs, f));
  fs.rmSync(staging, { recursive: true, force: true });
  return { applied: true, manifest, dir: abs };
}
