// server.js (RastroO) — versão “conecta Instagram” completa e robusta
// Apague o conteúdo antigo e cole este arquivo inteiro.

import express from "express";
import fetch from "node-fetch";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import path from "path";
import fs from "fs";

const app = express();
app.use(express.json());
app.use(cookieParser());

// ---------- CONFIG ----------
const IG_APP_ID = process.env.IG_APP_ID;          // ex: 1349096403310350
const IG_APP_SECRET = process.env.IG_APP_SECRET;  // a chave secreta do app
const IG_REDIRECT = process.env.IG_REDIRECT;      // ex: https://trk.rastroo.site/auth/ig/callback

// Segurança básica de checagem de env
if (!IG_APP_ID || !IG_APP_SECRET || !IG_REDIRECT) {
  console.warn("Faltam variáveis IG_APP_ID, IG_APP_SECRET e/ou IG_REDIRECT.");
}

// ---------- ARMAZENAMENTO (simples em arquivo) ----------
const DATA_DIR = "./data";
const IG_STORE_FILE = path.join(DATA_DIR, "ig_store.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(IG_STORE_FILE)) fs.writeFileSync(IG_STORE_FILE, JSON.stringify({}), "utf-8");
}
ensureDataDir();

function loadStore() {
  try {
    const raw = fs.readFileSync(IG_STORE_FILE, "utf-8");
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}
function saveStore(obj) {
  fs.writeFileSync(IG_STORE_FILE, JSON.stringify(obj, null, 2), "utf-8");
}

// ---------- SERVE PASTA PUBLIC ----------
app.use("/public", express.static("public", { fallthrough: true }));

// ---------- HELPERS ----------
const FB = "https://graph.facebook.com/v18.0";
const FB_AUTH = "https://www.facebook.com/v18.0/dialog/oauth";

function makeState() {
  return crypto.randomBytes(24).toString("hex");
}

function previewToken(t) {
  if (!t || t.length < 8) return "";
  return t.slice(0, 4) + "…" + t.slice(-4);
}

// Busca IG conectado a UMA das páginas da conta
async function findIgAccount(userAccessToken) {
  // 1) lista páginas
  const pagesRes = await fetch(`${FB}/me/accounts?fields=name,instagram_business_account&limit=100&access_token=${userAccessToken}`);
  if (!pagesRes.ok) throw new Error(`Erro listando páginas: ${await pagesRes.text()}`);
  const pages = (await pagesRes.json()).data || [];

  for (const p of pages) {
    if (p.instagram_business_account && p.instagram_business_account.id) {
      const igId = p.instagram_business_account.id;
      // pega username
      const igRes = await fetch(`${FB}/${igId}?fields=username&access_token=${userAccessToken}`);
      if (!igRes.ok) throw new Error(`Erro pegando IG username: ${await igRes.text()}`);
      const ig = await igRes.json();
      return {
        page_id: p.id,
        page_name: p.name,
        ig_id: igId,
        ig_username: ig.username || ""
      };
    }
  }
  return null; // nenhuma página com IG vinculado
}

// Troca S->L (short->long lived) para ficar estável ~60 dias
async function exchangeLongLived(userAccessToken) {
  const url = `${FB}/oauth/access_token?grant_type=fb_exchange_token&client_id=${IG_APP_ID}&client_secret=${IG_APP_SECRET}&fb_exchange_token=${userAccessToken}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Erro exchange long-lived: ${await r.text()}`);
  return await r.json(); // { access_token, token_type, expires_in }
}

// ---------- API: STATUS ----------
app.get("/api/ig/status", async (req, res) => {
  const store = loadStore();
  const s = {
    ok: true,
    connected: Boolean(store.user_access_token && store.ig_id),
    connected_facebook: Boolean(store.user_access_token),
    ig_id: store.ig_id || "",
    username: store.ig_username || "",
    page_name: store.page_name || "",
    token_preview: previewToken(store.user_access_token),
    token_expires_in: store.expires_in || null
  };
  res.json(s);
});

// ---------- AUTH: LOGIN ----------
app.get("/auth/ig/login", (req, res) => {
  const state = makeState();
  // grava state em cookie (SameSite=Lax para sobreviver ao redirect)
  res.cookie("ig_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: true
  });

  const scope = [
    "pages_show_list",
    "pages_read_engagement",
    "instagram_basic",
    "instagram_manage_insights",
    "instagram_manage_comments"
  ].join(",");

  const url = `${FB_AUTH}?client_id=${IG_APP_ID}&redirect_uri=${encodeURIComponent(IG_REDIRECT)}&state=${state}&response_type=code&scope=${scope}`;
  return res.redirect(url);
});

// ---------- AUTH: CALLBACK ----------
app.get("/auth/ig/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    const cookieState = req.cookies.ig_oauth_state;
    if (!code || !state || !cookieState || state !== cookieState) {
      return res.redirect("/public/connect.html#state_error");
    }

    // troca code -> short-lived user token
    const tokenUrl = `${FB}/oauth/access_token?client_id=${IG_APP_ID}&client_secret=${IG_APP_SECRET}&redirect_uri=${encodeURIComponent(IG_REDIRECT)}&code=${code}`;
    const tRes = await fetch(tokenUrl);
    if (!tRes.ok) {
      const txt = await tRes.text();
      return res.redirect(`/public/connect.html#token_error:${encodeURIComponent(txt)}`);
    }
    const tJson = await tRes.json(); // {access_token, token_type, expires_in}
    const shortToken = tJson.access_token;

    // troca para long-lived
    const longJson = await exchangeLongLived(shortToken);
    const userToken = longJson.access_token;
    const expiresIn = longJson.expires_in;

    // tenta identificar IG vinculado
    const link = await findIgAccount(userToken);

    const store = loadStore();
    store.user_access_token = userToken;
    store.expires_in = expiresIn;
    // se achou IG
    if (link) {
      store.page_id = link.page_id;
      store.page_name = link.page_name;
      store.ig_id = link.ig_id;
      store.ig_username = link.ig_username;
      saveStore(store);
      return res.redirect("/public/connect.html#connected");
    } else {
      // salva mesmo assim (conectado ao FB, mas IG não está ligado a uma Página)
      store.page_id = "";
      store.page_name = "";
      store.ig_id = "";
      store.ig_username = "";
      saveStore(store);
      return res.redirect("/public/connect.html#no_ig_link");
    }
  } catch (e) {
    return res.redirect(`/public/connect.html#callback_error:${encodeURIComponent(e.message)}`);
  }
});

// ---------- (opcional) refrescar token sob demanda ----------
app.get("/api/ig/refresh", async (req, res) => {
  try {
    const store = loadStore();
    if (!store.user_access_token) return res.json({ ok: false, error: "Sem token" });
    const ll = await exchangeLongLived(store.user_access_token);
    store.user_access_token = ll.access_token;
    store.expires_in = ll.expires_in;
    saveStore(store);
    res.json({ ok: true, token_preview: previewToken(store.user_access_token), expires_in: store.expires_in });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ---------- FALLBACK ----------
app.get("/", (_, res) => res.redirect("/public/app.html"));
app.use((_, res) => res.status(404).send("Not found"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("RastroO up on", PORT));
