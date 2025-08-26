// server.js — RastroO (com IG Reels + credenciais + aliases)
// - Rotas OAuth: /auth/ig  |  callback: /auth/ig/callback
// - Compat: /api/ig/creds (usado pela tua UI antiga) e /api/ig/status
// - Reels: /api/ig/reels (plays/reach/likes/comments/saved)
// - Debug/Health: /api/debug/last_oauth, /healthz
// - Aliases: /auth/ig/login -> /auth/ig
// - Persistência: DISK_PATH (recomendado) ou ./data/ig_store.json

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const fs = require("fs");
const path = require("path");

// Polyfill de fetch (Node 16+) — em Node 18+ usa o global.fetch
let _fetch = global.fetch;
if (!_fetch) {
  _fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
}
const fetch = (...args) => _fetch(...args);

// ===== App =====
const app = express();
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// estáticos
const PUBLIC_DIR = path.join(__dirname, "public");
app.use("/public", express.static(PUBLIC_DIR));

// porta Render
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// ===== Store (arquivo) =====
const DATA_DIR = process.env.DISK_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const IG_STORE_FILE = process.env.DISK_PATH || path.join(DATA_DIR, "ig_store.json");

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
const store = safeRead(IG_STORE_FILE, { instagram: {} });
let lastOAuth = null;

// ===== ENVs =====
const IG_APP_ID = process.env.IG_APP_ID || "";
const IG_APP_SECRET = process.env.IG_APP_SECRET || "";
const IG_REDIRECT = process.env.IG_REDIRECT || ""; // ex: https://trk.rastroo.site/auth/ig/callback
const IG_VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN || "RASTROO_VERIFY";
const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || "state_local_dev";
const FB_VER = "v19.0"; // versão do Graph

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

// ===== Health & raiz =====
app.get("/", (_req, res) => res.redirect("/public/app.html"));
app.get("/healthz", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ===== Status/creds (compat com tua UI) =====
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
      : "",
    page_id: ig.page_id || "",
    updated_at: ig.updated_at || "",
  });
});

// *** MUITAS UIs ANTIGAS USAM /api/ig/creds — deixamos compatível ***
app.get("/api/ig/creds", (req, res) => {
  const ig = store.instagram || {};
  res.json({
    ok: true,
    connected: Boolean(ig.ig_user_id && ig.username && ig.facebook_access_token),
    igid: ig.ig_user_id || "",
    username: ig.username || "",
    token_preview: ig.facebook_access_token
      ? ig.facebook_access_token.slice(0, 6) + "..." + ig.facebook_access_token.slice(-4)
      : "",
  });
});

// Debug último OAuth
app.get("/api/debug/last_oauth", (_req, res) => res.json({ ok: true, lastOAuth }));

// ===== Aliases (evita "Cannot GET /auth/ig/login") =====
app.get(
  ["/auth/ig/login", "/auth/ig/connect", "/auth/instagram", "/connect/instagram"],
  (req, res) => res.redirect("/auth/ig")
);

// ===== OAuth (login) =====
app.get("/auth/ig", (req, res) => {
  if (!envOk()) {
    return res
      .status(500)
      .send("Config faltando: IG_APP_ID, IG_APP_SECRET e IG_REDIRECT (Render > Environment).");
  }
  const state = Buffer.from(JSON.stringify({ t: Date.now(), s: OAUTH_STATE_SECRET })).toString(
    "base64",
  );

  const scopes = [
    "instagram_basic",
    "instagram_manage_insights",
    "instagram_manage_messages",
    "pages_show_list",
    "pages_read_engagement",
    "business_management",
  ];

  const url =
    `https://www.facebook.com/${FB_VER}/dialog/oauth` +
    `?client_id=${encodeURIComponent(IG_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(IG_REDIRECT)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scopes.join(","))}` +
    `&state=${encodeURIComponent(state)}`;

  res.redirect(url);
});

// ===== OAuth (callback) =====
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

    // short-lived
    const tokenURL =
      `https://graph.facebook.com/${FB_VER}/oauth/access_token` +
      `?client_id=${encodeURIComponent(IG_APP_ID)}` +
      `&client_secret=${encodeURIComponent(IG_APP_SECRET)}` +
      `&redirect_uri=${encodeURIComponent(IG_REDIRECT)}` +
      `&code=${encodeURIComponent(String(code))}`;

    const tokenResp = await fetch(tokenURL);
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok) throw new Error("Token error: " + JSON.stringify(tokenJson));
    let accessToken = tokenJson.access_token;

    // long-lived
    const longURL =
      `https://graph.facebook.com/${FB_VER}/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${encodeURIComponent(IG_APP_ID)}` +
      `&client_secret=${encodeURIComponent(IG_APP_SECRET)}` +
      `&fb_exchange_token=${encodeURIComponent(accessToken)}`;

    const longResp = await fetch(longURL);
    const longJson = await longResp.json();
    if (longResp.ok && longJson.access_token) accessToken = longJson.access_token;

    // páginas → tenta achar IG (instagram_business_account OU connected_instagram_account)
    const pagesResp = await fetch(
      `https://graph.facebook.com/${FB_VER}/me/accounts?access_token=${encodeURIComponent(
        accessToken,
      )}`,
    );
    const pagesJson = await pagesResp.json();
    if (!pagesResp.ok) throw new Error("me/accounts error: " + JSON.stringify(pagesJson));

    let found = null;
    if (Array.isArray(pagesJson.data)) {
      for (const pg of pagesJson.data) {
        const infoResp = await fetch(
          `https://graph.facebook.com/${FB_VER}/${pg.id}` +
            `?fields=instagram_business_account{id,username},connected_instagram_account{id,username}` +
            `&access_token=${encodeURIComponent(accessToken)}`,
        );
        const infoJson = await infoResp.json();

        let igId = null,
          igUser = "";
        if (infoJson.instagram_business_account && infoJson.instagram_business_account.id) {
          igId = infoJson.instagram_business_account.id;
          igUser = infoJson.instagram_business_account.username || "";
        } else if (infoJson.connected_instagram_account && infoJson.connected_instagram_account.id) {
          igId = infoJson.connected_instagram_account.id;
          igUser = infoJson.connected_instagram_account.username || "";
        }
        if (igId) {
          if (!igUser) {
            const uResp = await fetch(
              `https://graph.facebook.com/${FB_VER}/${igId}?fields=username&access_token=${encodeURIComponent(
                accessToken,
              )}`,
            );
            const uJson = await uResp.json();
            igUser = uJson.username || "";
          }
          found = { page_id: pg.id, ig_user_id: igId, username: igUser };
          break;
        }
      }
    }

    if (!found) {
      throw new Error("Não encontrei IG Business/Creator ligado a uma Página nesta conta da Meta.");
    }

    // salva
    store.instagram = {
      facebook_access_token: accessToken,
      ig_user_id: found.ig_user_id,
      username: found.username,
      page_id: found.page_id,
      updated_at: new Date().toISOString(),
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

// ===== IG Reels + Insights =====
app.get("/api/ig/reels", async (req, res) => {
  try {
    const ig = store.instagram || {};
    if (!ig.facebook_access_token || !ig.ig_user_id) {
      return res.status(400).json({ ok: false, error: "Conecte sua conta do Instagram primeiro." });
    }
    const token = ig.facebook_access_token;
    const IGID = ig.ig_user_id;
    const limit = Math.min(parseInt(req.query.limit || "30", 10), 50);

    const fields =
      "id,media_type,media_product_type,caption,permalink,thumbnail_url,timestamp,like_count,comments_count";

    // lista mídia
    const mediaResp = await fetch(
      `https://graph.facebook.com/${FB_VER}/${IGID}/media?fields=${encodeURIComponent(
        fields,
      )}&limit=${limit}&access_token=${encodeURIComponent(token)}`,
    );
    const mediaJson = await mediaResp.json();
    if (!mediaResp.ok) throw new Error("media error: " + JSON.stringify(mediaJson));
    const items = (mediaJson.data || []).filter(
      (m) => m.media_product_type === "REELS" || m.media_type === "VIDEO",
    );

    // para cada mídia, tenta insights
    const want = "plays,reach,likes,comments,saved";
    const enriched = [];
    for (const m of items) {
      let insights = {};
      try {
        const insResp = await fetch(
          `https://graph.facebook.com/${FB_VER}/${m.id}/insights?metric=${encodeURIComponent(
            want,
          )}&access_token=${encodeURIComponent(token)}`,
        );
        const insJson = await insResp.json();
        if (insResp.ok && Array.isArray(insJson.data)) {
          insights = insJson.data.reduce((acc, it) => {
            acc[it.name] = (it.values && it.values[0] && it.values[0].value) || 0;
            return acc;
          }, {});
        }
      } catch (_) {}

      enriched.push({
        id: m.id,
        caption: m.caption || "",
        permalink: m.permalink,
        thumb: m.thumbnail_url,
        ts: m.timestamp,
        like_count: m.like_count || 0,
        comments_count: m.comments_count || 0,
        insights,
      });
    }

    res.json({ ok: true, total: enriched.length, items: enriched });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Erro IG" });
  }
});

// ===== Webhook verify (opcional) =====
app.get("/ig/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === IG_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===== Start =====
try {
  app.listen(PORT, () => {
    console.log(`RastroO server ON :${PORT}`);
  });
} catch (e) {
  console.error("Falha ao subir servidor:", e);
  process.exit(1);
}
