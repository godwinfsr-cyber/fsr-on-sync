import { spawn } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { LOG_DIR, ROOT, hasShopifyCredentials } from "../config.ts";
import { errMsg } from "../util.ts";
import { MK_KEYS, type MkSettings } from "./config.ts";
import { allRows, currentMLock, getMkSettings, mdb, setMkSetting } from "./db.ts";
import { nextMkScheduledAt } from "./sync.ts";

// "GYMSHARK SYNC" section of the existing localhost-only dashboard (served at /michaelkors).
const EDITABLE: (keyof MkSettings)[] = [
  "SYNC_PAUSED", "SYNC_INTERVAL_HOURS", "SOURCE_MODE", "FEED_DIR", "FX_PROVIDER", "MANUAL_EXCHANGE_RATE", "MAX_EXCHANGE_RATE_AGE_HOURS", "WEIGHT_BANDS",
  "WEIGHT_SURCHARGE_FALLBACK_INR", "CATEGORY_WEIGHT_KG", "PROFIT_BANDS", "DEFAULT_ETA", "EXCLUDED_CATEGORIES", "REQUEST_DELAY_MS", "DRY_RUN", "SYNC_LIMIT",
  "SOURCE_PRICE_BASIS", "COMPARE_AT_MODE", "PRICE_ROUNDING_MODE", "PRODUCT_MISSING_CONFIRMATION_SCANS", "MIN_CATALOG_SIZE", "MISSING_ACTION",
  "NEW_PRODUCT_STATUS", "OVERWRITE_MANUAL_DESCRIPTION", "ADOPT_EXISTING_PRODUCTS", "PRODUCT_TYPE_MAP",
];
const HELP: Partial<Record<keyof MkSettings, string>> = {
  SYNC_PAUSED: "true = sync disabled",
  SYNC_INTERVAL_HOURS: "Hours between scheduled syncs",
  SOURCE_MODE: "http (michaelkors.com) | feed (authorized files in FEED_DIR)",
  FEED_DIR: "Folder of saved product pages / JSON-LD files",
  FX_PROVIDER: "open.er-api.com | frankfurter | manual",
  MANUAL_EXCHANGE_RATE: "₹ per $1, only for FX_PROVIDER=manual",
  MAX_EXCHANGE_RATE_AGE_HOURS: "Older rates are never used - prices pause instead",
  WEIGHT_BANDS: "Shipping: maxKg:₹ list, last band '+'",
  WEIGHT_SURCHARGE_FALLBACK_INR: "Shipping when Michael Kors states no weight",
  CATEGORY_WEIGHT_KG: "Optional owner weights per category, e.g. handbag:1.2,shoe:1.5",
  PROFIT_BANDS: "Profit: max landed ₹:profit ₹ list, last band '+'",
  DEFAULT_ETA: "Written to custom.eta",
  EXCLUDED_CATEGORIES: "Extra categories never imported (watches are always excluded)",
  REQUEST_DELAY_MS: "Gap between source requests (min 1000)",
  DRY_RUN: "true = never write to Shopify",
  SYNC_LIMIT: "Test product limit (0 = whole eligible catalog)",
  MIN_CATALOG_SIZE: "Scans with fewer eligible styles are SOURCE_SCAN_UNRELIABLE",
  MISSING_ACTION: "archive | draft (never deleted)",
};

function status() {
  const s = getMkSettings();
  const runs = mdb.prepare("SELECT id, mode, trigger, status, started_at, duration_ms, summary_json FROM sync_runs ORDER BY started_at DESC LIMIT 15").all() as
    { id: string; mode: string; trigger: string; status: string; started_at: string; duration_ms: number | null; summary_json: string | null }[];
  const lastOk = mdb.prepare("SELECT started_at FROM sync_runs WHERE status IN ('success','partial') AND mode = 'live' ORDER BY started_at DESC LIMIT 1").get() as { started_at: string } | undefined;
  const last = runs.find((r) => r.status !== "running");
  const summary = last?.summary_json ? JSON.parse(last.summary_json) : null;
  const fx = mdb.prepare("SELECT provider, rate, provider_updated_at, fetched_at FROM fx_rates WHERE ok = 1 ORDER BY fetched_at DESC LIMIT 1").get() ?? null;
  const fxErr = mdb.prepare("SELECT provider, fetched_at, error FROM fx_rates WHERE ok = 0 ORDER BY fetched_at DESC LIMIT 1").get() ?? null;
  return {
    paused: s.SYNC_PAUSED, dryRun: s.DRY_RUN, running: currentMLock(), shopifyConnected: hasShopifyCredentials(),
    lastSuccessfulSync: lastOk?.started_at ?? null, nextScheduledSync: nextMkScheduledAt(s), last: summary ? { ...summary, durationMs: last!.duration_ms } : null,
    fx, fxErr,
    runs: runs.map(({ summary_json, ...r }) => ({ ...r, counts: summary_json ? JSON.parse(summary_json).counts : null })),
    settings: Object.fromEntries(EDITABLE.map((k) => [k, s[k]])),
  };
}

function send(res: http.ServerResponse, code: number, body: string, type = "application/json") {
  res.writeHead(code, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
  res.end(body);
}
async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let data = "";
  for await (const chunk of req) { data += chunk; if (data.length > 100_000) throw new Error("body too large"); }
  return data ? JSON.parse(data) : {};
}

/** Handles /michaelkors and /api/michaelkors/*; returns false for other paths. POSTs are CSRF-checked by the caller. */
export async function handleMichaelKors(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/michaelkors" && !url.pathname.startsWith("/api/michaelkors/")) return false;
  try {
    if (req.method === "GET" && url.pathname === "/michaelkors") { send(res, 200, PAGE, "text/html"); return true; }
    if (req.method === "GET" && url.pathname === "/api/michaelkors/status") { send(res, 200, JSON.stringify(status())); return true; }
    if (req.method === "GET" && url.pathname === "/api/michaelkors/products") {
      send(res, 200, JSON.stringify(allRows().map((r) => ({
        style: r.style_code, title: r.title, category: r.category, colours: r.colours ? JSON.parse(r.colours).length : 0, status: r.last_sync_status, shopify: r.shopify_product_id,
        usd: r.source_price_usd, regular: r.source_regular_price_usd, fsr: r.fsr_selling_price, rate: r.exchange_rate, surcharge: r.weight_surcharge_inr, availability: r.availability,
        synced: r.last_synced_at, missing: r.missing_scans, error: r.error_message, url: r.source_url,
      }))));
      return true;
    }
    const rep = url.pathname.match(/^\/api\/michaelkors\/runs\/(MICHAELKORS-SYNC-[\d-]+)\/report$/);
    if (req.method === "GET" && rep) {
      const f = path.join(LOG_DIR, `${rep[1]}.report.txt`);
      if (fs.existsSync(f)) send(res, 200, fs.readFileSync(f, "utf-8"), "text/plain"); else send(res, 404, "report not found", "text/plain");
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/michaelkors/sync") {
      if (currentMLock()) { send(res, 409, JSON.stringify({ error: "A Michael Kors sync is already running" })); return true; }
      const body = await readBody(req);
      const args = ["src/michaelkors/cli.ts", "sync", "--trigger", "dashboard"];
      if (body.mode === "dry") args.push("--dry-run");
      if (Number(body.limit) > 0) args.push("--limit", String(Number(body.limit)));
      const out = fs.openSync(path.join(LOG_DIR, "michaelkors-dashboard-runs.log"), "a");
      spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ["ignore", out, out], windowsHide: true }).unref();
      send(res, 202, JSON.stringify({ started: true }));
      return true;
    }
    if (req.method === "POST" && (url.pathname === "/api/michaelkors/pause" || url.pathname === "/api/michaelkors/resume")) {
      setMkSetting("SYNC_PAUSED", url.pathname.endsWith("/pause"));
      send(res, 200, JSON.stringify({ paused: getMkSettings().SYNC_PAUSED }));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/michaelkors/settings") {
      const body = await readBody(req);
      const errors: string[] = [];
      const current = getMkSettings() as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(body)) {
        if (!EDITABLE.includes(k as keyof MkSettings) || !(MK_KEYS as string[]).includes(k)) { errors.push(`${k}: not editable`); continue; }
        if (String(current[k]) === String(v) && k !== "MANUAL_EXCHANGE_RATE") continue;
        try { setMkSetting(k as keyof MkSettings, v); } catch (e) { errors.push(errMsg(e)); }
      }
      send(res, errors.length ? 400 : 200, JSON.stringify({ errors, settings: status().settings }));
      return true;
    }
    send(res, 404, JSON.stringify({ error: "not found" }));
  } catch (e) {
    send(res, 500, JSON.stringify({ error: errMsg(e) }));
  }
  return true;
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Michael Kors Sync</title>
<style>
:root{--bg:#f6f6f1;--fg:#111;--muted:#6b6b66;--line:#e3e2da;--card:#fff;--ok:#1f7a3d;--warn:#a15c00;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e0e;--fg:#f2f2ee;--muted:#a3a39d;--line:#2a2a28;--card:#161615;--ok:#5fcf85;--warn:#e0a44a;--bad:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 64px}h1{font-size:28px;margin:0 0 4px;letter-spacing:-.02em}h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;margin:32px 0 12px;color:var(--muted)}
.sub{color:var(--muted);margin:0 0 20px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);padding:14px}.k{color:var(--muted);font-size:12px}.v{font-size:18px;font-weight:600;margin-top:2px;word-break:break-word}
.btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}button{font:inherit;padding:9px 14px;border:1px solid var(--fg);background:var(--fg);color:var(--bg);cursor:pointer}
button.ghost{background:transparent;color:var(--fg)}button:disabled{opacity:.4;cursor:default}input,select{font:inherit;padding:7px 8px;border:1px solid var(--line);background:var(--card);color:var(--fg);width:100%}
form{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}label span{display:block;font-size:12px;color:var(--muted);margin-bottom:3px}label small{display:block;color:var(--muted);font-size:11px;margin-top:2px}
.tbl{overflow-x:auto;border:1px solid var(--line);background:var(--card)}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted);font-weight:500}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}pre{white-space:pre-wrap;background:var(--card);border:1px solid var(--line);padding:12px;max-height:520px;overflow:auto;font-size:12px}
.banner{border:1px solid var(--warn);color:var(--warn);padding:10px 12px;margin:8px 0}a{color:inherit}nav a{margin-right:14px}
</style></head><body><main>
<nav class="sub"><a href="/">ON.com Sync</a><a href="/tissot">Tissot India Sync</a><a href="/gymshark">Gymshark Sync</a><a href="/alo">ALO Yoga Sync</a><strong>Michael Kors Sync</strong></nav>
<h1>MICHAEL KORS SYNC</h1><p class="sub">michaelkors.com (USD) → Full Size Run · USD × live rate + weight shipping + profit band · ETA 15–20 Days · watches excluded · authorized importer</p>
<div id="banners"></div>
<div class="grid" id="stats"></div>
<div class="btns">
<button id="run">Run Michael Kors Sync Now</button><button class="ghost" id="dry">Dry Run</button>
<button class="ghost" id="pause">Pause Michael Kors Sync</button><button class="ghost" id="resume">Resume Michael Kors Sync</button>
</div>
<h2>Settings</h2><form id="cfg"></form><div class="btns"><button id="save">Save settings</button><span id="saveMsg" class="k"></span></div>
<h2>Sync history</h2><div class="tbl"><table id="runs"></table></div><pre id="report" hidden></pre>
<h2>Products</h2><div class="tbl"><table id="products"></table></div>
</main><script>
const HELP=${JSON.stringify(HELP)};
const api=(p,o={})=>fetch(p,{...o,headers:{'Content-Type':'application/json','X-Requested-With':'on-sync'}}).then(async r=>{const t=await r.text();try{return JSON.parse(t)}catch{return t}});
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const when=iso=>iso?new Date(iso).toLocaleString():'—';
const inr=v=>v==null?'—':'₹'+Number(v).toLocaleString('en-IN',{maximumFractionDigits:2});
const usd=v=>v==null?'—':'$'+Number(v).toFixed(2);
let cfgBuilt=false;
async function refresh(){
 const s=await api('/api/michaelkors/status');const c=s.last?.counts||{};
 const st=s.running?'<span class="warn">Running '+esc(s.running.id)+'</span>':s.paused?'<span class="warn">Paused</span>':'<span class="ok">Active</span>';
 const fx=s.fx?('₹'+Number(s.fx.rate).toFixed(4)+' <span class="k">'+esc(s.fx.provider)+' · '+when(s.fx.fetched_at)+'</span>'):'<span class="bad">none</span>';
 const cards=[['Status',st],['Mode',s.dryRun?'Dry run':'Live'],['USD → INR',fx],['Last successful sync',when(s.lastSuccessfulSync)],['Next scheduled sync',s.paused?'Paused':when(s.nextScheduledSync)],
  ['Styles found',c.styles??'—'],['Created',c.created??'—'],['Updated',c.updated??'—'],['Unchanged',c.unchanged??'—'],['Price changes',c.priceChanges??'—'],['Needs review',c.needsReview??'—'],['Failed',c.failed??'—'],
  ['Last sync duration',s.last?.durationMs!=null?Math.round(s.last.durationMs/1000)+'s':'—']];
 document.getElementById('stats').innerHTML=cards.map(([k,v])=>'<div class="card"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join('');
 const b=[];if(!s.shopifyConnected)b.push('Shopify Admin API credentials are not configured - live syncs are disabled.');
 
 if(s.settings.DRY_RUN)b.push('DRY_RUN is on - scheduled syncs only report proposed changes.');
 if(s.last?.fx&&!s.last.fx.ok)b.push('Last sync had NO valid exchange rate - price updates were paused: '+s.last.fx.reason);
 if(s.fxErr&&(!s.fx||s.fxErr.fetched_at>s.fx.fetched_at))b.push('Latest exchange-rate fetch failed ('+s.fxErr.fetched_at+'): '+s.fxErr.error);
 document.getElementById('banners').innerHTML=b.map(x=>'<div class="banner">'+esc(x)+'</div>').join('');
 document.getElementById('run').disabled=!!s.running;document.getElementById('dry').disabled=!!s.running;
 if(!cfgBuilt){document.getElementById('cfg').innerHTML=Object.entries(s.settings).map(([k,v])=>'<label><span>'+k+'</span>'+(typeof v==='boolean'?'<select name="'+k+'"><option value="true"'+(v?' selected':'')+'>true</option><option value="false"'+(!v?' selected':'')+'>false</option></select>':'<input name="'+k+'" value="'+esc(v)+'">')+'<small>'+esc(HELP[k]||'')+'</small></label>').join('');cfgBuilt=true;}
 document.getElementById('runs').innerHTML='<tr><th>Sync ID</th><th>Mode</th><th>Trigger</th><th>Status</th><th>Started</th><th>Duration</th><th>Styles</th><th>New</th><th>Upd.</th><th>Same</th><th>Failed</th><th></th></tr>'+
  s.runs.map(r=>{const k=r.counts||{};const cls=r.status==='success'?'ok':r.status==='partial'||r.status==='running'?'warn':'bad';
  return '<tr><td>'+esc(r.id)+'</td><td>'+r.mode+'</td><td>'+esc(r.trigger)+'</td><td class="'+cls+'">'+r.status+'</td><td>'+when(r.started_at)+'</td><td>'+(r.duration_ms?Math.round(r.duration_ms/1000)+'s':'—')+'</td><td>'+(k.styles??'')+'</td><td>'+(k.created??'')+'</td><td>'+(k.updated??'')+'</td><td>'+(k.unchanged??'')+'</td><td>'+(k.failed??'')+'</td><td><a href="#" data-r="'+esc(r.id)+'">report</a></td></tr>'}).join('');
 const ps=await api('/api/michaelkors/products');
 document.getElementById('products').innerHTML='<tr><th>Style</th><th>Title</th><th>Category</th><th>Colours</th><th>Status</th><th>Michael Kors (from)</th><th>Rate</th><th>Surcharge</th><th>FSR price (from)</th><th>Availability</th><th>Last synced</th><th>Missing</th><th>Error</th></tr>'+
  ps.map(p=>'<tr><td><a href="'+esc(p.url)+'" target="_blank" rel="noopener">'+esc(p.style)+'</a></td><td>'+esc(p.title)+'</td><td>'+esc(p.category)+'</td><td>'+p.colours+'</td><td>'+esc(p.status)+'</td><td>'+usd(p.usd)+(p.regular&&p.regular>p.usd?' <span class="k">was '+usd(p.regular)+'</span>':'')+'</td><td>'+(p.rate??'—')+'</td><td>'+inr(p.surcharge)+'</td><td>'+inr(p.fsr)+'</td><td>'+esc(p.availability)+'</td><td>'+when(p.synced)+'</td><td>'+(p.missing||'')+'</td><td class="bad">'+esc(p.error||'')+'</td></tr>').join('');
}
document.addEventListener('click',async e=>{const a=e.target.closest('a[data-r]');if(!a)return;e.preventDefault();const pre=document.getElementById('report');pre.hidden=false;pre.textContent=await api('/api/michaelkors/runs/'+a.dataset.r+'/report');pre.scrollIntoView({behavior:'smooth'});});
document.getElementById('run').onclick=async()=>{const r=await api('/api/michaelkors/sync',{method:'POST',body:'{}'});alert(r.error||'Michael Kors sync started (uses the DRY_RUN and SYNC_LIMIT settings).');refresh();};
document.getElementById('dry').onclick=async()=>{const n=prompt('Dry run: how many styles? (0 = whole catalog)','5');if(n===null)return;const r=await api('/api/michaelkors/sync',{method:'POST',body:JSON.stringify({mode:'dry',limit:Number(n)||0})});alert(r.error||'Dry run started.');refresh();};
document.getElementById('pause').onclick=async()=>{await api('/api/michaelkors/pause',{method:'POST'});refresh();};
document.getElementById('resume').onclick=async()=>{await api('/api/michaelkors/resume',{method:'POST'});refresh();};
document.getElementById('save').onclick=async()=>{const body={};for(const el of document.getElementById('cfg').elements)body[el.name]=el.value;const r=await api('/api/michaelkors/settings',{method:'POST',body:JSON.stringify(body)});document.getElementById('saveMsg').textContent=r.errors?.length?r.errors.join('; '):'Saved.';};
refresh();setInterval(refresh,10000);
</script></body></html>`;

