// server.js — RastroO (MVP) com CORS habilitado
// -------------------------------------------------
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// Arquivos estáticos (dashboard, snippet.js)
app.use('/public', express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '1h',
}));

// --------- CORS (permite chamadas do seu site) ----------
const ALLOWED_ORIGINS = new Set([
  'https://rastroo.site',
  'https://www.rastroo.site',
  'https://trk.rastroo.site',
  'https://rastroo.onrender.com', // útil em testes
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// --------------------------------------------------------

// Banco (SQLite)
const db = new sqlite3.Database(path.join(__dirname, 'rastroo.db'));

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS hits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      creator TEXT,
      sid TEXT,
      path TEXT,
      referrer TEXT,
      ip_hash TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      creator TEXT,
      sid TEXT,
      email TEXT,
      name TEXT,
      ip_hash TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      creator TEXT,
      sid TEXT,
      order_id TEXT UNIQUE,
      amount REAL,
      currency TEXT,
      ip_hash TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT
    )
  `);
});

// Helpers DB (promises)
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

// Util
const now = () => Date.now();
function ipHashFromReq(req) {
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    '';
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

// Rate limit simples para /api/hit (10 hits/min por SID)
const MAX_HITS_PER_MIN = 10;
const hitBuckets = new Map(); // key = `${sid}:${minute}`, value = count

// ------------------ ROTAS API ----------------------------

// Healthcheck
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// HIT
app.post('/api/hit', async (req, res) => {
  try {
    const b = req.body || {};
    const pagePath = String(b.path || '');
    const referrer = String(b.referrer || '');
    const sid = String(b.sid || '');
    const creator = String(b.creator || 'desconhecido');
    const utm = b.utm || {};
    const ipHash = ipHashFromReq(req);

    // rate limit
    const minuteKey =
      (sid || ipHash) + ':' + Math.floor(now() / 60000).toString();
    const n = hitBuckets.get(minuteKey) || 0;
    if (n >= MAX_HITS_PER_MIN) return res.sendStatus(204);
    hitBuckets.set(minuteKey, n + 1);

    await run(
      `INSERT INTO hits (ts, creator, sid, path, referrer, ip_hash, utm_source, utm_medium, utm_campaign)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        now(),
        creator,
        sid,
        pagePath,
        referrer,
        ipHash,
        String(utm.source || ''),
        String(utm.medium || ''),
        String(utm.campaign || ''),
      ],
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('HIT error', e);
    res.status(500).json({ ok: false });
  }
});

// LEAD
app.post('/api/lead', async (req, res) => {
  try {
    const b = req.body || {};
    const sid = String(b.sid || '');
    const creator = String(b.creator || 'desconhecido');
    const email = String(b.email || '');
    const name = String(b.name || '');
    const utm = b.utm || {};
    const ipHash = ipHashFromReq(req);

    await run(
      `INSERT INTO leads (ts, creator, sid, email, name, ip_hash, utm_source, utm_medium, utm_campaign)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        now(),
        creator,
        sid,
        email,
        name,
        ipHash,
        String(utm.source || ''),
        String(utm.medium || ''),
        String(utm.campaign || ''),
      ],
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('LEAD error', e);
    res.status(500).json({ ok: false });
  }
});

// SALE
app.post('/api/sale', async (req, res) => {
  try {
    const b = req.body || {};
    const sid = String(b.sid || '');
    const creator = String(b.creator || 'desconhecido');
    const orderId = String(b.orderId || '');
    const amount = Number(b.amount || 0);
    const currency = String(b.currency || 'BRL');
    const utm = b.utm || {};
    const ipHash = ipHashFromReq(req);

    await run(
      `INSERT OR IGNORE INTO sales (ts, creator, sid, order_id, amount, currency, ip_hash, utm_source, utm_medium, utm_campaign)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        now(),
        creator,
        sid,
        orderId,
        amount,
        currency,
        ipHash,
        String(utm.source || ''),
        String(utm.medium || ''),
        String(utm.campaign || ''),
      ],
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('SALE error', e);
    res.status(500).json({ ok: false });
  }
});

// REPORT
app.get('/api/report', async (req, res) => {
  try {
    const from =
      req.query.from ?
        new Date(req.query.from + 'T00:00:00Z').getTime() :
        0;
    const to =
      req.query.to ?
        new Date(req.query.to + 'T23:59:59Z').getTime() :
        now();

    const hits = await all(
      `SELECT creator, COUNT(*) as n FROM hits WHERE ts BETWEEN ? AND ? GROUP BY creator`,
      [from, to],
    );
    const leads = await all(
      `SELECT creator, COUNT(*) as n FROM leads WHERE ts BETWEEN ? AND ? GROUP BY creator`,
      [from, to],
    );
    const sales = await all(
      `SELECT creator, COUNT(*) as n, SUM(amount) as revenue FROM sales WHERE ts BETWEEN ? AND ? GROUP BY creator`,
      [from, to],
    );

    const map = new Map();
    for (const r of hits) map.set(r.creator, { creator: r.creator, hits: r.n, leads: 0, sales: 0, revenue: 0 });
    for (const r of leads) {
      const m = map.get(r.creator) || { creator: r.creator, hits: 0, leads: 0, sales: 0, revenue: 0 };
      m.leads = r.n; map.set(r.creator, m);
    }
    for (const r of sales) {
      const m = map.get(r.creator) || { creator: r.creator, hits: 0, leads: 0, sales: 0, revenue: 0 };
      m.sales = r.n; m.revenue = Number(r.revenue || 0); map.set(r.creator, m);
    }

    const perCreator = Array.from(map.values()).map((r) => ({
      ...r,
      cr_h_to_l: r.hits ? +(r.leads / r.hits * 100).toFixed(2) : 0,
      cr_l_to_v: r.leads ? +(r.sales / r.leads * 100).toFixed(2) : 0,
    }));

    const summary = perCreator.reduce(
      (acc, r) => {
        acc.hits += r.hits;
        acc.leads += r.leads;
        acc.sales += r.sales;
        acc.revenue += r.revenue;
        return acc;
      },
      { hits: 0, leads: 0, sales: 0, revenue: 0 },
    );

    res.json({ ok: true, summary, perCreator });
  } catch (e) {
    console.error('REPORT error', e);
    res.status(500).json({ ok: false });
  }
});

// Redireciona raiz para o dashboard
app.get('/', (req, res) => {
  res.redirect('/public/dashboard.html');
});

// Sobe o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('RastroO rodando na porta', PORT);
});
