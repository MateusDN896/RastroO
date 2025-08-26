// server.js — RastroO (DN) — API + Snippet + Dashboard API + Instagram Webhooks
// + Link Builder com suporte a user=@username (último comentário)
// Cole inteiro e faça deploy no Render.

const express = require('express');
const path = require('path');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------------- CORS (liberado para seus domínios) ----------------
const ALLOWED = new Set([
  'https://rastroo.site',
  'https://www.rastroo.site',
  'https://trk.rastroo.site',
  'https://896.xpages.co'
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------- "Banco" em memória ----------------
const DB = {
  events: [],      // { ts, type:'hit'|'lead'|'sale', creator, amount?, meta:{} }
  igEvents: [],    // eventos brutos do IG (webhook)
  comments: {},    // comment_id -> media_id
  userLast: {}     // username -> { comment_id, media_id, ts }
};

// ---------------- Helpers ----------------
function inRange(ts, fromStr, toStr){
  if(!fromStr && !toStr) return true;
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
  const perVideo   = new Map();

  for (const e of rows){
    const creator = (e.creator || '—').trim();
    const vid = (e.meta && (e.meta.vid || e.meta.vurl || e.meta.utm_content)) || '—';
    const vlabel = (e.meta && (e.meta.vurl || e.meta.vid)) || vid;

    if (e.type === 'hit') hits++;
    if (e.type === 'lead') leads++;
    if (e.type === 'sale'){ sales++; revenue += (e.amount || 0); }

    pushRow(perCreator, creator, r => {
      if (e.type === 'hit') r.hits++;
      if (e.type === 'lead') r.leads++;
      if (e.type === 'sale'){ r.sales++; r.revenue += (e.amount || 0); }
      r.creator = creator;
    });

    pushRow(perVideo, vid, r => {
      if (e.type === 'hit') r.hits++;
      if (e.type === 'lead') r.leads++;
      if (e.type === 'sale'){ r.sales++; r.revenue += (e.amount || 0); }
      r.vid = vid; r.vlabel = vlabel;
    });
  }

  const addCR = r => ({
    ...r,
    cr_h_to_l: r.hits  ? Math.round((r.leads / r.hits ) * 100) : 0,
    cr_l_to_v: r.leads ? Math.round((r.sales / r.leads) * 100) : 0
  });

  return {
    summary: { hits, leads, sales, revenue },
    perCreator: [...perCreator.values()].map(addCR),
    perVideo:   [...perVideo.values()].map(addCR),
  };
}

// ---------------- Snippet cliente ----------------
const SNIPPET_JS = `
// RastroO snippet (grava hit/lead/sale e carrega UTM/vid)
(function(){
  var API = (window.RASTROO_API || location.origin).replace(/\\/$/,'');
  var LS = 'rastroo_attr', once=false;

  function qs(){ var o={}, q=new URLSearchParams(location.search||''); q.forEach((v,k)=>o[k]=v); return o; }
  function load(){ try{ return JSON.parse(localStorage.getItem(LS)||'{}') }catch(_){ return {} } }
  function save(a){ try{ localStorage.setItem(LS, JSON.stringify(a)) }catch(_){ } }
  function path(){ return location.pathname + (location.search||''); }

  (function init(){
    var a=load(), q=qs(), ch=false;
    ['r','utm_source','utm_medium','utm_campaign','utm_term','utm_content','vid','vurl','vh'].forEach(k=>{
      if(q[k]){ a[k]=q[k]; ch=true; }
    });
    if(ch) save(a);
    if(!once){ once=true; send('hit', {}); }
  })();

  function send(type, payload){
    var a=load(), body=Object.assign({}, payload||{});
    body.type = type;
    body.creator = body.creator || a.vh || a.r || '—';
    body.meta = Object.assign({ path: path() }, a, body.meta||{});
    fetch(API + '/api/event', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body),
      keepalive: type!=='hit'
    }).catch(function(){});
  }

  window.RastroO = {
    hit:  function(m){ send('hit',  { meta: m||{} }); },
    lead: function(d){ send('lead', { email:d&&d.email, name:d&&d.name, meta:d&&d.meta }); },
    sale: function(d){
      var v=0; if(d&&d.amount!=null) v=parseFloat(String(d.amount).replace(',','.'))||0;
      send('sale', { orderId:d&&d.orderId, amount:v, currency:(d&&d.currency)||'BRL', meta:d&&d.meta });
    }
  };
})();
`;
app.get('/public/snippet.js', (_req,res) => res.type('application/javascript').send(SNIPPET_JS));

// ---------------- API de eventos ----------------
app.post('/api/event', (req,res)=>{
  const { type, creator } = req.body || {};
  if (!type || !['hit','lead','sale'].includes(type)) {
    return res.status(400).json({ ok:false, error:'invalid type' });
  }
  let amount = 0;
  if (req.body && req.body.amount != null) {
    amount = parseFloat(String(req.body.amount).replace(',','.')) || 0;
  }
  DB.events.push({
    ts: Date.now(),
    type,
    creator: (creator || '—').toString().trim(),
    email: req.body.email,
    orderId: req.body.orderId,
    amount: type==='sale' ? amount : undefined,
    meta: req.body.meta || {}
  });
  res.json({ ok:true, ts: Date.now() });
});

app.get('/api/report', (req,res)=>{
  const { from, to } = req.query;
  res.json({ ok:true, ...summarize(DB.events, from, to) });
});

app.get('/api/ping', (_req,res)=> res.json({ ok:true, ts: Date.now() }));

// ---------------- Webhooks do Instagram ----------------
const IG_VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN || 'RASTROO_VERIFY';

// Verificação (GET com challenge)
app.get('/ig/webhook', (req,res)=>{
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === IG_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Recebimento (POST)
app.post('/ig/webhook', (req,res)=>{
  try{
    const data = req.body || {};
    DB.igEvents.push({ ts: Date.now(), data });

    // Mapeia comment_id -> media_id e último por username
    if (Array.isArray(data.entry)) {
      for (const entry of (data.entry||[])) {
        for (const ch of (entry.changes||[])) {
          if (ch.field === 'comments' || ch.field === 'instagram_comments') {
            const v = ch.value || {};
            if (v.id && v.media_id) DB.comments[v.id] = v.media_id;

            // username pode vir em value.username ou value.from.username (depende da versão)
            const uname = (v.username || (v.from && v.from.username) || '').replace(/^@/,'');
            if (uname) {
              DB.userLast[uname] = { comment_id: v.id, media_id: v.media_id, ts: Date.now() };
            }
          }
        }
      }
    }
  }catch(_){}
  res.sendStatus(200);
});

// Debug IG
app.get('/api/ig/last', (_req,res)=>{
  res.json({
    ok:true,
    total: DB.igEvents.length,
    last: DB.igEvents.slice(-1)[0] || null,
    mapSize: Object.keys(DB.comments).length,
    usersTracked: Object.keys(DB.userLast).length
  });
});

// Ver mapas
app.get('/api/ig/map', (_req,res)=> res.json({ ok:true, map: DB.comments, total: Object.keys(DB.comments).length }));
app.get('/api/ig/user-last', (req,res)=>{
  const u = (req.query.u||'').replace(/^@/,'');
  res.json({ ok:true, user:u, last: u ? (DB.userLast[u]||null) : null });
});

// Constrói link com ?vid a partir de comment_id OU media_id OU user=@username
// Ex.: /api/ig/build?user=mateusdn&base=https://896.xpages.co&utm_source=ig_dm&r=@dn
const BASE_DEFAULT = 'https://896.xpages.co';
function buildUrlFromReq(q){
  const base = q.base || BASE_DEFAULT;
  let vid = q.media_id || '';

  if (!vid && q.comment_id) {
    vid = DB.comments[q.comment_id] || '';
  }
  if (!vid && q.user) {
    const u = String(q.user||'').replace(/^@/,'');
    if (u && DB.userLast[u]) vid = DB.userLast[u].media_id || '';
  }

  const u = new URL(base);
  if (vid) u.searchParams.set('vid', vid);
  if (q.utm_source) u.searchParams.set('utm_source', q.utm_source);
  if (q.r) u.searchParams.set('r', q.r);
  return { url: u.toString(), vid };
}

app.get('/api/ig/build', (req,res)=>{
  const out = buildUrlFromReq(req.query);
  if (!out.vid) return res.status(404).json({ ok:false, error:'not_found', hint:'Envie comment_id, media_id ou user=@username (o webhook precisa ter visto um comentário desse user).' });
  return res.json({ ok:true, ...out });
});

// Atalho que redireciona direto
// Ex.: /go?user=@mateusdn&base=https%3A%2F%2F896.xpages.co&utm_source=ig_dm&r=@dn
app.get('/go', (req,res)=>{
  const out = buildUrlFromReq(req.query);
  return res.redirect(out.url);
});

// ---------------- Static & rotas base ----------------
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.get('/', (_req,res)=> res.redirect('/public/dashboard.html')); // dashboard.html redireciona pra v2

// ---------------- Start ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('RastroO running on port', PORT));
