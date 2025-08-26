// server.js — RastroO (COMPLETO)
// - Persistência em arquivo (DISK_PATH ou ./data/rastroo-store.json)
// - OAuth IG com STATE assinado (sem depender de memória)
// - Fallbacks para achar IG: via Páginas (instagram_business_account ou connected_instagram_account) e via Usuário
// - Endpoints da dashboard (/api/event, /api/leads, /api/report, /api/status)
// - Snippet que conta toda visita como "lead" (removido "hit")
// - Reels + insights
// - Webhook IG opcional
// - Rotas de debug: /api/debug e /api/debug/last_oauth

/* eslint-disable */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------ App / Middlewares ------------------
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS básico (ajuste se precisar liberar mais origens)
const ALLOWED = new Set([
  'https://rastroo.site',
  'https://www.rastroo.site',
  'https://trk.rastroo.site',
  'https://app.rastroo.site',
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

// ------------------ ENV ------------------
const IG_APP_ID         = process.env.IG_APP_ID || '';
const IG_APP_SECRET     = process.env.IG_APP_SECRET || '';
const IG_REDIRECT       = process.env.IG_REDIRECT || 'https://trk.rastroo.site/auth/ig/callback';
const IG_VERIFY_TOKEN   = process.env.IG_VERIFY_TOKEN || 'RASTROO_VERIFY';
const OAUTH_STATE_SECRET= process.env.OAUTH_STATE_SECRET || IG_APP_SECRET || 'fallback-secret';

const DISK_PATH         = process.env.DISK_PATH || ''; // e.g. /data/rastroo-store.json (Render Disk recomendado)

// ------------------ Store (arquivo JSON) ------------------
const LOCAL_FALLBACK    = path.join(__dirname, 'data', 'rastroo-store.json');

function storeFile(){ return DISK_PATH || LOCAL_FALLBACK; }
function ensureDirFor(file){
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function loadStore(){
  const file = storeFile();
  try{
    ensureDirFor(file);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file,'utf8'));
  }catch(e){ console.error('[store] load error:', e.message); }
  return {
    ig: { token:'', igid:'', username:'', via:'', pageId:'' },
    events: [],          // { ts, type:'lead'|'sale', creator, amount?, meta? }
    leadStatus: {},      // iu -> 'pago'|'lead'|'reprovado'
    comments: {},        // comment_id -> media_id
    userLast: {}         // username -> { comment_id, media_id, ts }
  };
}
let DB = loadStore();
let saveTimer=null;
function saveSoon(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{
    try{
      ensureDirFor(storeFile());
      fs.writeFileSync(storeFile(), JSON.stringify(DB,null,2),'utf8');
    }catch(e){ console.error('[store] save error:', e.message); }
  }, 120);
}

// ------------------ Utils ------------------
function inRange(ts, fromStr, toStr){
  if(!fromStr && !toStr) return true;
  const d = new Date(ts);
  const from = fromStr ? new Date(fromStr+'T00:00:00Z') : null;
  const to   = toStr   ? new Date(toStr  +'T23:59:59Z') : null;
  if (from && d<from) return false;
  if (to   && d>to)   return false;
  return true;
}
function summarize(events, from, to){
  const rows = events.filter(e => inRange(e.ts, from, to));
  let leads=0, sales=0, revenue=0;
  for (const e of rows){
    if (e.type==='lead') leads++;
    if (e.type==='sale'){ sales++; revenue += (e.amount||0); }
  }
  return { leads, sales, revenue };
}
function countsByVid(){
  const m = new Map();
  for (const e of DB.events){
    const vid = e.meta && e.meta.vid;
    if(!vid) continue;
    if(!m.has(vid)) m.set(vid, { leads:0, sales:0, revenue:0 });
    const r = m.get(vid);
    if (e.type==='lead')  r.leads++;
    if (e.type==='sale'){ r.sales++; r.revenue += (e.amount||0); }
  }
  return m;
}

// ------------------ Debug ------------------
let LAST_OAUTH_DEBUG = {};
app.get('/api/debug', (_req,res)=>{
  res.json({
    ok:true,
    mode: DISK_PATH ? 'disk' : 'memory',
    ig_connected: !!(DB.ig.token && DB.ig.igid),
    events: DB.events.length,
    now: new Date().toISOString()
  });
});
app.get('/api/debug/last_oauth', (_req,res)=> res.json(LAST_OAUTH_DEBUG));

// ------------------ Snippet (toda visita = LEAD) ------------------
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
    if(!once){ once=true; send('lead', {}); } // visita conta como lead
  })();

  function chooseCreator(a, type, override){
    if (override && override.creator) return override.creator;
    return a.iu || a.vh || a.r || '—';
  }

  function send(type, payload){
    var a=load(), body=Object.assign({}, payload||{});
    if (type==='hit') type='lead';
    body.type = type;
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

// ------------------ API: Eventos / Relatórios ------------------
app.post('/api/event', (req,res)=>{
  let { type, creator } = req.body || {};
  if (type === 'hit') type = 'lead'; // "hit" vira "lead"
  if (!type || !['lead','sale'].includes(type)) return res.status(400).json({ ok:false, error:'invalid type' });

  let amount = 0;
  if (req.body && req.body.amount != null) amount = parseFloat(String(req.body.amount).replace(',','.')) || 0;

  DB.events.push({
    ts: Date.now(),
    type,
    creator: (creator || '—').toString().trim(),
    email: req.body.email,
    orderId: req.body.orderId,
    amount: type==='sale' ? amount : undefined,
    meta: req.body.meta || {}
  });
  saveSoon();
  res.json({ ok:true, ts: Date.now() });
});

app.get('/api/report', (req,res)=>{
  const { from, to } = req.query;
  const sum = summarize(DB.events, from, to);
  res.json({ ok:true, summary: sum });
});

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
  const items = [...byUser.values()]
    .map(r => ({ ...r, status: (DB.leadStatus[r.iu] || (r.sales>0?'pago':'lead')) }))
    .sort((a,b)=> b.last_ts - a.last_ts);
  res.json({ ok:true, total: items.length, items });
});

app.post('/api/status', (req,res)=>{
  let { iu, status } = req.body || {};
  if (!iu) return res.status(400).json({ ok:false, error:'iu required' });
  iu = String(iu).replace(/^@/,'');
  if (!['pago','lead','reprovado'].includes(status)) return res.status(400).json({ ok:false, error:'invalid status' });
  DB.leadStatus[iu] = status;
  saveSoon();
  res.json({ ok:true });
});

// ------------------ Static & Redirects ------------------
app.get('/', (_req,res)=> res.redirect('/public/app.html'));
app.get(['/public','/public/','/public/dashboard.html','/dashboard','/panel'], (_req,res)=> res.redirect('/public/app.html'));
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

// =====================================================
// ================ Instagram Graph API ================
// =====================================================
const GRAPH = 'https://graph.facebook.com/v18.0/';

// helpers: state assinado (15min)
function buildState(){
  const nonce = crypto.randomBytes(16).toString('hex');
  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha256', OAUTH_STATE_SECRET).update(nonce+'.'+ts).digest('hex');
  return `${nonce}.${ts}.${sig}`;
}
function verifyState(state){
  try{
    const [nonce, ts, sig] = String(state||'').split('.');
    if (!nonce || !ts || !sig) return false;
    const expect = crypto.createHmac('sha256', OAUTH_STATE_SECRET).update(nonce+'.'+ts).digest('hex');
    if (sig !== expect) return false;
    const age = Date.now() - Number(ts);
    return age >= 0 && age <= 15*60*1000;
  }catch{ return false; }
}

async function fbGET(pathEnd, params){
  const url = new URL(GRAPH + pathEnd);
  for (const [k,v] of Object.entries(params||{})) url.searchParams.set(k, v);
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error((j && j.error && j.error.message) || 'Erro Graph');
  return j;
}

app.get('/api/ig/creds', (_req,res)=>{
  res.json({
    ok:true,
    connected: !!(DB.ig.token && DB.ig.igid),
    igid: DB.ig.igid || '',
    username: DB.ig.username || '',
    token_preview: DB.ig.token ? (DB.ig.token.slice(0,8)+'…'+DB.ig.token.slice(-5)) : ''
  });
});

app.get('/auth/ig/login', (req,res)=>{
  if (!IG_APP_ID || !IG_REDIRECT || !OAUTH_STATE_SECRET) {
    return res.status(400).send('Config faltando: IG_APP_ID / IG_REDIRECT / OAUTH_STATE_SECRET.');
  }
  const scope = [
    'instagram_basic',
    'instagram_manage_insights',
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_metadata'
  ].join(',');
  const url = new URL('https://www.facebook.com/v18.0/dialog/oauth');
  url.searchParams.set('client_id', IG_APP_ID);
  url.searchParams.set('redirect_uri', IG_REDIRECT);
  url.searchParams.set('scope', scope);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', buildState());
  res.redirect(url.toString());
});

app.get('/auth/ig/callback', async (req,res)=>{
  try{
    const { code, state } = req.query;
    if (!code || !verifyState(state)) {
      return res.status(400).send('State inválido ou expirado.');
    }
    if (!IG_APP_ID || !IG_APP_SECRET || !IG_REDIRECT) {
      return res.status(400).send('Config faltando: IG_APP_ID/IG_APP_SECRET/IG_REDIRECT');
    }

    // short token
    const t1 = await fbGET('oauth/access_token', {
      client_id: IG_APP_ID, client_secret: IG_APP_SECRET, redirect_uri: IG_REDIRECT, code
    });
    const shortToken = t1.access_token;

    // long-lived
    const t2 = await fbGET('oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: IG_APP_ID, client_secret: IG_APP_SECRET, fb_exchange_token: shortToken
    });
    const longToken = t2.access_token;

    // ----- Via PÁGINAS (do usuário) -----
    let chosen = null, pagesDump = null;
    try{
      pagesDump = await fbGET('me/accounts', { access_token: longToken });
      const pages = pagesDump.data || [];
      for (const p of pages){
        try{
          // pega os dois campos, pois depends da experiência de página
          const info = await fbGET(`${p.id}`, {
            fields: 'instagram_business_account{id,username},connected_instagram_account{id,username}',
            access_token: longToken
          });
          let ig = null;
          if (info.instagram_business_account && info.instagram_business_account.id) {
            ig = { id: info.instagram_business_account.id, username: info.instagram_business_account.username || '' };
          } else if (info.connected_instagram_account && info.connected_instagram_account.id) {
            ig = { id: info.connected_instagram_account.id, username: info.connected_instagram_account.username || '' };
          }
          if (ig) {
            if (!ig.username) {
              try{
                const u = await fbGET(`${ig.id}`, { fields: 'username', access_token: longToken });
                ig.username = u.username || '';
              }catch(_){}
            }
            chosen = { via:'pages', pageId:p.id, igid: ig.id, username: ig.username || '' };
            break;
          }
        }catch(_){}
      }
    }catch(_){}

    // ----- Fallback via USUÁRIO -----
    if (!chosen) {
      try{
        const me = await fbGET('me', { fields: 'instagram_business_accounts{id,username}', access_token: longToken });
        const igs = (me.instagram_business_accounts && me.instagram_business_accounts.data) || [];
        if (igs.length) chosen = { via:'user', pageId:'', igid: igs[0].id, username: (igs[0].username||'') };
      }catch(_){}
    }

    LAST_OAUTH_DEBUG = { when:new Date().toISOString(), chosen, pagesDump };

    if (!chosen) {
      return res.status(400).send('Não encontrei um Instagram Business/Creator ligado a uma página nessa conta.');
    }

    DB.ig = { token: longToken, igid: chosen.igid, username: chosen.username || '', via: chosen.via, pageId: chosen.pageId || '' };
    saveSoon();

    LAST_OAUTH_DEBUG = { when:new Date().toISOString(), chosen, note:'ok' };
    return res.redirect('/public/app.html#/reels');
  }catch(e){
    LAST_OAUTH_DEBUG = { when:new Date().toISOString(), error: e?.message || 'desconhecido' };
    return res.status(500).send('Erro na conexão IG: ' + (e?.message || 'desconhecido'));
  }
});

// ------------------ IG Reels + Insights ------------------
async function igGET(pathEnd, params={}){
  const token = DB.ig.token;
  if (!token) throw new Error('Conta do Instagram não conectada.');
  const url = new URL(GRAPH + pathEnd);
  for (const [k,v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error((j && j.error && j.error.message) || 'Erro IG');
  return j;
}

app.get('/api/ig/reels', async (req,res)=>{
  try{
    if (!DB.ig.token || !DB.ig.igid) return res.status(400).json({ ok:false, error:'Conecte sua conta do Instagram em /public/connect.html' });
    const IGID = DB.ig.igid;
    const limit = Math.min(parseInt(req.query.limit || '30',10), 50);

    const fields = [
      'id','media_type','media_product_type','caption','permalink',
      'thumbnail_url','timestamp','like_count','comments_count'
    ].join(',');

    const media = await igGET(`${IGID}/media`, { fields, limit: String(limit) });
    const items = (media.data || []).filter(m => m.media_product_type==='REELS' || m.media_type==='VIDEO');

    const want = 'plays,reach,likes,comments,saved';
    const byVid = countsByVid();

    const enriched = await Promise.all(items.map(async (m)=>{
      let insights = {};
      try{
        const ins = await igGET(`${m.id}/insights`, { metric: want });
        if (Array.isArray(ins.data)) insights = ins.data.reduce((acc,it)=>{ acc[it.name]=(it.values?.[0]?.value)||0; return acc; }, {});
      }catch(_){}
      return {
        id:m.id, caption:m.caption||'', permalink:m.permalink, thumb:m.thumbnail_url, ts:m.timestamp,
        like_count:m.like_count||0, comments_count:m.comments_count||0,
        insights, counts: byVid.get(m.id)||{leads:0,sales:0,revenue:0}
      };
    }));

    res.json({ ok:true, total: enriched.length, items: enriched });
  }catch(e){
    res.status(500).json({ ok:false, error: e.message || 'Erro IG' });
  }
});

// ------------------ Webhook IG (opcional) ------------------
app.get('/ig/webhook', (req,res)=>{
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === IG_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});
app.post('/ig/webhook', (req,res)=>{ try{
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try{
      const data = JSON.parse(body||'{}');
      if (Array.isArray(data.entry)) {
        for (const entry of data.entry) {
          for (const ch of (entry.changes||[])) {
            if (ch.field === 'comments' || ch.field === 'instagram_comments') {
              const v = ch.value || {};
              if (v.id && v.media_id) DB.comments[v.id] = v.media_id;
              const uname = (v.username || (v.from&&v.from.username) || '').replace(/^@/,'');
              if (uname) DB.userLast[uname] = { comment_id:v.id, media_id:v.media_id, ts:Date.now() };
            }
          }
        }
      }
      saveSoon();
    }catch(_){}
    res.sendStatus(200);
  });
}catch(_){ res.sendStatus(200); }});

// ------------------ Start ------------------
app.listen(PORT, ()=> console.log('RastroO rodando na porta', PORT));
