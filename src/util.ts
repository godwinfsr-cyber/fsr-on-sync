import crypto from "node:crypto";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function hash(value: unknown): string {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex").slice(0, 16);
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/** Thrown when the source signals we should back off (429/403/challenge page). Never retried around. */
export class SourceBlockedError extends Error {
  constructor(msg: string) { super(msg); this.name = "SourceBlockedError"; }
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { attempts?: number; baseMs?: number; onRetry?: (err: unknown, attempt: number, waitMs: number) => void; shouldRetry?: (err: unknown) => boolean } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseMs ?? 2000;
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      if (e instanceof SourceBlockedError || (opts.shouldRetry && !opts.shouldRetry(e)) || i === attempts) throw e;
      const wait = base * 2 ** (i - 1) + Math.floor(Math.random() * 500);
      opts.onRetry?.(e, i, wait);
      await sleep(wait);
    }
  }
  throw last;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
