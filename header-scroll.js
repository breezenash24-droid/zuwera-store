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

   The header does not move alone: the announcement bar sits directly above it,
   and the two hide as one strip. Which of them goes first is announced by
   announcement-bar.js on the #bar element — see barPolicy() below.
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
  // (account/returns/about), <header class="co-header"> (checkout). Match them all
  // (but never the in-modal mobile menu nav).
  function getNav() { return document.querySelector('nav#nav, header.nav, nav.nav, nav.zw-nav, header.co-header'); }

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

  // Read scroll position from whichever element actually scrolls. Pages that set
  // overflow-x on <body> can make <body> the scroll container (window.scrollY stays
  // 0), so fall back to documentElement/body scrollTop.
  function scrollY() {
    return window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
  }

  /* The announcement bar (#bar) sits directly above the header, and the two
     are one strip of chrome: whichever moves, the other cannot be left
     behind. announcement-bar.js publishes which of them moves first, on the
     element itself — this file runs BEFORE it (both deferred, this one is
     listed first on every page), so a load-time flag would be read before it
     was written. Live DOM state at scroll time cannot be read too early, and
     resolves to "no bar" on every page without one.

       'self'   the bar hides on its own scroll rule. Wait for it: a header
                that goes first leaves a promo strip floating above nothing.
       'chrome' the bar is "Always visible" and will never hide by itself.
                Waiting for it was waiting forever — this is what made an
                auto-hide header sit pinned on the home and product pages,
                where the bar is on. Take the bar with us instead.

     Policy is separate from visibility on purpose. Once the header has
     carried a static bar away the bar is not visible, and asking "is it
     showing" would then say no and strand it there on the way back up. */
  function barPolicy() {
    var bar = document.getElementById('bar');
    if (!bar || !bar.dataset.zwBarHide) return '';
    return bar.dataset.zwBarHide === 'self' ? 'self' : 'chrome';
  }
  function barIsShowing() {
    var bar = document.getElementById('bar');
    if (!bar) return false;
    var cs = window.getComputedStyle(bar);
    if (cs.display === 'none') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    return true;
  }
  function setBar(hidden) {
    if (barPolicy() !== 'chrome') return;   // the bar owns its own timing
    try { if (typeof window.zwBarSetHidden === 'function') window.zwBarSetHidden(hidden); } catch (_) {}
  }

  function init() {
    var nav = getNav();
    if (!nav) return;

    var mode = resolveMode(cachedCfg());
    var lastY = scrollY();
    var ticking = false;

    /* prefers-reduced-motion: the stylesheet already neutralises the hidden
       transform, so the class was being toggled onto a header that never
       moved. That was harmless while nothing else read it — but the bar now
       follows this decision, and drop001 mirrors the class onto <html> to
       reposition its filter bar. Both would be acting on a header that is
       still sitting there. Not hiding at all is what a reduced-motion
       visitor already sees; now the rest of the page agrees with it. */
    var reduce = false;
    try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) {}

    function show() { nav.classList.remove(HIDDEN); setBar(false); }
    function hide() { nav.classList.add(HIDDEN); setBar(true); }

    // Let other scripts pop the header back into view — e.g. add-to-bag, so the
    // shopper sees the updated bag icon even if they'd scrolled the header away.
    // Resets lastY so a scroll jitter doesn't immediately re-hide it. Returns true
    // if the header WAS hidden, so callers can wait for the ~0.35s slide-in before
    // playing their own animation.
    window.zwRevealHeader = function () {
      var wasHidden = nav.classList.contains(HIDDEN);
      show();
      lastY = scrollY();
      return wasHidden;
    };

    // Shared add-to-bag acknowledgment for every page. The homepage/product page
    // define their own (targeting #cart-btn); this guarded fallback covers the
    // .zw-hdr-bag header used by the collection, account and bag pages so the
    // animation fires everywhere you can add to bag. Reveals the header if it was
    // scrolled away, then dips the bag icon + pops the count badge (CSS in
    // storefront-cohesion.css; prefers-reduced-motion honored there).
    if (typeof window.animateAddToBag !== 'function') {
      window.animateAddToBag = function () {
        var bag = document.querySelector('#cart-btn, .zw-hdr-bag');
        if (!bag) return;
        var pulse = function () {
          bag.classList.remove('bag-dip'); void bag.offsetWidth; bag.classList.add('bag-dip');
          var c = bag.querySelector('.cc, .cart-count, .zw-hdr-bag-count');
          if (c) { c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop'); }
          window.setTimeout(function () { bag.classList.remove('bag-dip'); }, 500);
        };
        var wasHidden = (typeof window.zwRevealHeader === 'function') && window.zwRevealHeader();
        if (wasHidden) window.setTimeout(pulse, 380); else pulse();
      };
    }

    function update() {
      ticking = false;
      if (mode !== 'auto-hide' || reduce) { show(); return; }
      // Never hide while a modal / scroll-lock is active (modal-lock.js sets these).
      if (document.body.dataset.scrollLocked || window.__zwScrollLocking || window.__zwScrollRestoring) return;
      var y = scrollY();
      if (y <= REVEAL_AT) { show(); lastY = y; return; }
      // Follow a bar that hides itself: it goes first, and the header only
      // starts once it has. A bar that does NOT hide itself is no longer a
      // reason to stay — show()/hide() take it along.
      if (barPolicy() === 'self' && barIsShowing()) { show(); lastY = y; return; }
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

    // Capture phase + document listener so a scroll on a nested scroll container
    // (e.g. <body> when a page sets overflow-x) still reaches us.
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
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

/* ── Auto-reload on new deploy ────────────────────────────────────────────────
   /version.json carries a build id that bump-cache-version.js regenerates on every
   deploy (any JS/CSS change) and serves no-store. This compares it against the value
   seen at page load; when a newer build ships it reloads the tab so a returning /
   long-open tab silently picks up the latest version — the "loads the correct version
   every time" guarantee for tabs that were already open before the deploy.

   It reloads ONLY at a safe moment — never with a modal/drawer open, mid-checkout, or
   while the user is typing — so it can't interrupt a purchase or lose form input. It
   re-checks when the tab regains focus (the common "left it open" case) and every 5
   min. Absent version.json (older deploys) → it just no-ops. Loaded on every storefront
   page via header-scroll.js; this IIFE is independent of the header logic above. */
(function () {
  var STORE = '__zw_reloaded_to';       // build id we've already reloaded to (sessionStorage)
  var loaded = null;                     // build id at page load (baseline)
  var pending = null;                    // build id of a detected-but-not-yet-applied deploy
  var reloading = false;
  function unsafe() {
    try {
      if (document.body && document.body.hasAttribute('data-scroll-locked')) return true; // modal open
      if (/checkout/.test(location.pathname)) return true;                                 // mid-purchase
      var ae = document.activeElement;
      if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return true;                 // typing
      if (document.querySelector('.zwf-bag.open, .zwf-search.open, .modal.open')) return true; // drawer/modal
    } catch (_) {}
    return false;
  }
  function doReload(build) {
    if (reloading) return;
    // Never reload twice for the same build — survives a bfcache restore, a double
    // visibilitychange/focus fire, or product.html's own reload path. This is what
    // makes it loop-PROOF: a reload can only ever happen for a build we haven't
    // recorded yet.
    try { if (sessionStorage.getItem(STORE) === build) return; sessionStorage.setItem(STORE, build); } catch (_) {}
    reloading = true;
    try { location.reload(); } catch (_) { reloading = false; }
  }
  function maybeReload() { if (pending && !unsafe()) doReload(pending); }
  function check() {
    fetch('/version.json?_=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.build) return;
        if (loaded === null) { loaded = j.build; return; }        // establish baseline
        if (j.build !== loaded) { pending = j.build; maybeReload(); } // new deploy detected
      })
      .catch(function () {});
  }
  check();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { check(); maybeReload(); }
  });
  window.addEventListener('focus', maybeReload);
  setInterval(check, 5 * 60 * 1000);
})();
