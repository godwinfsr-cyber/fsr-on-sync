import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.ts";
import type { FeedEntry } from "./normalize.ts";

export interface FeedManifest {
  run: string; harvestedAt: string | null; startedAt: string; complete: boolean; listed: number; fetched: number; parsed: number; gone: number; failed: number;
  entries: number; stoppedReason: string | null; errors?: { url: string; message: string }[]; source: string;
  split?: { missing: number; existing: number; sitemapTotal: number; excluded: number };
}

const abs = (dir: string) => (path.isAbsolute(dir) ? dir : path.join(ROOT, dir));

/** One saved `coachHarvestExport(from, to)` result (raw JSON, or the browser tool's [{type,text}] wrapper). */
export function readExport(file: string): { manifest: FeedManifest; entries: FeedEntry[] } {
  const raw = fs.readFileSync(file, "utf8");
  let text = raw;
  if (/^\s*\[\s*\{\s*"type"/.test(raw)) text = (JSON.parse(raw) as { text: string }[])[0].text.replace(/\n\n\(captured at origin[^)]*\)\s*$/, "");
  let v: unknown = JSON.parse(text);
  if (typeof v === "string") v = JSON.parse(v);
  const { manifest, entries, error } = v as { manifest?: FeedManifest; entries?: FeedEntry[]; error?: string };
  if (error) throw new Error(`harvest export: ${error}`);
  if (!manifest || !Array.isArray(entries)) throw new Error(`${file}: not a Coach harvest export (expected {manifest, entries})`);
  for (const e of entries) if (typeof e.url !== "string" || (!e.gone && !Array.isArray(e.ld))) throw new Error(`${file}: bad entry ${String(e.url)}`);
  return { manifest, entries };
}

/** Writes the harvested chunks (all from one harvest run) as the feed. Refuses mixed runs or a gap in the chunks. */
export function writeFeed(files: string[], feedDir: string): { manifest: FeedManifest; entries: number; dir: string } {
  const parts = files.map(readExport).sort((a, b) => ((a.manifest as unknown as { from: number }).from ?? 0) - ((b.manifest as unknown as { from: number }).from ?? 0));
  const run = parts[0].manifest.run;
  if (parts.some((p) => p.manifest.run !== run)) throw new Error("chunks come from different harvest runs");
  const entries: FeedEntry[] = [];
  for (const p of parts) {
    const from = (p.manifest as unknown as { from: number }).from ?? 0;
    if (from !== entries.length) throw new Error(`chunk starting at ${from} does not follow ${entries.length} (missing or duplicated chunk)`);
    entries.push(...p.entries);
  }
  const manifest = { ...parts[0].manifest };
  if (entries.length !== manifest.entries) throw new Error(`harvest has ${manifest.entries} entries, chunks hold ${entries.length}`);
  // each harvest pass is kept in its own folder (pass 1: every style page; pass 2: own pages of products that pass 1 only
  // saw as variants on another style's page); the importer reads all of them together
  const dir = path.join(abs(feedDir), "runs", run);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^(part-\d+|manifest)\.json$/.test(f)) fs.rmSync(path.join(dir, f));
  for (let i = 0; i * 100 < entries.length; i++) fs.writeFileSync(path.join(dir, `part-${String(i).padStart(5, "0")}.json`), JSON.stringify(entries.slice(i * 100, i * 100 + 100)));
  delete (manifest as unknown as { from?: number }).from;
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { manifest, entries: entries.length, dir };
}

function readRun(dir: string): { manifest: FeedManifest; entries: FeedEntry[] } {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as FeedManifest;
  const entries: FeedEntry[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^part-\d+\.json$/.test(x)).sort()) entries.push(...(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as FeedEntry[]));
  if (entries.length !== manifest.entries) throw new Error(`feed ${manifest.run} is inconsistent: manifest says ${manifest.entries} entries, parts hold ${entries.length}`);
  return { manifest, entries };
}

/** All harvest passes together. The combined manifest is complete only if every pass is. */
export function readFeed(feedDir: string): { manifest: FeedManifest; entries: FeedEntry[] } {
  const root = path.join(abs(feedDir), "runs");
  const runs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "manifest.json"))).sort() : [];
  if (!runs.length) throw new Error(`no Coach feed at ${root} - run the browser harvest first`);
  const parts = runs.map((r) => readRun(path.join(root, r))).sort((a, b) => String(a.manifest.startedAt).localeCompare(String(b.manifest.startedAt)));
  const entries = parts.flatMap((p) => p.entries);
  const m0 = parts[0].manifest;
  const manifest: FeedManifest = {
    ...m0, run: parts.map((p) => p.manifest.run).join("+"), harvestedAt: parts.at(-1)!.manifest.harvestedAt, complete: parts.every((p) => p.manifest.complete),
    listed: parts.reduce((a, p) => a + p.manifest.listed, 0), fetched: parts.reduce((a, p) => a + p.manifest.fetched, 0), parsed: parts.reduce((a, p) => a + p.manifest.parsed, 0),
    gone: parts.reduce((a, p) => a + p.manifest.gone, 0), failed: parts.reduce((a, p) => a + p.manifest.failed, 0), entries: entries.length,
    stoppedReason: parts.map((p) => p.manifest.stoppedReason).filter(Boolean).join("; ") || null,
  };
  const dir = abs(feedDir);
  // extra test pages (e.g. watch pages kept only to prove the exclusion) live in tests/*.json next to the feed
  const extra = path.join(dir, "tests");
  if (fs.existsSync(extra)) for (const f of fs.readdirSync(extra).filter((x) => x.endsWith(".json")).sort()) entries.push(...readExport(path.join(extra, f)).entries);
  return { manifest, entries };
}
