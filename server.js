// server.js — RastroO (CommonJS) IG + Sales + GEO + Auto-Heal + Force-Connect + Debug
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const geoip = require("geoip-lite");

// fetch compat
let _fetch = global.fetch;
if (!_fetch) _fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const fetch = (...args) => _fetch(...args);

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// no-cache em HTML
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
const IG_APP_ID = process.env.IG_APP_ID || "";
const IG_APP_SECRET = process.env.IG_APP_SECRET || "";
const IG_REDIRECT = process.env.IG_REDIRECT || ""; // ex.: https://trk.rastroo.site/auth/ig/callback
const IG_VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN || "RASTROO_VERIFY";
const FB_VER = "v20.0";

// STORE
const DISK_PATH = process.env.DISK_PATH || path.join(__dirname, "data", "rastroo-store.json");
(function ensureStoreFile() {
  try {
    fs.mkdirSync(path.dirname(DISK_PATH), { recursive: true });
    if (!fs.existsSync(DISK_PATH)) {
      fs.writeFileSync(DISK_PATH, JSON.stringify({ connection: null, events: [], tmp_token: null }, null, 2), "utf8");
    } else {
      const cur = JSON.parse(fs.readFileSync(DISK_PATH, "utf8") || "{}");
      if (!("events" in cur)) cur.events = [];
      if (!("tmp_token" in cur)) cur.tmp_token = null;
      fs.writeFileSync(DISK_PATH, JSON.stringify(cur, null, 2), "utf8");
    }
  } catch(e){ console.error("STORE_INIT_ERR", e); }
})();
function readStore(){ try { return JSON.parse(fs.readFileSync(DISK_PATH, "utf8")); } catch { return { connection:null, events:[], tmp_token:null }; } }
function writeStore(obj){ try { fs.writeFileSync(DISK_PATH, JSON.stringify(obj, null, 2), "utf8"); } catch(e){ console.error("STORE_SAVE_ERR", e); } }
let store = readStore();

// HELPERS
function rndState(){ return crypto.randomBytes(16).toString("hex"); }
function clientIp(req){ const xf=(req.headers["x-forwarded-for"]||"").toString().split(",")[0].trim(); return xf || req.socket?.remoteAddress || ""; }

// HEALTH
app.get("/api/ping", (_req,res)=>res.json({ ok:true, ts:Date.now() }));

// AUTH STATUS
app.get("/api/auth/status", (_req,res)=>{
  const c = readStore().connection;
  if (!c) return res.json({ ok:true, connected:false });
  res.json({ ok:true, connected: !!(c.igid && c.ig_token), username:c.username||"", igid:c.igid||"", page_id:c.page_id||"" });
});

// OAUTH START
const AUTH_SCOPES = ["instagram_basic","instagram_manage_insights","pages_show_list"].join(",");
app.get("/auth/ig/login",(req,res)=>{
  try{
    if (!IG_APP_ID || !IG_APP_SECRET || !IG_REDIRECT) return res.status(500).send("Config faltando: IG_APP_ID / IG_APP_SECRET / IG_REDIRECT.");
    const state=rndState();
    res.cookie("rst_oauth_state", state, {
      httpOnly:true, secure:true, sameSite:"lax", domain:".rastroo.site", path:"/", maxAge:10*60*1000
    });
    const q = new URLSearchParams({ client_id:IG_APP_ID, redirect_uri:IG_REDIRECT, response_type:"code", scope:AUTH_SCOPES, state }).toString();
    res.redirect(`https://www.facebook.com/${FB_VER}/dialog/oauth?${q}`);
  }catch(e){ console.error("AUTH_START_ERR",e); res.status(500).send("OAuth init error"); }
});

// OAUTH CALLBACK
app.get("/auth/ig/callback", async (req,res)=>{
  try{
    const { code, state, error, error_description } = req.query;
    if (error) return res.redirect(`/public/app.html#/connect?error=${encodeURIComponent(error_description || error)}`);

    const stateCookie = req.cookies ? req.cookies["rst_oauth_state"] : null;
    if (!code || !state || !stateCookie || stateCookie !== state) {
      return res.redirect(`/public/app.html#/connect?error=${encodeURIComponent("codigo_ou_state_ausente")}`);
    }
    res.clearCookie("rst_oauth_state", { path:"/", domain:".rastroo.site" });

    // code -> short token
    const p = new URLSearchParams({ client_id:IG_APP_ID, client_secret:IG_APP_SECRET, redirect_uri:IG_REDIRECT, code }).toString();
    const jTok = await (await fetch(`https://graph.facebook.com/${FB_VER}/oauth/access_token?${p}`)).json();
    if (!jTok.access_token) return res.redirect(`/public/app.html#/connect?error=token_exchange`);
    let accessToken = jTok.access_token;

    // long-lived
    const jLong = await (await fetch(
      `https://graph.facebook.com/${FB_VER}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(IG_APP_ID)}&client_secret=${encodeURIComponent(IG_APP_SECRET)}&fb_exchange_token=${encodeURIComponent(accessToken)}`
    )).json();
    if (jLong.access_token) accessToken = jLong.access_token;

    // salva token para auto-heal/force-connect
    store = readStore(); store.tmp_token = accessToken; writeStore(store);

    // tenta achar IG via páginas
    const pages = await (await fetch(`https://graph.facebook.com/${FB_VER}/me/accounts?access_token=${encodeURIComponent(accessToken)}`)).json();
    let found = null;
    if (Array.isArray(pages.data)) {
      for (const pg of pages.data) {
        const info = await (await fetch(
          `https://graph.facebook.com/${FB_VER}/${pg.id}?fields=instagram_business_account{id,username},connected_instagram_account{id,username}&access_token=${encodeURIComponent(accessToken)}`
        )).json();
        const igid = info?.instagram_business_account?.id || info?.connected_instagram_account?.id || null;
        const iguser = info?.instagram_business_account?.username || info?.connected_instagram_account?.username || "";
        if (igid) { found = { page_id: pg.id, igid, username: iguser }; break; }
      }
    }

    if (!found) {
      // deixa o tmp_token salvo para auto-heal / force-connect
      return res.redirect(`/public/app.html#/connect?error=no_ig_business_linked`);
    }

    // conexão OK
    store = readStore();
    store.connection = { page_id:found.page_id, igid:found.igid, username:found.username, ig_token:accessToken, connected_at:Date.now() };
    store.tmp_token = null;
    writeStore(store);

    res.redirect("/public/app.html#/dashboard");
  }catch(e){ console.error("AUTH_CB_ERR",e); res.redirect(`/public/app.html#/connect?error=callback_exception`); }
});

// ======= AUTO-HEAL (usado nos endpoints que precisam de conexão)
async function tryAutoHeal() {
  try {
    const s = readStore();
    if (s.connection && s.connection.igid && s.connection.ig_token) return s.connection;
    if (!s.tmp_token) return null;

    // tenta descobrir página/IG com o tmp_token
    const token = s.tmp_token;
    const pages = await (await fetch(`https://graph.facebook.com/${FB_VER}/me/accounts?access_token=${encodeURIComponent(token)}`)).json();
    if (!Array.isArray(pages.data) || pages.data.length === 0) return null;

    for (const pg of pages.data) {
      const info = await (await fetch(
        `https://graph.facebook.com/${FB_VER}/${pg.id}?fields=instagram_business_account{id,username},connected_instagram_account{id,username}&access_token=${encodeURIComponent(token)}`
      )).json();
      const igid = info?.instagram_business_account?.id || info?.connected_instagram_account?.id || null;
      const iguser = info?.instagram_business_account?.username || info?.connected_instagram_account?.username || "";
      if (igid) {
        const conn = { page_id: pg.id, igid, username: iguser, ig_token: token, connected_at: Date.now() };
        store = readStore(); store.connection = conn; store.tmp_token = null; writeStore(store);
        return conn;
      }
    }
    return null;
  } catch { return null; }
}

// IG: Reels (usa auto-heal)
app.get("/api/ig/reels", async (req,res)=>{
  try{
    let c = readStore().connection;
    if (!c || !c.igid || !c.ig_token) c = await tryAutoHeal();
    if (!c || !c.igid || !c.ig_token) return res.json({ ok:false, error:"not_connected" });

    const FIELDS = [
      "id","caption","media_type","media_product_type","thumbnail_url","media_url",
      "permalink","comments_count","like_count","video_play_count","timestamp"
    ].join(",");
    const limit = Math.min(100, parseInt(req.query.limit || "100", 10));
    const url = `https://graph.facebook.com/${FB_VER}/${c.igid}/media?fields=${encodeURIComponent(FIELDS)}&limit=${limit}&access_token=${encodeURIComponent(c.ig_token)}`;
    const js = await (await fetch(url)).json();
    if (js.error) {
      if (js.error.code === 190) { store = readStore(); store.connection = null; writeStore(store); return res.json({ ok:false, error:"not_connected" }); }
      return res.json({ ok:false, error:"fb_error", raw:js.error });
    }
    const data = Array.isArray(js.data)? js.data : [];
    const items = data.filter(m => m.media_product_type==="REELS" || ((m.permalink||"").includes("/reel/")));
    res.json({ ok:true, count: items.length, items });
  }catch(e){ console.error("IG_REELS_ERR",e); res.json({ ok:false, error:"server_error" }); }
});

// TRACK (lead/sale) + GEO
app.post("/api/track",(req,res)=>{
  try{
    const { type, reel_id, permalink, amount, username, meta, country, city } = req.body || {};
    if (!type) return res.status(400).json({ ok:false, error:"type_required" });
    if (!["sale","lead"].includes(type)) return res.status(400).json({ ok:false, error:"type_invalid" });

    const ip = clientIp(req);
    const g = geoip.lookup(ip) || null;
    const cc = (country || g?.country || "").toUpperCase() || null;
    const cty = city || g?.city || null;

    store = readStore(); store.events = store.events || [];
    store.events.push({ type, reel_id:reel_id||null, permalink:permalink||null, amount:Number(amount||0), username:username||null, meta:meta||null, geo:{ ip, country:cc, city:cty }, ts:Date.now() });
    writeStore(store);
    res.json({ ok:true });
  }catch(e){ console.error("TRACK_ERR",e); res.status(500).json({ ok:false, error:"server_error" }); }
});

// SALES by reel
app.get("/api/sales/by-reel",(req,res)=>{
  try{
    const since = Number(req.query.since || 0);
    const until = Number(req.query.until || Date.now()+1);
    const evs = (readStore().events||[]).filter(e=> e.type==="sale" && (!since || e.ts>=since) && (!until || e.ts<until));
    const byKey = {}; let totalSales=0, totalRevenue=0;
    for (const e of evs){
      const key = e.reel_id || e.permalink || "desconhecido";
      if (!byKey[key]) byKey[key] = { sales:0, revenue:0, last_ts:0 };
      byKey[key].sales += 1; byKey[key].revenue += Number(e.amount||0); if (e.ts>byKey[key].last_ts) byKey[key].last_ts=e.ts;
      totalSales += 1; totalRevenue += Number(e.amount||0);
    }
    const ranking = Object.entries(byKey).map(([k,v])=>({ key:k, ...v })).sort((a,b)=> b.sales-b.sales || b.revenue-a.revenue);
    res.json({ ok:true, since, until, total_sales:totalSales, total_revenue:totalRevenue, by_reel:byKey, ranking });
  }catch(e){ console.error("BY_REEL_ERR",e); res.status(500).json({ ok:false, error:"server_error" }); }
});

// GEO summary
app.get("/api/geo/summary",(req,res)=>{
  try{
    const since = Number(req.query.since || 0);
    const until = Number(req.query.until || Date.now()+1);
    const all = (readStore().events||[]).filter(e=> (!since || e.ts>=since) && (!until || e.ts<until));
    const byCountry = {}; let totalLeads=0, totalSales=0;
    for (const e of all){
      const cc = (e.geo?.country || "??").toUpperCase();
      if (!byCountry[cc]) byCountry[cc] = { leads:0, sales:0, revenue:0, cities:{} };
      if (e.type==="lead"){ byCountry[cc].leads++; totalLeads++; }
      if (e.type==="sale"){ byCountry[cc].sales++; byCountry[cc].revenue += Number(e.amount||0); totalSales++; }
      const city = (e.geo?.city || "Desconhecida");
      if (!byCountry[cc].cities[city]) byCountry[cc].cities[city] = { leads:0, sales:0, revenue:0 };
      if (e.type==="lead") byCountry[cc].cities[city].leads++;
      if (e.type==="sale"){ byCountry[cc].cities[city].sales++; byCountry[cc].cities[city].revenue += Number(e.amount||0); }
    }
    const countries = Object.entries(byCountry).map(([code,v])=>{
      const cities = Object.entries(v.cities).map(([name,c])=>({ name, ...c }))
        .sort((a,b)=> b.sales-a.sales || b.leads-a.leads).slice(0,5);
      return { code, ...v, cities };
    }).sort((a,b)=> b.sales-a.sales || b.leads-a.leads || b.revenue-a.revenue);
    res.json({ ok:true, since, until, total_leads:totalLeads, total_sales:totalSales, countries });
  }catch(e){ console.error("GEO_SUMMARY_ERR",e); res.status(500).json({ ok:false, error:"server_error" }); }
});

// DEBUG — páginas & IG visíveis (usa connection.ig_token ou tmp_token)
app.get("/api/debug/fb/pages", async (req,res)=>{
  try{
    const s = readStore();
    const token = s.connection?.ig_token || s.tmp_token;
    if (!token) return res.json({ ok:false, error:"no_token" });
    const pages = await (await fetch(`https://graph.facebook.com/${FB_VER}/me/accounts?access_token=${encodeURIComponent(token)}`)).json();
    const out = [];
    for (const pg of (pages.data||[])) {
      const info = await (await fetch(
        `https://graph.facebook.com/${FB_VER}/${pg.id}?fields=name,instagram_business_account{id,username},connected_instagram_account{id,username}&access_token=${encodeURIComponent(token)}`
      )).json();
      out.push({ page:{ id:pg.id, name:info.name }, ig: info.instagram_business_account || info.connected_instagram_account || null });
    }
    res.json({ ok:true, pages:out });
  }catch(e){ res.json({ ok:false, error:String(e) }); }
});

// DEBUG — reset auth
app.all("/api/debug/auth/reset",(req,res)=>{
  try{ store = readStore(); store.connection=null; store.tmp_token=null; writeStore(store); res.json({ ok:true, reset:true }); }
  catch(e){ res.status(500).json({ ok:false, error:String(e) }); }
});

// DEBUG — FORCE CONNECT (usa tmp_token se não houver connection)
app.all("/api/debug/force-connect", async (req,res)=>{
  try{
    const q = req.method === 'POST' ? req.body : req.query;
    let { page_id, igid, username } = q || {};
    page_id = String(page_id||"").trim(); igid = String(igid||"").trim(); username = String(username||"").trim();

    store = readStore();
    const token = store.connection?.ig_token || store.tmp_token;
    if (!token) return res.json({ ok:false, error:"no_token" });
    if (!page_id || !igid) return res.json({ ok:false, error:"missing_params" });

    store.connection = { page_id, igid, username: username||"", ig_token: token, connected_at: Date.now() };
    store.tmp_token = null;
    writeStore(store);
    res.json({ ok:true, connected:true, connection: store.connection });
  }catch(e){ res.status(500).json({ ok:false, error:String(e) }); }
});

// Webhook verify (opcional)
app.get("/ig/webhook",(req,res)=>{
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode==="subscribe" && token===IG_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// raiz
app.get("/", (_req,res)=>res.redirect("/public/app.html"));

const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
app.listen(PORT, ()=>console.log(`RastroO ON :${PORT}`));
