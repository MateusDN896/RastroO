// server.js (mínimo para validar deploy)
const express = require("express");
const app = express();

app.get("/api/ping", (req, res) => {
  res.json({ ok: true, port: process.env.PORT || 10000, ts: Date.now() });
});

// sirva /public para já validar arquivos estáticos
const path = require("path");
app.use("/public", express.static(path.join(__dirname, "public")));

app.listen(process.env.PORT || 10000, "0.0.0.0", () =>
  console.log("RastroO HELLO rodando na porta", process.env.PORT || 10000)
);
