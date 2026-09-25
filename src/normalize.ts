import type { Settings } from "./config.ts";
import type { ListingItem, ProductDetail, SourceSize } from "./source/types.ts";
import { escapeHtml, hash } from "./util.ts";

export interface NormalizedSize extends SourceSize {
  sourceLabel: string;  // exact size label on ON US, e.g. "9" (label holds the storefront size, e.g. UK "8.5")
  variantSku: string;   // FSR convention: <colorway SKU>-<storefront size>, e.g. 3MF30742143-8.5
  listedBySource: boolean;
}

export interface NormalizedProduct {
  sourceProductId: string;
  sourceSku: string;
  styleCode: string | null;
  sourceUrl: string;
  brand: string;
  model: string;
  gender: "Men" | "Women" | "Kids" | "Unisex" | null;
  colorName: string | null;     // exact source value, "Pearl | Ivory"
  colorDisplay: string | null;  // "Pearl & Ivory"
  category: string | null;      // "Men – All-day comfort"
  title: string;
  descriptionHtml: string;
  seoTitle: string;
  seoDescription: string;
  sourceDescription: string | null;
  price: number | null;
  listPrice: number | null;
  currency: string | null;
  availability: string | null;
  lastSeason: boolean;
  sizes: NormalizedSize[];
  images: string[];
  imageAlt: string;
  tags: string[];
  materials: string | null;
  countryOfOrigin: string | null;
  countryCode: string | null;
  missing: string[];
  hashes: { content: string; image: string; availability: string; price: string };
}

const COUNTRY_CODES: Record<string, string> = {
  vietnam: "VN", indonesia: "ID", china: "CN", cambodia: "KH", india: "IN", bangladesh: "BD", thailand: "TH",
  portugal: "PT", italy: "IT", switzerland: "CH", "sri lanka": "LK", myanmar: "MM", philippines: "PH", taiwan: "TW",
};

const DISCLAIMER =
  "<p><strong>Disclaimer:</strong> Product images are for reference only. The actual product may vary slightly in color, texture, or details due to lighting, photography angles, or display settings.</p>";

export function genderOf(groupName: string, url: string): NormalizedProduct["gender"] {
  if (/^women'?s\b/i.test(groupName) || /\/womens\//.test(url)) return "Women";
  if (/^men'?s\b/i.test(groupName) || /\/mens\//.test(url)) return "Men";
  if (/\b(kids'?|youth|toddler|infant)\b/i.test(groupName) || /\/kids\//.test(url) || /-3[ky][a-z]\d/i.test(url)) return "Kids";
  if (/unisex/i.test(groupName)) return "Unisex";
  return null;
}

/** "Pearl | Ivory" -> "Pearl & Ivory"; "Iceberg | Iceberg" -> "Iceberg" */
export function displayColor(color: string | null): string | null {
  if (!color) return null;
  const parts = [...new Set(color.split("|").map((p) => p.trim()).filter(Boolean))];
  return parts.join(" & ") || null;
}

export function sortSizes(a: string, b: string): number {
  const na = parseFloat(a.replace(/[^0-9.]/g, ""));
  const nb = parseFloat(b.replace(/[^0-9.]/g, ""));
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

/** Truncate at a word boundary. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6)).trimEnd()}…`;
}

/**
 * ON US size -> storefront size. The store lists UK sizes: men's/unisex UK = US - 0.5, women's UK = US - 2
 * (offsets configurable). Kids' sizes and non-numeric labels are left exactly as ON shows them.
 */
export function storefrontSize(usLabel: string, gender: NormalizedProduct["gender"], settings: Pick<Settings, "SIZE_SYSTEM" | "MEN_US_TO_UK_OFFSET" | "WOMEN_US_TO_UK_OFFSET">): string {
  if (settings.SIZE_SYSTEM !== "UK" || gender === "Kids") return usLabel;
  if (!/^\d+(\.\d+)?$/.test(usLabel.trim())) return usLabel;
  const offset = gender === "Women" ? settings.WOMEN_US_TO_UK_OFFSET : settings.MEN_US_TO_UK_OFFSET;
  const v = Math.round((Number(usLabel) - offset) * 10) / 10;
  return v > 0 ? String(v) : usLabel;
}

function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? "").replace(/\(\s*\)/g, "").replace(/\s+-\s*$/, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * Builds the product Full Size Run would publish from the source record.
 * `previousSizes` keeps sizes the source stopped listing as unavailable variants instead of
 * deleting them (avoids variant churn and keeps order history intact).
 */
export function normalize(listing: ListingItem, detail: ProductDetail, settings: Settings, previousSizes: string[] = []): NormalizedProduct {
  const sku = listing.sku;
  const groupName = detail.groupName || listing.groupName;
  const gender = genderOf(groupName, listing.url);
  const model = detail.modelName || groupName.replace(/^(men|women|kids)'?s?\s+/i, "").trim();
  const colorName = detail.color ?? listing.color;
  const colorDisplay = displayColor(colorName);
  const genderLabel = gender === "Men" ? "Men's" : gender === "Women" ? "Women's" : gender === "Kids" ? "Kids'" : gender ?? "";
  const title = fillTemplate(settings.TITLE_TEMPLATE, { model, color: colorDisplay ?? "", gender: genderLabel, brand: "On" });

  const listed = new Map(detail.sizes.map((s) => [s.label, s]));
  const labels = [...new Set([...detail.sizes.map((s) => s.label), ...previousSizes])].sort(sortSizes);
  const sizes: NormalizedSize[] = labels.map((sourceLabel) => {
    const s = listed.get(sourceLabel);
    const label = storefrontSize(sourceLabel, gender, settings);
    return {
      label,
      sourceLabel,
      available: s ? s.available : false,
      stockHint: s?.stockHint ?? null,
      variantSku: `${sku}-${label}`,
      listedBySource: Boolean(s),
    };
  });

  const sourceDescription = detail.description?.trim() || null;
  const variantSkus = sizes.map((s) => s.variantSku);
  const uk = settings.SIZE_SYSTEM === "UK";
  const note = gender === "Women" ? `<p><strong>NOTE:</strong> Sizes are ${uk ? "UK" : "US"} Women's sizing.</p><p> </p>`
    : gender === "Kids" ? "<p><strong>NOTE:</strong> Sizes are US Kids' sizing.</p><p> </p>"
    : ""; // men's listings carry no NOTE, same as the store's existing template
  // Matches the store's existing description template: paragraph, bold SKU line, optional NOTE, Disclaimer.
  const descriptionHtml = [
    sourceDescription ? `<p>${escapeHtml(sourceDescription)}</p><p> </p>` : "",
    `<p><strong>SKU - ${escapeHtml(sku)}</strong></p><p> </p>`,
    note,
    DISCLAIMER,
  ].join("");

  const seoTitle = `${title} | Full Size Run`.length <= 70 ? `${title} | Full Size Run` : clip(title, 70);
  const seoDescription = clip(sourceDescription ? `${title}. ${sourceDescription}` : title, 320);

  const tags = [...new Set([
    ...settings.BASE_TAGS.split(",").map((t) => t.trim()).filter(Boolean),
    ...(gender ? [gender] : []),
  ])];

  const country = detail.countryOfOrigin;
  const n: Omit<NormalizedProduct, "hashes"> = {
    sourceProductId: sku,
    sourceSku: sku,
    styleCode: detail.styleCode ?? listing.styleCode,
    sourceUrl: listing.url,
    brand: "On",
    model,
    gender,
    colorName,
    colorDisplay,
    category: listing.groupSummary,
    title,
    descriptionHtml,
    seoTitle,
    seoDescription,
    sourceDescription,
    price: detail.price ?? listing.price,
    listPrice: detail.listPrice,
    currency: detail.currency ?? listing.currency,
    availability: detail.availability ?? listing.availability,
    lastSeason: detail.lastSeason,
    sizes,
    images: detail.images.length ? detail.images : listing.image ? [listing.image] : [],
    imageAlt: `On ${model} ${colorDisplay ?? ""} ${gender ?? ""}`.replace(/\s+/g, " ").trim(),
    tags,
    materials: detail.materials,
    countryOfOrigin: country,
    countryCode: country ? COUNTRY_CODES[country.toLowerCase()] ?? null : null,
    missing: detail.missing,
  };
  return {
    ...n,
    hashes: {
      content: hash({ title: n.title, d: n.descriptionHtml, tags: n.tags, m: n.materials, c: n.countryOfOrigin, skus: variantSkus, v: settings.VENDOR, t: settings.PRODUCT_TYPE }),
      image: hash(n.images.map((u) => u.split("?")[0])),
      availability: hash(sizes.map((s) => [s.sourceLabel, s.available])),
      price: hash([n.price, n.listPrice, n.currency]),
    },
  };
}
