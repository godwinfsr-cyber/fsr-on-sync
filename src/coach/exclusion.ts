// HARD EXCLUSION: COACH watches are never imported into Full Size Run (store owner, 2026-09-26).
// Not configurable - no setting, env var or flag can enable them. EXCLUDED_CATEGORIES can only ADD exclusions.
//
// Excluded: watches, smartwatches, timepieces, watch straps / bands, Apple Watch bands / straps, watch gift sets and any
// other watch-specific accessory. Checked on every field the source exposes: category / subcategory (Coach
// classification, filter category, item_category path, category id), breadcrumbs, product type, title, URL (source,
// canonical, final), description / specifications and tags. What counts is what the product IS: a "Watch Hunger Stop"
// tote or a "strap" for a bag is not a watch accessory.

export type ExclusionLevel = "category" | "breadcrumb" | "product_type" | "title" | "url" | "tags" | "specification" | "restored" | "excluded_category";

export interface CoachExclusionInput {
  title: string;
  category?: string | null;          // "Women > Shoes" / item_category path
  subcategory?: string | null;       // Coach classification, e.g. "Watches"
  filterCategory?: string | null;    // c_filterCategory, e.g. "WATCHES"
  categoryId?: string | null;        // "women-watches"
  breadcrumbs?: string[];
  productType?: string | null;
  url?: string | null;
  canonicalUrl?: string | null;
  finalUrl?: string | null;
  description?: string | null;       // plain text
  tags?: string[];
}

export interface ExclusionResult {
  excluded: boolean;
  status: "watch_excluded" | "skipped" | null;
  level: ExclusionLevel | null;
  reason: string | null;
}

export const WATCH_LOG_MESSAGE = "COACH watch excluded — watches cannot be imported by Full Size Run.";

// a category label that IS a watch category as a whole ("Watches", "Smart Watches", "Watch Straps", "Apple Watch Bands",
// "Women's Watches", id "women-watches"). A combined label such as "Jewelry & Watches" is NOT: a bangle filed there is jewelry.
const WATCH_CATEGORY = /^(?:(?:women'?s?|men'?s?|womens|mens|all|shop|outlet|sale|new)[\s_-]+)?(?:smart[\s_-]?watch(?:es)?|watch(?:es)?|time[\s_-]?pieces?|(?:apple[\s_-])?watch[\s_-](?:bands?|straps?|accessor(?:y|ies)|gift[\s_-]sets?)|(?:apple[\s_-])?watch[\s_-]?(?:bands?|straps?))$/i;
// product noun in a title: watch, smartwatch, timepiece, watch strap / band, "Strap for Apple Watch"
const WATCH_NOUN = /\b(?:smart\s?watch(?:es)?|watch(?:es|band|bands|strap|straps)?|time\s?pieces?)\b/i;
// phrases that use the word "watch" without being one
const NOT_A_WATCH = /\bwatch\s+(?:hunger|this\s+space|out)\b/i;
// product slug that names a watch: mini-liz-watch-24mm, apple-watch-strap-38mm-40mm-and-41mm, ruby-watch-gift-set-32mm
const WATCH_SLUG = /(?:^|-)(?:smart-?)?watch(?:es|band|bands|strap|straps)?(?:-|$)|(?:^|-)time-?pieces?(?:-|$)/i;
// technical specifications only a watch has; two or more distinct markers are needed
const WATCH_SPECS: RegExp[] = [
  /\b(?:quartz|automatic|mechanical|chronograph)\b[\s\S]{0,20}\bmovement\b|\b\d-?hand\s+movement\b/i,
  /\bwater[\s-]?resist(?:ant|ance)\b[\s\S]{0,25}\b\d+\s?(?:ATM|m|meters?)\b/i,
  /\b\d{2}\s?mm\s+(?:case|dial)\b|\bcase\s+(?:diameter|size)\b|\bmineral\s+crystal\b/i,
  /\b(?:apple\s+watch|lug\s+width|dial\b)/i,
];
// Coach Restored = refurbished pre-owned pieces. Coach "Remade" items (also filed under "(Re)Loved") are newly made from
// reclaimed materials, not pre-owned, so the "(Re)Loved" label on its own does not exclude a product.
const RESTORED = /(?:^|[\s/-])(?:restored|pre-?loved|pre-?owned)(?:$|[\s/-])/i;

function slugOf(u: string | null | undefined): string {
  if (!u) return "";
  try {
    const parts = new URL(u, "https://www.coach.com").pathname.toLowerCase().split("/").filter(Boolean);
    return parts.length >= 2 && /\.html$/.test(parts.at(-1)!) ? parts.at(-2)! : parts.at(-1) ?? "";
  } catch { return String(u).toLowerCase(); }
}
function segmentsOf(u: string | null | undefined): string[] {
  try { return new URL(u ?? "", "https://www.coach.com").pathname.toLowerCase().split("/").filter(Boolean); } catch { return []; }
}

/**
 * FINAL SAFETY CHECK - runs before ANY Shopify create or image upload. true = a COACH watch, smartwatch, timepiece,
 * watch strap / band, Apple Watch band or watch-specific accessory (status "watch_excluded").
 */
export function isExcludedCoachWatch(p: CoachExclusionInput): ExclusionResult {
  const hit = (level: ExclusionLevel, reason: string): ExclusionResult => ({ excluded: true, status: "watch_excluded", level, reason });
  for (const [label, v] of [["category", p.category], ["subcategory", p.subcategory], ["filter category", p.filterCategory], ["category id", p.categoryId]] as const) {
    if (!v) continue;
    for (const seg of String(v).split(">").map((x) => x.trim()).filter(Boolean)) if (WATCH_CATEGORY.test(seg)) return hit("category", `source ${label} "${v}" is a watch category`);
  }
  for (const c of p.breadcrumbs ?? []) if (WATCH_CATEGORY.test(c.trim())) return hit("breadcrumb", `breadcrumb "${c}" is a watch category`);
  if (p.productType && WATCH_CATEGORY.test(p.productType.trim())) return hit("product_type", `product type "${p.productType}" is a watch category`);
  for (const u of [p.url, p.canonicalUrl, p.finalUrl]) {
    if (!u) continue;
    const seg = segmentsOf(u).find((s) => /^(?:[a-z-]*-)?(?:smart-?)?watch(?:es)?(?:-[a-z-]+)?$/.test(s) && !/\.html$/.test(s));
    if (seg && seg !== slugOf(u)) return hit("url", `URL is under the watch route "/${seg}/" (${u})`);
    const slug = slugOf(u);
    if (slug && WATCH_SLUG.test(slug) && !NOT_A_WATCH.test(slug.replace(/-/g, " "))) return hit("url", `product URL names a watch ("${slug}")`);
  }
  if (WATCH_NOUN.test(p.title) && !NOT_A_WATCH.test(p.title)) return hit("title", `product title identifies a watch / watch strap / watch accessory ("${p.title}")`);
  const tag = (p.tags ?? []).find((t) => WATCH_CATEGORY.test(t.trim()));
  if (tag) return hit("tags", `tag "${tag}" is a watch category`);
  const markers = WATCH_SPECS.filter((re) => re.test(p.description ?? "")).length;
  if (markers >= 2) return hit("specification", `specification describes a watch (${markers} watch-only specs)`);
  return { excluded: false, status: null, level: null, reason: null };
}

/** Watch check first (hard rule), then Restored (unless enabled) and the owner's EXCLUDED_CATEGORIES (status "skipped"). */
export function isExcludedCoachProduct(p: CoachExclusionInput, opts: { excludedCategories?: string[]; includeRestored?: boolean } = {}): ExclusionResult {
  const w = isExcludedCoachWatch(p);
  if (w.excluded) return w;
  const skip = (level: ExclusionLevel, reason: string): ExclusionResult => ({ excluded: true, status: "skipped", level, reason });
  if (!opts.includeRestored) {
    const where = [p.title, slugOf(p.url), slugOf(p.canonicalUrl), p.category, p.categoryId, ...(p.breadcrumbs ?? [])].find((x) => x && RESTORED.test(String(x).replace(/-/g, " ")));
    if (where) return skip("restored", `Coach Restored (refurbished / pre-owned) item ("${where}") - not imported (COACH_INCLUDE_RESTORED=false)`);
  }
  const extra = (opts.excludedCategories ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const blob = [p.title, p.category, p.subcategory, p.filterCategory, p.categoryId, ...(p.breadcrumbs ?? []), slugOf(p.url).replace(/-/g, " ")].filter(Boolean).join(" | ").toLowerCase();
  const ex = extra.find((x) => blob.includes(x));
  if (ex) return skip("excluded_category", `category "${ex}" is in COACH_EXCLUDED_CATEGORIES`);
  return { excluded: false, status: null, level: null, reason: null };
}

/** URL-only pre-check used during discovery (saves a page read for products whose URL names a watch). */
export function isWatchUrl(url: string): boolean {
  return isExcludedCoachWatch({ title: "", url }).excluded;
}
export function isRestoredUrl(url: string): boolean {
  return RESTORED.test(slugOf(url).replace(/-/g, " "));
}
