// server.js — RastroO (DIAGNÓSTICO) sem DB: armazena tudo em memória
// Objetivo: validar que o backend responde e o painel lê os dados.
// Depois de validar, voltamos pro SQLite/Supabase.
// --------------------------------------------------------------
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// LOG de requisições (ajuda a ver nos Logs do Render)
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

// CORS aberto (pra não travar nada agora)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Arquivos estáticos (dashboard, snippet.js)
app.use('/public', express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '1h',
}));

// ===== Armazenamento em memória =====
const hits  = []; // { ts, creator, sid, path, referrer, ip_hash, utm_* }
const leads = []; // { ts, creator, sid, email, name, ip_hash, utm_* }
const sales = []; // { ts, creator, sid, order_id, amount, currency, ip_hash, utm_* }

const now = () => Date.now();
function ipHashFromReq(req) {
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress || '';
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

// Rate limit simples de HIT (10/min por SID/IP)
const MAX_HITS_PER_MIN = 10;
const hitBuckets = new Map(); // key=`${sidOrIp}:${minute}` -> count

// -------- Rotas --------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), mode: 'memory' });
});

app.post('/api/hit', (req, res) => {
  try {
    const b = req.body || {};
    const sid = String(b.sid || '');
    const creator = String(b.creator || 'desconhecido');
    const utm = b.utm || {};
    const pagePath = String(b.path || '');
    const referrer = String(b.referrer || '');
    const ipHash = ipHashFromReq(req);

    const key = (sid || ipHash) + ':' + Math.floor(now() / 60000);
    const n = hitBuckets.get(key) || 0;
    if (n >= MAX_HITS_PER_MIN) return res.sendStatus(204);
    hitBuckets.set(key, n + 1);

    hits.push({
      ts: now(), creator, sid,
      path: pagePath, referrer, ip_hash: ipHash,
      utm_source: String(utm.source || ''),
      utm_medium: String(utm.medium || ''),
      utm_campaign: String(utm.campaign || '')
    });
    console.log('HIT gravado (mem):', { creator, sid, pagePath });
    res.json({ ok: true });
  } catch (e) {
    console.error('HIT error', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/api/lead', (req, res) => {
  try {
    const b = req.body || {};
    const sid = String(b.sid || '');
    const creator = String(b.creator || 'desconhecido');
    const email = String(b.email || '');
    const name = String(b.name || '');
    const utm = b.utm || {};
    const ipHash = ipHashFromReq(req);

    leads.push({
      ts: now(), creator, sid, email, name,
      ip_hash: ipHash,
      utm_source: String(utm.source || ''),
      utm_medium: String(utm.medium || ''),
      utm_campaign: String(utm.campaign || '')
    });
    console.log('LEAD gravado (mem):', { creator, email });
    res.json({ ok: true });
  } catch (e) {
    console.error('LEAD error', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/api/sale', (req, res) => {
  try {
    const b = req.body || {};
    const sid = String(b.sid || '');
    const creator = String(b.creator || 'desconhecido');
    const orderId = String(b.orderId || '');
    const amount = Number(b.amount || 0);
    const currency = String(b.currency || 'BRL');
    const utm = b.utm || {};
    const ipHash = ipHashFromReq(req);

    sales.push({
      ts: now(), creator, sid, order_id: orderId,
      amount, currency, ip_hash: ipHash,
      utm_source: String(utm.source || ''),
      utm_medium: String(utm.medium || ''),
      utm_campaign: String(utm.campaign || '')
    });
    console.log('SALE gravada (mem):', { creator, orderId, amount });
    res.json({ ok: true });
  } catch (e) {
    console.error('SALE error', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/report', (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from + 'T00:00:00Z').getTime() : 0;
    const to   = req.query.to   ? new Date(req.query.to   + 'T23:59:59Z').getTime() : now();

    const inRange = (ts) => ts >= from && ts <= to;

    const agg = new Map(); // creator -> {hits,leads,sales,revenue}
    function ensure(c){ if(!agg.has(c)) agg.set(c, { creator:c, hits:0, leads:0, sales:0, revenue:0 }); return agg.get(c); }

    for(const h of hits)  if(inRange(h.ts))  ensure(h.creator).hits++;
    for(const l of leads) if(inRange(l.ts))  ensure(l.creator).leads++;
    for(const s of sales) if(inRange(s.ts)) { const m=ensure(s.creator); m.sales++; m.revenue += Number(s.amount||0); }

    const perCreator = Array.from(agg.values()).map(r => ({
      ...r,
      cr_h_to_l: r.hits ? +(r.leads / r.hits * 100).toFixed(2) : 0,
      cr_l_to_v: r.leads ? +(r.sales / r.leads * 100).toFixed(2) : 0,
    }));

    const summary = perCreator.reduce((a,r)=>({ 
      hits:a.hits+r.hits, leads:a.leads+r.leads, sales:a.sales+r.sales, revenue:a.revenue+r.revenue 
    }), { hits:0, leads:0, sales:0, revenue:0 });

    res.json({ ok:true, summary, perCreator });
  } catch (e) {
    console.error('REPORT error', e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// Rotas de teste (GET) — clicáveis
app.get('/api/debug/hit', (req, res) => {
  const creator = req.query.r || '@debug';
  hits.push({ ts: now(), creator, sid:'dbg', path:'/debug', referrer:'', ip_hash:'dbg', utm_source:'', utm_medium:'', utm_campaign:'' });
  res.json({ ok:true, type:'hit', creator });
});
app.get('/api/debug/lead', (req, res) => {
  const creator = req.query.r || '@debug';
  leads.push({ ts: now(), creator, sid:'dbg', email:`dbg+${Date.now()}@mail.com`, name:'Lead Debug', ip_hash:'dbg', utm_source:'', utm_medium:'', utm_campaign:'' });
  res.json({ ok:true, type:'lead', creator });
});
app.get('/api/debug/sale', (req, res) => {
  const creator = req.query.r || '@debug';
  sales.push({ ts: now(), creator, sid:'dbg', order_id:'ord-'+Date.now(), amount:29.9, currency:'BRL', ip_hash:'dbg', utm_source:'', utm_medium:'', utm_campaign:'' });
  res.json({ ok:true, type:'sale', creator });
});

// Raiz -> dashboard
app.get('/', (_req, res) => res.redirect('/public/dashboard.html'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('RastroO rodando (memória) na porta', PORT));
