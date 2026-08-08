/* ────────────────────────────────────────────────────────────────────────────
   integrations.js — storefront loader for admin-enabled third-party services.

   site_settings.integrations = {
     clarity:    { enabled: true, id: 'abc123' },
     sentry:     { enabled: true, id: 'https://…@o0.ingest.sentry.io/0' },
     crisp:      { enabled: true, id: '…' },
     tawk:       { enabled: true, id: '5f…/1f…' },
     pinterest:  { enabled: true, id: '2612…' },
     tiktok:     { enabled: true, id: 'C7…' },
     plausible:  { enabled: true, id: 'example.com' },
     trustpilot: { enabled: true, id: '5f…' }
   }

   Every entry is a single public identifier — nothing secret goes in here, and
   this key IS anon-readable by design (the browser has to read it). Secrets for
   server-side integrations (Slack/Discord webhook URLs) live in the masked key
   store instead, via /api/update-api-key.

   Admin: APIs → More Integrations. Loaders are lazy: an integration that is
   absent or disabled costs exactly one cache read and injects nothing.

   CSP: every host injected here is listed in the script-src / connect-src of
   _headers' Content-Security-Policy-Report-Only. Adding a new integration means
   adding its hosts there too, or enforcing that policy later will break it.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
  var REST  = 'https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/site_settings?select=value&key=eq.integrations';
  var CACHE = 'zw_integrations';

  var loaded = {};

  function script(src, attrs, before) {
    var s = document.createElement('script');
    s.src = src;
    s.async = true;
    if (attrs) for (var k in attrs) { if (Object.prototype.hasOwnProperty.call(attrs, k)) s.setAttribute(k, attrs[k]); }
    (before || document.head).appendChild(s);
    return s;
  }

  function inline(code) {
    var s = document.createElement('script');
    s.text = code;
    document.head.appendChild(s);
    return s;
  }

  /* Each loader receives the integration's public id. Kept deliberately close to
     each vendor's documented snippet so they stay easy to compare against docs. */
  var LOADERS = {
    // Microsoft Clarity — heatmaps + session replay. Free, no volume cap.
    clarity: function (id) {
      inline('(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};' +
             't=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;' +
             'y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})' +
             '(window,document,"clarity","script","' + id + '");');
    },


    // Sentry — browser error monitoring. `id` is the public DSN.
    sentry: function (id) {
      var s = script('https://browser.sentry-cdn.com/7.120.0/bundle.tracing.min.js', {
        crossorigin: 'anonymous'
      });
      s.onload = function () {
        try {
          window.Sentry.init({
            dsn: id,
            tracesSampleRate: 0.1,
            // Storefront noise that is not actionable: extension injections and
            // the benign ResizeObserver loop warning browsers emit on reflow.
            ignoreErrors: ['ResizeObserver loop', 'Non-Error promise rejection captured']
          });
        } catch (_) {}
      };
    },

    // Crisp — live chat.
    crisp: function (id) {
      window.$crisp = [];
      window.CRISP_WEBSITE_ID = id;
      script('https://client.crisp.chat/l.js');
    },

    // Tawk.to — live chat, free tier. `id` is "propertyId/widgetId".
    tawk: function (id) {
      window.Tawk_API = window.Tawk_API || {};
      window.Tawk_LoadStart = new Date();
      script('https://embed.tawk.to/' + id, { crossorigin: '*' });
    },

    // Pinterest Tag — shopping/retargeting.
    pinterest: function (id) {
      inline('!function(e){if(!window.pintrk){window.pintrk=function(){window.pintrk.queue.push(' +
             'Array.prototype.slice.call(arguments))};var n=window.pintrk;n.queue=[],n.version="3.0";' +
             'var t=document.createElement("script");t.async=!0,t.src=e;' +
             'var r=document.getElementsByTagName("script")[0];r.parentNode.insertBefore(t,r)}}' +
             '("https://s.pinimg.com/ct/core.js");pintrk("load","' + id + '");pintrk("page");');
    },

    // TikTok Pixel.
    tiktok: function (id) {
      inline('!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];' +
             'ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"];' +
             'ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};' +
             'for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);' +
             'ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e};' +
             'ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";' +
             'ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=i,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};' +
             'var o=d.createElement("script");o.type="text/javascript",o.async=!0,o.src=i+"?sdkid="+e+"&lib="+t;' +
             'var a=d.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};' +
             'ttq.load("' + id + '");ttq.page();}(window,document,"ttq");');
    },

    // Plausible — privacy-friendly analytics, no cookie banner needed.
    plausible: function (id) {
      script('https://plausible.io/js/script.js', { 'data-domain': id, defer: 'defer' });
    },

    // Trustpilot — review widgets. Loading the bootstrap lets any
    // .trustpilot-widget element on the page render.
    trustpilot: function () {
      script('https://widget.trustpilot.com/bootstrap/v5/tp.widget.bootstrap.min.js', {
        async: 'async'
      });
    },

  };

  function apply(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    Object.keys(LOADERS).forEach(function (key) {
      var entry = cfg[key];
      if (!entry || entry.enabled === false) return;
      // Trustpilot is the one loader that needs no id; everything else does.
      var id = String(entry.id || '').trim();
      if (!id && key !== 'trustpilot') return;
      if (loaded[key]) return;
      loaded[key] = true;
      try { LOADERS[key](id); } catch (_) {}
    });
  }

  // Cached first so an enabled integration starts loading immediately rather
  // than waiting on a round trip; then refreshed in case the admin changed it.
  try {
    var cached = localStorage.getItem(CACHE);
    if (cached) apply(JSON.parse(cached));
  } catch (_) {}

  fetch(REST, { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON }, cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (rows) {
      var cfg = rows && rows[0] && rows[0].value;
      if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch (_) { cfg = null; } }
      if (!cfg) return;
      try { localStorage.setItem(CACHE, JSON.stringify(cfg)); } catch (_) {}
      apply(cfg);
    })
    .catch(function () {});
})();
