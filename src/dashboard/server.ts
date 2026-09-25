import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DASHBOARD_PORT, LOG_DIR, ROOT, SETTING_KEYS, hasShopifyCredentials, type Settings } from "../config.ts";
import { allProducts, currentLock, db, getSettings, setSetting } from "../db.ts";
import { nextScheduledAt } from "../sync.ts";
import { errMsg } from "../util.ts";

// Localhost-only admin UI (no auth, so it never binds to a public interface).
const HOST = "127.0.0.1";

const EDITABLE: (keyof Settings)[] = [
  "SYNC_INTERVAL_HOURS", "DEFAULT_ETA", "MARKUP_TYPE", "MARKUP_VALUE", "EXCHANGE_RATE", "EXCHANGE_RATE_BUFFER_PCT", "MIN_PROFIT",
  "ROUNDING_RULE", "COMPARE_AT_MODE", "PRODUCT_MISSING_CONFIRMATION_SCANS", "MISSING_ACTION", "NEW_PRODUCT_STATUS", "SYNC_LIMIT",
  "DRY_RUN", "CONTENT_REUSE_CONFIRMED", "ADOPT_EXISTING_PRODUCTS",
];

function status() {
  const s = getSettings();
  const runs = db.prepare("SELECT id, mode, trigger, status, started_at, finished_at, duration_ms, summary_json FROM sync_runs ORDER BY started_at DESC LIMIT 15").all() as
    { id: string; mode: string; trigger: string; status: string; started_at: string; finished_at: string | null; duration_ms: number | null; summary_json: string | null }[];
  const lastOk = db.prepare("SELECT id, started_at FROM sync_runs WHERE status IN ('success','partial') AND mode = 'live' ORDER BY started_at DESC LIMIT 1").get() as { id: string; started_at: string } | undefined;
  const last = runs.find((r) => r.status !== "running");
  const lastSummary = last?.summary_json ? JSON.parse(last.summary_json) : null;
  return {
    paused: s.SYNC_PAUSED, dryRun: s.DRY_RUN, running: currentLock(), shopifyConnected: hasShopifyCredentials(),
    lastSuccessfulSync: lastOk?.started_at ?? null, nextScheduledSync: nextScheduledAt(s), last: lastSummary,
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    // Basic CSRF guard: state-changing requests must come from this page.
    if (req.method === "POST" && req.headers["x-requested-with"] !== "on-sync") return send(res, 403, JSON.stringify({ error: "forbidden" }));

    if (req.method === "GET" && url.pathname === "/") return send(res, 200, PAGE, "text/html");
    if (req.method === "GET" && url.pathname === "/api/status") return send(res, 200, JSON.stringify(status()));
    if (req.method === "GET" && url.pathname === "/api/products") {
      const rows = allProducts().map((r) => ({ id: r.source_product_id, title: r.title, status: r.last_sync_status, shopify: r.shopify_product_id, price: r.last_source_price, fsr: r.last_fsr_price, seen: r.last_seen_at, synced: r.last_synced_at, missing: r.missing_scans, error: r.error_message, url: r.source_url }));
      return send(res, 200, JSON.stringify(rows));
    }
    const rep = url.pathname.match(/^\/api\/runs\/(SYNC-[\d-]+)\/report$/);
    if (req.method === "GET" && rep) {
      const f = path.join(LOG_DIR, `${rep[1]}.report.txt`);
      return fs.existsSync(f) ? send(res, 200, fs.readFileSync(f, "utf-8"), "text/plain") : send(res, 404, "report not found", "text/plain");
    }
    if (req.method === "POST" && url.pathname === "/api/sync") {
      if (currentLock()) return send(res, 409, JSON.stringify({ error: "A sync is already running" }));
      const body = await readBody(req);
      const args = ["src/cli.ts", "sync", "--trigger", "dashboard"];
      if (body.mode === "dry") args.push("--dry-run");
      if (body.mode === "live") args.push("--live");
      if (Number(body.limit) > 0) args.push("--limit", String(Number(body.limit)));
      const out = fs.openSync(path.join(LOG_DIR, "dashboard-runs.log"), "a");
      spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ["ignore", out, out], windowsHide: true }).unref();
      return send(res, 202, JSON.stringify({ started: true }));
    }
    if (req.method === "POST" && (url.pathname === "/api/pause" || url.pathname === "/api/resume")) {
      setSetting("SYNC_PAUSED", url.pathname === "/api/pause");
      return send(res, 200, JSON.stringify({ paused: getSettings().SYNC_PAUSED }));
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      const body = await readBody(req);
      const errors: string[] = [];
      for (const [k, v] of Object.entries(body)) {
        if (!EDITABLE.includes(k as keyof Settings) || !(SETTING_KEYS as string[]).includes(k)) { errors.push(`${k}: not editable`); continue; }
        try { setSetting(k as keyof Settings, v); } catch (e) { errors.push(errMsg(e)); }
      }
      return send(res, errors.length ? 400 : 200, JSON.stringify({ errors, settings: status().settings }));
    }
    send(res, 404, JSON.stringify({ error: "not found" }));
  } catch (e) {
    send(res, 500, JSON.stringify({ error: errMsg(e) }));
  }
});

server.listen(DASHBOARD_PORT, HOST, () => console.log(`ON Sync dashboard: http://${HOST}:${DASHBOARD_PORT}`));

const FIELD_HELP: Partial<Record<keyof Settings, string>> = {
  SYNC_INTERVAL_HOURS: "Hours between scheduled syncs",
  DEFAULT_ETA: "Written to custom.eta on new products",
  MARKUP_TYPE: "percentage | fixed",
  MARKUP_VALUE: "% or ₹ depending on type",
  EXCHANGE_RATE: "₹ per 1 USD (0 = not set)",
  EXCHANGE_RATE_BUFFER_PCT: "Extra % on the rate",
  MIN_PROFIT: "Minimum ₹ over converted cost",
  ROUNDING_RULE: "none, nearest_10, nearest_100, ceil_100, ceil_500, ceil_1000, end_99, end_999",
  COMPARE_AT_MODE: "source_list | none",
  PRODUCT_MISSING_CONFIRMATION_SCANS: "Scans before acting on a vanished product",
  MISSING_ACTION: "archive | draft | unavailable",
  NEW_PRODUCT_STATUS: "ACTIVE | DRAFT",
  SYNC_LIMIT: "0 = whole catalog",
  DRY_RUN: "true = never write to Shopify",
  CONTENT_REUSE_CONFIRMED: "Only after confirming permission to reuse ON images/text",
  ADOPT_EXISTING_PRODUCTS: "Link manual products that share an ON SKU",
};

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ON.com Sync</title>
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
.banner{border:1px solid var(--warn);color:var(--warn);padding:10px 12px;margin:8px 0}a{color:inherit}
</style></head><body><main>
<h1>ON.com Sync</h1><p class="sub">ON US · Last Season · Shoes → Full Size Run (fullsizerun.in)</p>
<div id="banners"></div>
<div class="grid" id="stats"></div>
<div class="btns">
<button id="run">Run Sync Now</button><button class="ghost" id="dry">Dry Run (5 products)</button>
<button class="ghost" id="pause">Pause Sync</button><button class="ghost" id="resume">Resume Sync</button>
</div>
<h2>Configuration</h2><form id="cfg"></form><div class="btns"><button id="save">Save configuration</button><span id="saveMsg" class="k"></span></div>
<h2>Sync history</h2><div class="tbl"><table id="runs"></table></div><pre id="report" hidden></pre>
<h2>Products</h2><div class="tbl"><table id="products"></table></div>
</main><script>
const HELP=${JSON.stringify(FIELD_HELP)};
const api=(p,o={})=>fetch(p,{...o,headers:{'Content-Type':'application/json','X-Requested-With':'on-sync'}}).then(async r=>{const t=await r.text();try{return JSON.parse(t)}catch{return t}});
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const when=iso=>iso?new Date(iso).toLocaleString():'—';
let cfgBuilt=false;
async function refresh(){
 const s=await api('/api/status'); const c=s.last?.counts||{};
 const st=s.running?'<span class="warn">Running '+esc(s.running.id)+'</span>':s.paused?'<span class="warn">Paused</span>':'<span class="ok">Active</span>';
 const cards=[['Status',st],['Mode',s.dryRun?'Dry run':'Live'],['Last successful sync',when(s.lastSuccessfulSync)],['Next scheduled sync',s.paused?'Paused':when(s.nextScheduledSync)],
  ['Products discovered',c.discovered??'—'],['Products synced',(c.created??0)+(c.updated??0)+(c.unchanged??0)],['Products failed',c.failed??'—'],['Shopify',s.shopifyConnected?'<span class="ok">Credentials set</span>':'<span class="bad">Not connected</span>']];
 document.getElementById('stats').innerHTML=cards.map(([k,v])=>'<div class="card"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join('');
 const b=[]; if(!s.shopifyConnected)b.push('Shopify Admin API credentials are not configured - live syncs are disabled (see README).');
 if(!s.settings.CONTENT_REUSE_CONFIRMED)b.push('Content reuse not confirmed - ON images and description text are withheld from Shopify.');
 if(!(s.settings.EXCHANGE_RATE>0))b.push('Exchange rate not set - prices cannot be calculated.');
 document.getElementById('banners').innerHTML=b.map(x=>'<div class="banner">'+esc(x)+'</div>').join('');
 document.getElementById('run').disabled=!!s.running; document.getElementById('dry').disabled=!!s.running;
 if(!cfgBuilt){document.getElementById('cfg').innerHTML=Object.entries(s.settings).map(([k,v])=>'<label><span>'+k+'</span>'+(typeof v==='boolean'?'<select name="'+k+'"><option value="true"'+(v?' selected':'')+'>true</option><option value="false"'+(!v?' selected':'')+'>false</option></select>':'<input name="'+k+'" value="'+esc(v)+'">')+'<small>'+esc(HELP[k]||'')+'</small></label>').join('');cfgBuilt=true;}
 document.getElementById('runs').innerHTML='<tr><th>Sync ID</th><th>Mode</th><th>Trigger</th><th>Status</th><th>Started</th><th>Duration</th><th>Disc.</th><th>New</th><th>Upd.</th><th>Same</th><th>Failed</th><th></th></tr>'+
  s.runs.map(r=>{const k=r.counts||{};const cls=r.status==='success'?'ok':r.status==='partial'||r.status==='running'?'warn':'bad';
  return '<tr><td>'+esc(r.id)+'</td><td>'+r.mode+'</td><td>'+esc(r.trigger)+'</td><td class="'+cls+'">'+r.status+'</td><td>'+when(r.started_at)+'</td><td>'+(r.duration_ms?Math.round(r.duration_ms/1000)+'s':'—')+'</td><td>'+(k.discovered??'')+'</td><td>'+(k.created??'')+'</td><td>'+(k.updated??'')+'</td><td>'+(k.unchanged??'')+'</td><td>'+(k.failed??'')+'</td><td><a href="#" data-r="'+esc(r.id)+'">report</a></td></tr>'}).join('');
 const ps=await api('/api/products');
 document.getElementById('products').innerHTML='<tr><th>ON SKU</th><th>Title</th><th>Status</th><th>Source $</th><th>FSR ₹</th><th>Last seen</th><th>Last synced</th><th>Missing</th><th>Error</th></tr>'+
  ps.map(p=>'<tr><td><a href="'+esc(p.url)+'" target="_blank" rel="noopener">'+esc(p.id)+'</a></td><td>'+esc(p.title)+'</td><td>'+esc(p.status)+'</td><td>'+(p.price??'')+'</td><td>'+(p.fsr??'')+'</td><td>'+when(p.seen)+'</td><td>'+when(p.synced)+'</td><td>'+(p.missing||'')+'</td><td class="bad">'+esc(p.error||'')+'</td></tr>').join('');
}
document.addEventListener('click',async e=>{const a=e.target.closest('a[data-r]');if(!a)return;e.preventDefault();const pre=document.getElementById('report');pre.hidden=false;pre.textContent=await api('/api/runs/'+a.dataset.r+'/report');pre.scrollIntoView({behavior:'smooth'});});
document.getElementById('run').onclick=async()=>{const r=await api('/api/sync',{method:'POST',body:'{}'});alert(r.error||'Sync started (uses the DRY_RUN setting).');refresh();};
document.getElementById('dry').onclick=async()=>{const r=await api('/api/sync',{method:'POST',body:JSON.stringify({mode:'dry',limit:5})});alert(r.error||'Dry run started.');refresh();};
document.getElementById('pause').onclick=async()=>{await api('/api/pause',{method:'POST'});refresh();};
document.getElementById('resume').onclick=async()=>{await api('/api/resume',{method:'POST'});refresh();};
document.getElementById('save').onclick=async()=>{const body={};for(const el of document.getElementById('cfg').elements)body[el.name]=el.value;const r=await api('/api/settings',{method:'POST',body:JSON.stringify(body)});document.getElementById('saveMsg').textContent=r.errors?.length?r.errors.join('; '):'Saved.';};
refresh();setInterval(refresh,10000);
</script></body></html>`;

