/* ────────────────────────────────────────────────────────────────────────────
   header-scroll.js — header scroll behavior, admin-controlled PER PAGE.

   site_settings.header_behavior = { mode, pages } where:
     • mode  — site-wide default: "auto-hide" (Adidas-style: hide on scroll down,
       reveal on scroll up) or "pinned" (always visible).
     • pages — per-page overrides keyed by page, e.g. { "returns": "pinned" }.
       The page key is the filename without extension ("/" → "home").

   Resolution for the current page: pages[pageKey] || mode || "auto-hide".
   The whole config is cached in localStorage (zw_header_cfg) for instant apply,
   then refreshed from site_settings. CSS lives in storefront-cohesion.css
   (.zw-nav-hidden → translateY(-100%); reduced-motion keeps the header shown).
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
  var REST = 'https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/site_settings?select=value&key=eq.header_behavior';
  var CFG_KEY = 'zw_header_cfg';
  var HIDDEN = 'zw-nav-hidden';
  var THRESH = 6;       // ignore sub-pixel / jitter scrolls
  var REVEAL_AT = 90;   // always show within this many px of the top

  // Header element varies by page: <nav id="nav"> (home/bag), <header class="nav">
  // (collection/policies/size guide), <nav class="nav"> (product), <nav class="zw-nav">
  // (account/returns/about). Match them all (but never the in-modal mobile menu nav).
  function getNav() { return document.querySelector('nav#nav, header.nav, nav.nav, nav.zw-nav'); }

  // Page identity = filename without ".html" ("/" or "/index.html" → "home").
  function pageKey() {
    var p = (location.pathname || '').replace(/^\/+/, '').replace(/\.html$/i, '').toLowerCase();
    if (!p || p === 'index') return 'home';
    return p;
  }
  function cachedCfg() { try { return JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch (_) { return null; } }
  function resolveMode(cfg) {
    if (!cfg || typeof cfg !== 'object') return 'auto-hide';
    var ov = cfg.pages && cfg.pages[pageKey()];
    if (ov === 'pinned' || ov === 'auto-hide') return ov;
    return cfg.mode === 'pinned' ? 'pinned' : 'auto-hide';
  }

  function init() {
    var nav = getNav();
    if (!nav) return;

    var mode = resolveMode(cachedCfg());
    var lastY = window.pageYOffset || document.documentElement.scrollTop || 0;
    var ticking = false;

    function show() { nav.classList.remove(HIDDEN); }
    function hide() { nav.classList.add(HIDDEN); }

    function update() {
      ticking = false;
      if (mode !== 'auto-hide') { show(); return; }
      // Never hide while a modal / scroll-lock is active (modal-lock.js sets these).
      if (document.body.dataset.scrollLocked || window.__zwScrollLocking || window.__zwScrollRestoring) return;
      var y = window.pageYOffset || document.documentElement.scrollTop || 0;
      if (y <= REVEAL_AT) { show(); lastY = y; return; }
      var dy = y - lastY;
      if (Math.abs(dy) < THRESH) return;
      if (dy > 0) hide(); else show();   // down → hide, up → reveal
      lastY = y;
    }
    function onScroll() {
      if (ticking) return;
      ticking = true;
      (window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(update);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    if (mode !== 'auto-hide') show();

    // Refresh config from site_settings (background), cache + re-resolve for THIS page.
    try {
      fetch(REST, { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rows) {
          if (!rows || !rows[0]) return;
          var cfg = rows[0].value;
          if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch (_) {} }
          if (!cfg || typeof cfg !== 'object') return;
          try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (_) {}
          mode = resolveMode(cfg);
          if (mode !== 'auto-hide') show();
        })
        .catch(function () {});
    } catch (_) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
