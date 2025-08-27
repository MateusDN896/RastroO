// server.js — RastroO (CommonJS) com IG + agregador + GEO por IP

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const geoip = require("geoip-lite");

// fetch (Node 18 tem global; Node 16 usa node-fetch dinamicamente)
let _fetch = global.fetch;
if (!_fetch) {
  _fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
}
const fetch = (...args) => _fetch(...args);

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// NUNCA cachear HTML
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

// ====== ENVs ======
const IG_APP_ID = process.env.IG_APP_ID || "";
const IG_APP_SECRET = process.env.IG_APP_SECRET || "";
const IG_REDIRECT = process.env.IG_REDIRECT || ""; // ex.: https://trk.rastroo.site/auth/ig/callback
const IG_VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN || "RASTROO_VERIFY";
const FB_VER = "v20.0";

// ====== STORE (DISK_PATH) ======
const DISK_PATH = process.env.DISK_PATH || path.join(__dirname, "data", "rastroo-store.json");
(function ensureStoreFile() {
  try {
    fs.mkdirSync(path.dirname(DISK_PATH), { recursive: true });
    if (!fs.existsSync(DISK_PATH)) {
      fs.writeFileSync(
        DISK_PATH,
        JSON.stringify({ connection: null, events: [] }, null, 2),
        "utf8"
      );
    } else {
      const cur = JSON.parse(fs.readFileSync(DISK_PATH, "utf8") || "{}");
      if (!cur.events) { cur.events = []; fs.writeFileSync(DISK_PATH, JSON.stringify(cur, null, 2), "utf8"); }
    }
  } catch (e) { console.error("STORE_INIT_ERR", e); }
})();
function readStore() { try { return JSON.parse(fs.readFileSync(DISK_PATH, "utf8")); } catch { return { connection: null, events: [] }; } }
function writeStore(obj) { try { fs.writeFileSync(DISK_PATH, JSON.stringify(obj, null, 2), "utf8"); } catch (e) { console.error("STORE_SAVE_ERR", e); } }
let store = readStore();

// ====== HELPERS ======
function rndState() { return crypto.randomBytes(16).toString("hex"); }
function clientIp(req) {
  const xf = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
  return xf || req.socket?.remoteAddress || "";
}
function requireConnected(req, res, next) {
  const c = readStore().connection;
  if (!c || !c.igid || !c.ig_token) return res.json({ ok: false, error: "not_connected" });
  next();
}

// ====== HEALTH ======
app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ====== AUTH STATUS ======
app.get("/api/auth/status", (_req, res) => {
  const c = readStore().connection;
  if (!c) return res.json({ ok: true, connected: false });
  res.json({ ok: true, connected: !!(c.igid && c.ig_token), username: c.username || "", igid: c.igid || "", page_id: c.page_id || "" });
});

// ====== OAuth start ======
const AUTH_SCOPES = [ "instagram_basic", "instagram_manage_insights", "pages_show_list" ].join(",");
app.get("/auth/ig/login", (req, res) => {
  try {
    if (!IG_APP_ID || !IG_APP_SECRET || !IG_REDIRECT) {
      return res.status(500).send("Config faltando: IG_APP_ID / IG_APP_SECRET / IG_REDIRECT.");
    }
    const state = rndState();
    res.cookie("rst_oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 10 * 60 * 1000 });
    const params = new URLSearchParams({ client_id: IG_APP_ID, redirect_uri: IG_REDIRECT, response_type: "code", scope: AUTH_SCOPES, state }).toString();
    res.redirect(`https://www.facebook.com/${FB_VER}/dialog/oauth?${params}`);
  } catch (e) { console.error("AUTH_START_ERR", e); res.status(500).send("OAuth init error"); }
});

// ====== OAuth callback ======
app.get("/auth/ig/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) return res.redirect(`/public/app.html#/connect?error=${encodeURIComponent(error_description || error)}`);

    const stateCookie = req.cookies ? req.cookies["rst_oauth_state"] : null;
    if (!code || !state || !stateCookie || stateCookie !== state) {
      return res.redirect(`/public/app.html#/connect?error=${encodeURIComponent("codigo_ou_state_ausente")}`);
    }
    res.clearCookie("rst_oauth_state", { path: "/" });

    // troca code -> token curto
    const p = new URLSearchParams({ client_id: IG_APP_ID, client_secret: IG_APP_SECRET, redirect_uri: IG_REDIRECT, code }).toString();
    const tokUrl = `https://graph.facebook.com/${FB_VER}/oauth/access_token?${p}`;
    const jTok = await (await fetch(tokUrl)).json();
    if (!jTok.access_token) return res.redirect(`/public/app.html#/connect?error=token_exchange`);
    let accessToken = jTok.access_token;

    // tenta long-lived
    const longUrl = `https://graph.facebook.com/${FB_VER}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(IG_APP_ID)}&client_secret=${encodeURIComponent(IG_APP_SECRET)}&fb_exchange_token=${encodeURIComponent(accessToken)}`;
    const jLong = await (await fetch(longUrl)).json();
    if (jLong.access_token) accessToken = jLong.access_token;

    // pega página com IG conectado
    const jPages = await (await fetch(`https://graph.facebook.com/${FB_VER}/me/accounts?access_token=${encodeURIComponent(accessToken)}`)).json();
    let found = null;
    if (Array.isArray(jPages.data)) {
      for (const pg of jPages.data) {
        const info = await (await fetch(
          `https://graph.facebook.com/${FB_VER}/${pg.id}?fields=instagram_business_account{id,username},connected_instagram_account{id,username}&access_token=${encodeURIComponent(accessToken)}`
        )).json();
        let igid = info?.instagram_business_account?.id || info?.connected_instagram_account?.id || null;
        let iguser = info?.instagram_business_account?.username || info?.connected_instagram_account?.username || "";
        if (igid) {
          if (!iguser) {
            const jU = await (await fetch(`https://graph.facebook.com/${FB_VER}/${igid}?fields=username&access_token=${encodeURIComponent(accessToken)}`)).json();
            iguser = jU.username || "";
          }
          found = { page_id: pg.id, igid, username: iguser };
          break;
        }
      }
    }
    if (!found) return res.redirect(`/public/app.html#/connect?error=no_ig_business_linked`);

    store = readStore();
    store.connection = { page_id: found.page_id, igid: found.igid, username: found.username, ig_token: accessToken, connected_at: Date.now() };
    writeStore(store);

    res.redirect("/public/app.html#/dashboard");
  } catch (e) { console.error("AUTH_CB_ERR", e); res.redirect(`/public/app.html#/connect?error=callback_exception`); }
});

// ====== IG: listar mídia (reels tolerante) ======
app.get("/api/ig/reels", async (req, res) => {
  try {
    const c = readStore().connection;
    if (!c || !c.igid || !c.ig_token) return res.json({ ok: false, error: "not_connected" });

    const FIELDS = [
      "id","caption","media_type","media_product_type","thumbnail_url","media_url","permalink",
      "comments_count","like_count","video_play_count","timestamp"
    ].join(",");

    const limit = Math.min(100, parseInt(req.query.limit || "100", 10));
    const url = `https://graph.facebook.com/${FB_VER}/${c.igid}/media?fields=${encodeURIComponent(FIELDS)}&limit=${limit}&access_token=${encodeURIComponent(c.ig_token)}`;
    const js = await (await fetch(url)).json();
    if (js.error) {
      if (js.error.code === 190) { store = readStore(); store.connection = null; writeStore(store); return res.json({ ok:false, error:"not_connected" }); }
      return res.json({ ok:false, error:"fb_error", raw:js });
    }

    const data = Array.isArray(js.data) ? js.data : [];
    const items = data.filter(m => m.media_product_type === "REELS" || ((m.permalink||"").includes("/reel/")));
    res.json({ ok:true, count: items.length, items });
  } catch (e) { console.error("IG_REELS_ERR", e); res.json({ ok:false, error:"server_error" }); }
});

// ====== TRACK: registrar eventos (sale/lead) + GEO ======
app.post("/api/track", (req, res) => {
  try {
    const { type, reel_id, permalink, amount, username, meta, country, city } = req.body || {};
    if (!type) return res.status(400).json({ ok:false, error:"type_required" });
    if (!["sale","lead"].includes(type)) return res.status(400).json({ ok:false, error:"type_invalid" });

    // Geo por IP (fallback se não vier country/city no body)
    const ip = clientIp(req);
    let geo = geoip.lookup(ip) || null;
    const cc = (country || geo?.country || "").toUpperCase() || null;
    const cty = city || geo?.city || null;

    store = readStore();
    store.events = store.events || [];
    store.events.push({
      type,
      reel_id: reel_id || null,
      permalink: permalink || null,
      amount: Number(amount || 0),
      username: username || null,
      meta: meta || null,
      geo: { ip, country: cc, city: cty },
      ts: Date.now()
    });
    writeStore(store);
    res.json({ ok:true });
  } catch (e) { console.error("TRACK_ERR", e); res.status(500).json({ ok:false, error:"server_error" }); }
});

// ====== SALES: agregado por Reel ======
app.get("/api/sales/by-reel", (req, res) => {
  try {
    const since = Number(req.query.since || 0);
    const until = Number(req.query.until || Date.now()+1);
    const evs = (readStore().events || []).filter(e => e.type==="sale" && (!since || e.ts>=since) && (!until || e.ts<until));

    const byKey = {}; let totalSales=0, totalRevenue=0;
    for (const e of evs) {
      const key = e.reel_id || e.permalink || "desconhecido";
      if (!byKey[key]) byKey[key] = { sales:0, revenue:0, last_ts:0 };
      byKey[key].sales += 1;
      byKey[key].revenue += Number(e.amount || 0);
      if (e.ts > byKey[key].last_ts) byKey[key].last_ts = e.ts;
      totalSales += 1; totalRevenue += Number(e.amount || 0);
    }
    const ranking = Object.entries(byKey).map(([k,v]) => ({ key:k, ...v })).sort((a,b)=> b.sales - a.sales || b.revenue - a.revenue);
    res.json({ ok:true, since, until, total_sales:totalSales, total_revenue:totalRevenue, by_reel:byKey, ranking });
  } catch (e) { console.error("BY_REEL_ERR", e); res.status(500).json({ ok:false, error:"server_error" }); }
});

// ====== GEO: resumo por país/cidade ======
app.get("/api/geo/summary", (req,res)=>{
  try{
    const since = Number(req.query.since || 0);
    const until = Number(req.query.until || Date.now()+1);
    const all = (readStore().events || []).filter(e => (!since || e.ts>=since) && (!until || e.ts<until));

    const byCountry = {}; let totalLeads=0, totalSales=0;
    for (const e of all) {
      const cc = (e.geo?.country || "??").toUpperCase();
      if (!byCountry[cc]) byCountry[cc] = { leads:0, sales:0, revenue:0, cities:{} };
      if (e.type === "lead") { byCountry[cc].leads += 1; totalLeads += 1; }
      if (e.type === "sale") { byCountry[cc].sales += 1; byCountry[cc].revenue += Number(e.amount || 0); totalSales += 1; }
      const city = (e.geo?.city || "Desconhecida");
      if (!byCountry[cc].cities[city]) byCountry[cc].cities[city] = { leads:0, sales:0, revenue:0 };
      if (e.type === "lead") byCountry[cc].cities[city].leads += 1;
      if (e.type === "sale") { byCountry[cc].cities[city].sales += 1; byCountry[cc].cities[city].revenue += Number(e.amount || 0); }
    }

    const countries = Object.entries(byCountry).map(([code,v])=>{
      const cities = Object.entries(v.cities).map(([name,c])=>({ name, ...c }))
        .sort((a,b)=> b.sales - a.sales || b.leads - a.leads).slice(0,5);
      return { code, ...v, cities };
    }).sort((a,b)=> b.sales - a.sales || b.leads - a.leads || b.revenue - a.revenue);

    res.json({ ok:true, since, until, total_leads: totalLeads, total_sales: totalSales, countries });
  }catch(e){ console.error("GEO_SUMMARY_ERR",e); res.status(500).json({ ok:false, error:"server_error" }); }
});

// DEBUG cru
app.get("/api/debug/ig/media", async (req, res) => {
  try {
    const c = readStore().connection;
    if (!c || !c.igid || !c.ig_token) return res.json({ ok:false, error:"not_connected" });
    const url = `https://graph.facebook.com/${FB_VER}/${c.igid}/media?fields=id,media_type,media_product_type,permalink,thumbnail_url,media_url,caption,timestamp&limit=25&access_token=${encodeURIComponent(c.ig_token)}`;
    const js = await (await fetch(url)).json();
    res.json(js);
  } catch (e) { res.json({ ok:false, error:String(e) }); }
});

// raiz
app.get("/", (_req, res) => res.redirect("/public/app.html"));

const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
app.listen(PORT, () => console.log(`RastroO ON :${PORT}`));
