// HARD EXCLUSION: Tory Burch watches are never imported into Full Size Run (store owner, 2026-09-26).
// Not configurable - no setting, env var or flag can enable them. EXCLUDED_CATEGORIES can only ADD exclusions.
//
// Excluded: watches, timepieces, smartwatches, watch bands / straps, Apple Watch bands, watch-specific accessories.
// Checked at every level the source exposes (see isExcludedToryBurchWatch): source department / class / subclass,
// JSON-LD category + breadcrumbs, collection ids, source + canonical URL (toryburch.com files every watch under
// /en-us/watches/...), embedded catalog path, product title, variant names, and watch-only technical specifications.
// What counts is what the product IS: a "T-Strap Sandal" or a "Headband" is not a watch strap/band.

export type ExclusionLevel = "category" | "breadcrumb" | "structured_data" | "url" | "product" | "specification";

export interface TbExclusionInput {
  title: string;
  department?: string | null;        // embedded productDepartmentName / Id, e.g. "Watches" / "watches"
  productClass?: string | null;      // embedded productClassName / Id, e.g. "Smart Watches" / "watches-smart-watches"
  subclass?: string | null;
  category?: string | null;          // JSON-LD / derived "Handbags > Shoulder Bags"
  breadcrumbs?: string[];            // ["Sale", "Sale Handbags"]
  collection?: string | null;        // embedded topLevelClassificationCategoryName / primaryCategoryId
  productType?: string | null;       // any product type label (incl. the FSR type we would assign)
  url?: string | null;
  canonicalUrl?: string | null;
  staticUrl?: string | null;         // embedded catalog path, e.g. "watches/smart-watches/miller-band-for-apple-watch"
  variantNames?: string[];           // JSON-LD variant names ("Miller Band for Apple Watch in brown, size OS")
  description?: string | null;       // plain text (only strong, watch-only specifications count)
}

export interface ExclusionResult {
  excluded: boolean;
  status: "watch_excluded" | "skipped" | null;
  level: ExclusionLevel | null;
  reason: string | null;
}

export const WATCH_EXCLUDED_CODE = "TORY_BURCH_WATCH_EXCLUDED";
export const WATCH_SKIP_REASON = "Tory Burch watches and watch-related products are excluded from Full Size Run import.";
export const WATCH_LOG_MESSAGE = "Tory Burch watch excluded — watches cannot be imported by Full Size Run.";

// a label that IS a watch category ("Watches", "Smart Watches", "Strap Watches", "Watch Bands", "Apple Watch Bands", ids "watches-smart-watches")
const WATCH_CATEGORY = /(?:^|[\s>/_-])(?:smart[\s_-]?watch(?:es)?|(?:strap|bracelet|mesh)[\s_-]watch(?:es)?|watch(?:es)?|time[\s_-]?pieces?|(?:apple[\s_-])?watch[\s_-](?:bands?|straps?|accessor(?:y|ies)))(?:$|[\s>/_-])/i;
// product noun: watch, smartwatch, timepiece; "Band for Apple Watch", "Watch Strap" etc. all contain the word watch
const WATCH_NOUN = /\b(?:smart\s?watch(?:es)?|watch(?:es|band|bands|strap|straps)?|time\s?pieces?)\b/i;
// URL / catalog path segment that is a watch route: /watches/, /smart-watches/, /strap-watches/, /watch-bands/
const WATCH_ROUTE = /(?:^|\/)(?:[a-z-]*-)?(?:smart-?)?watch(?:es)?(?:-[a-z-]+)?(?:\/|$)/i;
// product slug that names a watch: kira-watch, band-for-apple-watch, eleanor-watch-38mm
const WATCH_SLUG = /(?:^|-)(?:smart-?)?watch(?:es|band|bands|strap|straps)?(?:-|$)|(?:^|-)time-?pieces?(?:-|$)/i;
// technical specifications only a watch has; two or more distinct markers are needed
const WATCH_SPECS: RegExp[] = [
  /\b(?:quartz|automatic|mechanical|chronograph)\b[\s\S]{0,20}\bmovement\b|\b\d-?hand\s+movement\b/i,
  /\bwater[\s-]?resistant\b[\s\S]{0,25}\b\d+\s?(?:ATM|m|meters?)\b/i,
  /\b\d{2}\s?mm\s+(?:case|dial)\b|\bcase\s+(?:diameter|size)\b/i,
  /\b(?:apple\s+watch|wear\s?os|heart[\s-]?rate|touch\s?screen\s+display|smartwatch|lug\s+width)\b/i,
];

function pathOf(u: string | null | undefined): string {
  if (!u) return "";
  try { return new URL(u, "https://www.toryburch.com").pathname.toLowerCase(); } catch { return String(u).toLowerCase(); }
}
/** Product routes are /en-us/<department>/<class>/<slug>/<STYLE>.html: category segments + slug. */
function splitRoute(u: string | null | undefined): { segments: string[]; slug: string } {
  const parts = pathOf(u).split("/").filter(Boolean).filter((x) => !/^[a-z]{2}-[a-z]{2}$/.test(x));
  if (parts.length && /\.html$/.test(parts.at(-1)!)) return { segments: parts.slice(0, -2), slug: parts.at(-2) ?? "" };
  return { segments: parts, slug: "" };
}

/**
 * FINAL SAFETY CHECK - run before ANY Shopify create / update / image upload. true = a Tory Burch watch, timepiece,
 * smartwatch, watch band / strap, Apple Watch band or watch-specific accessory (status "watch_excluded").
 */
export function isExcludedToryBurchWatch(p: TbExclusionInput): ExclusionResult {
  const hit = (level: ExclusionLevel, reason: string): ExclusionResult => ({ excluded: true, status: "watch_excluded", level, reason });

  // A. source category (department / class / subclass / product type)
  for (const [label, v] of [["department", p.department], ["class", p.productClass], ["subclass", p.subclass], ["product type", p.productType]] as const) {
    if (v && WATCH_CATEGORY.test(v.trim())) return hit("category", `source ${label} "${v}" is a watch category`);
  }
  // C. breadcrumb / collection
  for (const c of p.breadcrumbs ?? []) if (WATCH_CATEGORY.test(c.trim())) return hit("breadcrumb", `breadcrumb "${c}" is a watch collection`);
  if (p.collection && WATCH_CATEGORY.test(p.collection)) return hit("breadcrumb", `collection "${p.collection}" is a watch collection`);
  // E. structured data category path
  for (const seg of (p.category ?? "").split(">").map((x) => x.trim()).filter(Boolean)) {
    if (WATCH_CATEGORY.test(seg)) return hit("structured_data", `structured-data category "${p.category}" is a watch category`);
  }
  // D. URL level (source, canonical, embedded catalog path)
  for (const u of [p.canonicalUrl, p.url, p.staticUrl ? `/${p.staticUrl}/x.html` : null]) {
    if (!u) continue;
    const { segments, slug } = splitRoute(u);
    const seg = segments.find((x) => WATCH_ROUTE.test(`/${x}/`));
    if (seg) return hit("url", `URL is under the watch route "/${seg}/" (${u})`);
    if (slug && WATCH_SLUG.test(slug)) return hit("url", `product URL names a watch ("${slug}")`);
  }
  // B. product title / variant names: what the product IS
  if (WATCH_NOUN.test(p.title)) return hit("product", `product title identifies a watch / watch band / watch accessory ("${p.title}")`);
  const vn = (p.variantNames ?? []).find((x) => WATCH_NOUN.test(x));
  if (vn) return hit("structured_data", `structured-data variant name identifies a watch ("${vn}")`);
  // spec level (only strong, watch-only specifications)
  const markers = WATCH_SPECS.filter((re) => re.test(p.description ?? "")).length;
  if (markers >= 2) return hit("specification", `specification describes a watch (${markers} watch-only specs)`);
  return { excluded: false, status: null, level: null, reason: null };
}

/** Watch check first (hard rule), then the owner's extra EXCLUDED_CATEGORIES (status "skipped"). */
export function isExcludedToryBurchProduct(p: TbExclusionInput, extraExcludedCategories: string[] = []): ExclusionResult {
  const w = isExcludedToryBurchWatch(p);
  if (w.excluded) return w;
  const extra = extraExcludedCategories.map((x) => x.trim().toLowerCase()).filter(Boolean);
  const { segments } = splitRoute(p.canonicalUrl ?? p.url);
  const blob = [p.department, p.productClass, p.category, ...(p.breadcrumbs ?? []), ...segments.map((s) => s.replace(/-/g, " ")), p.title].filter(Boolean).join(" | ").toLowerCase();
  const ex = extra.find((x) => blob.includes(x));
  if (ex) return { excluded: true, status: "skipped", level: "category", reason: `category "${ex}" is in EXCLUDED_CATEGORIES` };
  return { excluded: false, status: null, level: null, reason: null };
}

/** URL-only pre-check used during discovery (saves a page request for products under /watches/). */
export function isWatchUrl(url: string): boolean {
  return isExcludedToryBurchWatch({ title: "", url }).excluded;
}
/** URL-only pre-check for EXCLUDED_CATEGORIES departments (e.g. /fragrance-beauty/, /home/). */
export function excludedDepartmentOfUrl(url: string, extraExcludedCategories: string[]): string | null {
  const dept = splitRoute(url).segments[0]?.replace(/-/g, " ") ?? "";
  return extraExcludedCategories.map((x) => x.trim().toLowerCase()).filter(Boolean).find((x) => dept.includes(x)) ?? null;
}
