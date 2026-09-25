import fs from "node:fs";
import path from "node:path";
import { LOG_DIR } from "./config.ts";
import { db } from "./db.ts";

type Level = "debug" | "info" | "warn" | "error";

// Anything that looks like a credential is scrubbed before it reaches disk or stdout.
const SECRET_PATTERNS: RegExp[] = [
  /shpat_[A-Za-z0-9]+/g, /shpss_[A-Za-z0-9]+/g, /shpca_[A-Za-z0-9]+/g, /shppa_[A-Za-z0-9]+/g, /atkn_[A-Za-z0-9._-]+/g,
  /("?(?:access_token|client_secret|password|cookie|authorization|x-shopify-access-token)"?\s*[:=]\s*)"?[^",\s}]+"?/gi,
];
export function redact(s: string): string {
  let out = s;
  for (const env of ["SHOPIFY_ADMIN_ACCESS_TOKEN", "SHOPIFY_CLIENT_SECRET"]) {
    const v = process.env[env];
    if (v && v.length > 6) out = out.split(v).join("[REDACTED]");
  }
  for (const p of SECRET_PATTERNS) out = out.replace(p, (_m, prefix) => (typeof prefix === "string" ? `${prefix}[REDACTED]` : "[REDACTED]"));
  return out;
}

export class Logger {
  syncId: string | null;
  private file: string;
  constructor(syncId: string | null) {
    this.syncId = syncId;
    this.file = path.join(LOG_DIR, `${syncId ?? "on-sync"}.jsonl`);
  }
  log(level: Level, stage: string, message: string, data?: Record<string, unknown>, sourceProductId?: string) {
    const ts = new Date().toISOString();
    const entry = { ts, level, syncId: this.syncId, stage, sourceProductId, message, ...(data ? { data } : {}) };
    const line = redact(JSON.stringify(entry));
    fs.appendFileSync(this.file, line + "\n");
    if (level !== "debug" || process.env.LOG_DEBUG) {
      const tag = level === "error" ? "ERROR" : level === "warn" ? "WARN " : "     ";
      process.stderr.write(redact(`${ts.slice(11, 19)} ${tag} [${stage}] ${sourceProductId ? sourceProductId + " " : ""}${message}`) + "\n");
    }
    if (this.syncId && level !== "debug") {
      db.prepare("INSERT INTO sync_events (sync_id, ts, level, stage, source_product_id, message, data_json) VALUES (?,?,?,?,?,?,?)")
        .run(this.syncId, ts, level, stage, sourceProductId ?? null, redact(message), data ? redact(JSON.stringify(data)) : null);
    }
  }
  debug(stage: string, msg: string, data?: Record<string, unknown>, id?: string) { this.log("debug", stage, msg, data, id); }
  info(stage: string, msg: string, data?: Record<string, unknown>, id?: string) { this.log("info", stage, msg, data, id); }
  warn(stage: string, msg: string, data?: Record<string, unknown>, id?: string) { this.log("warn", stage, msg, data, id); }
  error(stage: string, msg: string, data?: Record<string, unknown>, id?: string) { this.log("error", stage, msg, data, id); }
}
