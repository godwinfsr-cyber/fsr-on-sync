import { SOURCE } from "../config.ts";
import type { Logger } from "../logger.ts";
import { retry, errMsg } from "../util.ts";
import type { SourceBrowser } from "./browser.ts";
import type { ListingItem } from "./types.ts";

export interface DiscoveryResult {
  items: ListingItem[];
  groupsDiscovered: number;
  groupsReported: number | null; // schema.org numberOfItems (product groups) reported by the page
  pagesVisited: number;
  complete: boolean;             // true when we saw every group the page says exists
}

const MAX_PAGES = 30;

/**
 * Walks Last Season -> Shoes via the page's own "Show more" (?page=N) links and reads the
 * schema.org ItemList JSON-LD that the page publishes. Each page's list is cumulative.
 */
export async function discoverCatalog(browser: SourceBrowser, log: Logger): Promise<DiscoveryResult> {
  const bySku = new Map<string, ListingItem>();
  const groups = new Set<string>();
  let reported: number | null = null;
  let url: string | null = SOURCE.listingUrl;
  const visited = new Set<string>();
  let lastGroupCount = 0;

  while (url && !visited.has(url) && visited.size < MAX_PAGES) {
    visited.add(url);
    const pageUrl: string = url;
    const res = await retry(async () => {
      const page = await browser.goto(pageUrl);
      try {
        await page.waitForFunction((min: number) => {
          for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
              const j = JSON.parse(s.textContent || "{}");
              const list = (j["@graph"] || [j]).find((g: { "@type": string }) => g["@type"] === "ItemList");
              if (list && list.itemListElement?.length > min) return true;
            } catch { /* keep waiting */ }
          }
          return false;
        }, lastGroupCount, { timeout: 30_000 });
        return await page.evaluate(() => {
          let list: any = null;
          for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
              const j = JSON.parse(s.textContent || "{}");
              list = (j["@graph"] || [j]).find((g: any) => g["@type"] === "ItemList") || list;
            } catch { /* ignore */ }
          }
          const more = document.querySelector<HTMLAnchorElement>('a[href*="page="]');
          return { list, more: more ? more.href : null };
        });
      } finally {
        await page.close();
      }
    }, { attempts: 3, baseMs: 5000, onRetry: (e, a, w) => log.warn("discovery", `listing page retry ${a} in ${w}ms: ${errMsg(e)}`, { url: pageUrl }) });

    const list = res.list;
    if (!list) throw new Error(`No schema.org ItemList found on ${pageUrl}`);
    if (typeof list.numberOfItems === "number" && list.numberOfItems > 0) reported = list.numberOfItems;
    for (const el of list.itemListElement ?? []) {
      const g = el.item ?? {};
      groups.add(g.productGroupID ?? g.name);
      for (const v of g.hasVariant ?? []) {
        if (!v.sku || bySku.has(v.sku)) continue;
        bySku.set(v.sku, {
          sku: String(v.sku),
          styleCode: g.productGroupID ?? null,
          groupName: g.name ?? "",
          groupSummary: g.description ?? null,
          variantName: v.name ?? "",
          color: v.color ?? null,
          url: v.offers?.url ?? v.url ?? g.url,
          image: typeof v.image === "string" ? v.image : Array.isArray(v.image) ? v.image[0] : null,
          price: typeof v.offers?.price === "number" ? v.offers.price : v.offers?.price ? Number(v.offers.price) : null,
          currency: v.offers?.priceCurrency ?? null,
          availability: v.offers?.availability ? String(v.offers.availability).replace("https://schema.org/", "") : null,
          position: bySku.size + 1,
        });
      }
    }
    lastGroupCount = list.itemListElement?.length ?? lastGroupCount;
    log.info("discovery", `page ${visited.size}: ${groups.size} groups / ${bySku.size} colorways so far (site reports ${reported ?? "?"} groups)`, { url: pageUrl });
    url = res.more && !visited.has(res.more) ? res.more : null;
  }

  const complete = reported != null && groups.size >= reported;
  return { items: [...bySku.values()], groupsDiscovered: groups.size, groupsReported: reported, pagesVisited: visited.size, complete };
}
