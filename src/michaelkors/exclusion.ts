// HARD EXCLUSION: Michael Kors watches are never imported into Full Size Run (store owner, 2026-09-26).
//
// Checked at four levels: source category / breadcrumb, source URL, product data (title, product type, structured
// data) and, as a last resort, the technical specification text. The filter identifies what the product IS; the word
// "watch" appearing in marketing copy is not enough. Michael Kors' "Watch Hunger Stop" charity range (tote bags,
// T-shirts) is a campaign name, not a watch, so it is imported.

export type ExclusionLevel = "category" | "url" | "product" | "specification";

export interface ExclusionInput {
  title: string;
  category?: string | null;          // "Women > Shoes > Boots" (structured-data category)
  breadcrumbs?: string[];            // ["Women", "Handbags", "Totes"]
  productType?: string | null;       // any source product type / collection label
  url?: string | null;               // source URL
  canonicalUrl?: string | null;
  description?: string | null;       // plain text (used only for strong technical watch specifications)
}

export interface ExclusionResult {
  excluded: boolean;
  status: "watch_excluded" | "skipped" | null;
  level: ExclusionLevel | null;
  reason: string | null;
}

export const WATCH_SKIP_REASON = "Michael Kors watches are excluded from Full Size Run import.";

// campaign names that contain "watch" but are not watches
const NOT_A_WATCH_PHRASES = [/watch[\s-]+hunger[\s-]+stop/gi];
const stripCampaigns = (s: string) => NOT_A_WATCH_PHRASES.reduce((acc, re) => acc.replace(re, " "), s);

// a category label that IS a watch category (whole label, e.g. "Women's Watches", "Smartwatches", "Watch Accessories")
const WATCH_CATEGORY = /^\s*(?:(?:men'?s|women'?s|mens|womens|unisex)\s+)?(?:smart\s?watch(?:es)?|watch(?:es)?|time\s?pieces?|watch\s+(?:accessories|straps?|bands?))\s*$/i;
// the product noun: watch, smartwatch, timepiece, or a watch component (strap / band / bracelet set / charm for a watch)
const WATCH_NOUN = /\b(?:smart\s?watch(?:es)?|watch(?:es)?|time\s?pieces?)\b/i;
// URL route segments of the watch categories, e.g. /women/watches/, /men/watches/smartwatches/, /outlet/accessories/watches/
const WATCH_ROUTE = /\/(?:[a-z-]*-)?(?:smart)?watch(?:es)?(?:-[a-z-]+)?\//i;
// product slug tokens that name a watch product, e.g. /slim-runway-silver-tone-watch/MK3178.html
const WATCH_SLUG = /(?:^|-)(?:smart)?watch(?:es)?(?:-|$)|(?:^|-)time-?pieces?(?:-|$)/i;
// technical specs only a watch has; two or more distinct markers are needed
const WATCH_SPECS: RegExp[] = [
  /\b(?:quartz|automatic|mechanical|chronograph)\b[\s\S]{0,20}\bmovement\b|\b\d-?hand\s+movement\b/i,
  /\bwater[\s-]?resistant\b[\s\S]{0,25}\b\d+\s?ATM\b/i,
  /\b\d{2}\s?mm\s+case\b/i,
  /\b(?:wear\s?os|heart[\s-]?rate|touch\s?screen\s+display|smartwatch)\b/i,
];

function slugOf(u: string | null | undefined): string {
  if (!u) return "";
  try {
    const parts = new URL(u, "https://www.michaelkors.com").pathname.split("/").filter(Boolean);
    const last = parts.at(-1) ?? "";
    // product routes are /<slug>/<STYLE>.html
    return /\.html$/i.test(last) ? (parts.at(-2) ?? "") : "";
  } catch { return ""; }
}
function routeOf(u: string | null | undefined): string {
  if (!u) return "";
  try {
    const p = new URL(u, "https://www.michaelkors.com").pathname;
    return /\.html$/i.test(p) ? "" : p.endsWith("/") ? p : `${p}/`; // only category routes
  } catch { return ""; }
}

/**
 * FINAL SAFETY CHECK - run before any Shopify create / update. Returns excluded=true for Michael Kors watches
 * (status "watch_excluded") and for the extra EXCLUDED_CATEGORIES (status "skipped").
 */
export function isExcludedMichaelKorsProduct(p: ExclusionInput, extraExcludedCategories: string[] = []): ExclusionResult {
  const hit = (level: ExclusionLevel, reason: string): ExclusionResult => ({ excluded: true, status: "watch_excluded", level, reason });
  const segments = [
    ...(p.category ?? "").split(">").map((x) => x.trim()),
    ...(p.breadcrumbs ?? []).slice(0, -1).map((x) => x.trim()), // the last breadcrumb is the product name itself
    ...(p.productType ? [p.productType.trim()] : []),
  ].filter(Boolean);

  // A. category level
  const cat = segments.find((x) => WATCH_CATEGORY.test(x));
  if (cat) return hit("category", `source category "${cat}" is a watch category`);

  // C. URL level (category routes and product slugs)
  for (const u of [p.canonicalUrl, p.url]) {
    const route = stripCampaigns(routeOf(u));
    if (route && WATCH_ROUTE.test(route)) return hit("url", `source URL is a watch category route (${u})`);
    const slug = stripCampaigns(slugOf(u)).replace(/^-+|-+$/g, "");
    if (slug && WATCH_SLUG.test(slug)) return hit("url", `product URL names a watch (${slugOf(u)})`);
  }

  // B. product data level: what the title says the product IS
  const title = stripCampaigns(p.title);
  if (WATCH_NOUN.test(title)) return hit("product", `product title identifies a watch / watch component ("${p.title}")`);

  // D. technical specification (only strong, watch-only specs; generic mentions of "watch" do not count)
  const desc = stripCampaigns(p.description ?? "");
  const markers = WATCH_SPECS.filter((re) => re.test(desc)).length;
  if (markers >= 2) return hit("specification", `specification describes a watch (${markers} watch-only specs: movement / ATM water resistance / case size / smartwatch features)`);

  // other categories the owner chose not to import (not watches)
  const extra = extraExcludedCategories.map((x) => x.trim().toLowerCase()).filter(Boolean);
  const blob = [...segments, p.title].join(" | ").toLowerCase();
  const ex = extra.find((x) => blob.includes(x));
  if (ex) return { excluded: true, status: "skipped", level: "category", reason: `category "${ex}" is in EXCLUDED_CATEGORIES` };

  return { excluded: false, status: null, level: null, reason: null };
}

/** URL-only pre-check used during discovery (saves a page request for obvious watch products). */
export function isWatchUrl(url: string): boolean {
  return isExcludedMichaelKorsProduct({ title: "", url }).status === "watch_excluded";
}
