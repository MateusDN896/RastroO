// server.js — RastroO (compatível com Node < 18 e >= 18)

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const fs = require("fs");
const path = require("path");

// --- fetch polyfill (garante em qualquer versão do Node)
let _fetch = global.fetch;
if (!_fetch) {
  _fetch = (...args) =>
    import('node-fetch').then(({ default: f }) => f(...args));
}
const fetch = (...args) => _fetch(...args);

// --- App base
const app = express();
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// --- Público estático
const PUBLIC_DIR = path.join(__dirname, "public");
app.use("/public", express.static(PUBLIC_DIR));

// --- Porta Render
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// --- Armazenamento em disco
const DATA_DIR = process.env.DISK_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const IG_STORE_FILE = process.env.DISK_PATH || path.join(DATA_DIR, "ig_store.json");

// Helpers de arquivo
function safeRead(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.warn("[safeRead]", e.message);
    return fallback;
  }
}
function safeWrite(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.warn("[safeWrite]", e.message);
  }
}

// Estado
const store = safeRead(IG_STORE_FILE, { instagram: {} });
let lastOAuth = null;

// --- ENV
const IG_APP_ID = process.env.IG_APP_ID || "";
const IG_APP_SECRET = process.env.IG_APP_SECRET || "";
const IG_REDIRECT = process.env.IG_REDIRECT || "";
const IG_VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN || "RASTROO_VERIFY";
const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || "state_local_dev";

function envOk() {
  const miss = [];
  if (!IG_APP_ID) miss.push("IG_APP_ID");
  if (!IG_APP_SECRET) miss.push("IG_APP_SECRET");
  if (!IG_REDIRECT) miss.push("IG_REDIRECT");
  if (miss.length) {
    console.warn("⚠️ Variáveis ausentes:", miss.join(", "));
    return false;
  }
  return true;
}

// ---------- Health & raiz ----------
app.get("/", (_req, res) => res.redirect("/public/app.html"));
app.get("/healthz", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- Status IG ----------
app.get("/api/ig/status", (_req, res) => {
  const ig = store.instagram || {};
  res.json({
    ok: true,
    connected_facebook: Boolean(ig.facebook_access_token),
    connected: Boolean(ig.ig_user_id && ig.username && ig.facebook_access_token),
    igid: ig.ig_user_id || "",
    username: ig.username || "",
    token_preview: ig.facebook_access_token
      ? ig.facebook_access_token.slice(0, 6) + "..." + ig.facebook_access_token.slice(-4)
      : ""
  });
});

// ---------- Debug ----------
app.get("/api/debug/last_oauth", (_req, res) => res.json({ ok: true, lastOAuth }));

// ---------- OAuth IG ----------
app.get("/auth/ig", (req, res) => {
  if (!envOk()) {
    return res
      .status(500)
      .send("Config faltando: IG_APP_ID, IG_APP_SECRET e IG_REDIRECT (Render > Environment).");
  }
  const state = Buffer.from(JSON.stringify({ t: Date.now(), s: OAUTH_STATE_SECRET })).toString("base64");

  const scopes = [
    "instagram_basic",
    "instagram_manage_insights",
    "instagram_manage_messages",
    "pages_show_list",
    "pages_read_engagement",
    "business_management"
  ];

  const url =
    "https://www.facebook.com/v19.0/dialog/oauth" +
    `?client_id=${encodeURIComponent(IG_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(IG_REDIRECT)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scopes.join(","))}` +
    `&state=${encodeURIComponent(state)}`;

  res.redirect(url);
});

app.get("/auth/ig/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) throw new Error("Código/estado ausente");

    // valida state
    try {
      const parsed = JSON.parse(Buffer.from(String(state), "base64").toString("utf8"));
      if (!parsed || parsed.s !== OAUTH_STATE_SECRET) throw new Error("State inválido ou expirado");
    } catch {
      throw new Error("State inválido ou expirado");
    }

    // curto
    const tokenURL =
      "https://graph.facebook.com/v19.0/oauth/access_token" +
      `?client_id=${encodeURIComponent(IG_APP_ID)}` +
      `&client_secret=${encodeURIComponent(IG_APP_SECRET)}` +
      `&redirect_uri=${encodeURIComponent(IG_REDIRECT)}` +
      `&code=${encodeURIComponent(String(code))}`;

    const tokenResp = await fetch(tokenURL);
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok) throw new Error("Token error: " + JSON.stringify(tokenJson));
    let accessToken = tokenJson.access_token;

    // longo
    const longURL =
      "https://graph.facebook.com/v19.0/oauth/access_token" +
      `?grant_type=fb_exchange_token` +
      `&client_id=${encodeURIComponent(IG_APP_ID)}` +
      `&client_secret=${encodeURIComponent(IG_APP_SECRET)}` +
      `&fb_exchange_token=${encodeURIComponent(accessToken)}`;

    const longResp = await fetch(longURL);
    const longJson = await longResp.json();
    if (longResp.ok && longJson.access_token) accessToken = longJson.access_token;

    // páginas
    const pagesResp = await fetch(
      `https://graph.facebook.com/v19.0/me/accounts?access_token=${encodeURIComponent(accessToken)}`
    );
    const pagesJson = await pagesResp.json();
    if (!pagesResp.ok) throw new Error("me/accounts error: " + JSON.stringify(pagesJson));

    let found = null;
    if (Array.isArray(pagesJson.data)) {
      for (const pg of pagesJson.data) {
        const igResp = await fetch(
          `https://graph.facebook.com/v19.0/${pg.id}?fields=connected_instagram_account&access_token=${encodeURIComponent(
            accessToken
          )}`
        );
        const igJson = await igResp.json();
        const igAcc = igJson.connected_instagram_account;
        if (igAcc && igAcc.id) {
          const userResp = await fetch(
            `https://graph.facebook.com/v19.0/${igAcc.id}?fields=username&access_token=${encodeURIComponent(
              accessToken
            )}`
          );
          const userJson = await userResp.json();
          found = { page_id: pg.id, ig_user_id: igAcc.id, username: userJson.username || "" };
          break;
        }
      }
    }
    if (!found)
      throw new Error("Não encontrei IG Business/Creator ligado a uma Página nesta conta da Meta.");

    // salva
    store.instagram = {
      facebook_access_token: accessToken,
      ig_user_id: found.ig_user_id,
      username: found.username,
      page_id: found.page_id,
      updated_at: new Date().toISOString()
    };
    safeWrite(IG_STORE_FILE, store);
    lastOAuth = { ok: true, when: new Date().toISOString(), store: store.instagram };

    res.redirect("/public/connect.html?ok=1");
  } catch (err) {
    console.error("[OAuth callback error]", err);
    lastOAuth = { ok: false, error: String(err && err.message ? err.message : err) };
    res.redirect(`/public/connect.html?error=${encodeURIComponent(lastOAuth.error)}`);
  }
});

// ---------- Webhook (verify) ----------
app.get("/ig/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === IG_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ---------- Start ----------
try {
  app.listen(PORT, () => {
    console.log(`RastroO server ON :${PORT}`);
  });
} catch (e) {
  console.error("Falha ao subir servidor:", e);
  process.exit(1);
}
