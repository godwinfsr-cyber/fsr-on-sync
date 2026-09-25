/** One colorway as listed in the category page's schema.org JSON-LD. */
export interface ListingItem {
  sku: string;                // colorway SKU, e.g. 3MF30742143 (stable source product id)
  styleCode: string | null;   // productGroupID, e.g. 3MF3074
  groupName: string;          // "Men's Cloudmonster 1"
  groupSummary: string | null; // "Men – All-day comfort"
  variantName: string;        // "Men's Cloudmonster 1 Pearl | Ivory"
  color: string | null;       // "Pearl | Ivory"
  url: string;
  image: string | null;
  price: number | null;
  currency: string | null;
  availability: string | null; // schema.org value, e.g. InStock
  position: number;
}

export interface SourceSize {
  label: string;              // exact label shown on the source, e.g. "7.5"
  available: boolean;
  stockHint: string | null;   // e.g. "Only 6 left"
}

export interface ProductDetail {
  url: string;
  sku: string;
  styleCode: string | null;
  groupName: string | null;
  modelName: string | null;       // "Cloudmonster 1"
  summary: string | null;         // "All-day movement"
  description: string | null;
  color: string | null;
  colorDisplay: string | null;    // "Pearl & Ivory" (from gallery alt text when available)
  price: number | null;
  listPrice: number | null;
  currency: string | null;
  availability: string | null;
  lastSeason: boolean;
  sizes: SourceSize[];
  sizeChartUS: string[];          // every size in the size guide (to report sizes not offered/sold out)
  images: string[];               // ordered, de-duplicated, highest quality exposed
  highlights: { title: string; text: string }[];
  materials: string | null;
  countryOfOrigin: string | null;
  fit: string | null;
  breadcrumbs: string[];
  missing: string[];              // fields that could not be found
}
