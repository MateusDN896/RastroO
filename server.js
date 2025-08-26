// server.js — RastroO (COMPLETO)
// ------------------------------------------------------------
// Endpoints do rastreador (leads/vendas/relatório) + Conector IG
// com fallback (via páginas e via usuário), webhook IG opcional,
// debug e servindo /public.
// ------------------------------------------------------------

/* eslint-disable */
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const cors = require('cors');
const axios = require('axios');
const qs = require('querystring');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');

// ---------- Config básica ----------
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(cookieParser());
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Serve arquivos estáticos da pasta /public
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

// ---------- Pastas e "banco" de arquivos ----------
const DATA_DIR = path.join(__dirname, 'data');
const IG_FILE = path.join(DATA_DIR, 'ig.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');

async function ensureData() {
  if (!fs.existsSync(DATA_DIR)) await fsp.mkdir(DATA_DIR, { recursive: true });
  if (!fs.existsSync(IG_FILE)) await fsp.writeFile(IG_FILE, JSON.stringify({ access_token: '', igid: '', username: '', via: '', pageId: '' }, null, 2));
  if (!fs.existsSync(EVENTS_FILE)) await fsp.writeFile(EVENTS_FILE, JSON.stringify({ events: [] }, null, 2));
}
function nowTs() { return Date.now(); }

async function readJSON(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return null; }
}
async function writeJSON(file, obj) {
  await fsp.writeFile(file, JSON.stringify(obj, null, 2));
}

// ---------- Helper: HMAC state (prevenir “state inválido”) ----------
function buildState(secret) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const ts = Date.now().toString();
  const payload = `${nonce}.${ts}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function verifyState(state, secret, maxAgeMs = 10 * 60 * 1000) {
  if (!state) return false;
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, ts, sig] = parts;
  const payload = `${nonce}.${ts}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (expected !== sig) return false;
  const age = Date.now() - Number(ts);
  return age >= 0 && age <= maxAgeMs;
}

// ---------- Helpers Facebook Graph ----------
const GRAPH = 'https://graph.facebook.com/v23.0/';
async function fbGET(pathEnd, params) {
  const url = GRAPH + pathEnd + (params ? ('?' + qs.stringify(params)) : '');
  const { data } = await axios.get(url);
  return data;
}
async function fbPOST(pathEnd, params) {
  const url = GRAPH + pathEnd;
  const { data } = await axios.post(url, qs.stringify(params));
  return data;
}

// ---------- IG Creds (salva/ler) ----------
async function saveIgCreds(creds) {
  const base = await readJSON(IG_FILE) || {};
  const merged = { ...base, ...creds };
  await writeJSON(IG_FILE, merged);
  return merged;
}
async function getIgCreds() {
  const c = await readJSON(IG_FILE);
  return c || { access_token: '', igid: '', username: '', via: '', pageId: '' };
}

// ---------- Debug do último OAuth ----------
let LAST_OAUTH_DEBUG = {};
app.get('/api/debug/last_oauth', (req, res) => res.json(LAST_OAUTH_DEBUG));

// ---------- Checagem de ENVs ----------
function requireEnv(...keys) {
  const miss = keys.filter(k => !process.env[k] || process.env[k].trim() === '');
  if (miss.length) return { ok: false, miss };
  return { ok: true };
}
app.get('/api/ig/check_env', (req, res) => {
  const check = requireEnv('IG_APP_ID','IG_APP_SECRET','IG_REDIRECT','OAUTH_STATE_SECRET');
  res.json({ ok: check.ok, miss: check.miss || [] });
});

// ---------- Creds do IG (para a UI verificar) ----------
app.get('/api/ig/creds', async (req, res) => {
  const c = await getIgCreds();
  res.json({
    ok: true,
    connected: !!(c && c.access_token && c.igid),
    igid: c.igid || '',
    username: c.username || '',
    token_preview: c.access_token ? (c.access_token.slice(0, 8) + '...' + c.access_token.slice(-5)) : ''
  });
});

// ---------- OAuth IG: Login + Callback ----------
app.get('/auth/ig/login', async (req, res) => {
  const check = requireEnv('IG_APP_ID','IG_REDIRECT','OAUTH_STATE_SECRET');
  if (!check.ok) return res.status(500).send('Config faltando: defina IG_APP_ID, IG_REDIRECT e OAUTH_STATE_SECRET.');

  const scopes = [
    'instagram_basic',
    'instagram_manage_insights',
    'instagram_manage_comments',
    'instagram_manage_messages',
    'pages_read_engagement',
    'pages_show_list',
    'business_management'
  ].join(',');

  const state = buildState(process.env.OAUTH_STATE_SECRET);
  const url = 'https://www.facebook.com/v23.0/dialog/oauth?' + qs.stringify({
    client_id: process.env.IG_APP_ID,
    redirect_uri: process.env.IG_REDIRECT,
    scope: scopes,
    response_type: 'code',
    state
  });
  return res.redirect(url);
});

app.get('/auth/ig/callback', async (req, res) => {
  const { code, state } = req.query;

  // valida state
  try {
    if (!verifyState(state, process.env.OAUTH_STATE_SECRET)) {
      return res.status(400).send('State inválido ou expirado.');
    }
  } catch {
    return res.status(400).send('State inválido ou expirado.');
  }

  // troca code por token
  try {
    const short = await axios.get(GRAPH + 'oauth/access_token', {
      params: {
        client_id: process.env.IG_APP_ID,
        client_secret: process.env.IG_APP_SECRET,
        redirect_uri: process.env.IG_REDIRECT,
        code
      }
    });
    const shortToken = short.data.access_token;

    // long-lived
    const long = await axios.get(GRAPH + 'oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.IG_APP_ID,
        client_secret: process.env.IG_APP_SECRET,
        fb_exchange_token: shortToken
      }
    });
    const longToken = long.data.access_token;

    // tenta via páginas
    let chosen = null;
    let pagesData = null;
    try {
      pagesData = await fbGET('me/accounts', { access_token: longToken });
      const pages = pagesData.data || [];
      for (const p of pages) {
        try {
          const info = await fbGET(`${p.id}`, {
            fields: 'instagram_business_account{id,username}',
            access_token: longToken
          });
          if (info.instagram_business_account && info.instagram_business_account.id) {
            chosen = {
              via: 'pages',
              pageId: p.id,
              igid: info.instagram_business_account.id,
              username: info.instagram_business_account.username || ''
            };
            break;
          }
        } catch {}
      }
    } catch {}

    // fallback via usuário
    if (!chosen) {
      try {
        const meIGs = await fbGET('me', {
          fields: 'instagram_business_accounts{id,username}',
          access_token: longToken
        });
        const igs = (meIGs.instagram_business_accounts && meIGs.instagram_business_accounts.data) || [];
        if (igs.length) {
          chosen = {
            via: 'user',
            pageId: '',
            igid: igs[0].id,
            username: igs[0].username || ''
          };
        }
      } catch {}
    }

    LAST_OAUTH_DEBUG = { when: new Date().toISOString(), chosen };

    if (!chosen) {
      return res.status(400).send('Não encontrei um Instagram Business/Creator ligado a uma página nessa conta.');
    }

    await saveIgCreds({
      access_token: longToken,
      igid: chosen.igid,
      username: chosen.username,
      via: chosen.via,
      pageId: chosen.pageId || ''
    });

    // redireciona para sua UI
    return res.redirect('/public/app.html#/reels');

  } catch (err) {
    LAST_OAUTH_DEBUG = { error: err?.response?.data || String(err) };
    return res.status(500).send('Erro no OAuth IG: ' + (err?.response?.data?.error?.message || err.message));
  }
});

// ---------- Webhook IG (opcional) ----------
app.get('/ig/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === (process.env.IG_VERIFY_TOKEN || 'RASTROO_VERIFY')) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Forbidden');
});

app.post('/ig/webhook', (req, res) => {
  // Somente registra no log — você pode processar aqui se quiser DM/comentários em tempo real.
  console.log('IG Webhook event:', JSON.stringify(req.body));
  res.sendStatus(200);
});

// =====================================================
// ================ RastroO — Eventos ==================
// =====================================================

// formato salvo: { events: [{ts,type:'lead'|'sale'|'hit', creator, amount}] }
async function appendEvent(ev) {
  const db = await readJSON(EVENTS_FILE) || { events: [] };
  db.events.push(ev);
  await writeJSON(EVENTS_FILE, db);
  return ev;
}

// Para compatibilidade com seus testes:
app.get('/api/debug/hit', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Novo/antigo: registrar eventos
app.post('/api/hit', async (req, res) => {
  try {
    const { creator = '@anon', ref = '', utm_source = '' } = req.body || {};
    await appendEvent({ ts: nowTs(), type: 'hit', creator, ref, utm_source });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

app.post('/api/lead', async (req, res) => {
  try {
    const { creator = '@anon', username = '', meta = {} } = req.body || {};
    await appendEvent({ ts: nowTs(), type: 'lead', creator, username, meta });
    res.json({ ok: true, type: 'lead', creator });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

app.post('/api/sale', async (req, res) => {
  try {
    const { creator = '@anon', amount = 0, currency = 'BRL', order = '', meta = {} } = req.body || {};
    await appendEvent({ ts: nowTs(), type: 'sale', creator, amount: Number(amount)||0, currency, order, meta });
    res.json({ ok: true, type: 'sale', creator });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// Relatório simples: totals + por creator (filtrado por data)
app.get('/api/report', async (req, res) => {
  try {
    const db = await readJSON(EVENTS_FILE) || { events: [] };
    const from = req.query.from ? Number(req.query.from) : 0;
    const to = req.query.to ? Number(req.query.to) : Date.now();

    const rows = db.events.filter(e => e.ts >= from && e.ts <= to);

    const totals = { hits: 0, leads: 0, sales: 0, revenue: 0 };
    const perCreator = {}; // {creator: {hits,leads,sales,revenue}}

    for (const e of rows) {
      perCreator[e.creator] = perCreator[e.creator] || { hits: 0, leads: 0, sales: 0, revenue: 0 };
      if (e.type === 'hit') { totals.hits++; perCreator[e.creator].hits++; }
      if (e.type === 'lead') { totals.leads++; perCreator[e.creator].leads++; }
      if (e.type === 'sale') {
        totals.sales++; perCreator[e.creator].sales++;
        const amt = Number(e.amount) || 0;
        totals.revenue += amt;
        perCreator[e.creator].revenue += amt;
      }
    }

    res.json({ ok: true, totals, perCreator, count: rows.length, range: { from, to } });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// Página raiz pode redirecionar pra sua app shell se quiser
app.get('/', (req, res) => {
  res.redirect('/public/app.html#/dashboard');
});

// ---------- Start ----------
ensureData().then(() => {
  app.listen(PORT, () => {
    console.log('RastroO server rodando na porta', PORT);
  });
});
