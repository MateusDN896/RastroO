// server.js — drop-in completo

import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bodyParser from 'body-parser';
import cookieSession from 'cookie-session';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);

// ====== ENV ======
const IG_APP_ID     = process.env.IG_APP_ID || '';
const IG_APP_SECRET = process.env.IG_APP_SECRET || '';
const IG_REDIRECT   = process.env.IG_REDIRECT || '';
const IG_VERIFY     = process.env.IG_VERIFY_TOKEN || 'RASTROO_VERIFY';
const OAUTH_SECRET  = process.env.OAUTH_STATE_SECRET || 'CHANGE_ME';
const DISK_PATH     = process.env.DISK_PATH || path.join(__dirname, 'rastroo-store.json');

if (!IG_APP_ID || !IG_APP_SECRET || !IG_REDIRECT) {
  console.warn('[WARN] Defina IG_APP_ID / IG_APP_SECRET / IG_REDIRECT nas variáveis de ambiente.');
}

const AUTH_SCOPES = [
  'instagram_basic',
  'instagram_manage_insights',
  'pages_show_list'
].join(',');

// ====== STORE ======
function loadStore() {
  try {
    if (!fs.existsSync(DISK_PATH)) return { connection: null };
    const txt = fs.readFileSync(DISK_PATH, 'utf8');
    const json = JSON.parse(txt || '{}');
    return json || { connection: null };
  } catch (e) {
    console.error('STORE_LOAD_ERR', e);
    return { connection: null };
  }
}
function saveStore(obj) {
  try {
    fs.mkdirSync(path.dirname(DISK_PATH), { recursive: true });
    fs.writeFileSync(DISK_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('STORE_SAVE_ERR', e);
  }
}

let store = loadStore();

// ====== MIDDLEWARES ======
app.use(bodyParser.json());
app.use(cookieSession({
  name: 'rastroo_sess',
  keys: [OAUTH_SECRET],
  sameSite: 'lax',
  maxAge: 1000 * 60 * 60 * 24 * 30 // 30 dias
}));

// static
app.use('/public', express.static(path.join(__dirname, 'public')));

// ====== UTILS ======
function randomState() {
  return crypto.randomBytes(16).toString('hex');
}

function ensureConnected(req, res, next) {
  const c = store.connection;
  if (!c || !c.ig_token || !c.igid) {
    return res.json({ ok:false, error:'not_connected' });
  }
  next();
}

// ====== HEALTH ======
app.get('/api/ping', (_req,res)=>res.json({ok:true, ts:Date.now()}));

// ====== AUTH STATUS ======
app.get('/api/auth/status', (_req,res)=>{
  const c = store.connection;
  if (!c) return res.json({ ok:true, connected:false });
  res.json({
    ok:true,
    connected: !!c.ig_token && !!c.igid,
    username: c.username || '',
    igid: c.igid || ''
  });
});

// ====== OAUTH START ======
app.get('/auth/ig/login', (req,res)=>{
  try {
    const state = randomState();
    req.session.oauth_state = state;
    const params = new URLSearchParams({
      client_id: IG_APP_ID,
      redirect_uri: IG_REDIRECT,
      response_type: 'code',
      state,
      scope: AUTH_SCOPES
    }).toString();
    const url = `https://www.facebook.com/v20.0/dialog/oauth?${params}`;
    res.redirect(url);
  } catch (e) {
    console.error('AUTH_START_ERR', e);
    res.status(500).send('OAuth init error');
  }
});

// ====== OAUTH CALLBACK ======
app.get('/auth/ig/callback', async (req,res)=>{
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      console.error('OAUTH_ERROR', error, error_description);
      return res.status(400).send(`OAuth error: ${error_description || error}`);
    }
    if (!code || !state || state !== req.session.oauth_state) {
      console.error('[ Erro  de retorno de chamada do OAuth  ]  Erro:  Código/estado  ausente');
      return res.status(400).send('Código/estado ausente ou inválido');
    }

    // troca code -> access_token
    const p = new URLSearchParams({
      client_id: IG_APP_ID,
      client_secret: IG_APP_SECRET,
      redirect_uri: IG_REDIRECT,
      code
    }).toString();
    const tokenUrl = `https://graph.facebook.com/v20.0/oauth/access_token?${p}`;
    const rTok = await fetch(tokenUrl);
    const jTok = await rTok.json();

    if (!jTok.access_token) {
      console.error('TOKEN_EXCHANGE_FAIL', jTok);
      return res.status(400).send('Falha ao trocar code por token.');
    }
    const fbToken = jTok.access_token;

    // lista pages e acha uma com instagram_business_account
    const pgs = await fetch(`https://graph.facebook.com/v20.0/me/accounts?access_token=${fbToken}`);
    const jPgs = await pgs.json();
    const page = (jPgs.data || []).find(p => p.instagram_business_account);
    if (!page) {
      console.error('NO_IG_LINKED_PAGE', jPgs);
      return res
        .status(400)
        .send('Não encontrei um Instagram Business/Creator ligado a uma página nessa conta.');
    }

    const igid = page.instagram_business_account.id;

    // pega username
    const uResp = await fetch(`https://graph.facebook.com/v20.0/${igid}?fields=username&access_token=${fbToken}`);
    const jU = await uResp.json();
    const username = jU.username || '';

    store.connection = {
      igid,
      ig_token: fbToken,
      username,
      connected_at: Date.now()
    };
    saveStore(store);

    // volta para app
    res.redirect('/public/app.html#/reels');
  } catch (e) {
    console.error('AUTH_CB_ERR', e);
    res.status(500).send('Erro na callback OAuth');
  }
});

// ====== IG REELS (tolerante) ======
app.get('/api/ig/reels', ensureConnected, async (_req,res)=>{
  try {
    const { igid, ig_token } = store.connection;

    const FIELDS = [
      'id','caption','media_type','media_product_type',
      'thumbnail_url','media_url','permalink',
      'comments_count','like_count','video_play_count',
      'timestamp'
    ].join(',');

    const url = `https://graph.facebook.com/v20.0/${igid}/media?fields=${encodeURIComponent(FIELDS)}&limit=100&access_token=${ig_token}`;
    const r = await fetch(url);
    const js = await r.json();

    if (js.error) {
      console.error('IG_MEDIA_ERR', js.error);
      // se token inválido, desconecta
      if (js.error.code === 190) {
        store.connection = null;
        saveStore(store);
        return res.json({ ok:false, error:'not_connected' });
      }
      return res.json({ ok:false, error:'fb_error', raw:js });
    }

    const data = js.data || [];
    // aceita REELS OU permalink com /reel/
    const items = data.filter(m =>
      m.media_product_type === 'REELS' ||
      ((m.permalink || '').includes('/reel/'))
    );

    res.json({ ok:true, count: items.length, items });
  } catch (e) {
    console.error('IG_REELS_ROUTE_ERR', e);
    res.json({ ok:false, error:'server_error' });
  }
});

// ====== DEBUG opcional ======
app.get('/api/debug/ig/media', ensureConnected, async (_req,res)=>{
  try {
    const { igid, ig_token } = store.connection;
    const url = `https://graph.facebook.com/v20.0/${igid}/media?fields=id,media_product_type,permalink&limit=50&access_token=${ig_token}`;
    const r = await fetch(url);
    const js = await r.json();
    res.json(js);
  } catch (e) {
    res.json({ ok:false, error:String(e) });
  }
});

// ====== IG WEBHOOK (opcional; deixa pronto) ======
app.get('/ig/webhook', (req,res)=>{
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === IG_VERIFY) {
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});
app.post('/ig/webhook', (req,res)=>{ res.sendStatus(200); });

// ====== INDEX ======
app.get('/', (_req,res)=>res.redirect('/public/app.html'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> {
  console.log(`=> Servidor RastroO LIGADO : ${PORT}`);
});
