// server.js — RastroO (CORS + static + health + raiz -> dashboard_v2)
const express = require('express');
const path = require('path');

const app = express();
app.set('trust proxy', true);

// -------------------- Middlewares básicos --------------------
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// -------------------- CORS (allowlist) --------------------
// Se precisar liberar mais domínios, adicione aqui:
const ALLOWED = new Set([
  'https://rastroo.site',
  'https://www.rastroo.site',
  'https://trk.rastroo.site',
  'https://896.xpages.co' // xQuiz (xpages)
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    // Se algum endpoint usar cookies/credenciais cross-site, descomente:
    // res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// -------------------- Arquivos estáticos --------------------
// Sem cache pra você sempre ver mudanças do dashboard
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

// -------------------- Healthcheck --------------------
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// -------------------- Raiz -> Dashboard --------------------
app.get('/', (_req, res) => res.redirect('/public/dashboard_v2.html'));

// ===================================================================
//  MANTENHA AQUI EMBAIXO AS SUAS ROTAS DE API JÁ EXISTENTES
//  (ex.: /api/event, /api/report, etc). NÃO APAGUE ESSE BLOCO DE CIMA.
// ===================================================================

// Exemplo opcional de ping (não obrigatório):
app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// -------------------- Start --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RastroO rodando na porta ${PORT}`);
});
