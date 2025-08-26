// RastroO - MVP self-hosted
// Run: npm i && npm run dev
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;

// Security / parsers
app.use(helmet());
app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:true}));
app.use(cors());
app.use(morgan('tiny'));

// Static
app.use('/public', express.static(path.join(__dirname, 'public')));

// --- Simple in-memory rate limiter per session (hit endpoint) ---
const rateBucket = new Map(); // sessionId -> [timestamps]
function canHit(sessionId) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxHits = 10;
  if(!sessionId) return true; // if no session, don't block (we still track)
  const arr = rateBucket.get(sessionId) || [];
  // prune
  const filtered = arr.filter(ts => now - ts < windowMs);
  filtered.push(now);
  rateBucket.set(sessionId, filtered);
  return filtered.length <= maxHits;
}

// --- DB setup ---
const db = new Database(path.join(__dirname, 'rastroo.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS creators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  notes TEXT,
  createdAt TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  createdAt TEXT DEFAULT (datetime('now')),
  creatorSlug TEXT,
  page TEXT,
  referrer TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT,
  device TEXT,
  ipHash TEXT,
  sessionId TEXT
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  createdAt TEXT DEFAULT (datetime('now')),
  email TEXT,
  name TEXT,
  creatorSlug TEXT,
  page TEXT,
  sessionId TEXT,
  extraJson TEXT
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  createdAt TEXT DEFAULT (datetime('now')),
  orderId TEXT UNIQUE,
  amount REAL,
  currency TEXT,
  creatorSlug TEXT,
  sessionId TEXT,
  attribution TEXT CHECK(attribution IN ('FIRST','LAST')) DEFAULT 'LAST',
  extraJson TEXT
);
`);

// Seed creators if empty
const countCreators = db.prepare('SELECT COUNT(*) as c FROM creators').get().c;
if (countCreators === 0) {
  const seed = db.prepare('INSERT INTO creators (name, slug, notes) VALUES (?,?,?)');
  seed.run('Pedro', '@pedro', 'Seed');
  seed.run('Mateus', '@mateus', 'Seed');
  seed.run('Reels RJ', '@reelsRJ', 'Seed');
  console.log('Seeded creators.');
}

// Helpers
function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function inferCreator({explicit, cookies, utm_source}) {
  if (explicit && explicit.trim()) return explicit.trim();
  if (cookies && cookies.rastroo_creator) return cookies.rastroo_creator;
  if (utm_source && typeof utm_source === 'string' && utm_source.startsWith('@')) return utm_source;
  return 'desconhecido';
}

function parseDate(d) {
  // return ISO string (YYYY-MM-DD)
  return d ? d : null;
}

// --- API ---

// Health
app.get('/api/health', (req, res) => res.json({ok:true, ts:Date.now()}));

// Collect page hit
app.post('/api/hit', (req, res) => {
  try {
    const ua = req.headers['user-agent'] || '';
    // Express may set req.ip like ::ffff:127.0.0.1
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
    const body = req.body || {};
    const {
      page, referrer,
      utm_source, utm_medium, utm_campaign, utm_content,
      device, sessionId, creatorSlug
    } = body;

    if (sessionId && !canHit(sessionId)) {
      return res.status(429).json({error:'Too many hits per minute for this session'});
    }

    const ipHash = sha256((ip||'') + '|' + ua);
    const creator = inferCreator({
      explicit: creatorSlug,
      cookies: body.cookies || {},
      utm_source
    });

    const stmt = db.prepare(`INSERT INTO hits
      (creatorSlug, page, referrer, utm_source, utm_medium, utm_campaign, utm_content, device, ipHash, sessionId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(creator, page || '', referrer || '', utm_source || '', utm_medium || '',
             utm_campaign || '', utm_content || '', device || '', ipHash, sessionId || '');

    res.json({ok:true});
  } catch (e) {
    console.error(e);
    res.status(500).json({error:'internal'});
  }
});

// Collect lead
app.post('/api/lead', (req, res) => {
  try {
    const body = req.body || {};
    const {email, name, page, sessionId, creatorSlug, extraJson} = body;
    if (!email) return res.status(400).json({error:'email required'});

    const creator = inferCreator({explicit: creatorSlug, cookies: body.cookies || {}, utm_source: body.utm_source});

    const stmt = db.prepare(`INSERT INTO leads
      (email, name, page, sessionId, creatorSlug, extraJson)
      VALUES (?, ?, ?, ?, ?, ?)`);
    stmt.run(email, name || '', page || '', sessionId || '', creator, extraJson ? JSON.stringify(extraJson) : null);

    res.json({ok:true});
  } catch (e) {
    console.error(e);
    res.status(500).json({error:'internal'});
  }
});

// Collect sale
app.post('/api/sale', (req, res) => {
  try {
    const body = req.body || {};
    const {orderId, amount, currency, sessionId, creatorSlug, attribution, extraJson} = body;
    if (!orderId) return res.status(400).json({error:'orderId required'});

    const creator = inferCreator({explicit: creatorSlug, cookies: body.cookies || {}, utm_source: body.utm_source});

    const stmt = db.prepare(`INSERT INTO sales
      (orderId, amount, currency, sessionId, creatorSlug, attribution, extraJson)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(orderId, amount || 0, currency || 'BRL', sessionId || '', creator,
             (attribution === 'FIRST' ? 'FIRST' : 'LAST'),
             extraJson ? JSON.stringify(extraJson) : null);

    res.json({ok:true});
  } catch (e) {
    if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({error:'duplicate orderId'});
    }
    console.error(e);
    res.status(500).json({error:'internal'});
  }
});

// Reports
app.get('/api/report', (req, res) => {
  try {
    const from = req.query.from; // YYYY-MM-DD
    const to = req.query.to;     // YYYY-MM-DD
    // Build where clause
    const whereHits = [];
    const whereLeads = [];
    const whereSales = [];
    const params = {};

    if (from) {
      whereHits.push("createdAt >= @from || ' 00:00:00'");
      whereLeads.push("createdAt >= @from || ' 00:00:00'");
      whereSales.push("createdAt >= @from || ' 00:00:00'");
      params.from = from;
    }
    if (to) {
      whereHits.push("createdAt <= @to || ' 23:59:59'");
      whereLeads.push("createdAt <= @to || ' 23:59:59'");
      whereSales.push("createdAt <= @to || ' 23:59:59'");
      params.to = to;
    }

    function group(table, where) {
      const clause = where.length ? ('WHERE ' + where.join(' AND ')) : '';
      const sql = `SELECT creatorSlug, COUNT(*) as total FROM ${table} ${clause} GROUP BY creatorSlug`;
      return db.prepare(sql).all(params);
    }

    const hits = group('hits', whereHits);
    const leads = group('leads', whereLeads);
    const sales = db.prepare(`
      SELECT creatorSlug,
             COUNT(*) as total,
             SUM(amount) as revenue
      FROM sales ${whereSales.length?('WHERE ' + whereSales.join(' AND ')):''}
      GROUP BY creatorSlug
    `).all(params);

    // Merge by creator
    const byCreator = new Map();
    const merge = (arr, key, valKeys) => {
      arr.forEach(r => {
        const k = r.creatorSlug || 'desconhecido';
        if (!byCreator.has(k)) byCreator.set(k, {creatorSlug: k, hits:0, leads:0, sales:0, revenue:0});
        const obj = byCreator.get(k);
        valKeys.forEach(vk => { obj[vk] = (obj[vk] || 0) + (r[vk] || 0); });
        byCreator.set(k, obj);
      });
    };
    merge(hits, 'creatorSlug', ['total']);
    merge(leads, 'creatorSlug', ['total']);
    sales.forEach(r => {
      const k = r.creatorSlug || 'desconhecido';
      if (!byCreator.has(k)) byCreator.set(k, {creatorSlug: k, hits:0, leads:0, sales:0, revenue:0});
      const obj = byCreator.get(k);
      obj.sales += r.total || 0;
      obj.revenue += r.revenue || 0;
      byCreator.set(k, obj);
    });

    const rows = Array.from(byCreator.values()).map(r => ({
      creatorSlug: r.creatorSlug,
      hits: r.total || r.hits || 0,
      leads: r.leads || 0,
      sales: r.sales || 0,
      revenue: r.revenue || 0,
      cr_hit_to_lead: r.total && r.leads ? (r.leads / r.total) : 0,
      cr_lead_to_sale: r.leads ? (r.sales / r.leads) : 0
    }));

    res.json({ok:true, rows});
  } catch (e) {
    console.error(e);
    res.status(500).json({error:'internal'});
  }
});

// Simple creators CRUD (list/create)
app.get('/api/creators', (req, res) => {
  try {
    const rows = db.prepare('SELECT id, name, slug, notes, createdAt FROM creators ORDER BY createdAt DESC').all();
    res.json({ok:true, rows});
  } catch (e) {
    console.error(e);
    res.status(500).json({error:'internal'});
  }
});

app.post('/api/creators', (req, res) => {
  try {
    const {name, slug, notes} = req.body || {};
    if (!name || !slug) return res.status(400).json({error:'name and slug required'});
    db.prepare('INSERT INTO creators (name, slug, notes) VALUES (?,?,?)').run(name, slug, notes || '');
    res.json({ok:true});
  } catch (e) {
    if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({error:'slug already exists'});
    }
    console.error(e);
    res.status(500).json({error:'internal'});
  }
});

// Serve dashboard
app.get('/', (req, res) => res.redirect('/public/dashboard.html'));

app.listen(PORT, () => {
  console.log(`RastroO MVP running at http://localhost:${PORT}`);
});
