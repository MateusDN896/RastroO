// server.js — RastroO + Instagram Webhooks (Passo 1)
// by DN & Chat

const express = require('express');
const path = require('path');
const fetch = require('node-fetch'); // usado no passo 2 (envio de DM)

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// -------------------- CORS (allowlist) --------------------
const ALLOWED = new Set([
  'https://rastroo.site',
  'https://www.rastroo.site',
  'https://trk.rastroo.site',
  'https://896.xpages.co' // xQuiz
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// -------------------- Memória (simples) --------------------
const DB = {
  events: [],       // { ts, type, creator, amount, meta:{} ... }
  igEvents: [],     // brutos do webhook do Instagram (p/ debug)
  comments: {}      // mapa: comment_id -> media_id (preenche no webhook)
};

// -------------------- Helpers dashboard --------------------
function inRange(ts, fromStr, toStr) {
  if (!fromStr && !toStr) return true;
  const d = new Date(ts);
  const from = fromStr ? new Date(fromStr + 'T00:00:00Z') : null;
  const to   = toStr   ? new Date(toStr   + 'T23:59:59Z') : null;
  if (from && d < from) return false;
  if (to   && d > to)   return false;
  return true;
}
function pushRow(map, key, updater){
  if (!map.has(key)) map.set(key, { key, hits:0, leads:0, sales:0, revenue:0 });
  updater(map.get(key));
}
function summarize(events, from, to){
  const rows = events.filter(e => inRange(e.ts, from, to));
  let hits=0, leads=0, sales=0, revenue=0;

  const perCreator = new Map();
  const perVideo   = new Map(); // chave = meta.vid || meta.vurl || meta.utm_content || '—'

  for (const e of rows){
    const creator = (e.creator || '—').trim();
    const vid = (e.meta && (e.meta.vid || e.meta.vurl || e.meta.utm_content)) || '—';
    const vlabel = (e.meta && (e.meta.vurl || e.meta.vid)) || vid;

    if (e.type === 'hit')  hits++;
    if (e.type === 'lead') leads++;
    if (e.type === 'sale') { sales++; revenue += (e.amount||0); }

    pushRow(perCreator, creator, r => {
      if (e.type === 'hit')  r.hits++;
      if (e.type === 'lead') r.leads++;
      if (e.type === 'sale') { r.sales++; r.revenue += (e.amount||0); }
      r.creator = creator;
    });

    pushRow(perVideo, vid, r => {
      if (e.type === 'hit')  r.hits++;
      if (e.type === 'lead') r.leads++;
      if (e.type === 'sale') { r.sales++; r.revenue += (e.amount||0); }
      r.vid = vid;
      r.vlabel = vlabel;
    });
  }

  const addCR = r => ({
    ...r,
    cr_h_to_l: r.hits ? Math.round((r.leads / r.hits) * 100) : 0,
    cr_l_to_v: r.leads ? Math.round((r.sales / r.leads) * 100) : 0,
  });

  return {
    summary: { hits, leads, sales, revenue },
    perCreator: [...perCreator.values()].map(addCR).sort((a,b)=> (b.hits-a.hits) || (b.leads-a.leads)),
    perVideo:   [...perVideo.values()].map(addCR).sort((a,b)=> (b.sales-a.sales) || (b.leads-a.leads) || (b.hits-a.hits)),
  };
}

// ==========================================================
//  SNIPPET (para usar no xQuiz/WordPress se quiser)
// ==========================================================
const SNIPPET_JS = `
// RastroO snippet (client)
(function(){
  var API = (window.RASTROO_API || location.origin).replace(/\\/$/,'');
  var LSKEY = 'rastroo_attr';
  var once  = false;

  function qs(){ var o={},q=new URLSearchParams(location.search||''); q.forEach((v,k)=>o[k]=v); return o; }
  function load(){ try { return JSON.parse(localStorage.getItem(LSKEY)||'{}'); } catch(_){ return {}; } }
  function save(a){ try { localStorage.setItem(LSKEY, JSON.stringify(a)); } catch(_){ } }
  function path(){ return location.pathname + (location.search||''); }

  (function boot(){
    var a=load(), q=qs(), changed=false;
    ['r','utm_source','utm_medium','utm_campaign','utm_term','utm_content','vid','vurl','vh'].forEach(function(k){
      if(q[k]){ a[k]=q[k]; changed=true; }
    });
    if(changed) save(a);
    if(!once){ once=true; send('hit',{}); }
  })();

  function send(type,payload){
    var a=load(), body=Object.assign({}, payload||{});
    body.type=type; body.creator = body.creator || a.vh || a.r || '—';
    body.meta = Object.assign({ path: path() }, a, body.meta||{});
    fetch(API + '/api/event', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body), keepalive: type!=='hit'
    }).catch(function(){});
  }

  window.RastroO = {
    hit:  function(meta){ send('hit',  { meta: meta||{} }); },
    lead: function(data){ send('lead', { email: data&&data.email, name: data&&data.name, meta: data&&data.meta }); },
    sale: function(data){
      var amount = 0; if (data && data.amount!=null) amount = parseFloat(String(data.amount).replace(',','.')) || 0;
      send('sale', { orderId: data&&data.orderId, amount: amount, currency: (data&&data.currency)||'BRL', meta: data&&data.meta });
    }
  };
})();
`;
app.get('/public/snippet.js', (_req,res)=> res.type('application/javascript').send(SNIPPET_JS));

// ==========================================================
//  DASHBOARD (com agrupamento por Vídeo)
// ==========================================================
const DASHBOARD_HTML = `<!doctype html>
<html lang="pt-br" data-theme="light"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>RastroO — Dashboard</title>
<style>
:root{--bg:#0b0c10;--text:#0f172a;--muted:#64748b;--card:#fff;--border:#e5e7eb;--head:#f8fafc;--primary:#6d5cff;--pc:#fff;--shadow:0 6px 24px rgba(2,6,23,.08);}
[data-theme="dark"]{--bg:#0b0b0f;--text:#e6e8ee;--muted:#9aa3b2;--card:#111319;--border:#1f2430;--head:#0e1117;--primary:#8b5cf6;--pc:#0b0b0f;--shadow:0 10px 32px rgba(0,0,0,.45);}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;background:var(--bg);color:var(--text)}
.hero{background:linear-gradient(135deg,#6d5cff 0%,#23a6d5 100%);color:#fff;padding:18px 16px 60px}
.container{max-width:1120px;margin:0 auto;padding:0 14px}
header{display:flex;align-items:center;gap:10px}
h1{font-size:20px;margin:0;font-weight:800}.spacer{flex:1}.tag{opacity:.92;border:1px solid rgba(255,255,255,.25);padding:6px 10px;border-radius:999px;font-size:12px}
main{margin-top:-32px;padding-bottom:60px}.card{background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow)}
.toolbar{display:flex;gap:10px;align-items:center;padding:12px;flex-wrap:wrap}
select,input,button{font:inherit;border:1px solid var(--border);background:var(--card);color:var(--text);padding:10px 12px;border-radius:12px}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:12px}
.kpi{text-align:center;padding:16px}.kpi h2{margin:0;font-size:30px}.kpi p{margin:6px 0 0;color:var(--muted)}
@media (max-width:900px){.kpis{grid-template-columns:repeat(2,1fr)}}@media (max-width:560px){.kpis{grid-template-columns:1fr}}
.table{margin:12px;border:1px solid var(--border);border-radius:14px;overflow:auto}
table{width:100%;border-collapse:collapse;min-width:780px;background:var(--card)}
th,td{padding:12px 14px;border-bottom:1px solid var(--border);text-align:left;white-space:nowrap}
th{background:var(--head)}tbody tr:nth-child(even){background:rgba(0,0,0,.02)}
.status{font-size:12px;color:var(--muted);padding:8px 14px}
</style></head><body>
<section class="hero"><div class="container"><header>
<h1>RastroO — Dashboard</h1><span id="apiBase" class="tag">API</span><div class="spacer"></div>
<select id="groupBy"><option value="creator">Agrupar: Criadores</option><option value="video">Agrupar: Vídeos</option></select>
</header></div></section>
<main class="container">
<section class="card" style="margin-top:-20px">
  <div class="toolbar">
    <label>Período <select id="period"><option value="today">Hoje</option><option value="7d" selected>7 dias</option><option value="15d">15 dias</option><option value="30d">30 dias</option><option value="all">Tudo</option></select></label>
    <input id="filter" placeholder="Filtrar (@creator ou vídeo)">
    <button id="refresh">Atualizar</button><span id="status" class="status">…</span>
  </div>
  <div class="kpis">
    <div class="kpi"><h2 id="kHits">0</h2><p>Hits</p></div>
    <div class="kpi"><h2 id="kLeads">0</h2><p>Leads</p></div>
    <div class="kpi"><h2 id="kSales">0</h2><p>Vendas</p></div>
    <div class="kpi"><h2 id="kRev">R$ 0,00</h2><p>Receita</p></div>
  </div>
</section>
<section class="table card"><table><thead id="thead"></thead><tbody id="tbody"></tbody></table></section>
<div id="last" class="status"></div>
</main>
<script>
const API=location.origin;document.getElementById('apiBase').textContent=API.replace(/^https?:\\/\\//,'');
const fmtMoney=v=>(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const z2=n=>String(n).padStart(2,'0');const ymd=d=>d.getFullYear()+'-'+z2(d.getMonth()+1)+'-'+z2(d.getDate());
function rangeQuick(k){const e=new Date(),s=new Date();if(k==='today'){}else if(k==='7d'){s.setDate(s.getDate()-6);}else if(k==='15d'){s.setDate(s.getDate()-14);}else if(k==='30d'){s.setDate(s.getDate()-29);}else if(k==='all'){s.setFullYear(2000);e.setFullYear(2099);}return {from:ymd(s),to:ymd(e)};}
let DATA=null;
async function load(){const g=document.getElementById('groupBy').value;const p=document.getElementById('period').value;const {from,to}=rangeQuick(p);
  const url=\`\${API}/api/report?from=\${from}&to=\${to}\`;
  document.getElementById('status').textContent='Carregando…'; document.getElementById('last').textContent=url;
  const r=await fetch(url,{cache:'no-store'}); const j=await r.json(); DATA=j; document.getElementById('status').textContent='OK';
  document.getElementById('kHits').textContent=j.summary.hits||0; document.getElementById('kLeads').textContent=j.summary.leads||0; document.getElementById('kSales').textContent=j.summary.sales||0; document.getElementById('kRev').textContent=fmtMoney(j.summary.revenue||0);
  render(g);
}
function render(group){ if(!DATA) return; const filt=(document.getElementById('filter').value||'').toLowerCase();
  let rows=[], head='';
  if(group==='video'){ rows=(DATA.perVideo||[]).map(r=>({col1:r.vid, col2:r.vlabel, ...r})); head='<tr><th>Vídeo (ID)</th><th>Link</th><th>Hits</th><th>Leads</th><th>Vendas</th><th>CR H→L</th><th>CR L→V</th><th>Receita</th></tr>'; }
  else { rows=(DATA.perCreator||[]).map(r=>({col1:r.creator, ...r})); head='<tr><th>Creator</th><th>Hits</th><th>Leads</th><th>Vendas</th><th>CR H→L</th><th>CR L→V</th><th>Receita</th></tr>'; }
  rows=rows.filter(r=>!filt || (r.col1||'').toLowerCase().includes(filt) || (r.col2||'').toLowerCase().includes(filt));
  document.getElementById('thead').innerHTML=head;
  const tb=document.getElementById('tbody'); tb.innerHTML='';
  for(const r of rows){
    const tr=document.createElement('tr');
    if(group==='video'){
      const link = r.vlabel && /^https?:/i.test(r.vlabel) ? \`<a href="\${r.vlabel}" target="_blank">abrir</a>\` : (r.vlabel||'—');
      tr.innerHTML=\`<td>\${r.vid||'—'}</td><td>\${link}</td><td>\${r.hits||0}</td><td>\${r.leads||0}</td><td>\${r.sales||0}</td><td>\${r.cr_h_to_l||0}%</td><td>\${r.cr_l_to_v||0}%</td><td>\${(r.revenue||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</td>\`;
    } else {
      tr.innerHTML=\`<td>\${r.creator||'—'}</td><td>\${r.hits||0}</td><td>\${r.leads||0}</td><td>\${r.sales||0}</td><td>\${r.cr_h_to_l||0}%</td><td>\${r.cr_l_to_v||0}%</td><td>\${(r.revenue||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</td>\`;
    }
    tb.appendChild(tr);
  }
}
document.getElementById('refresh').onclick=load;
document.getElementById('groupBy').onchange=()=>render(document.getElementById('groupBy').value);
document.getElementById('period').onchange=load;
document.getElementById('filter').oninput=()=>render(document.getElementById('groupBy').value);
load();
</script>
</body></html>`;
app.get('/public/dashboard_v2.html', (_req,res)=>res.type('html').send(DASHBOARD_HTML));
app.get('/public/dashboard.html',   (_req,res)=>res.type('html').send(DASHBOARD_HTML));
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

// -------------------- API de eventos --------------------
app.get('/healthz', (_req,res)=> res.json({ ok:true, uptime:process.uptime(), mode:'memory' }));
app.get('/api/ping', (_req,res)=> res.json({ ok:true, ts:Date.now() }));

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
      creator: (creator || '—').toString().trim(),
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

// Relatório
app.get('/api/report', (req,res)=>{
  const { from, to } = req.query || {};
  const rep = summarize(DB.events, from, to);
  res.json({ ok:true, ...rep });
});

// Debug rápido
app.get('/api/debug/hit', (req,res)=>{ DB.events.push({ ts:Date.now(), type:'hit',  creator:req.query.r||'@teste', meta:{} }); res.json({ ok:true }); });
app.get('/api/debug/lead', (req,res)=>{ DB.events.push({ ts:Date.now(), type:'lead', creator:req.query.r||'@teste', email:'x@x', meta:{} }); res.json({ ok:true }); });
app.get('/api/debug/sale', (req,res)=>{ const v=parseFloat(req.query.v||'10'); DB.events.push({ ts:Date.now(), type:'sale', creator:req.query.r||'@teste', amount:isNaN(v)?0:v, meta:{} }); res.json({ ok:true }); });

// ==========================================================
//  INSTAGRAM WEBHOOKS (Passo 1)
// ==========================================================
const IG_VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN || 'RASTROO_VERIFY';
const IG_PAGE_ACCESS_TOKEN = process.env.IG_PAGE_ACCESS_TOKEN || ''; // usado no passo 2

// Verificação (setup do Webhook)
// Meta chama GET com hub.mode, hub.verify_token, hub.challenge
app.get('/ig/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === IG_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Recebimento dos eventos (comentários, etc.)
app.post('/ig/webhook', (req, res) => {
  try{
    const data = req.body || {};
    DB.igEvents.push({ ts: Date.now(), data });
    // Tenta mapear comment_id -> media_id (pra usar como vid)
    if (Array.isArray(data.entry)) {
      for (const entry of data.entry) {
        const changes = entry.changes || [];
        for (const ch of changes) {
          if (ch.field === 'comments' || ch.field === 'instagram_comments') {
            const v = ch.value || {};
            // value pode conter: id (comment_id), text, media_id, from
            if (v.id && v.media_id) {
              DB.comments[v.id] = v.media_id;
            }
          }
        }
      }
    }
  }catch(_){}
  res.sendStatus(200);
});

// Endpoints de debug/inspeção (pra você ver se está chegando)
app.get('/api/ig/last', (_req,res)=>{
  res.json({
    ok:true,
    total: DB.igEvents.length,
    last: DB.igEvents.slice(-1)[0] || null,
    mapSize: Object.keys(DB.comments).length
  });
});

// -------------------- Raiz -> Dashboard --------------------
app.get('/', (_req, res) => res.redirect('/public/dashboard_v2.html'));

// -------------------- Start --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('RastroO rodando na porta', PORT);
});
