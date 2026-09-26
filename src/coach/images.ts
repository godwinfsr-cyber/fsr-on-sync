// Product gallery per style + colour from Coach's image server (coach.scene7.com - open to scripted reads, unlike the
// product pages). The page lists some photos; the rest of the colour's gallery follows Coach's own view codes (a0 front,
// a3 angle, a8 inside, a10 outsole, a91 detail ...). Each candidate is confirmed with scene7's own existence check
// (req=exists) before it is handed to Shopify, so only real photos of THIS style + colour are attached.
import { sleep } from "../util.ts";
import { COACH_SOURCE, type CoachSettings } from "./config.ts";
import type { CoachItem } from "./dedupe.ts";
import { imageBase, imageSuffix } from "./normalize.ts";

export type ExistsFn = (url: string) => Promise<boolean>;

export const scene7Exists: ExistsFn = async (url) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${url}?req=exists,json`, { headers: { "User-Agent": COACH_SOURCE.userAgent }, signal: AbortSignal.timeout(15_000) });
      if (r.status >= 500 || r.status === 429) throw new Error(`HTTP ${r.status}`);
      const t = await r.text();
      return /"catalogRecord\.exists"\s*:\s*"1"/.test(t);
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
};

const ORDER = ["a0", "a3", "a8", "a9", "a10", "a91", "a1", "a2", "a4", "a5", "a6", "a7", "a81", "a88", "a92", "a93"];

/** Ordered, confirmed gallery for one product: [{url (full-resolution rendition), alt}]. */
export async function galleryFor(item: Pick<CoachItem, "key" | "style" | "colourCode" | "name" | "colourName" | "images" | "imageSuffixHints">, s: Pick<CoachSettings, "IMAGE_SIZE" | "IMAGE_QUALITY" | "MAX_IMAGES">, exists: ExistsFn = scene7Exists): Promise<{ url: string; alt: string }[]> {
  // base name of this colour's photos, e.g. https://coach.scene7.com/is/image/Coach/cv933_imxaq
  const own = `${item.style}_${item.colourCode}`.toLowerCase().replace(/\//g, "");
  const bases = [...new Set(item.images.map(imageBase))];
  const base = bases.find((b) => b.toLowerCase().endsWith(`/${own}`)) ?? bases[0] ?? `${COACH_SOURCE.imageHost}${own}`;
  const listed = new Set(item.images.filter((u) => imageBase(u) === base).map((u) => imageSuffix(u)).filter(Boolean) as string[]);
  const candidates = [...new Set([...listed, ...ORDER, ...item.imageSuffixHints])]
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, Math.max(s.MAX_IMAGES + 6, 16));
  const out: string[] = [];
  // checked 4 at a time, in Coach's gallery order
  for (let i = 0; i < candidates.length && out.length < s.MAX_IMAGES; i += 4) {
    const batch = candidates.slice(i, i + 4);
    const ok = await Promise.all(batch.map((suf) => (listed.has(suf) ? true : exists(`${base}_${suf}`))));
    batch.forEach((suf, j) => { if (ok[j] && out.length < s.MAX_IMAGES) out.push(`${base}_${suf}`); });
  }
  const alt = `Coach ${item.name} - ${item.colourName ?? item.colourCode}`;
  return out.map((u, i) => ({ url: `${u}?wid=${s.IMAGE_SIZE}&hei=${s.IMAGE_SIZE}&fmt=jpg&qlt=${s.IMAGE_QUALITY}`, alt: i === 0 ? alt : `${alt} (${i + 1})` }));
}
const rank = (suf: string) => { const i = ORDER.indexOf(suf); return i >= 0 ? i : 100 + Number(suf.replace(/\D/g, "")); };
