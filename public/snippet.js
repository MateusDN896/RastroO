/* RastroO snippet - embed this in any page. 
Add: <script src="https://YOUR_SERVER/public/snippet.js" defer></script>
Then use window.RastroO.lead({...}) and window.RastroO.sale({...})
*/
(function(){
  const API_BASE = window.RASTROO_API || ''; // e.g. 'https://yourserver.com'
  if (!API_BASE) console.warn('[RastroO] Set window.RASTROO_API to your server base URL.');

  function uuidv4(){
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function setCookie(name, value, days){
    const d = new Date();
    d.setTime(d.getTime() + (days*24*60*60*1000));
    const expires = "expires="+ d.toUTCString();
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = name + "=" + (value || "")  + "; SameSite=Lax; path=/; " + expires + secure;
  }
  function getCookie(name){
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
  }

  function getParam(name){
    const url = new URL(window.location.href);
    return url.searchParams.get(name);
  }

  function parseUTMs(){
    const url = new URL(window.location.href);
    const utm = {};
    ['utm_source','utm_medium','utm_campaign','utm_content'].forEach(k=>{
      const v = url.searchParams.get(k);
      if (v) utm[k] = v;
    });
    return utm;
  }

  function deviceInfo(){
    const ua = navigator.userAgent || '';
    if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Opera Mini/i.test(ua)) return 'mobile';
    if (/iPad|Tablet/i.test(ua)) return 'tablet';
    return 'desktop';
  }

  // session cookie
  let sessionId = getCookie('rastroo_session');
  if (!sessionId) {
    sessionId = uuidv4();
    setCookie('rastroo_session', sessionId, 90);
  }

  // creator cookie via ?r=
  const r = getParam('r');
  if (r) setCookie('rastroo_creator', r, 90);

  // send hit
  window.addEventListener('load', function(){
    try{
      const utm = parseUTMs();
      const body = {
        page: window.location.href,
        referrer: document.referrer || '',
        device: deviceInfo(),
        sessionId,
        creatorSlug: getCookie('rastroo_creator') || null,
        ...utm,
        cookies: { rastroo_creator: getCookie('rastroo_creator') }
      };
      fetch(API_BASE + '/api/hit', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body),
        keepalive: true
      }).catch(()=>{});
    } catch(e){}
  });

  window.RastroO = {
    lead: function({email, name, page, extra}){
      const utm = parseUTMs();
      return fetch(API_BASE + '/api/lead', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          email, name: name || '',
          page: page || window.location.href,
          sessionId,
          creatorSlug: getCookie('rastroo_creator') || null,
          ...utm,
          extraJson: extra || null,
          cookies: { rastroo_creator: getCookie('rastroo_creator') }
        })
      }).then(r=>r.json());
    },
    sale: function({orderId, amount, currency, attribution, extra}){
      const utm = parseUTMs();
      return fetch(API_BASE + '/api/sale', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          orderId, amount: amount || 0, currency: currency || 'BRL',
          sessionId,
          creatorSlug: getCookie('rastroo_creator') || null,
          ...utm,
          attribution: attribution || 'LAST',
          extraJson: extra || null,
          cookies: { rastroo_creator: getCookie('rastroo_creator') }
        })
      }).then(r=>r.json());
    }
  };
})();