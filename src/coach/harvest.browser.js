// Coach catalog harvester - runs INSIDE a normal browser tab on https://www.coach.com (the Claude in-app browser).
// coach.com answers scripted requests (PC and GitHub cloud runner alike) with an Akamai 403, so the product data is
// collected ONCE through an ordinary browser session, one page at a time with a pause between pages, and handed to the
// cloud importer as a feed (data/coach-feed/*.json, see `node src/coach/cli.ts feed-import`). All Shopify work happens in
// the cloud (GitHub Actions). No stealth, no CAPTCHA handling: a 403 / 429 / challenge page stops the harvest.
//
// Usage (javascript_tool on a coach.com tab): paste this file, then
//   startCoachHarvest({ urls: [...product urls...], delayMs: 2500 })  -> returns immediately; progress: coachHarvestStatus()
//   coachHarvestExport(from, to)                                       -> JSON {manifest, entries[from..to)} once finished
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const KEEP_CA = /^c_(gender|department|classification|isOutlet|productReach|itemProductReachNum|material|materialVal|merchandiseClass|styleGroup|model|filterCategory|isDiscontinued|isFinalSale|isGiftCardProduct|isCoachtopia|color|liningMaterial|outsoleMaterial|upperMaterial|closureType|platformHeight|heelHeight|additionalDetails|aIFabricContent|aiColorBucket|isNew|isOnSale|productEnglishName|megaPDPStyleGroup)$/;
  const slimOffer = (o) => (o ? { price: o.price, priceCurrency: o.priceCurrency, availability: o.availability, url: o.url } : o);
  const slimLd = (x) => {
    if (x["@type"] === "BreadcrumbList") return { "@type": "BreadcrumbList", itemListElement: (x.itemListElement || []).map((i) => ({ position: i.position, name: i.name, item: i.item })) };
    const { aggregateRating, review, isSimilarTo, offers, hasVariant, ...rest } = x;
    const out = { ...rest };
    if (offers) out.offers = Array.isArray(offers) ? offers.map(slimOffer) : slimOffer(offers);
    if (hasVariant) out.hasVariant = hasVariant.map((v) => ({ ...v, image: (v.image || []).map((i) => (typeof i === "string" ? i : i.url)), offers: slimOffer(v.offers) }));
    return out;
  };
  const decodeFlight = (d) => {
    let out = "";
    for (const s of d.scripts) for (const m of s.textContent.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) { try { out += JSON.parse(`"${m[1]}"`); } catch { /* partial */ } }
    return out;
  };
  const findProduct = (o, depth = 0) => {
    if (!o || typeof o !== "object" || depth > 60) return null;
    if (!Array.isArray(o) && o.variationAttributes && o.pricingInfo && o.customAttributes) return o;
    for (const v of Object.values(o)) { const r = findProduct(v, depth + 1); if (r) return r; }
    return null;
  };
  const jsonString = (flight, key) => { const m = flight.match(new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`)); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } };
  const jsonArray = (flight, key) => { const m = flight.match(new RegExp(`"${key}":(\\[[^\\]]*\\])`)); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } };

  function parsePage(html, url, finalUrl) {
    const d = new DOMParser().parseFromString(html, "text/html");
    const title = (d.querySelector("title")?.textContent || "").trim();
    if (/access denied|just a moment|attention required|captcha|verify you are human|are you a robot/i.test(title)) throw Object.assign(new Error(`challenge page: ${title}`), { blocked: true });
    const ld = [];
    let webDesc = null;
    for (const s of d.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        for (const x of [].concat(JSON.parse(s.textContent))) {
          if (!x) continue;
          if (x["@type"] === "ProductGroup" || x["@type"] === "Product" || x["@type"] === "BreadcrumbList") ld.push(slimLd(x));
          if (x["@type"] === "WebPage" && typeof x.description === "string") webDesc = x.description;
        }
      } catch { /* malformed block */ }
    }
    if (!ld.some((x) => x["@type"] === "ProductGroup" || x["@type"] === "Product")) return null; // not a product page (withdrawn / redirected)
    const flight = decodeFlight(d);
    let main = null;
    const i = flight.indexOf('"variationAttributes"');
    if (i >= 0) {
      const row = flight.slice(flight.lastIndexOf("\n", i) + 1, flight.indexOf("\n", i) < 0 ? undefined : flight.indexOf("\n", i));
      try { main = findProduct(JSON.parse(row.slice(row.indexOf(":") + 1))); } catch { main = null; }
    }
    const slimMain = main && {
      id: main.id, masterId: main.masterId, orderable: main.orderable,
      customAttributes: Object.fromEntries(Object.entries(main.customAttributes || {}).filter(([k]) => KEEP_CA.test(k))),
      pricingInfo: main.pricingInfo, variationAttributes: main.variationAttributes, variantsAssigned: main.variantsAssigned, canonicals: main.canonicals,
      images: (main.imageGroups || []).filter((g) => g.viewType === "Product").flatMap((g) => g.images.map((im) => ({ src: im.src, alt: im.alt }))),
    };
    return {
      url, finalUrl, canonical: d.querySelector('link[rel="canonical"]')?.getAttribute("href") || null,
      title, ld, webDesc, main: slimMain,
      longDescription: jsonString(flight, "longDescription"),
      itemCategory: jsonArray(flight, "item_category"), categoryId: jsonString(flight, "category_id"),
      imageSequence: jsonString(flight, "categoryImageSequence"),
    };
  }

  window.coachHarvestStatus = () => { const { entries, urls, ...rest } = window.__coachHarvest || {}; return JSON.stringify({ ...rest, errors: (rest.errors || []).slice(-10) }); };
  window.coachHarvestExport = (from = 0, to = Infinity) => {
    const st = window.__coachHarvest;
    if (!st || st.state === "running") return JSON.stringify({ error: "harvest not finished" });
    const manifest = { run: st.run, harvestedAt: st.finishedAt, startedAt: st.startedAt, complete: st.state === "done" && st.failed === 0, listed: st.listed, fetched: st.fetched, parsed: st.parsed, gone: st.gone, failed: st.failed, entries: st.entries.length, from, stoppedReason: st.stoppedReason, errors: st.errors, source: "in-app browser on www.coach.com" };
    return JSON.stringify({ manifest, entries: st.entries.slice(from, to) });
  };

  window.startCoachHarvest = function startCoachHarvest({ urls, delayMs = 2500 } = {}) {
    if (window.__coachHarvest?.state === "running") return "already running";
    if (!Array.isArray(urls) || !urls.length) return "no urls";
    const st = (window.__coachHarvest = { state: "running", run: `H${Date.now().toString(36)}`, startedAt: new Date().toISOString(), listed: urls.length, fetched: 0, parsed: 0, gone: 0, failed: 0, errors: [], stoppedReason: null, entries: [], urls });
    (async () => {
      let consecutive = 0;
      for (const url of urls) {
        if (st.state !== "running") break;
        const t0 = Date.now();
        try {
          const res = await fetch(url, { credentials: "same-origin", headers: { Accept: "text/html" } });
          st.fetched++;
          if (res.status === 403 || res.status === 429) { st.state = "blocked"; st.stoppedReason = `HTTP ${res.status} at ${url}`; break; }
          if (res.status === 404 || res.status === 410) { st.gone++; st.entries.push({ url, gone: true, status: res.status }); }
          else if (!res.ok) throw new Error(`HTTP ${res.status}`);
          else {
            const e = parsePage(await res.text(), url, res.url);
            if (e) { st.entries.push(e); st.parsed++; } else { st.gone++; st.entries.push({ url, gone: true, finalUrl: res.url }); }
          }
          consecutive = 0;
        } catch (err) {
          if (err.blocked) { st.state = "blocked"; st.stoppedReason = String(err.message); break; }
          st.failed++; consecutive++;
          st.errors.push({ url, message: String(err.message || err) });
          if (consecutive >= 5) { st.state = "failed"; st.stoppedReason = "5 consecutive errors"; break; }
          await sleep(10_000);
        }
        const wait = delayMs - (Date.now() - t0);
        if (wait > 0) await sleep(wait);
      }
      if (st.state === "running") st.state = "done";
      st.finishedAt = new Date().toISOString();
    })();
    return `started ${st.run}: ${urls.length} urls`;
  };
})();
