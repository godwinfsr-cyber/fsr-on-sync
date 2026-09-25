import type { Logger } from "./logger.ts";
import { SourceBlockedError, errMsg, sleep } from "./util.ts";

export interface FetchResult { status: number; url: string; body: string }

/** The page sits behind a virtual waiting room (e.g. Queue-it for a limited drop). Never bypassed; the caller skips it. */
export class AccessControlledError extends Error {
  constructor(msg: string) { super(msg); this.name = "AccessControlledError"; }
}
const WAITING_ROOM = (u: URL) => /^queue\./i.test(u.hostname) || /queue-it/i.test(u.hostname);

export interface PoliteHttpOptions {
  userAgent: string;
  label: string;                 // used in error messages, e.g. "Tissot"
  acceptLanguage?: string;
  accept?: string;
  challenge?: RegExp;            // body (first 3000 chars) pattern that means "challenge / CAPTCHA page"
}

/**
 * Polite, identifiable, sequential HTTP client shared by the catalog sources (Tissot, Casio, Gymshark).
 * - one request at a time with a fixed gap (REQUEST_DELAY_MS), honest User-Agent, 30s timeout
 * - 5xx / network errors: retried with exponential backoff
 * - 429: slows the whole crawl down (doubles the gap, waits Retry-After or 60s) and logs it; gives up after 3
 * - 403 / challenge page: stops the crawl (SourceBlockedError) - no stealth, proxies or CAPTCHA handling
 * - 404 / 410: returned to the caller (product withdrawn), not an error
 */
export class PoliteHttp {
  delayMs: number;
  requests = 0;
  rateLimitEvents = 0;
  private last = 0;
  private log: Logger;
  private o: Required<PoliteHttpOptions>;
  constructor(delayMs: number, log: Logger, opts: PoliteHttpOptions) {
    this.delayMs = delayMs;
    this.log = log;
    this.o = {
      acceptLanguage: "en-IN,en;q=0.9", accept: "text/html,application/xml;q=0.9,*/*;q=0.8", challenge: /captcha|verify you are human/i, ...opts,
    };
  }

  async get(url: string, accept = this.o.accept): Promise<FetchResult> {
    let rateLimited = 0;
    for (let attempt = 1; ; attempt++) {
      const wait = this.last + this.delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      this.requests++;
      let res: Response;
      let current = url;
      try {
        // redirects are followed by hand so a waiting-room hop is recognised instead of looping
        for (let hop = 0; ; hop++) {
          res = await fetch(current, {
            headers: { "User-Agent": this.o.userAgent, Accept: accept, "Accept-Language": this.o.acceptLanguage },
            signal: AbortSignal.timeout(30_000),
            redirect: "manual",
          });
          const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
          if (!loc) break;
          const next = new URL(loc, current);
          if (WAITING_ROOM(next)) throw new AccessControlledError(`${url} is behind a virtual waiting room (${next.hostname}) - skipped, not bypassed`);
          if (hop >= 5) throw new Error(`too many redirects for ${url}`);
          current = next.toString();
        }
      } catch (e) {
        if (e instanceof AccessControlledError) throw e;
        if (attempt >= 3) throw new Error(`network error for ${url}: ${errMsg(e)}`);
        const backoff = 3000 * 2 ** (attempt - 1);
        this.log.warn("http", `network error, retry ${attempt} in ${backoff}ms: ${errMsg(e)}`, { url });
        await sleep(backoff);
        continue;
      }
      if (res.status === 429) {
        rateLimited++;
        this.rateLimitEvents++;
        const retryAfter = Number(res.headers.get("retry-after")) || 60;
        this.delayMs = Math.min(this.delayMs * 2, 30_000);
        this.log.warn("http", `rate limited (HTTP 429) - slowing down: waiting ${retryAfter}s, request gap now ${this.delayMs}ms`, { url });
        if (rateLimited >= 3) throw new SourceBlockedError(`${this.o.label} kept rate-limiting (HTTP 429 x${rateLimited}) - stopping this crawl`);
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status === 403) throw new SourceBlockedError(`${this.o.label} refused access (HTTP 403) for ${url} - stopping crawl`);
      if (res.status >= 500) {
        if (attempt >= 3) throw new Error(`HTTP ${res.status} for ${url} after ${attempt} attempts`);
        const backoff = 5000 * 2 ** (attempt - 1);
        this.log.warn("http", `HTTP ${res.status}, retry ${attempt} in ${backoff}ms`, { url });
        await sleep(backoff);
        continue;
      }
      const body = await res.text();
      if (/<title>\s*(just a moment|attention required|access denied)/i.test(body.slice(0, 5000)) || this.o.challenge.test(body.slice(0, 3000))) {
        throw new SourceBlockedError(`Bot-protection / challenge page returned for ${url} - stopping crawl`);
      }
      return { status: res.status, url: current, body };
    }
  }
}
