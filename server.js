// server.js — RastroO (IG + OAuth sólido + Status/Debug + Store em disco)

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ===== fetch compat =====
let _fetch = global.fetch;
if (!_fetch) {
  _fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
}
const fetch = (...args) => _fetch(...args);

// ===== app =====
const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// ===== no-cache para HTML =====
app.use((req, res, next) => {
  if (req.path.endsWith(".html") || req.path === "/") {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
  }
  next();
});

// ===== estáticos =====
const PUBLIC_DIR = path.join(__dirname, "public");
app.use("/public", express.static(PUBLIC_DIR, { maxAge: "0", etag: true, lastModified: true }));

// ===== ENV obrigatórias =====
const IG_APP_ID      = process.env.IG_APP_ID      || "";
const IG_APP_SECRET  = process.env.IG_APP_SECRET  || "";
const IG_REDIRECT    = process.env.IG_REDIRECT    || ""; // ex.: https://trk.rastroo.site/auth/ig/callback
const IG_VERIFY_TOKEN= process.env.IG_VERIFY_TOKEN|| "RASTROO_VERIFY";
const FB_VER         = "v20.0";

// ===== store em disco (Render: usar /data) =====
const DISK_PATH = process.env.DISK_PATH || path.join(__dirname, "data", "rastroo-store.json");
fs.mkdirSync(path.dirname(DISK_PATH), { recursive: true });

function readStore() {
  try {
    const raw = fs.readFileSync(DISK_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { ts: Date.now() };
  }
}
function writeStore(obj) {
  fs.writeFileSync(DISK_PATH, JSON.stringify(obj, null, 2), "utf8");
}

// ===== helpers =====
function setLastOAuth(msg, extra = {}) {
  const s = readStore();
  s.last_oauth = { ts: Date.now(), msg, ...extra };
  writeStore(s);
}

function oauthUrl(state) {
  const scope = [
    "pages_show_list",
    "instagram_basic",
    "instagram_manage_insights",
    "instagram_manage_comments",
    "pages_read_engagement",
    "pages_read_user_content"
  ].join(",");
  const p = new URL(`https://www.facebook.com/${FB_VER}/dialog/oauth`);
  p.searchParams.set("client_id", IG_APP_ID);
  p.searchParams.set("redirect_uri", IG_REDIRECT);
  p.searchParams.set("state", state);
  p.searchParams.set("response_type", "code");
  p.searchParams.set("scope", scope);
  return p.toString();
}

// ===== sanity =====
if (!IG_APP_ID || !IG_APP_SECRET || !IG_REDIRECT) {
  console.log("[Config] IG_APP_ID / IG_APP_SECRET / IG_REDIRECT faltando — ajuste no Render > Environment.");
}

// ===== ping/status/debug =====
app.get("/api/ping", (req, res) => res.json({ ok: true }));

app.get("/api/auth/status", async (req, res) => {
  const s = readStore();
  const connected = Boolean(s.ig?.username && s.ig?.id && s.oauth?.access_token);
  res.json({
    ok: true,
    connected,
    username: s.ig?.username || "",
    igid: s.ig?.id || "",
    token_preview: s.oauth?.access_token ? s.oauth.access_token.slice(0, 12) + "..." : ""
  });
});

app.get("/api/debug/last_oauth", (req, res) => {
  const s = readStore();
  res.json({ ok: true, last_oauth: s.last_oauth || null, ig: s.ig || null });
});

// ===== alias amigável =====
app.get(["/auth/ig", "/auth/instagram"], (req, res) => res.redirect("/auth/ig/login"));

// ===== login =====
app.get("/auth/ig/login", (req, res) => {
  try {
    if (!IG_APP_ID || !IG_APP_SECRET || !IG_REDIRECT) {
      setLastOAuth("Env vars faltando");
      return res.status(500).send("Config faltando: defina IG_APP_ID, IG_APP_SECRET e IG_REDIRECT.");
    }
    const state = crypto.randomBytes(16).toString("hex");
    res.cookie("ig_state", state, {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      maxAge: 5 * 60 * 1000
    });
    const url = oauthUrl(state);
    setLastOAuth("redirect_to_meta", { url });
    res.redirect(url);
  } catch (e) {
    setLastOAuth("login_exception", { e: String(e) });
    res.status(500).send("Falhou no /auth/ig/login");
  }
});

// ===== callback =====
app.get("/auth/ig/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    const saved = req.cookies.ig_state;
    if (!code || !state || !saved || state !== saved) {
      setLastOAuth("codigo/estado_invalido", { code: !!code, state, saved });
      return res.status(400).send("Erro: código/estado ausente ou inválido.");
    }

    // troca code -> access_token (user token)
    const tok = new URL(`https://graph.facebook.com/${FB_VER}/oauth/access_token`);
    tok.searchParams.set("client_id", IG_APP_ID);
    tok.searchParams.set("client_secret", IG_APP_SECRET);
    tok.searchParams.set("redirect_uri", IG_REDIRECT);
    tok.searchParams.set("code", code);

    const tRes = await fetch(tok.toString());
    const tJson = await tRes.json();
    if (!tRes.ok || !tJson.access_token) {
      setLastOAuth("token_exchange_fail", { status: tRes.status, body: tJson });
      return res.status(500).send("Falha ao trocar código por token.");
    }

    const userToken = tJson.access_token;

    // pega páginas
    const pagesRes = await fetch(`https://graph.facebook.com/${FB_VER}/me/accounts?access_token=${encodeURIComponent(userToken)}`);
    const pagesJson = await pagesRes.json();
    if (!pagesRes.ok || !Array.isArray(pagesJson.data)) {
      setLastOAuth("fetch_pages_fail", { status: pagesRes.status, body: pagesJson });
      return res.status(500).send("Falha ao buscar páginas.");
    }

    // procura página com instagram_business_account
    let chosen = null;
    let ig = null;
    for (const p of pagesJson.data) {
      const infoRes = await fetch(
        `https://graph.facebook.com/${FB_VER}/${p.id}?fields=instagram_business_account{id,username}&access_token=${encodeURIComponent(userToken)}`
      );
      const infoJson = await infoRes.json();
      if (infoJson.instagram_business_account?.id) {
        chosen = p;
        ig = infoJson.instagram_business_account; // {id, username}
        break;
      }
    }

    if (!ig?.id) {
      setLastOAuth("sem_ig_business", { pages: pagesJson.data?.length || 0 });
      return res.status(400).send("Não encontrei um Instagram Business/Creator ligado a uma Página desta conta.");
    }

    // salva store
    const cur = readStore();
    cur.oauth = { access_token: userToken, ts: Date.now() };
    cur.ig = { id: ig.id, username: ig.username || "", page_id: chosen?.id || "" };
    setLastOAuth("ok", { username: ig.username, igid: ig.id });
    writeStore(cur);

    // volta ao app
    res.clearCookie("ig_state");
    res.redirect("/public/app.html#/dashboard?ig=ok");
  } catch (e) {
    setLastOAuth("callback_exception", { e: String(e) });
    res.status(500).send("Falhou no /auth/ig/callback");
  }
});

// ===== homepage simples (opcional): redireciona para app
app.get("/", (req, res) => res.redirect("/public/app.html#/dashboard"));

// ===== sobe =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`RastroO ligado na porta ${PORT}`);
});
