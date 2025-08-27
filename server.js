// server.js — RastroO (Conexão IG por Wizard + OAuth opcional + Reels + Debug + Store em disco)

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// fetch compat
let _fetch = global.fetch;
if (!_fetch) _fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const fetch = (...args) => _fetch(...args);

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// no-cache para html
app.use((req, res, next) => {
  if (req.path.endsWith(".html") || req.path === "/") {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
  }
  next();
});

// estáticos
const PUBLIC_DIR = path.join(__dirname, "public");
app.use("/public", express.static(PUBLIC_DIR, { maxAge: "0", etag: true, lastModified: true }));

// ENVs
const IG_APP_ID      = process.env.IG_APP_ID      || "";
const IG_APP_SECRET  = process.env.IG_APP_SECRET  || "";
const IG_REDIRECT    = process.env.IG_REDIRECT    || ""; // ex.: https://trk.rastroo.site/auth/ig/callback
const IG_VERIFY_TOKEN= process.env.IG_VERIFY_TOKEN|| "RASTROO_VERIFY";
const FB_VER         = "v20.0";

// store em disco
const DISK_PATH = process.env.DISK_PATH || path.join(__dirname, "data", "rastroo-store.json");
fs.mkdirSync(path.dirname(DISK_PATH), { recursive: true });
function readStore(){ try { return JSON.parse(fs.readFileSync(DISK_PATH,"utf8")); } catch { return {}; } }
function writeStore(obj){ fs.writeFileSync(DISK_PATH, JSON.stringify(obj, null, 2), "utf8"); }
function setStore(patch){ const s=readStore(); Object.assign(s, patch); writeStore(s); return s; }

// helpers
function oauthUrl(state){
  const scope = [
    "pages_show_list",
    "instagram_basic",
    "instagram_manage_insights",
    "instagram_manage_comments",
    "pages_read_engagement",
    "pages_read_user_content"
  ].join(",");
  const u = new URL(`https://www.facebook.com/${FB_VER}/dialog/oauth`);
  u.searchParams.set("client_id", IG_APP_ID);
  u.searchParams.set("redirect_uri", IG_REDIRECT);
  u.searchParams.set("state", state);
  u.searchParams.set("response_type","code");
  u.searchParams.set("scope", scope);
  return u.toString();
}

// health/debug
app.get("/api/ping", (req,res)=> res.json({ ok:true, ts:Date.now() }));
app.get("/api/auth/status", (req,res)=>{
  const s = readStore();
  const connected = Boolean(s.connection?.ig?.id && s.connection?.token?.access_token);
  res.json({
    ok:true,
    connected,
    username: s.connection?.ig?.username || "",
    igid: s.connection?.ig?.id || "",
    token_preview: s.connection?.token?.access_token ? s.connection.token.access_token.slice(0,12)+"..." : ""
  });
});
app.post("/api/debug/auth/reset",(req,res)=>{
  const s = readStore(); delete s.connection; writeStore(s);
  res.json({ ok:true, reset:true });
});

// ====== WIZARD (cola o token e pronto) ======
app.get("/api/debug/wizard", (req,res)=>{
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="pt-BR"><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>RastroO — Conectar Instagram</title>
<style>
  body{margin:0;font:16px/1.5 system-ui,Segoe UI,Roboto; background:#0b1220; color:#eaf0ff}
  .box{max-width:860px;margin:4vh auto;padding:20px;border:1px solid #1b2b4a;background:#0e1730;border-radius:14px}
  input,textarea,button{width:100%;padding:12px;border-radius:10px;border:1px solid #1b2b4a;background:#0b162e;color:#eaf0ff}
  button{cursor:pointer;background:#3b82f6;border-color:#3b82f6;font-weight:700}
  .muted{color:#9bb0d0}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:720px){.row{grid-template-columns:1fr}}
  pre{white-space:pre-wrap;background:#0a1226;border:1px solid #1b2b4a;padding:12px;border-radius:10px;max-height:260px;overflow:auto}
  a{color:#9dc1ff}
</style>
<div class="box">
  <h2>Conectar Instagram (modo rápido)</h2>
  <p class="muted">1) Clique no botão abaixo para abrir o <b>Graph Explorer</b>. Faça login com o <b>mesmo Facebook</b> que é <b>admin</b> da Página conectada ao seu Instagram Profissional.</p>
  <p class="muted">2) Marque estas permissões quando aparecer: <code>pages_show_list</code>, <code>instagram_basic</code>, <code>instagram_manage_insights</code>, <code>pages_read_engagement</code>, <code>pages_read_user_content</code>.</p>
  <p class="muted">3) Copie o <b>User Access Token</b> gerado e cole aqui embaixo. Clique em <b>Conectar</b>.</p>
  <div class="row">
    <p><a target="_blank" rel="noopener" href="https://developers.facebook.com/tools/explorer/">🔗 Abrir Graph Explorer</a></p>
    <p><a target="_blank" rel="noopener" href="https://developers.facebook.com/tools/explorer/?method=GET&path=me%2Faccounts">🔗 Testar /me/accounts</a></p>
  </div>
  <label>Token do Facebook (User Access Token)</label>
  <textarea id="token" rows="4" placeholder="Cole aqui o token completo"></textarea>
  <div style="margin:10px 0"></div>
  <button id="go">Conectar</button>
  <div style="margin:10px 0"></div>
  <pre id="out">Aguardando…</pre>
  <p class="muted">Dica: se aparecer "sem IG ligado", abra a Página no Facebook e conecte seu Instagram em <b>Configurações → Contas vinculadas → Instagram</b>.</p>
</div>
<script>
const out = document.getElementById('out');
document.getElementById('go').onclick = async ()=>{
  const token = document.getElementById('token').value.trim();
  if (!token) { out.textContent = 'Cole o token primeiro.'; return; }
  out.textContent = 'Conectando...';
  try{
    const r = await fetch('/api/debug/force-token', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token })
    });
    const j = await r.json();
    out.textContent = JSON.stringify(j, null, 2);
    if (j.ok) {
      setTimeout(()=> location.href='/public/app.html#/dashboard', 800);
    }
  }catch(e){ out.textContent = String(e); }
};
</script>
</html>`);
});

// POST: recebe token, acha Página->IG e salva conexão
app.post("/api/debug/force-token", async (req,res)=>{
  try{
    const token = String(req.body?.token || "").trim();
    if (!token) return res.status(400).json({ ok:false, error:"token_required" });

    // 1) lista páginas dessa conta
    const pages = await (await fetch(`https://graph.facebook.com/${FB_VER}/me/accounts?access_token=${encodeURIComponent(token)}`)).json();
    if (!Array.isArray(pages.data) || pages.data.length===0) {
      return res.json({ ok:false, error:"no_pages_visible", raw: pages });
    }

    // 2) procura página com instagram_business_account
    let page=null, ig=null;
    for (const pg of pages.data) {
      const info = await (await fetch(
        `https://graph.facebook.com/${FB_VER}/${pg.id}?fields=name,instagram_business_account{id,username}&access_token=${encodeURIComponent(token)}`
      )).json();
      if (info.instagram_business_account?.id) {
        page = { id: pg.id, name: info.name };
        ig = info.instagram_business_account; // {id, username}
        break;
      }
    }
    if (!ig?.id) {
      return res.json({ ok:false, error:"no_ig_business_linked", hint:"Conecte seu Instagram à Página no Facebook." });
    }

    // 3) salva em disco
    setStore({
      connection: {
        token: { access_token: token, saved_at: Date.now() },
        page,
        ig
      }
    });

    res.json({ ok:true, connected:true, page, ig, note:"Conectado via Wizard" });
  }catch(e){ res.status(500).json({ ok:false, error:String(e) }); }
});
/* ====== FIM do WIZARD ====== */

// Alias amigável e OAuth opcional (mantido)
app.get(["/auth/ig", "/auth/instagram"], (req,res)=> res.redirect("/auth/ig/login"));
app.get("/auth/ig/login",(req,res)=>{
  try{
    if (!IG_APP_ID || !IG_APP_SECRET || !IG_REDIRECT) {
      return res.status(500).send("Config faltando: IG_APP_ID / IG_APP_SECRET / IG_REDIRECT.");
    }
    const state = crypto.randomBytes(16).toString("hex");
    res.cookie("ig_state", state, { httpOnly:true, sameSite:"lax", secure:true, maxAge:5*60*1000 });
    res.redirect(oauthUrl(state));
  }catch(e){ res.status(500).send("Falhou no /auth/ig/login"); }
});
app.get("/auth/ig/callback", async (req,res)=>{
  try{
    const { code, state } = req.query;
    const saved = req.cookies.ig_state;
    if (!code || !state || !saved || state !== saved) return res.status(400).send("State inválido/expirado.");
    const q = new URL(`https://graph.facebook.com/${FB_VER}/oauth/access_token`);
    q.searchParams.set("client_id", IG_APP_ID);
    q.searchParams.set("client_secret", IG_APP_SECRET);
    q.searchParams.set("redirect_uri", IG_REDIRECT);
    q.searchParams.set("code", code);
    const t = await (await fetch(q.toString())).json();
    if (!t.access_token) return res.status(500).send("Falha ao trocar código por token.");
    // tenta achar IG
    const pages = await (await fetch(`https://graph.facebook.com/${FB_VER}/me/accounts?access_token=${encodeURIComponent(t.access_token)}`)).json();
    let page=null, ig=null;
    for (const pg of (pages.data||[])) {
      const info = await (await fetch(
        `https://graph.facebook.com/${FB_VER}/${pg.id}?fields=name,instagram_business_account{id,username}&access_token=${encodeURIComponent(t.access_token)}`
      )).json();
      if (info.instagram_business_account?.id) { page={id:pg.id,name:info.name}; ig=info.instagram_business_account; break; }
    }
    if (!ig?.id) return res.status(400).send("Não encontrei IG Business/Creator ligado a uma Página desta conta.");
    setStore({ connection: { token:{ access_token: t.access_token, saved_at: Date.now() }, page, ig } });
    res.clearCookie("ig_state");
    res.redirect("/public/app.html#/dashboard?ig=ok");
  }catch(e){ res.status(500).send("Falhou no /auth/ig/callback"); }
});

// IG Reels (usa conexão salva)
app.get("/api/ig/reels", async (req,res)=>{
  try{
    const s = readStore();
    const token = s.connection?.token?.access_token;
    const igid  = s.connection?.ig?.id;
    if (!token || !igid) return res.json({ ok:false, error:"not_connected" });
    const FIELDS = [
      "id","caption","media_type","media_product_type","thumbnail_url","media_url",
      "permalink","comments_count","like_count","video_play_count","timestamp"
    ].join(",");
    const limit = Math.min(100, parseInt(req.query.limit||"50",10));
    const js = await (await fetch(
      `https://graph.facebook.com/${FB_VER}/${igid}/media?fields=${encodeURIComponent(FIELDS)}&limit=${limit}&access_token=${encodeURIComponent(token)}`
    )).json();
    if (js.error) return res.json({ ok:false, error:"fb_error", raw:js.error });
    const data = Array.isArray(js.data)? js.data : [];
    const items = data.filter(m => m.media_product_type==="REELS" || (m.permalink||"").includes("/reel/"));
    res.json({ ok:true, count: items.length, items });
  }catch(e){ res.json({ ok:false, error:String(e) }); }
});

// raiz
app.get("/", (req,res)=> res.redirect("/public/app.html#/dashboard"));

// sobe
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log(`RastroO ON :${PORT}`));
