// server.js — RastroO (FULL, com IG fallback melhorado + persistência opcional via DISK_PATH)

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const axios = require('axios');
const qs = require('querystring');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// --------- CORS básico (ajuste se quiser liberar outros domínios) ---------
const ALLOWED = new Set([
  'https://rastroo.site',
  'https://www.rastroo.site',
  'https://trk.rastroo.site',
  'https://app.rastroo.site'
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

// --------- ENV obrigatórias ---------
const IG_APP_ID        = process.env.IG_APP_ID || '';
const IG_APP_SECRET    = process.env.IG_APP_SECRET || '';
const IG_REDIRECT      = process.env.IG_REDIRECT || 'https://trk.rastroo.site/auth/ig/callback';
const IG_VERIFY_TOKEN  = process.env.IG_VERIFY_TOKEN || 'RASTROO_VERIFY';
const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || IG_APP_SECRET || 'fallback-secret';

// --------- Store (arquivo) ---------
const DISK_PATH = process.env.DISK_PATH || ''; // e.g. /data/rastroo-store.json (Render Disk)
const MEM_FALLBACK_PATH = path.join(__dirname, 'data', 'rastroo-store.json');

function storePath() { return DISK_PATH || MEM_FALLBACK_PATH; }
function ensureDirFor(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function loadStore() {
  const file = storePath();
  try {
    ensureDirFor(file);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch(e) { console.error('[store] load error', e.message); }
  return {
    ig: { token:'', igid:'', username:'', via:'', pageId:'' },
    events: [],          // {ts,type:'lead'|'sale', creator, amount?, meta?}
    leadStatus: {},      // iu -> 'pago'|'lead'|'reprovado'
    comments: {},        // comment_id -> media_id
    userLast: {}         // username -> { comment_id, media_id, ts }
  };
}
let DB = loadStore();
let saveTimer = null;
function saveStoreSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      ensureDirFor(storePath());
      fs.writeFileSync(storePath(), JSON.stringify(DB, null, 2), 'utf8');
    } catch(e) { console.error('[store] save error', e.message); }
  }, 120);
}

// --------- Utils ---------
function inRange(ts, fromStr, toStr){
  if(!fromStr && !toStr) return true;
  const d = new Date(ts);
  const from = fromStr ? new Date(fromStr + 'T00:00:00Z') : null;
  const to   = toStr   ? new Date(toStr   + 'T23:59:59Z') : null;
  if (from && d < from) return false;
  if (to   && d > to)   return false;
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

// --------- Debug ---------
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

// --------- Snippet: toda visita conta como "lead" ---------
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
    if(!once){ once=true; send('lead', {}); }
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

// --------- Eventos / Relatórios ---------
app.post('/api/event', (req,res)=>{
  let { type, creator } = req.body || {};
  if (type === 'hit') type = 'lead';
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
  saveStoreSoon();
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
  saveStoreSoon();
  res.json({ ok:true });
});

// --------- Static & Redirects ---------
app.get('/', (_req,res)=> res.redirect('/public/app.html'));
app.get(['/public','/public/','/public/dashboard.html','/dashboard','/panel'], (_req,res)=> res.redirect('/public/app.html'));
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

// =====================================================
// ================ Instagram Graph API ================
// =====================================================
const GRAPH = 'https://graph.facebook.com/v23.0/';

// State assinado (não depende de memória)
function buildState() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const ts = Date.now().toString();
  const payload = `${nonce}.${ts}`;
  const sig = crypto.createHmac('sha256', OAUTH_STATE_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function verifyState(state, maxAgeMs=15*60*1000){
  try{
    const [nonce, ts, sig] = String(state||'').split('.');
    if (!nonce || !ts || !sig) return false;
    const expected = crypto.createHmac('sha256', OAUTH_STATE_SECRET).update(`${nonce}.${ts}`).digest('hex');
    if (sig !== expected) return false;
    const age = Date.now() - Number(ts);
    return age >= 0 && age <= maxAgeMs;
  }catch{ return false; }
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
    'pages_manage_metadata' // ajuda a ler conexão IG<->Página na NPE
  ].join(',');
  const url = 'https://www.facebook.com/v23.0/dialog/oauth?' + qs.stringify({
    client_id: IG_APP_ID,
    redirect_uri: IG_REDIRECT,
    scope,
    response_type: 'code',
    state: buildState()
  });
  res.redirect(url);
});

async function fbGET(pathEnd, params){
  const url = GRAPH + pathEnd + (params ? ('?' + qs.stringify(params)) : '');
  const { data } = await axios.get(url);
  return data;
}

app.get('/auth/ig/callback', async (req,res)=>{
  try{
    const { code, state } = req.query;
    if (!code || !verifyState(state)) {
      return res.status(400).send('State inválido ou expirado.');
    }
    if (!IG_APP_ID || !IG_APP_SECRET || !IG_REDIRECT) {
      return res.status(400).send('Config faltando: IG_APP_ID/IG_APP_SECRET/IG_REDIRECT');
    }

    // troca code -> short token
    const short = await axios.get(GRAPH + 'oauth/access_token', {
      params: { client_id: IG_APP_ID, client_secret: IG_APP_SECRET, redirect_uri: IG_REDIRECT, code }
    });
    const shortToken = short.data.access_token;

    // short -> long-lived
    const long = await axios.get(GRAPH + 'oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token', client_id: IG_APP_ID,
        client_secret: IG_APP_SECRET, fb_exchange_token: shortToken
      }
    });
    const longToken = long.data.access_token;

    // ---------- Tenta VIA PÁGINAS ----------
    let chosen = null, pagesDump = null;
    try{
      const pages = await fbGET('me/accounts', { access_token: longToken });
      pagesDump = pages;
      for (const p of (pages.data || [])) {
        try{
          // pega ambos os campos; usa o que vier
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
            // se não veio username, tenta buscar
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

    // ---------- FALLBACK VIA USUÁRIO ----------
    if (!chosen) {
      try{
        const me = await fbGET('me', { fields: 'instagram_business_accounts{id,username}', access_token: longToken });
        const igs = (me.instagram_business_accounts && me.instagram_business_accounts.data) || [];
        if (igs.length) {
          chosen = { via:'user', pageId:'', igid: igs[0].id, username: (igs[0].username||'') };
        }
      }catch(_){}
    }

    LAST_OAUTH_DEBUG = { when: new Date().toISOString(), chosen, pagesDump };

    if (!chosen) {
      return res.status(400).send('Não encontrei um Instagram Business/Creator ligado a uma página nessa conta.');
    }

    DB.ig = { token: longToken, igid: chosen.igid, username: chosen.username || '', via: chosen.via, pageId: chosen.pageId || '' };
    saveStoreSoon();

    return res.redirect('/public/app.html#/reels');
  }catch(e){
    return res.status(500).send('Erro na conexão IG: ' + (e.response?.data?.error?.message || e.message || 'desconhecido'));
  }
});

// --------- IG Reels + Insights ---------
async function igFetch(pathEnd, params={}){
  const token = DB.ig.token;
  if (!token) throw new Error('Conta do Instagram não conectada.');
  const url = GRAPH + pathEnd + '?' + qs.stringify({ ...params, access_token: token });
  const { data } = await axios.get(url);
  return data;
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
    const mediaResp = await igFetch(`${IGID}/media`, { fields, limit: String(limit) });
    const items = (mediaResp.data || []).filter(m => m.media_product_type==='REELS' || m.media_type==='VIDEO');

    const wantMetrics = 'plays,reach,likes,comments,saved';
    const byVid = countsByVid();

    const enriched = await Promise.all(items.map(async (m)=>{
      let insights={};
      try{
        const ins = await igFetch(`${m.id}/insights`, { metric: wantMetrics });
        if (Array.isArray(ins.data)) {
          insights = ins.data.reduce((acc,it)=>{ acc[it.name]=(it.values?.[0]?.value)||0; return acc; }, {});
        }
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

// --------- Webhook IG (opcional) ---------
app.get('/ig/webhook', (req,res)=>{
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === IG_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});
app.post('/ig/webhook', (req,res)=>{ try{
  const data = req.body || {};
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
  saveStoreSoon();
}finally{ res.sendStatus(200); }});

// --------- Start ---------
app.listen(PORT, ()=> console.log('RastroO rodando na porta', PORT));
