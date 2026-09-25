import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import { SourceBlockedError, sleep } from "../util.ts";

// Conservative, identifiable crawling: a single headless Chromium, images/fonts/media not
// downloaded (we only read their URLs), a fixed delay between page loads, and an immediate
// stop if the site answers with rate-limit / access-denied / challenge responses.
// There is deliberately NO stealth, fingerprint spoofing, CAPTCHA solving or proxy rotation.
export class SourceBrowser {
  private browser: Browser | null = null;
  private ctx: BrowserContext | null = null;
  private lastNav = 0;
  delayMs: number;
  pagesLoaded = 0;

  constructor(delayMs: number) { this.delayMs = delayMs; }

  async open() {
    this.browser = await chromium.launch({ headless: true });
    this.ctx = await this.browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 900 }, timezoneId: "America/New_York" });
    await this.ctx.route("**/*", (route) => {
      const t = route.request().resourceType();
      return t === "image" || t === "font" || t === "media" ? route.abort() : route.continue();
    });
  }

  async close() {
    await this.ctx?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }

  /** Navigate politely; throws SourceBlockedError on signals that we must back off. */
  async goto(url: string): Promise<Page> {
    if (!this.ctx) throw new Error("browser not open");
    const wait = this.lastNav + this.delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastNav = Date.now();
    const page = await this.ctx.newPage();
    let resp: Response | null = null;
    try {
      resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (e) {
      await page.close();
      throw e;
    }
    this.pagesLoaded++;
    const status = resp?.status() ?? 0;
    if (status === 429 || status === 403 || status === 503) {
      await page.close();
      throw new SourceBlockedError(`Source responded HTTP ${status} for ${url} - stopping crawl instead of retrying around it`);
    }
    if (status >= 400) {
      await page.close();
      throw new Error(`HTTP ${status} for ${url}`);
    }
    const title = (await page.title().catch(() => "")) || "";
    if (/access denied|just a moment|attention required|captcha|verify you are human|are you a robot/i.test(title)) {
      await page.close();
      throw new SourceBlockedError(`Bot-protection page detected ("${title}") at ${url} - stopping crawl`);
    }
    return page;
  }
}
