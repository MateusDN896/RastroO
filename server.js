// server.js — RastroO (com tudo embutido)
// by DN & Chat

const express = require('express');
const path = require('path');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// -------------------- CORS (allowlist) --------------------
const ALLOWED = new Set([
  'https://rastroo.site',
  'https://www.rastroo.site',
  'https://trk.rastroo.site',
  'https://896.xpages.co' // xQuiz (xpages)
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    // res.setHeader('Access-Control-Allow-Credentials', 'true'); // se um dia precisar
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ==========================================================
//  STORAGE EM MEMÓRIA (simples pra funcionar AGORA)
//  (Se reiniciar/deploy, os dados zeram. Depois trocamos p/ SQLite.)
// ==========================================================
const DB = { events: [] };
// evento: { ts, type: 'hit'|'lead'|'sale', creator, email?, orderId?, amount?, meta? }

// -------------------- Helpers --------------------
const z2 = (n) => String(n).padStart(2,'0');
const ymd = (d) => `${d.getFullYear()}-${z2(d.getMonth()+1)}-${z2(d.getDate())}`;
function inRange(ts, fromStr, toStr) {
  if (!fromStr && !toStr) return true;
  const d = new Date(ts);
  const from = fromStr ? new Date(fromStr + 'T00:00:00Z') : null;
  const to   = toStr   ? new Date(toStr   + 'T23:59:59Z') : null;
  if (from && d < from) return false;
  if (to   && d > to)   return false;
  return true;
}
function summarize(events, from, to) {
  const rows = events.filter(e => inRange(e.ts, from, to));
  const per = new Map();
  let hits=0, leads=0, sales=0, revenue=0;
  for (const e of rows) {
    const c = (e.creator || '—').trim();
    if (!per.has(c)) per.set(c, { creator:c, hits:0, leads:0, sales:0, revenue:0 });
    const r = per.get(c);
    if (e.type === 'hit')  { r.hits++;  hits++; }
    if (e.type === 'lead') { r.leads++; leads++; }
    if (e.type === 'sale') { r.sales++; sales++; r.revenue += (e.amount||0); revenue += (e.amount||0); }
  }
  const perCreator = [...per.values()].map(r => ({
    ...r,
    cr_h_to_l: r.hits ? Math.round((r.leads/r.hits)*100) : 0,
    cr_l_to_v: r.leads ? Math.round((r.sales/r.leads)*100) : 0
  }));
  return { summary: { hits, leads, sales, revenue }, perCreator };
}

// ==========================================================
//  SDK / SNIPPET EMBUTIDO (serve em /public/snippet.js)
// ==========================================================
const SNIPPET_JS = `
// RastroO snippet (client-side)
// Usa window.RASTROO_API ou location.origin
(function(){
  var API = (window.RASTROO_API || location.origin).replace(/\\/$/,'');
  var LSKEY = 'rastroo_attr';
  var once  = false;

  function parseQS(){
    var out = {}, q = new URLSearchParams(location.search || '');
    q.forEach((v,k)=>{ out[k]=v; });
    return out;
  }
  function loadAttr(){
    try { return JSON.parse(localStorage.getItem(LSKEY) || '{}'); } catch(_){ return {}; }
  }
  function saveAttr(obj){
    try { localStorage.setItem(LSKEY, JSON.stringify(obj)); } catch(_){}
  }
  function currentPath(){ return location.pathname + (location.search||''); }

  // coletar r/UTMs da URL (se existirem) e guardar
  (function boot(){
    var a = loadAttr(), q = parseQS(), changed=false;
    ['r','utm_source','utm_medium','utm_campaign','utm_term','utm_content'].forEach(k=>{
      if (q[k]) { a[k]=q[k]; changed=true; }
    });
    if (changed) saveAttr(a);
    // auto-hit 1x por load
    if (!once) { once = true; send('hit', {}); }
  })();

  function send(type, payload){
    var a = loadAttr();
    var body = Object.assign({}, payload || {});
    body.type = type;
    body.creator = body.creator || a.r || '';
    body.meta = Object.assign({ path: currentPath() }, a, body.meta||{});
    fetch(API + '/api/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: type !== 'hit' ? true : false
    }).catch(function(){});
  }

  // API pública
  window.RastroO = {
    hit:  function(meta){ send('hit', { meta: meta||{} }); },
    lead: function(data){ send('lead', { email: data&&data.email, name: data&&data.name, meta: data&&data.meta }); },
    sale: function(data){
      var amount = 0;
      if (data && data.amount != null) {
        amount = parseFloat(String(data.amount).replace(',', '.')) || 0;
      }
      send('sale', { orderId: data&&data.orderId, amount, currency: data&&data.currency||'BRL', meta: data&&data.meta });
    }
  };
})();
`;
app.get('/public/snippet.js', (_req,res) => {
  res.type('application/javascript').send(SNIPPET_JS);
});

// ==========================================================
//  DASHBOARD V4 (mobile-first) EMBUTIDA
//  disponível em /public/dashboard_v2.html e /public/dashboard.html
// ==========================================================
const DASHBOARD_HTML = `<!doctype html>
<html lang="pt-br" data-theme="light">
<head>
  <meta charset="utf-8" />
  <title>RastroO — Dashboard V4</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root{
      --bg:#0b0c10; --text:#0f172a; --muted:#64748b;
      --card:#ffffff; --border:#e5e7eb; --head:#f8fafc;
      --primary:#6d5cff; --primary-contrast:#ffffff;
      --shadow:0 6px 24px rgba(2,6,23,.08);
      --chip:#eef2ff; --table-stripe:#fbfbfd;
      --grad:linear-gradient(135deg,#6d5cff 0%,#23a6d5 100%);
    }
    [data-theme="dark"]{
      --bg:#0b0b0f; --text:#e6e8ee; --muted:#9aa3b2;
      --card:#111319; --border:#1f2430; --head:#0e1117;
      --primary:#8b5cf6; --primary-contrast:#0b0b0f;
      --shadow:0 10px 32px rgba(0,0,0,.45);
      --chip:#1c2231; --table-stripe:#141a25;
      --grad:linear-gradient(135deg,#8b5cf6 0%,#00bcd4 100%);
    }
    *{box-sizing:border-box}
    html,body{height:100%}
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;background:var(--bg);color:var(--text)}
    .hero{background:var(--grad); color:#fff; padding:18px 16px 72px}
    .container{max-width:1120px; margin:0 auto; padding:0 14px}
    header{display:flex; align-items:center; gap:10px}
    h1{font-size:20px; margin:0; font-weight:700; letter-spacing:.2px}
    .spacer{flex:1}
    .round{display:inline-flex; align-items:center; justify-content:center; width:42px; height:42px; border-radius:999px; border:1px solid rgba(255,255,255,.25); background:rgba(255,255,255,.08); cursor:pointer}
    .round svg{width:18px; height:18px; fill:#fff}
    .tag{opacity:.92; border:1px solid rgba(255,255,255,.25); padding:6px 10px; border-radius:999px; font-size:12px}
    main{margin-top:-44px; padding-bottom:80px}
    .card{background:var(--card); border:1px solid var(--border); border-radius:16px; box-shadow:var(--shadow)}
    .period{display:flex; gap:10px; align-items:center; padding:12px; overflow:auto}
    .chip{flex:0 0 auto; padding:10px 14px; border-radius:999px; border:1px solid var(--border); background:var(--card); color:var(--text); cursor:pointer; font-weight:600}
    .chip[aria-pressed="true"]{ background:var(--primary); color:var(--primary-contrast); border-color:transparent }
    .search{margin-left:auto; min-width:160px}
    .search input{width:100%; padding:10px 12px; border-radius:12px; border:1px solid var(--border); background:var(--card); color:var(--text)}
    .kpis{display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; padding:12px 12px 14px}
    .kpi{padding:16px; text-align:center}
    .kpi h2{margin:0; font-size:30px}
    .kpi p{margin:6px 0 0; color:var(--muted)}
    @media (max-width:900px){ .kpis{grid-template-columns:repeat(2,minmax(0,1fr))} }
    @media (max-width:560px){ .kpis{grid-template-columns:1fr} }
    .list{padding:2px 12px 12px; display:grid; gap:10px}
    .creator{padding:14px; border:1px solid var(--border); border-radius:14px; background:var(--card)}
    .creator .top{display:flex; align-items:center; gap:10px}
    .badge{margin-left:auto; font-weight:700; padding:6px 10px; background:var(--chip); border:1px solid var(--border); border-radius:999px}
    .handle{font-weight:700}
    .muted{color:var(--muted)}
    .mrow{display:flex; gap:8px; margin-top:10px}
    .metric{flex:1; background:var(--head); border:1px solid var(--border); border-radius:12px; padding:10px; text-align:center}
    .metric b{display:block; font-size:18px}
    .prog{height:10px; background:var(--head); border:1px solid var(--border); border-radius:999px; overflow:hidden}
    .prog > i{display:block; height:100%; background:var(--primary)}
    @media (min-width:1000px){
      .tablewrap{margin:12px; border:1px solid var(--border); border-radius:14px; overflow:auto}
      table{width:100%; border-collapse:collapse; min-width:780px; background:var(--card)}
      th,td{padding:12px 14px; border-bottom:1px solid var(--border); text-align:left; white-space:nowrap}
      th{background:var(--head)}
      tbody tr:nth-child(even){background:var(--table-stripe)}
    }
    .fab{position:fixed; right:16px; bottom:16px; display:flex; gap:10px}
    .btn{display:inline-flex; align-items:center; gap:8px; padding:12px 14px; border-radius:12px; border:1px solid var(--border); background:var(--card); color:var(--text); cursor:pointer; box-shadow:var(--shadow)}
    .btn-primary{background:var(--primary); color:var(--primary-contrast); border-color:transparent}
    .sheet{position:fixed; left:0; right:0; bottom:-100%; background:var(--card); border-top:1px solid var(--border); box-shadow:0 -24px 48px rgba(0,0,0,.2); border-top-left-radius:16px; border-top-right-radius:16px; transition:bottom .25s ease; z-index:20}
    .sheet.show{bottom:0}
    .sheet .in{padding:16px}
    .row{display:flex; gap:10px; flex-wrap:wrap; align-items:center}
    .input{flex:1}
    .input input{width:100%; padding:12px; border-radius:12px; border:1px solid var(--border); background:var(--card); color:var(--text)}
    .status{font-size:12px; color:var(--muted); padding:8px 14px}
  </style>
</head>
<body>
  <section class="hero">
    <div class="container">
      <header>
        <h1>RastroO — <strong>V4</strong></h1>
        <span id="apiBase" class="tag">API</span>
        <div class="spacer"></div>
        <button id="refreshBtn" class="round" title="Atualizar">
          <svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.9 9.2 1 1 0 1 0-2-.4 6 6 0 1 1-5.9-6.8c1.6 0 3.06.62 4.17 1.63L14 10h6V4l-2.35 2.35z"/></svg>
        </button>
        <button id="themeToggle" class="round" title="Tema claro/escuro">
          <svg viewBox="0 0 24 24"><path d="M12 3a1 1 0 0 0-1 1v1a1 1 0 1 0 2 0V4a1 1 0 0 0-1-1zm0 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm7-6a1 1 0 0 0 1-1h1a1 1 0 1 0 0-2h-1a1 1 0 1 0-2 0 1 1 0 0 0 1 1zm-7 8a1 1 0 0 0-1 1v1a1 1 0 1 0 2 0v-1a1 1 0 0 0-1-1zM4 12a1 1 0 0 0 1-1 1 1 0 1 0-2 0H2a1 1 0 1 0 0 2h1a1 1 0 0 0 1-1zm1.64-6.36a1 1 0 0 0-1.41 1.41l.71.7a1 1 0 0 0 1.42-1.41l-.72-.7zM17.66 17.66a1 1 0 0 0 1.41 0l.71-.71a1 1 0 0 0-1.41-1.41l-.71.71a1 1 0 0 0 0 1.41zM17.66 7.05a1 1 0 0 0 1.41-1.41l-.71-.71a1 1 0 1 0-1.41 1.41l.71.71zM6.34 17.66l.71-.71a1 1 0 1 0-1.41-1.41l-.71.71a1 1 0 1 0 1.41 1.41z"/></svg>
        </button>
      </header>
    </div>
  </section>

  <main class="container">
    <section class="card" style="margin-top:-28px; padding-top:10px;">
      <div class="period">
        <button class="chip" data-p="today" aria-pressed="false">Hoje</button>
        <button class="chip" data-p="7d" aria-pressed="true">7 dias</button>
        <button class="chip" data-p="15d" aria-pressed="false">15 dias</button>
        <button class="chip" data-p="30d" aria-pressed="false">30 dias</button>
        <button class="chip" id="chipCustom" data-p="custom" aria-pressed="false">Personalizado</button>
        <div class="search" style="flex:1; max-width:260px">
          <input id="filter" placeholder="Filtrar creator (@mateus)">
        </div>
      </div>
      <div id="status" class="status">…</div>
    </section>

    <section class="card" style="margin-top:10px">
      <div class="kpis">
        <div class="kpi"><h2 id="kHits">0</h2><p>Hits</p></div>
        <div class="kpi"><h2 id="kLeads">0</h2><p>Leads</p></div>
        <div class="kpi"><h2 id="kSales">0</h2><p>Vendas</p></div>
        <div class="kpi"><h2 id="kRev">R$ 0,00</h2><p>Receita</p></div>
      </div>
    </section>

    <section class="card" style="margin-top:10px">
      <div class="list" id="list"></div>
    </section>

    <section class="tablewrap card" style="margin-top:10px; display:none" id="tableWrap">
      <table>
        <thead>
          <tr><th>Creator</th><th>Hits</th><th>Leads</th><th>Vendas</th><th>CR H→L</th><th>CR L→V</th><th>Receita</th></tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
    </section>

    <div id="lastFetch" class="status"></div>
  </main>

  <div class="fab">
    <button class="btn" id="autoBtn" title="Auto-refresh 30s">
      <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 6v3l4-4-4-4v3C7.6 4 4 7.6 4 12s3.6 8 8 8 8-3.6 8-8h-2c0 3.3-2.7 6-6 6s-6-2.7-6-6 2.7-6 6-6z"/></svg>
      <span id="autoLabel">Auto OFF</span>
    </button>
    <button class="btn btn-primary" id="csvBtn" title="Exportar CSV">
      <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18h14v2H5z"/></svg> CSV
    </button>
  </div>

  <div class="sheet" id="sheet">
    <div class="in">
      <h3 style="margin:0 0 10px">Período personalizado</h3>
      <div class="row">
        <div class="input"><label>De:<br><input type="date" id="from"></label></div>
        <div class="input"><label>Até:<br><input type="date" id="to"></label></div>
      </div>
      <div class="row" style="margin-top:12px; justify-content:flex-end">
        <button class="btn" id="cancelSheet">Cancelar</button>
        <button class="btn btn-primary" id="applySheet">Aplicar</button>
      </div>
    </div>
  </div>

<script>
  const API = location.origin;
  document.getElementById('apiBase').textContent = API.replace(/^https?:\\/\\//,'');
  const themeKey='rastroo_theme';
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  function applyTheme(mode){ document.documentElement.setAttribute('data-theme', mode); localStorage.setItem(themeKey, mode); }
  applyTheme(localStorage.getItem(themeKey) || (prefersDark?'dark':'light'));
  document.getElementById('themeToggle').onclick=()=>{ const t=document.documentElement.getAttribute('data-theme'); applyTheme(t==='dark'?'light':'dark'); };

  let lastData=null, autoTimer=null; let currentPeriod='7d'; let customRange=null;
  const fmtMoney=v=>(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const z2=n=>String(n).padStart(2,'0');
  const ymd=d=>d.getFullYear()+'-'+z2(d.getMonth()+1)+'-'+z2(d.getDate());
  function rangeQuick(key){ const end=new Date(), start=new Date();
    if(key==='today'){} else if(key==='7d'){ start.setDate(start.getDate()-6); }
    else if(key==='15d'){ start.setDate(start.getDate()-14); }
    else if(key==='30d'){ start.setDate(start.getDate()-29); }
    return {from: ymd(start), to: ymd(end)}; }

  async function loadReport(){
    let from,to; if(currentPeriod==='custom' && customRange){({from,to}=customRange)} else {({from,to}=rangeQuick(currentPeriod))}
    const url=\`\${API}/api/report?from=\${from}&to=\${to}\`;
    setStatus('Carregando…'); setLast(url);
    try{ const r=await fetch(url,{cache:'no-store'}); if(!r.ok) throw new Error('HTTP '+r.status);
      const j=await r.json(); if(!j.ok) throw new Error('API ok=false'); lastData=j; render(); setStatus('OK ✅');
    }catch(e){ setStatus('Erro ❌'); }
  }
  function setStatus(s){ document.getElementById('status').textContent=s; }
  function setLast(u){ document.getElementById('lastFetch').textContent='Fetch: '+u; }
  function k(id,v){ document.getElementById(id).textContent=v }
  function escapeHtml(s){ return String(s).replace(/[&<>\"']/g, m=>({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",\"\\\"\":\"&quot;\",\"'\":\"&#39;\"}[m])) }

  function render(){ if(!lastData) return;
    k('kHits', lastData.summary.hits||0);
    k('kLeads', lastData.summary.leads||0);
    k('kSales', lastData.summary.sales||0);
    document.getElementById('kRev').textContent = fmtMoney(lastData.summary.revenue||0);

    const list=document.getElementById('list');
    const filt=(document.getElementById('filter').value||'').trim().toLowerCase();
    const rows=(lastData.perCreator||[]).filter(r=>!filt||(r.creator||'').toLowerCase().includes(filt))
                                       .sort((a,b)=>(b.hits||0)-(a.hits||0));
    list.innerHTML='';
    for(const r of rows){
      const hits=r.hits||0, leads=r.leads||0, sales=r.sales||0, rev=Number(r.revenue||0);
      const crHL = hits? Math.round((leads/hits)*100):0;
      const crLV = leads? Math.round((sales/leads)*100):0;
      const card=document.createElement('div'); card.className='creator';
      card.innerHTML=\`
        <div class="top"><div class="handle">\${escapeHtml(r.creator||'—')}</div>
          <div class="badge">\${fmtMoney(rev)}</div></div>
        <div class="mrow">
          <div class="metric"><span class="muted">Hits</span><b>\${hits}</b></div>
          <div class="metric"><span class="muted">Leads</span><b>\${leads}</b></div>
          <div class="metric"><span class="muted">Vendas</span><b>\${sales}</b></div>
        </div>
        <div class="mrow" style="margin-top:8px">
          <div class="metric" style="flex:1"><span class="muted">CR H→L</span>
            <div class="prog"><i style="width:\${Math.min(crHL,100)}%"></i></div>
          </div>
          <div class="metric" style="flex:1"><span class="muted">CR L→V</span>
            <div class="prog"><i style="width:\${Math.min(crLV,100)}%"></i></div>
          </div>
        </div>\`;
      list.appendChild(card);
    }

    const wrap=document.getElementById('tableWrap');
    wrap.style.display = window.matchMedia('(min-width: 1000px)').matches ? 'block' : 'none';
    const tb=document.getElementById('tbody'); tb.innerHTML='';
    for(const r of rows){
      const tr=document.createElement('tr');
      tr.innerHTML = \`<td>\${escapeHtml(r.creator||'—')}</td>
        <td>\${r.hits||0}</td><td>\${r.leads||0}</td><td>\${r.sales||0}</td>
        <td>\${(r.cr_h_to_l||0)}%</td><td>\${(r.cr_l_to_v||0)}%</td>
        <td>\${fmtMoney(r.revenue||0)}</td>\`;
      tb.appendChild(tr);
    }
  }

  const chips=[...document.querySelectorAll('.chip[data-p]')];
  function setPeriod(p){ currentPeriod=p; chips.forEach(c=>c.setAttribute('aria-pressed', String(c.dataset.p===p))); if(p!=='custom') closeSheet(); loadReport(); }
  chips.forEach(c=> c.addEventListener('click', ()=>{ const p=c.dataset.p; if(p==='custom'){ openSheet(); currentPeriod='custom'; chips.forEach(el=>el.setAttribute('aria-pressed', String(el===c))); return; } setPeriod(p); }));

  const sheet=document.getElementById('sheet');
  function openSheet(){ sheet.classList.add('show'); presetCustom(); }
  function closeSheet(){ sheet.classList.remove('show'); }
  function presetCustom(){ const {from,to}=rangeQuick('7d'); fromEl.value=from; toEl.value=to; }
  const fromEl=document.getElementById('from'); const toEl=document.getElementById('to');
  document.getElementById('applySheet').onclick=()=>{ const f=fromEl.value, t=toEl.value; if(!f||!t){ alert('Defina De e Até.'); return; } customRange={from:f,to:t}; setPeriod('custom'); closeSheet(); };
  document.getElementById('cancelSheet').onclick=()=>{ closeSheet(); };

  document.getElementById('filter').addEventListener('input', ()=> render());
  document.getElementById('csvBtn').onclick=()=>{ if(!lastData) return; const rows=[[ 'creator','hits','leads','sales','cr_h_to_l','cr_l_to_v','revenue' ]]; for(const r of (lastData.perCreator||[])) rows.push([ r.creator||'', r.hits||0, r.leads||0, r.sales||0, (r.cr_h_to_l||0), (r.cr_l_to_v||0), (r.revenue||0) ]); const csv=rows.map(a=>a.map(x=>'"'+String(x).replace(/"/g,'""')+'"').join(',')).join('\\n'); const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='rastroo-'+Date.now()+'.csv'; a.click(); };
  document.getElementById('refreshBtn').onclick=()=> loadReport();
  const autoBtn=document.getElementById('autoBtn'); const autoLabel=document.getElementById('autoLabel');
  autoBtn.onclick=()=>{ if(autoTimer){ clearInterval(autoTimer); autoTimer=null; autoLabel.textContent='Auto OFF'; autoBtn.classList.remove('btn-primary'); } else { autoTimer=setInterval(loadReport, 30000); autoLabel.textContent='Auto ON'; autoBtn.classList.add('btn-primary'); } };
  window.addEventListener('resize', ()=> render());
  setPeriod('7d');
</script>
</body></html>`;
app.get('/public/dashboard_v2.html', (_req,res)=>res.type('html').send(DASHBOARD_HTML));
app.get('/public/dashboard.html',   (_req,res)=>res.type('html').send(DASHBOARD_HTML));

// -------------------- Static /public (sem cache) --------------------
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

// -------------------- Health --------------------
app.get('/healthz', (_req,res)=> res.json({ ok:true, uptime:process.uptime(), mode:'memory' }));

// -------------------- Raiz -> Dashboard --------------------
app.get('/', (_req, res) => res.redirect('/public/dashboard_v2.html'));

// ==========================================================
//  API
// ==========================================================

// Ping simples
app.get('/api/ping', (_req,res)=> res.json({ ok:true, ts: Date.now() }));

// Recebe eventos
app.post('/api/event', (req,res)=>{
  try{
    const { type, creator, email, orderId } = req.body || {};
    let amount = 0;
    if (req.body && req.body.amount != null) {
      amount = parseFloat(String(req.body.amount).replace(',', '.')) || 0;
    }
    if (!type || !['hit','lead','sale'].includes(type)) {
      return res.status(400).json({ ok:false, error:'invalid type' });
    }
    const ev = {
      ts: Date.now(),
      type,
      creator: (creator || '').toString().trim() || '—',
      email: email || undefined,
      orderId: orderId || undefined,
      amount: type==='sale' ? amount : undefined,
      meta: req.body.meta || {}
    };
    DB.events.push(ev);
    res.json({ ok:true, ts: ev.ts });
  }catch(e){
    res.status(500).json({ ok:false, error: e.message });
  }
});

// Relatório por período
// GET /api/report?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/report', (req,res)=>{
  const { from, to } = req.query || {};
  const rep = summarize(DB.events, from, to);
  res.json({ ok:true, ...rep });
});

// (Opcional) rotas de debug rápido
app.get('/api/debug/hit', (req,res)=>{ DB.events.push({ ts:Date.now(), type:'hit', creator:req.query.r||'@teste', meta:{} }); res.json({ ok:true }); });
app.get('/api/debug/lead', (req,res)=>{ DB.events.push({ ts:Date.now(), type:'lead', creator:req.query.r||'@teste', email:'x@x', meta:{} }); res.json({ ok:true }); });
app.get('/api/debug/sale', (req,res)=>{ const v=parseFloat(req.query.v||'10'); DB.events.push({ ts:Date.now(), type:'sale', creator:req.query.r||'@teste', amount:isNaN(v)?0:v, meta:{} }); res.json({ ok:true }); });

// -------------------- Start --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('RastroO rodando na porta', PORT);
});
