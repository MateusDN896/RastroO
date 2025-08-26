// server.js — RastroO (DN) — REMOÇÃO DE HITS + LEAD NA CHEGADA + ETIQUETAS DE LEADS
// API de eventos + Snippet + Dashboard + IG Webhooks + Reels/Insights + Leads com status

const express = require('express');
const path = require('path');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// --------- CORS ---------
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

// --------- “Banco” em memória ---------
const DB = {
  events: [],      // { ts, type:'lead'|'sale', creator, amount?, meta:{ iu?, vid?, ... } }
  igEvents: [],    // IG webhooks brutos
  comments: {},    // comment_id -> media_id
  userLast: {},    // username -> { comment_id, media_id, ts }
  leadStatus: {}   // iu -> 'pago' | 'lead' | 'reprovado' (manual)
};

// --------- Helpers ---------
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
  if (!map.has(key)) map.set(key, { key, leads:0, sales:0, revenue:0 });
  updater(map.get(key));
}
function summarize(events, from, to){
  const rows = events.filter(e => inRange(e.ts, from, to));
  let leads=0, sales=0, revenue=0;
  const perCreator = new Map();
  const perVideo   = new Map();

  for (const e of rows){
    const creator = (e.creator || '—').trim();
    const vid = (e.meta && (e.meta.vid || e.meta.vurl || e.meta.utm_content)) || '—';
    const vlabel = (e.meta && (e.meta.vurl || e.meta.vid)) || vid;

    if (e.type === 'lead') leads++;
    if (e.type === 'sale'){ sales++; revenue += (e.amount || 0); }

    pushRow(perCreator, creator, r => {
      if (e.type === 'lead') r.leads++;
      if (e.type === 'sale'){ r.sales++; r.revenue += (e.amount || 0); }
      r.creator = creator;
    });

    pushRow(perVideo, vid, r => {
      if (e.type === 'lead') r.leads++;
      if (e.type === 'sale'){ r.sales++; r.revenue += (e.amount || 0); }
      r.vid = vid; r.vlabel = vlabel;
    });
  }

  const addCR = r => ({
    ...r,
    cr_l_to_v: r.leads ? Math.round((r.sales / r.leads) * 100) : 0
  });

  return {
    summary: { leads, sales, revenue },
    perCreator: [...perCreator.values()].map(addCR),
    perVideo:   [...perVideo.values()].map(addCR),
  };
}
function countsByVid(){
  const m = new Map();
  for (const e of DB.events){
    const vid = e.meta && e.meta.vid;
    if(!vid) continue;
    if(!m.has(vid)) m.set(vid, { leads:0, sales:0, revenue:0 });
    const r = m.get(vid);
    if (e.type==='lead')  r.leads++;
    if (e.type==='sale'){ r.sales++; r.revenue += (e.amount || 0); }
  }
  return m;
}

// --------- Snippet (toda chegada = LEAD) ---------
const SNIPPET_JS = `
(function(){
  var API = (window.RASTROO_API || location.origin).replace(/\\/$/,'');
  var LS = 'rastroo_attr', once=false;
  function qs(){ var o={}, q=new URLSearchParams(location.search||''); q.forEach((v,k)=>o[k]=v); return o; }
  function load(){ try{ return JSON.parse(localStorage.getItem(LS)||'{}') }catch(_){ return {} } }
  function save(a){ try{ localStorage.setItem(LS, JSON.stringify(a)) }catch(_){ } }
  function path(){ return location.pathname + (location.search||''); }

  (function init(){
    var a=load(), q=qs(), ch=false;
    ['r','utm_source','utm_medium','utm_campaign','utm_term','utm_content','vid','vurl','vh','iu'].forEach(function(k){
      if(q[k]){ a[k]=q[k]; ch=true; }
    });
    if(ch) save(a);
    // >>> Agora, cada chegada já conta como LEAD <<<
    if(!once){ once=true; send('lead', {}); }
  })();

  function chooseCreator(a, type, override){
    if (override && override.creator) return override.creator;
    // Para LEAD/SALE: prioriza @ do usuário (iu); fallback vh/r
    return a.iu || a.vh || a.r || '—';
  }

  function send(type, payload){
    var a=load(), body=Object.assign({}, payload||{});
    body.type = (type==='hit') ? 'lead' : type; // compat: se alguém chamar hit, vira lead
    body.creator = chooseCreator(a, body.type, body);
    body.meta = Object.assign({ path: path() }, a, body.meta||{});
    fetch(API + '/api/event', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body),
      keepalive: false
    }).catch(function(){});
  }

  window.RastroO = {
    lead: function(d){ send('lead', { email:d&&d.email, name:d&&d.name, meta:d&&d.meta }); },
    sale: function(d){
      var v=0; if(d&&d.amount!=null) v=parseFloat(String(d.amount).replace(',','.'))||0;
      send('sale', { orderId:d&&d.orderId, amount:v, currency:(d&&d.currency)||'BRL', meta:d&&d.meta });
    }
  };
})();
`;
app.get('/public/snippet.js', (_req,res)=> res.type('application/javascript').send(SNIPPET_JS));

// --------- API de eventos ---------
app.post('/api/event', (req,res)=>{
  let { type, creator } = req.body || {};
  if (type === 'hit') type = 'lead'; // compat: converte hit -> lead
  if (!type || !['lead','sale'].includes(type)) {
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

// --------- LEADS com etiquetas ---------
function computeLeadStatus(iu, stats){
  // prioridade: manual > pago (tem sale) > reprovado manual > lead
  const manual = DB.leadStatus[iu];
  if (manual === 'pago' || manual === 'reprovado' || manual === 'lead') return manual;
  if ((stats.sales||0) > 0) return 'pago';
  return 'lead';
}
app.get('/api/leads', (req,res)=>{
  const { from, to } = req.query;
  const byUser = new Map();
  for (const e of DB.events){
    if (!inRange(e.ts, from, to)) continue;
    const iu = e.meta && e.meta.iu;
    if (!iu) continue;
    if (!byUser.has(iu)) byUser.set(iu, { iu, leads:0, sales:0, revenue:0, last_ts:0 });
    const r = byUser.get(iu);
    if (e.type==='lead') r.leads++;
    if (e.type==='sale'){ r.sales++; r.revenue += (e.amount||0); }
    if (e.ts > r.last_ts) r.last_ts = e.ts;
  }
  const items = [...byUser.values()].map(r => ({ ...r, status: computeLeadStatus(r.iu, r) }))
                                   .sort((a,b)=> b.last_ts - a.last_ts);
  res.json({ ok:true, total: items.length, items });
});
app.post('/api/status', (req,res)=>{
  let { iu, status } = req.body || {};
  if (!iu) return res.status(400).json({ ok:false, error:'iu required' });
  iu = String(iu).replace(/^@/,'');
  if (!['pago','lead','reprovado'].includes(status)) return res.status(400).json({ ok:false, error:'invalid status' });
  DB.leadStatus[iu] = status;
  res.json({ ok:true });
});

// --------- IG Webhooks ---------
const IG_VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN || 'RASTROO_VERIFY';
app.get('/ig/webhook', (req,res)=>{
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === IG_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});
app.post('/ig/webhook', (req,res)=>{
  try{
    const data = req.body || {};
    DB.igEvents.push({ ts: Date.now(), data });
    if (Array.isArray(data.entry)) {
      for (const entry of data.entry) {
        for (const ch of (entry.changes||[])) {
          if (ch.field === 'comments' || ch.field === 'instagram_comments') {
            const v = ch.value || {};
            if (v.id && v.media_id) DB.comments[v.id] = v.media_id;
            const uname = (v.username || (v.from && v.from.username) || '').replace(/^@/,'');
            if (uname) DB.userLast[uname] = { comment_id: v.id, media_id: v.media_id, ts: Date.now() };
          }
        }
      }
    }
  }catch(_){}
  res.sendStatus(200);
});
app.get('/api/ig/last', (_req,res)=>{
  res.json({
    ok:true,
    total: DB.igEvents.length,
    last: DB.igEvents.slice(-1)[0] || null,
    mapSize: Object.keys(DB.comments).length,
    usersTracked: Object.keys(DB.userLast).length
  });
});
app.get('/api/ig/map', (_req,res)=> res.json({ ok:true, map: DB.comments, total: Object.keys(DB.comments).length }));
app.get('/api/ig/user-last', (req,res)=>{
  const u = (req.query.u||'').replace(/^@/,'');
  res.json({ ok:true, user:u, last: u ? (DB.userLast[u]||null) : null });
});

// --------- Builder/redirect (user/comment_id/media_id) ---------
const BASE_DEFAULT = 'https://896.xpages.co';
function buildUrlFromReq(q){
  const base = q.base || BASE_DEFAULT;
  let vid = q.media_id || '';
  if (!vid && q.comment_id) vid = DB.comments[q.comment_id] || '';
  if (!vid && q.user) {
    const u = String(q.user||'').replace(/^@/,'');
    if (u && DB.userLast[u]) vid = DB.userLast[u].media_id || '';
  }
  const u = new URL(base);
  if (vid) u.searchParams.set('vid', vid);
  if (q.utm_source) u.searchParams.set('utm_source', q.utm_source);
  if (q.r) u.searchParams.set('r', q.r);
  if (q.iu) u.searchParams.set('iu', q.iu);
  return { url: u.toString(), vid };
}
app.get('/api/ig/build', (req,res)=>{
  const out = buildUrlFromReq(req.query);
  if (!out.vid) return res.status(404).json({ ok:false, error:'not_found', hint:'Envie comment_id, media_id ou user=@username (o webhook precisa ter visto um comentário desse user).' });
  return res.json({ ok:true, ...out });
});
app.get('/go', (req,res)=> res.redirect(buildUrlFromReq(req.query).url));

// --------- Instagram Graph API: Reels + Insights ---------
const IG_TOKEN = process.env.IG_ACCESS_TOKEN || '';
const IG_IGID  = process.env.IG_IGID || process.env.IG_USER_ID || '';
async function igFetch(path, params={}){
  if (!IG_TOKEN) throw new Error('IG_ACCESS_TOKEN ausente');
  const url = new URL(`https://graph.facebook.com/v18.0/${path}`);
  for (const [k,v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', IG_TOKEN);
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error((j && j.error && j.error.message) || 'Erro IG');
  return j;
}
app.get('/api/ig/reels', async (req,res)=>{
  try{
    if (!IG_TOKEN || !IG_IGID) return res.status(400).json({ ok:false, error:'Faltam IG_ACCESS_TOKEN e/ou IG_IGID' });
    const limit = Math.min(parseInt(req.query.limit || '30',10), 50);

    const fields = [
      'id','media_type','media_product_type','caption','permalink',
      'thumbnail_url','timestamp','like_count','comments_count'
    ].join(',');

    const mediaResp = await igFetch(`${IG_IGID}/media`, { fields, limit: String(limit) });
    const items = (mediaResp.data || []).filter(m =>
      m.media_product_type === 'REELS' || m.media_type === 'VIDEO'
    );

    const wantMetrics = 'plays,reach,likes,comments,saved';
    const withInsights = await Promise.all(items.map(async (m) => {
      let insights = {};
      try{
        const ins = await igFetch(`${m.id}/insights`, { metric: wantMetrics });
        if (Array.isArray(ins.data)) {
          insights = ins.data.reduce((acc, it)=>{ acc[it.name] = (it.values && it.values[0] && it.values[0].value) || 0; return acc; }, {});
        }
      }catch(_){}
      return { ...m, insights };
    }));

    const byVid = countsByVid();
    const result = withInsights.map(m => ({
      id: m.id,
      caption: m.caption || '',
      permalink: m.permalink,
      thumb: m.thumbnail_url,
      ts: m.timestamp,
      like_count: m.like_count || 0,
      comments_count: m.comments_count || 0,
      insights: m.insights,
      counts: byVid.get(m.id) || { leads:0, sales:0, revenue:0 }
    }));

    res.json({ ok:true, total: result.length, items: result });
  }catch(e){
    res.status(500).json({ ok:false, error: e.message || 'Erro interno' });
  }
});

// --------- Static & root ---------
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.get('/', (_req,res)=> res.redirect('/public/dashboard.html'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('RastroO running on port', PORT));
