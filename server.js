// server.js — RastroO (CommonJS, compat Render)

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// fetch (Node 18 tem global; Node 16 usa node-fetch dinamicamente)
let _fetch = global.fetch;
if (!_fetch) {
  _fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
}
const fetch = (...args) => _fetch(...args);

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());
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
const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || "rastroo_state_secret";
const FB_VER = "v20.0";

// ====== STORE (DISK_PATH) ======
const DISK_PATH =
  process.env.DISK_PATH || path.join(__dirname, "data", "rastroo-store.json");
(function ensureStoreFile() {
  try {
    fs.mkdirSync(path.dirname(DISK_PATH), { recursive: true });
    if (!fs.existsSync(DISK_PATH)) {
      fs.writeFileSync(
        DISK_PATH,
        JSON.stringify({ connection: null }, null, 2),
        "utf8"
      );
    }
  } catch (e) {
    console.error("STORE_INIT_ERR", e);
  }
})();
function readStore() {
  try {
    return JSON.parse(fs.readFileSync(DISK_PATH, "utf8"));
  } catch {
    return { connection: null };
  }
}
function writeStore(obj) {
  try {
    fs.writeFileSync(DISK_PATH, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("STORE_SAVE_ERR", e);
  }
}
let store = readStore();

// ====== HELPERS ======
function rndState() {
  return crypto.randomBytes(16).toString("hex");
}
function requireConnected(req, res, next) {
  const c = store.connection;
  if (!c || !c.igid || !c.ig_token) {
    return res.json({ ok: false, error: "not_connected" });
  }
  next();
}

// ====== HEALTH ======
app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ====== AUTH STATUS ======
app.get("/api/auth/status", (_req, res) => {
  const c = store.connection;
  if (!c) return res.json({ ok: true, connected: false });
  res.json({
    ok: true,
    connected: !!(c.igid && c.ig_token),
    username: c.username || "",
    igid: c.igid || "",
    page_id: c.page_id || ""
  });
});

// ====== OAuth start ======
const AUTH_SCOPES = [
  "instagram_basic",
  "instagram_manage_insights",
  "pages_show_list"
].join(",");

app.get("/auth/ig/login", (req, res) => {
  try {
    if (!IG_APP_ID || !IG_APP_SECRET || !IG_REDIRECT) {
      return res
        .status(500)
        .send("Config faltando: IG_APP_ID / IG_APP_SECRET / IG_REDIRECT.");
    }

    const state = rndState();
    // cookie de state (httpOnly + Secure + Lax)
    res.cookie("rst_oauth_state", state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 10 * 60 * 1000
    });

    const params = new URLSearchParams({
      client_id: IG_APP_ID,
      redirect_uri: IG_REDIRECT,
      response_type: "code",
      scope: AUTH_SCOPES,
      state
    }).toString();

    res.redirect(`https://www.facebook.com/${FB_VER}/dialog/oauth?${params}`);
  } catch (e) {
    console.error("AUTH_START_ERR", e);
    res.status(500).send("OAuth init error");
  }
});

// ====== OAuth callback ======
app.get("/auth/ig/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      console.error("OAUTH_ERROR", error, error_description);
      return res
        .redirect(
          `/public/app.html#/connect?error=${encodeURIComponent(
            error_description || error
          )}`
        );
    }

    const stateCookie = req.cookies ? req.cookies["rst_oauth_state"] : null;
    if (!code || !state || !stateCookie || stateCookie !== state) {
      console.error("[OAuth callback] Código/estado ausente/ inválido");
      return res
        .redirect(
          `/public/app.html#/connect?error=${encodeURIComponent(
            "codigo_ou_state_ausente"
          )}`
        );
    }

    // consome cookie
    res.clearCookie("rst_oauth_state", { path: "/" });

    // troca code -> short token
    const p = new URLSearchParams({
      client_id: IG_APP_ID,
      client_secret: IG_APP_SECRET,
      redirect_uri: IG_REDIRECT,
      code
    }).toString();
    const tokUrl = `https://graph.facebook.com/${FB_VER}/oauth/access_token?${p}`;
    const rTok = await fetch(tokUrl);
    const jTok = await rTok.json();
    if (!jTok.access_token) {
      console.error("TOKEN_EXCHANGE_FAIL", jTok);
      return res.redirect(
        `/public/app.html#/connect?error=${encodeURIComponent("token_exchange")}`
      );
    }
    let accessToken = jTok.access_token;

    // (opcional) troca por long-lived
    const longUrl =
      `https://graph.facebook.com/${FB_VER}/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${encodeURIComponent(IG_APP_ID)}` +
      `&client_secret=${encodeURIComponent(IG_APP_SECRET)}` +
      `&fb_exchange_token=${encodeURIComponent(accessToken)}`;
    const rLong = await fetch(longUrl);
    const jLong = await rLong.json();
    if (jLong.access_token) accessToken = jLong.access_token;

    // páginas -> busca IG business/connected
    const rPages = await fetch(
      `https://graph.facebook.com/${FB_VER}/me/accounts?access_token=${encodeURIComponent(
        accessToken
      )}`
    );
    const jPages = await rPages.json();

    let found = null;
    if (Array.isArray(jPages.data)) {
      for (const pg of jPages.data) {
        const rInfo = await fetch(
          `https://graph.facebook.com/${FB_VER}/${pg.id}` +
            `?fields=instagram_business_account{id,username},connected_instagram_account{id,username}` +
            `&access_token=${encodeURIComponent(accessToken)}`
        );
        const info = await rInfo.json();
        let igid = null;
        let iguser = "";
        if (info.instagram_business_account && info.instagram_business_account.id) {
          igid = info.instagram_business_account.id;
          iguser = info.instagram_business_account.username || "";
        } else if (info.connected_instagram_account && info.connected_instagram_account.id) {
          igid = info.connected_instagram_account.id;
          iguser = info.connected_instagram_account.username || "";
        }
        if (igid) {
          if (!iguser) {
            const rU = await fetch(
              `https://graph.facebook.com/${FB_VER}/${igid}?fields=username&access_token=${encodeURIComponent(
                accessToken
              )}`
            );
            const jU = await rU.json();
            iguser = jU.username || "";
          }
          found = { page_id: pg.id, igid, username: iguser };
          break;
        }
      }
    }

    if (!found) {
      return res.redirect(
        `/public/app.html#/connect?error=${encodeURIComponent(
          "no_ig_business_linked"
        )}`
      );
    }

    // salva
    store.connection = {
      page_id: found.page_id,
      igid: found.igid,
      username: found.username,
      ig_token: accessToken,
      connected_at: Date.now()
    };
    writeStore(store);

    // volta pro Reels
    res.redirect("/public/app.html#/reels");
  } catch (e) {
    console.error("AUTH_CB_ERR", e);
    res.redirect(
      `/public/app.html#/connect?error=${encodeURIComponent("callback_exception")}`
    );
  }
});

// ====== IG: listar mídia (reels tolerante) ======
app.get("/api/ig/reels", async (req, res) => {
  try {
    const c = store.connection;
    if (!c || !c.igid || !c.ig_token) {
      return res.json({ ok: false, error: "not_connected" });
    }

    const FIELDS = [
      "id",
      "caption",
      "media_type",
      "media_product_type",
      "thumbnail_url",
      "media_url",
      "permalink",
      "comments_count",
      "like_count",
      "video_play_count",
      "timestamp"
    ].join(",");

    const url =
      `https://graph.facebook.com/${FB_VER}/${c.igid}/media` +
      `?fields=${encodeURIComponent(FIELDS)}&limit=100&access_token=${encodeURIComponent(
        c.ig_token
      )}`;

    const r = await fetch(url);
    const js = await r.json();
    if (js.error) {
      console.error("IG_MEDIA_ERR", js.error);
      if (js.error.code === 190) {
        // token inválido/expirado
        store.connection = null;
        writeStore(store);
        return res.json({ ok: false, error: "not_connected" });
      }
      return res.json({ ok: false, error: "fb_error", raw: js });
    }

    const data = Array.isArray(js.data) ? js.data : [];
    const items = data.filter(
      (m) =>
        m.media_product_type === "REELS" ||
        ((m.permalink || "").includes("/reel/"))
    );

    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    console.error("IG_REELS_ERR", e);
    res.json({ ok: false, error: "server_error" });
  }
});

// DEBUG cru (pra ver o que a API está mandando)
app.get("/api/debug/ig/media", async (req, res) => {
  try {
    const c = store.connection;
    if (!c || !c.igid || !c.ig_token) {
      return res.json({ ok: false, error: "not_connected" });
    }
    const url =
      `https://graph.facebook.com/${FB_VER}/${c.igid}/media` +
      `?fields=id,media_type,media_product_type,permalink,thumbnail_url,media_url,caption,timestamp` +
      `&limit=25&access_token=${encodeURIComponent(c.ig_token)}`;
    const r = await fetch(url);
    const js = await r.json();
    res.json(js);
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

// Webhook verify (opcional)
app.get("/ig/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === IG_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// raiz
app.get("/", (_req, res) => res.redirect("/public/app.html"));

const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
app.listen(PORT, () => console.log(`RastroO ON :${PORT}`));
