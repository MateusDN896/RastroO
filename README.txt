RastroO — MVP (self-hosted)
================================

Rodar localmente
----------------
1) Baixe esta pasta ou descompacte o zip.
2) No terminal, entre na pasta e rode:
   npm i
   npm run dev
3) Abra http://localhost:3000

Arquivos
--------
- server.js        → API (Express + SQLite com better-sqlite3)
- public/snippet.js → Snippet para colar nas páginas que você quer rastrear
- public/dashboard.html → Painel simples
- rastroo.db       → Criado automaticamente

Como usar o snippet
-------------------
1) Hospede este app (vercel, render, hostinger node, etc.).
2) Na sua landing, adicione antes do </body>:
   <script>window.RASTROO_API='https://SEU_DOMINIO';</script>
   <script src="https://SEU_DOMINIO/public/snippet.js" defer></script>

3) Para enviar lead por JS:
   window.RastroO.lead({ email: 'fulana@email.com', name: 'Fulana' })

4) Para registrar venda (ex: webhook depois do pagamento):
   window.RastroO.sale({ orderId: '123', amount: 27.90, currency: 'BRL', attribution: 'LAST' })

Privacidade
-----------
- Não salvamos IP puro. Apenas hash (sha256 de IP+UA).
- Cookies SameSite=Lax; Secure quando HTTPS.

Limites
-------
- /api/hit tem rate-limit de 10 hits/min por sessão (session cookie).

Obs
---
- Este é um MVP. Para produção, usar Postgres (Supabase) e autenticação no painel.
