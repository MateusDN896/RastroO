<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
  <title>RastroO — App</title>
  <style>
    :root{
      --bg:#0b1020;--panel:#111a2e;--card:#0f1627;--text:#e7eefc;--muted:#93a3b2;--brand:#3b82f6;
      --border:#1f2940;--ok:#10b981;--warn:#f59e0b;--danger:#ef4444;
    }
    *{box-sizing:border-box}
    html,body{height:100%}
    body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,Segoe UI,Roboto}
    a{color:inherit;text-decoration:none}

    .app{min-height:100vh;display:grid;grid-template-columns:240px 1fr}
    @media(max-width:900px){.app{grid-template-columns:1fr}}

    .sidebar{background:var(--panel);border-right:1px solid var(--border);padding:16px;position:sticky;top:0;height:100vh;overflow:auto}
    @media(max-width:900px){.sidebar{position:static;height:auto}}
    .brand{display:flex;gap:10px;align-items:center;margin-bottom:16px}
    .brand .dot{width:10px;height:10px;border-radius:999px;background:linear-gradient(135deg,var(--brand),#8b82f6)}
    .brand b{font-size:18px}

    nav a{display:block;padding:10px 12px;border-radius:8px;border:1px solid transparent}
    nav a.active{background:var(--card);border-color:var(--border)}
    nav a + a{margin-top:8px}

    .main{padding:18px}
    .header{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-bottom:16px}
    .tag{font-size:12px;padding:4px 8px;border-radius:999px;border:1px solid var(--border);background:var(--card)}
    .btn{display:inline-flex;gap:8px;align-items:center;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--panel);cursor:pointer}

    .cards{display:grid;grid-template-columns:1fr;gap:12px}
    @media(min-width:520px){.cards{grid-template-columns:1fr 1fr}}
    @media(min-width:980px){.cards{grid-template-columns:repeat(3,1fr)}}
    .card{border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--card)}
    .thumb{aspect-ratio:9/16;background-size:cover;background-position:center}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px}
    .row{display:flex;justify-content:space-between;font-size:12px}
    .muted{color:var(--muted)}
    .mt{margin-top:10px}

    .table{width:100%;border-collapse:collapse;border:1px solid var(--border);background:var(--panel)}
    .table th,.table td{padding:10px;border-top:1px solid var(--border);text-align:left;font-size:13px}
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand"><span class="dot"></span><b>RastroO</b></div>
      <nav id="nav">
        <a href="#/dashboard">Dashboard</a>
        <a href="#/reels" class="active">Reels & Insights</a>
        <a href="#/connect">Conectar Instagram</a>
        <a href="#/config">Configurações</a>
      </nav>
      <div class="mt muted" id="authInfo"></div>
    </aside>

    <main class="main">
      <div class="header">
        <div><b id="title">Reels & Insights</b></div>
        <button class="btn" id="btnConnect">Conectar com Instagram (Meta)</button>
      </div>

      <div id="view"></div>
    </main>
  </div>

  <script>
    const view = document.getElementById('view');
    const btnConnect = document.getElementById('btnConnect');
    const authInfo = document.getElementById('authInfo');
    const titleEl = document.getElementById('title');
    const nav = document.getElementById('nav');

    function setActive(hash) {
      [...nav.querySelectorAll('a')].forEach(a=>{
        a.classList.toggle('active', a.getAttribute('href') === hash);
      });
    }

    async function authStatus(){
      const r = await fetch('/api/auth/status');
      const j = await r.json();
      const tag = j.connected ? `<span class="tag">IG: conectado</span>` : `<span class="tag muted">não conectado</span>`;
      authInfo.innerHTML = `${tag}<div class="mt muted">${j.username ? '@'+j.username : ''}</div>`;
      btnConnect.style.display = j.connected ? 'none':'inline-flex';
      return j;
    }

    function goConnect(){
      location.href = '/auth/ig/login';
    }
    btnConnect.addEventListener('click', goConnect);

    async function pageReels(){
      titleEl.textContent = 'Reels & Insights';
      const st = await authStatus();
      if (!st.connected) {
        view.innerHTML = `<div class="muted">Conecte sua conta para ver os Reels.</div>`;
        return;
      }
      view.innerHTML = `<div class="muted">Carregando Reels...</div>`;
      const r = await fetch('/api/ig/reels');
      const j = await r.json();
      if (!j.ok) {
        view.innerHTML = `<div class="muted">Erro ao carregar: ${j.error || 'falha'}</div>`;
        return;
      }
      if (!j.count) {
        view.innerHTML = `<div class="muted">Sem Reels para mostrar.</div>`;
        return;
      }
      const cards = j.items.map(m=>{
        const thumb = m.thumbnail_url || m.media_url || '';
        return `
          <a class="card" href="${m.permalink}" target="_blank" rel="noopener">
            <div class="thumb" style="background-image:url('${thumb}')"></div>
            <div class="meta">
              <div class="row"><span>Plays</span><b>${m.video_play_count ?? '-'}</b></div>
              <div class="row"><span>Likes</span><b>${m.like_count ?? '-'}</b></div>
              <div class="row"><span>Comentários</span><b>${m.comments_count ?? '-'}</b></div>
            </div>
          </a>
        `;
      }).join('');
      view.innerHTML = `<div class="cards">${cards}</div>`;
    }

    async function pageDashboard(){
      titleEl.textContent = 'Dashboard';
      await authStatus();
      view.innerHTML = `
        <table class="table">
          <thead><tr><th>Card</th><th>Valor</th></tr></thead>
          <tbody>
            <tr><td>Status</td><td id="st"></td></tr>
            <tr><td>Data</td><td>${new Date().toLocaleString()}</td></tr>
          </tbody>
        </table>
      `;
      const st = await fetch('/api/ping').then(r=>r.json()).catch(()=>({ok:false}));
      document.getElementById('st').textContent = st.ok ? 'OK' : 'Falha';
    }

    async function pageConnect(){
      titleEl.textContent = 'Conectar Instagram';
      const st = await authStatus();
      view.innerHTML = st.connected
        ? `<div>Já conectado como <b>@${st.username || ''}</b>.</div>`
        : `<div>Para conectar, clique no botão acima.</div>`;
    }

    async function pageConfig(){
      titleEl.textContent = 'Configurações';
      await authStatus();
      view.innerHTML = `
        <div class="muted">Configurações básicas (placeholder).</div>
      `;
    }

    async function router(){
      const r = (location.hash || '#/reels');
      setActive(r);
      if (r.startsWith('#/reels')) return pageReels();
      if (r.startsWith('#/dashboard')) return pageDashboard();
      if (r.startsWith('#/connect')) return pageConnect();
      if (r.startsWith('#/config')) return pageConfig();
      return pageReels();
    }

    window.addEventListener('hashchange', router);
    router();
    document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) router(); });
  </script>
</body>
</html>
