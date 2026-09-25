// Michael Kors catalog harvester - runs INSIDE a normal browser tab on https://www.michaelkors.com (the Claude
// in-app browser). It reads the robots.txt-listed product sitemap and each product page's own structured data,
// one page at a time with a pause between pages, and hands the pages to the local importer
// through window.mkHarvestExport() (read by `node src/michaelkors/cli.ts feed-import <file>`). No stealth, no CAPTCHA handling: a 403 / 429 / challenge
// page stops the harvest, which is then reported incomplete (the previous feed is kept).
//
// Usage (javascript_tool on the michaelkors.com tab): paste this file, then
//   startMkHarvest({ delayMs: 2000, limit: 0 })   -> returns immediately; progress: mkHarvestStatus()
//   mkHarvestExport()                             -> JSON {manifest, entries} once state is done / blocked / failed
(() => {
  const WATCH_SLUG = /(^|-)(smart)?watch(es)?(-|$)|(^|-)time-?pieces?(-|$)/i;
  const MIRROR = /\/(us\/es|ca\/en|ca\/fr)\//i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  const styleOf = (u) => { const m = new URL(u).pathname.match(/\/([^/]+)\/([A-Za-z0-9][A-Za-z0-9._-]*)\.html$/); return m ? { slug: m[1], style: decodeURIComponent(m[2]).toUpperCase() } : null; };
  const slimOffer = (o) => (o ? { price: o.price, priceCurrency: o.priceCurrency, availability: o.availability, url: o.url, priceSpecification: o.priceSpecification } : o);
  const slim = (x) => {
    if (x["@type"] === "BreadcrumbList") return { "@type": "BreadcrumbList", itemListElement: (x.itemListElement || []).map((i) => ({ position: i.position, name: i.name, item: i.item })) };
    const { aggregateRating, review, offers, hasVariant, hasMerchantReturnPolicy, ...rest } = x;
    const out = { ...rest };
    if (offers) out.offers = Array.isArray(offers) ? offers.map(slimOffer) : slimOffer(offers);
    if (hasVariant) out.hasVariant = hasVariant.map((v) => { const { offers: o, description, ...r } = v; return { ...r, offers: slimOffer(o) }; });
    return out;
  };

  function parsePage(html, url) {
    const d = new DOMParser().parseFromString(html, "text/html");
    const title = (d.querySelector("title")?.textContent || "").trim();
    if (/access denied|just a moment|attention required|captcha|verify you are human|are you a robot/i.test(title)) throw Object.assign(new Error(`challenge page: ${title}`), { blocked: true });
    const ld = [];
    for (const s of d.querySelectorAll('script[type="application/ld+json"]')) {
      try { const j = JSON.parse(s.textContent); for (const x of [].concat(j)) if (x && (x["@type"] === "ProductGroup" || x["@type"] === "Product" || x["@type"] === "BreadcrumbList")) ld.push(slim(x)); } catch { /* review widgets etc. */ }
    }
    if (!ld.some((x) => x["@type"] === "ProductGroup" || x["@type"] === "Product")) return null; // not a product page (withdrawn / redirected)
    const canonical = d.querySelector('link[rel="canonical"]')?.getAttribute("href") || null;
    const details = d.querySelector("#nav-details");
    const own = d.querySelector(".product-detail[data-pid] .default-price") || d.querySelector("[data-pid] .default-price");
    const num = (el) => { const v = Number(el?.getAttribute("content")); return Number.isFinite(v) && v > 0 ? v : null; };
    return {
      url, canonical, ld,
      detailsHtml: details ? details.innerHTML.replace(/\s+/g, " ").trim() : null,
      listPrice: num(own?.querySelector(".list .value")),
      salePrice: num(own?.querySelector(".sales .value")),
    };
  }

  window.mkHarvestStatus = () => { const { entries, ...rest } = window.__mkHarvest || {}; return JSON.stringify({ ...rest, errors: (rest.errors || []).slice(-10) }); };
  window.mkHarvestExport = () => {
    const st = window.__mkHarvest;
    if (!st || st.state === "running") return JSON.stringify({ error: "harvest not finished" });
    const manifest = { run: st.run, harvestedAt: st.finishedAt, startedAt: st.startedAt, complete: st.state === "done" && st.limit === 0 && st.failed === 0, listed: st.listed, fetched: st.fetched, failed: st.failed, watchUrls: st.watchUrls, entries: st.entries.length, stoppedReason: st.stoppedReason, source: "in-app browser on www.michaelkors.com" };
    return JSON.stringify({ manifest, entries: st.entries });
  };

  window.startMkHarvest = function startMkHarvest({ delayMs = 2000, limit = 0 } = {}) {
    if (window.__mkHarvest?.state === "running") return "already running";
    const st = (window.__mkHarvest = { state: "running", run: `H${Date.now().toString(36)}`, startedAt: new Date().toISOString(), limit, listed: 0, watchUrls: 0, toFetch: 0, fetched: 0, parsed: 0, gone: 0, failed: 0, errors: [], stoppedReason: null, entries: [] });
    (async () => {
      try {
        const idx = await fetch("/sitemap_index.xml");
        if (!idx.ok) throw Object.assign(new Error(`sitemap index HTTP ${idx.status}`), { blocked: idx.status === 403 || idx.status === 429 });
        const sitemaps = locs(await idx.text()).filter((u) => /sitemap_\d+-product\.xml$/i.test(u) && !MIRROR.test(u));
        if (!sitemaps.length) throw new Error("no product sitemap in the index");
        const byStyle = new Map();
        for (const sm of sitemaps) {
          await sleep(delayMs);
          const r = await fetch(new URL(sm).pathname);
          if (!r.ok) throw Object.assign(new Error(`${sm} HTTP ${r.status}`), { blocked: r.status === 403 || r.status === 429 });
          for (const u of locs(await r.text())) {
            if (MIRROR.test(u)) continue;
            const s = styleOf(u);
            if (s && !byStyle.has(s.style)) byStyle.set(s.style, { ...s, url: u });
          }
        }
        let pages = [...byStyle.values()];
        st.listed = pages.length;
        const watch = pages.filter((p) => WATCH_SLUG.test(p.slug.replace(/watch-hunger-stop/gi, "")));
        st.watchUrls = watch.length;
        pages = pages.filter((p) => !watch.includes(p));
        if (limit > 0) pages = pages.slice(0, limit);
        st.toFetch = pages.length;
        for (const p of pages) {
          if (st.state === "stopping") throw new Error("stopped by operator");
          await sleep(delayMs);
          let r;
          try { r = await fetch(new URL(p.url).pathname); }
          catch (e) { st.failed++; st.errors.push(`${p.style}: network ${e.message}`); continue; }
          st.fetched++;
          if (r.status === 403 || r.status === 429) throw Object.assign(new Error(`HTTP ${r.status} on ${p.url}`), { blocked: true });
          if (r.status === 404 || r.status === 410) { st.gone++; continue; }
          if (!r.ok) { st.failed++; st.errors.push(`${p.style}: HTTP ${r.status}`); continue; }
          try {
            const e = parsePage(await r.text(), p.url);
            if (!e) { st.gone++; continue; }
            st.entries.push(e); st.parsed++;
          } catch (e) {
            if (e.blocked) throw e;
            st.failed++; st.errors.push(`${p.style}: ${e.message}`);
          }
        }
        st.state = "done";
      } catch (e) {
        st.stoppedReason = e.message;
        st.state = e.blocked ? "blocked" : "failed";
      }
      st.finishedAt = new Date().toISOString();
    })();
    return `started ${st.run}`;
  };
  return "harvester loaded";
})();
