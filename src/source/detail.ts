import type { SourceBrowser } from "./browser.ts";
import type { ProductDetail, SourceSize } from "./types.ts";

// Highest-quality rendition the site itself exposes (its gallery srcset tops out at 4000px).
// Capping at 4000x4000 also keeps images under Shopify's 25-megapixel / 20 MB media limits.
export function bestImageUrl(src: string): string {
  const base = src.split("?")[0];
  return `${base}?w=4000&h=4000`;
}

/** Opens one colorway page and extracts only what is publicly displayed / published as JSON-LD. */
export async function fetchProductDetail(browser: SourceBrowser, url: string, sku: string): Promise<ProductDetail> {
  const page = await browser.goto(url);
  try {
    await page.waitForFunction(() => {
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        if ((s.textContent || "").includes("ProductGroup")) return true;
      }
      return false;
    }, undefined, { timeout: 30_000 });
    await page.waitForSelector('[data-test-id="productNameTitle"], [data-test-id="productTitle"]', { timeout: 20_000 }).catch(() => {});

    // Size buttons are rendered inline on desktop; on some layouts they sit behind "Select a size".
    const hasSizes = await page.$('[data-test-id="purchasePodSizeButton"]');
    if (!hasSizes) {
      const toggle = await page.$('[data-test-id="purchasePodSelectSizeButton"]');
      if (toggle) {
        await toggle.click().catch(() => {});
        await page.waitForSelector('[data-test-id="purchasePodSizeButton"]', { timeout: 8_000 }).catch(() => {});
      }
    }

    const raw = await page.evaluate((colorwaySku: string) => {
      let group: any = null;
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const j = JSON.parse(s.textContent || "{}");
          const g = (j["@graph"] || [j]).find((x: any) => x["@type"] === "ProductGroup");
          if (g) group = g;
        } catch { /* ignore */ }
      }
      const variant = group?.hasVariant?.find((v: any) => v.sku === colorwaySku) ?? null;
      const offer = variant?.offers ?? null;
      const listSpec = offer?.priceSpecification;
      const listPrice = Array.isArray(listSpec)
        ? listSpec.find((p: any) => /ListPrice/.test(p.priceType))?.price
        : listSpec && /ListPrice/.test(listSpec.priceType) ? listSpec.price : null;

      const sizes = [...document.querySelectorAll<HTMLButtonElement>('[data-test-id="purchasePodSizeButton"]')].map((b) => {
        // In-stock: data-wk-name="purchasePodSizeOption"; sold out: "...OptionOutOfStock" + class _sizeOutOfStock_ + "Notify me".
        const valueEl = b.querySelector('[data-wk-name^="purchasePodSizeOption"]') || b.querySelector('[class*="sizeValue"]');
        const label = (valueEl?.textContent || "").trim();
        const outOfStock = /OutOfStock/.test(valueEl?.getAttribute("data-wk-name") || "") || /outofstock|soldout|sold-out|unavailable|disabled/i.test(b.className)
          || b.disabled || b.getAttribute("aria-disabled") === "true";
        const rawHint = (b.querySelector('[class*="stockInfo"]')?.textContent || "").replace(/\s+/g, " ").trim() || null;
        const hint = outOfStock ? "Sold out" : rawHint;
        return { label, available: !outOfStock && !(rawHint && /no items left|sold out|notify me/i.test(rawHint)), stockHint: hint };
      }).filter((s) => s.label);

      const seen = new Set<string>();
      const images: string[] = [];
      let alt: string | null = null;
      for (const p of document.querySelectorAll('[data-test-id^="productPicture-"]')) {
        const img = p.querySelector("img");
        const src = img?.getAttribute("src") || img?.currentSrc || "";
        if (!src || !/ctfassets|on-running/.test(src)) continue;
        const key = src.split("?")[0];
        if (seen.has(key)) continue;
        seen.add(key);
        images.push(src);
        alt = alt || img?.getAttribute("alt") || null;
      }

      // Accordions may be collapsed, so read table cells / textContent rather than innerText.
      const accordions = [...document.querySelectorAll<HTMLElement>('[data-test-id="accordion"]')];
      const sizeAcc = accordions.find((a) => /SIZE\s*&\s*FIT/i.test(a.textContent || ""));
      const matAcc = accordions.find((a) => /MATERIALS/i.test(a.textContent || ""));
      const usCells = sizeAcc
        ? [...sizeAcc.querySelectorAll("tr")].map((r) => [...r.children].map((c) => (c.textContent || "").trim())).find((cells) => /^us$/i.test(cells[0] || ""))
        : undefined;
      const fitMatch = (sizeAcc?.textContent || "").match(/Size\s*&\s*Fit\s*(.*?)\s*Size Guide/i);
      const leaf = (el: Element | undefined, label: RegExp) => {
        if (!el) return null;
        const nodes = [...el.querySelectorAll("*")].filter((n) => n.children.length === 0).map((n) => (n.textContent || "").trim()).filter(Boolean);
        const i = nodes.findIndex((t) => label.test(t));
        return i >= 0 && nodes[i + 1] ? nodes[i + 1] : null;
      };

      const highlights = [...document.querySelectorAll<HTMLElement>('[data-test-id^="productHighlightCard-"]')].map((c) => {
        const [title, ...rest] = c.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
        return { title: title || "", text: rest.join(" ") };
      });

      const priceBlock = document.body.innerText;

      return {
        groupName: group?.name ?? null,
        styleCode: group?.productGroupID ?? null,
        description: group?.description ?? null,
        color: variant?.color ?? null,
        price: offer?.price != null ? Number(offer.price) : null,
        listPrice: listPrice != null ? Number(listPrice) : null,
        currency: offer?.priceCurrency ?? null,
        availability: offer?.availability ? String(offer.availability).replace("https://schema.org/", "") : null,
        modelName: (() => {
          const el = document.querySelector('[data-test-id="productNameTitle"]');
          if (!el) return null;
          const c = el.cloneNode(true) as HTMLElement;
          c.querySelectorAll('[class*="visuallyHidden"]').forEach((n) => n.remove());
          return (c.textContent || "").replace(/\s+/g, " ").trim() || null;
        })(),
        lastSeason: /last season/i.test(priceBlock.slice(0, 5000)),
        sizes,
        sizeChartUS: usCells ? usCells.slice(1).filter(Boolean) : [],
        images,
        alt,
        highlights,
        materials: leaf(matAcc, /^Materials$/i),
        countryOfOrigin: leaf(matAcc, /^Country of origin$/i),
        fit: fitMatch && fitMatch[1] ? fitMatch[1].trim() : null,
        breadcrumbs: [...new Set([...document.querySelectorAll<HTMLElement>('[data-test-id^="breadcrumb-"]')].map((b) => (b.textContent || "").trim().toLowerCase()))],
      };
    }, sku);

    // "On Cloudmonster 1 Pearl & Ivory Men Active life Shoes" -> "Pearl & Ivory"
    let colorDisplay: string | null = null;
    if (raw.alt && raw.modelName) {
      const m = raw.alt.match(new RegExp(`${raw.modelName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(.+?)\\s+(Men|Women|Kids|Unisex)\\b`, "i"));
      if (m) colorDisplay = m[1].trim();
    }

    const detail: ProductDetail = {
      url, sku,
      styleCode: raw.styleCode,
      groupName: raw.groupName,
      modelName: raw.modelName,
      summary: null, // filled from the listing's category line (e.g. "Men – All-day comfort")
      description: raw.description,
      color: raw.color,
      colorDisplay,
      price: raw.price,
      listPrice: raw.listPrice,
      currency: raw.currency,
      availability: raw.availability,
      lastSeason: raw.lastSeason,
      sizes: raw.sizes as SourceSize[],
      sizeChartUS: raw.sizeChartUS,
      images: raw.images.map(bestImageUrl),
      highlights: raw.highlights,
      materials: raw.materials,
      countryOfOrigin: raw.countryOfOrigin,
      fit: raw.fit,
      breadcrumbs: raw.breadcrumbs,
      missing: [],
    };
    const required: (keyof ProductDetail)[] = ["modelName", "description", "color", "price", "listPrice", "materials", "countryOfOrigin"];
    for (const k of required) if (detail[k] == null) detail.missing.push(k);
    if (!detail.sizes.length) detail.missing.push("sizes");
    if (!detail.images.length) detail.missing.push("images");
    detail.missing.push("barcode/GTIN (not published by source)");
    return detail;
  } finally {
    await page.close();
  }
}
