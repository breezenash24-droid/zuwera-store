/* ────────────────────────────────────────────────────────────────────────────
   header-scroll.js — header scroll behavior, admin-controlled.

   Modes (site_settings.header_behavior = { mode }):
     • "auto-hide" (default) — Adidas-style: hide the header when scrolling DOWN,
       reveal it when scrolling UP (and always show near the top).
     • "pinned" — header always visible (no auto-hide).

   The mode is cached in localStorage (zw_header_mode) for instant application, then
   refreshed from site_settings in the background. CSS lives in storefront-cohesion.css
   (.zw-nav-hidden → translateY(-100%); reduced-motion keeps it shown).
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
  var REST = 'https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/site_settings?select=value&key=eq.header_behavior';
  var MODE_KEY = 'zw_header_mode';
  var HIDDEN = 'zw-nav-hidden';
  var THRESH = 6;       // ignore sub-pixel / jitter scrolls
  var REVEAL_AT = 90;   // always show within this many px of the top

  function getNav() { return document.querySelector('nav#nav, nav.nav, nav.zw-nav'); }
  function cachedMode() { try { return localStorage.getItem(MODE_KEY); } catch (_) { return null; } }

  function init() {
    var nav = getNav();
    if (!nav) return;

    var mode = cachedMode() || 'auto-hide';
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

    // Refresh the mode from site_settings (background), cache + apply.
    try {
      fetch(REST, { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rows) {
          if (!rows || !rows[0]) return;
          var v = rows[0].value;
          if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) {} }
          var m = v && v.mode;
          if (m === 'pinned' || m === 'auto-hide') {
            try { localStorage.setItem(MODE_KEY, m); } catch (_) {}
            mode = m;
            if (m !== 'auto-hide') show();
          }
        })
        .catch(function () {});
    } catch (_) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
