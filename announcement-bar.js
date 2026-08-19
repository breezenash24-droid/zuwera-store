/* ────────────────────────────────────────────────────────────────────────────
   announcement-bar.js — shared announcement bar for EVERY storefront page.

   The bar used to exist only on home (storefront.js) + product (inline in
   product.html), each with its OWN copy of the logic. This module is the single
   shared implementation for every OTHER page: it injects the #bar + #bar-spacer
   markup if the page doesn't already have it, reads the admin config, and drives
   the bar on all viewports.

   Config: site_settings.announcement_bar =
     { enabled, mode, main, product,                       // legacy (home/product)
       default: { on, text, mode },                        // fallback for any page
       pages:   { <pageKey>: { on, text, mode } } }         // per-page override
   pageKey = filename without ".html" ("/" or index → "home"). Back-compat: legacy
   `main`→home text, `product`→product text, top-level `mode`→default mode.

   Behavior:
     • desktop  = header PUSH-OUT: the bar slides up via transform while the nav
       rises (nav `top`, transitioned in cohesion) + the spacer collapses — the
       header pushes the bar out. Reappears only at the very top.
       Modes: on|scroll|scrolloff|off.
     • mobile/tablet (≤900px) = the bar sits BELOW the nav (via --zw-bar-top) and
       fades on scroll (scroll/scrolloff) — NOT the desktop slide.
     • prefers-reduced-motion → instant.

   The bar and the header hide as ONE strip, never separately: with a scroll
   mode the bar goes first and the header follows, and with mode `on` the bar
   has no rule of its own so the header carries it away. See the handshake in
   apply() and its other half in header-scroll.js.

   Loaded on EVERY storefront page, home and product included — they used to
   ship their own copies of this logic and no longer do.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  // Single shared implementation of the announcement bar for EVERY page. On pages that
  // already ship a #bar in markup (home index.html, product.html) we ADOPT it and keep
  // their inline CSS; on all other pages we inject the bar + its own scoped CSS.

  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
  var REST = 'https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/site_settings?select=value&key=eq.announcement_bar';
  var MOBILE_MQ = '(max-width:900px)';

  // Self-contained CSS (scoped to the injected bar) so the module never depends on or
  // fights the tangled page/cohesion #bar rules. Dark bar so it stays visible on the
  // super-light theme; mobile drops it below the nav via --zw-bar-top (set by JS).
  function injectStyle() {
    if (document.getElementById('zw-announce-css')) return;
    var st = document.createElement('style');
    st.id = 'zw-announce-css';
    st.textContent =
      /* The bar follows the theme now, with its old literals as the
         fallbacks — so a theme that says nothing leaves it exactly as it
         was, and the builder's per-store override still wins over both
         because storefront.js applies that inline. */
      /* The fallback is the PAGE, not a colour. It used to be #09090b, so with
         the bar's own colour switched off the strip was black on every theme —
         while the admin said "off and it follows the page". It followed
         nothing; it was pinned to the value the site happened to ship with.

         --black and --white are the page background and text, so off now means
         what the label always claimed, and on still overrides both. */
      '#bar{background:var(--zw-bar-bg,var(--black,#09090b));color:var(--zw-bar-fg,var(--white,#F0EEE9));border-bottom:1px solid var(--c10);' +
      'padding:.45rem 2rem;display:flex;align-items:center;justify-content:center;gap:1.5rem;' +
      "font-family:var(--fm,var(--fb,'Barlow Condensed',sans-serif));font-size:.6rem;letter-spacing:.22em;text-transform:uppercase;" +
      'position:fixed;top:0;left:0;right:0;z-index:230;transition:transform .3s cubic-bezier(.32,.72,0,1),opacity .2s ease;will-change:transform}' +
      '#bar .bar-sep{opacity:.25;font-size:0;line-height:1}' +
      "#bar .bar-sep::before{content:'\\2726';font-size:.6rem}" +
      '@media(max-width:900px){#bar{top:var(--zw-bar-top,58px)!important;padding:.4rem 1rem!important;gap:0!important;' +
      'letter-spacing:.1em!important;font-size:.55rem!important;white-space:nowrap;overflow:hidden}' +
      '#bar .bar-sep{display:none!important}' +
      '#bar #announcementText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}}' +
      '@media(prefers-reduced-motion:reduce){#bar{transition:none!important}}';
    (document.head || document.documentElement).appendChild(st);
  }

  function pageKey() {
    var p = (location.pathname || '').replace(/^\/+/, '').replace(/\.html$/i, '').toLowerCase();
    if (!p || p === 'index') return 'home';
    return p.split('/')[0];
  }
  function isMobile() { return window.matchMedia && window.matchMedia(MOBILE_MQ).matches; }
  function reduceMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function getNav() { return document.querySelector('nav#nav, header.nav, nav.nav, nav.zw-nav, header.co-header'); }

  // Inject #bar + #bar-spacer as the first children of <body> (the bar is fixed, so
  // the spacer reserves its height in flow → content never jumps).
  function ensureBar() {
    var bar = document.getElementById('bar');
    if (bar) return bar;   // adopt the page's own bar (home/product keep their inline CSS)
    injectStyle();         // only inject our scoped CSS when WE create the bar
    var spacer = document.createElement('div');
    spacer.id = 'bar-spacer';
    spacer.setAttribute('aria-hidden', 'true');
    spacer.style.cssText = 'height:0;flex-shrink:0;pointer-events:none';
    bar = document.createElement('div');
    bar.id = 'bar';
    bar.style.display = 'none';
    bar.innerHTML = '<span class="bar-sep" aria-hidden="true"></span><span id="announcementText"></span><span class="bar-sep" aria-hidden="true"></span>';
    document.body.insertBefore(spacer, document.body.firstChild);
    document.body.insertBefore(bar, document.body.firstChild);
    return bar;
  }

  // Position the fixed bar + offset the nav so the bar sits ABOVE the header.
  function layout(barEl, navEl, isVisible) {
    var spacerEl = document.getElementById('bar-spacer');
    if (isMobile()) {
      // Mobile: bar drops BELOW the nav — measure the real nav height into --zw-bar-top.
      if (navEl) navEl.style.top = '';
      // Mobile puts the bar BELOW the nav, so the nav is at the top and has
      // nothing to be lifted past.
      if (navEl) navEl.style.removeProperty('--zw-nav-lift');
      if (spacerEl) spacerEl.style.height = '0';
      if (navEl) {
        var navH = Math.round(navEl.getBoundingClientRect().height);
        if (navH) document.documentElement.style.setProperty('--zw-bar-top', navH + 'px');
      }
    } else {
      document.documentElement.style.removeProperty('--zw-bar-top');
      var barH = (barEl && isVisible) ? barEl.offsetHeight : 0;
      // Constant 1px overlap through the whole slide (hidden rests at -1, not 0) → no
      // hairline seam between bar + header. Matches the home/product handlers. The
      // spacer is barH-1 too: for an IN-FLOW sticky nav that's what sets its rest
      // position, so it gets the same ~1px overlap as a fixed nav (not a thin 0.4px).
      if (navEl) navEl.style.top = (barH ? barH - 1 : -1) + 'px';
      // How far down the viewport the header is sitting. The hidden-header
      // transform adds this to its own -110% so that leaving is one composited
      // move rather than a transform racing an animated `top`.
      if (navEl) navEl.style.setProperty('--zw-nav-lift', (barH ? barH - 1 : 0) + 'px');
      if (spacerEl) spacerEl.style.height = isVisible ? (barH - 1) + 'px' : '0';
    }
    // Builder preview (homepage): the header height just changed — re-pad the builder
    // layout's top section so it stays clear of the header. No-op outside the builder.
    try { if (window.__zwApplyTopOffset) window.__zwApplyTopOffset(); } catch (_) {}
  }

  var _scrollHandler = null;
  function teardownScroll() {
    if (_scrollHandler) { window.removeEventListener('scroll', _scrollHandler); _scrollHandler = null; }
  }

  function apply(cfg) {
    var barEl = ensureBar();
    var navEl = getNav();
    var textEl = document.getElementById('announcementText');
    var key = pageKey();
    cfg = cfg || {};
    var pages = cfg.pages || {};
    var def = cfg.default || {};

    // Remember the markup's own placeholder (home/product ship one in their #bar) so an
    // empty admin message falls back to it instead of blanking those pages.
    if (barEl.dataset.zwDefaultText == null) {
      barEl.dataset.zwDefaultText = ((textEl ? (textEl.textContent || '') : '')).trim();
    }
    var markupDefault = barEl.dataset.zwDefaultText || '';

    // WHERE — one model: pages.<key> (bool or {on}) for EVERY page incl home/product.
    // Back-compat: no pages entry → home/product use `enabled`, others use default.on.
    var pv = pages[key];
    var on;
    if (pv !== undefined) { on = (pv === true) || !!(pv && pv.on); }
    else if (key === 'home' || key === 'product') { on = (cfg.enabled !== false); }
    else { on = !!def.on; }

    // TEXT — one shared message. Back-compat: main/product/default.text, then markup.
    var text = String(
      cfg.message ||
      (key === 'product' ? cfg.product : key === 'home' ? cfg.main : def.text) ||
      cfg.main || ''
    ).trim();
    if (!text && (key === 'home' || key === 'product')) text = markupDefault;

    var mode = String(cfg.mode || 'on').trim().toLowerCase();
    var link = String(cfg.link || '').trim();

    teardownScroll();
    // A previous apply() left a closure pointing at the bar as it was then.
    // Drop it before deciding again, so the header can never drive a stale one.
    window.zwBarSetHidden = null;
    barEl.style.transform = '';
    barEl.style.maxHeight = '';
    barEl.style.opacity = '1';
    barEl.style.pointerEvents = '';
    if (navEl) { navEl.style.transform = ''; navEl.style.removeProperty('z-index'); }
    if (textEl) {
      textEl.textContent = text;
      /* Builder preview only: name the field behind the message so editing it
         on the canvas writes announcement_bar.message rather than being matched
         by its text. The bar is chrome -- it belongs to no page section -- so
         without this it would fall through to a page-copy override and be
         stored twice, which is the fault this codebase already had to remove
         from the bar once. */
      if (window.__ZW_BUILDER_PREVIEW__) {
        textEl.setAttribute('data-zw-field', 'bar.message');
        textEl.setAttribute('data-zw-field-label', 'the announcement bar');
      }
    }

    // Clickable bar (optional link). The whole bar acts as a link; keyboard-accessible.
    barEl.onclick = null; barEl.onkeydown = null;
    if (link) {
      barEl.style.cursor = 'pointer';
      barEl.setAttribute('role', 'link'); barEl.setAttribute('tabindex', '0');
      barEl.setAttribute('aria-label', text + ' — open link');
      barEl.onclick = function () { window.location.href = link; };
      barEl.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.location.href = link; } };
    } else {
      barEl.style.cursor = '';
      barEl.removeAttribute('role'); barEl.removeAttribute('tabindex'); barEl.removeAttribute('aria-label');
    }

    if (!on || !text || mode === 'off') {
      // Bar is fully OFF on this page — leave the nav at its NATURAL position. (layout's
      // hidden branch rests the nav at top:-1, which is only meant for the transient
      // scroll-hide overlap; applying it here nudged the header up 1px on every bar-off
      // page, detaching its border from the content.)
      barEl.style.display = 'none';
      if (navEl) { navEl.style.top = ''; navEl.style.removeProperty('z-index'); }
      var _offSp = document.getElementById('bar-spacer'); if (_offSp) _offSp.style.height = '0';
      document.documentElement.style.removeProperty('--zw-bar-top');
      // Nothing here for the header to carry. Retract the handshake rather
      // than leaving header-scroll.js reading the answer for a bar that is no
      // longer on the page — apply() re-runs on preview and on resize.
      delete barEl.dataset.zwBarHide;
      window.zwBarSetHidden = null;
      return;
    }

    barEl.style.display = 'flex';
    layout(barEl, navEl, true);
    // Smooth the spacer AFTER first paint so the initial appearance doesn't animate.
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      var sp = document.getElementById('bar-spacer');
      var dur = reduceMotion() ? '0s' : '0.3s';
      if (sp) sp.style.transition = 'height ' + dur + ' cubic-bezier(.32,.72,0,1)';
    }); });

    /* ── Which of the two moves first ──────────────────────────────────────
       The bar and the header are one strip of chrome, driven by two files.
       This one owns the bar, header-scroll.js owns the nav, and neither can
       move without saying so — or the page shows a promo bar floating alone
       above nothing, or a header that never hides at all.

       So the bar publishes which of the two goes first, on the element:

         'self'    the bar hides on its own scroll rule (scroll / scrolloff).
                   The header waits for it, and only begins its own auto-hide
                   once the bar has actually gone.
         'chrome'  the bar is "Always visible": it has no scroll rule of its
                   own, so it moves only when the header does.

       The second case is the fault this fixes. Waiting for a bar that had no
       intention of leaving is a deadlock, and it is the shipping default —
       so "Auto-hide" in Settings → Header Scroll Behavior did nothing on
       every page the bar was turned on for, which is the home page and the
       product page. Admins were choosing between two behaviours where only
       one of them existed.

       On the element rather than in a variable because header-scroll.js runs
       BEFORE this file — both deferred, it is listed first on every page —
       and reads this at scroll time. Live DOM state cannot be read too early;
       a load-time flag can. */
    var hidesItself = (mode === 'scroll' || mode === 'scrolloff');
    barEl.dataset.zwBarHide = hidesItself ? 'self' : 'chrome';

    var reduce = reduceMotion();

    if (isMobile()) {
      // Mobile/tablet: fade (the bar is CSS-locked in place; no desktop slide).
      barEl.style.transition = 'opacity .3s ease';
      var mLast = window.scrollY, mHidden = false, mAt = Date.now() + 150;
      var mSet = function (h) { barEl.style.opacity = h ? '0' : '1'; barEl.style.pointerEvents = h ? 'none' : ''; };
      mSet(false);
      if (!hidesItself) {
        /* The header's handle. A fade, not the desktop slide: on a phone the
           bar sits BELOW the nav, so it has a nav's height of travel before it
           would clear the top and nothing to slide behind. .3s against the
           header's .35s means it finishes a touch first, which is the safe
           order — the bar is never the thing left behind. */
        window.zwBarSetHidden = function (h) {
          h = !!h;
          if (h === mHidden) return;
          mHidden = h; mSet(h);
        };
        // The header may already be hidden by the time this config lands — a
        // fast scroll during load. Match it rather than arriving alone above a
        // header that is not there.
        if (navEl && navEl.classList.contains('zw-nav-hidden')) { mHidden = true; mSet(true); }
        return;   // static: it leaves only when the header does
      }
      _scrollHandler = function () {
        var y = window.scrollY;
        if (document.body.dataset.scrollLocked || window.__zwScrollLocking || window.__zwScrollRestoring) { mLast = y; return; }
        if (Date.now() < mAt) { mLast = y; return; }
        if (mode !== 'scrolloff' && y <= 16) { if (mHidden) { mHidden = false; mSet(false); } }
        else if (y > 40 && y > mLast + 6) { if (!mHidden) { mHidden = true; mSet(true); if (mode === 'scrolloff') teardownScroll(); } }
        mLast = y;
      };
      window.addEventListener('scroll', _scrollHandler, { passive: true });
      return;
    }

    // Desktop: the header RISES and COVERS the bar — no slide-out, so no empty space can
    // ever show behind it. The bar stays put; the nav is lifted ABOVE the bar (#bar is
    // z-index 230) during the transition so it visibly covers the bar as it rises, and the
    // bar is hidden only once fully covered. What the header does AFTER (stay pinned vs
    // auto-hide) is header-scroll.js — admin-controlled (Settings → Header Scroll Behavior;
    // set "Always visible" to pin it like Nike).
    barEl.style.transition = 'none';
    barEl.style.transform = '';
    barEl.style.willChange = '';
    var last = window.scrollY, hidden = false, at = Date.now() + 150, hideTimer = null;
    var sync = function (h) {
      clearTimeout(hideTimer);
      if (h) {
        if (navEl) navEl.style.setProperty('z-index', '231', 'important');   // nav covers the bar
        layout(barEl, navEl, false);   // nav.top → -1: header rises OVER the stationary bar
        hideTimer = setTimeout(function () { barEl.style.display = 'none'; try { if (window.__zwUpdateHeaderHeight) window.__zwUpdateHeaderHeight(); } catch (_) {} }, reduce ? 0 : 340);
      } else {
        barEl.style.display = 'flex';
        layout(barEl, navEl, true);    // nav.top → barH-1: header lowers, revealing the bar
        // Drop the nav back below the bar only AFTER it settles, so at rest the bar is on
        // top again (keeps the mega-menu backdrop dimming the page, not the bar).
        hideTimer = setTimeout(function () { if (navEl) navEl.style.removeProperty('z-index'); }, reduce ? 0 : 340);
      }
    };
    /* ── Carried by the header ─────────────────────────────────────────
       A bar the header takes with it needs a different exit from the one
       above, and this is why: the bar's own hide is "the nav RISES and
       COVERS the strip, then the strip is removed" — which only reads
       right while the nav is still on screen doing the covering. When the
       header is itself sliding away there is nothing covering anything.
       The nav left, the bar stayed exactly where it was for another third
       of a second, and then blinked out: the header leaving before the bar.

       So a carried bar SLIDES, on the header's curve and duration, and is
       never display:none'd — the spacer is untouched either way, nothing
       here needs the element gone, and a transform that is still there is
       one that can animate straight back on the way up.

       translateY(-100%) is 26px of travel where the nav's is nearer 100,
       so the bar clears the top edge a hair AFTER the header rather than
       before it — the safe side of simultaneous, and the reason not to
       spend anything measuring an exact rigid offset.

       Nothing here touches the nav. It used to drop the nav to top:-1 so that
       a header sitting a bar's height down the page would clear — but `top` is
       a layout property, so that ran the layout on every frame of the slide,
       against a composited transform, on a different duration and curve. Two
       motions of different lengths pulling one element is what made the header
       read as slow and choppy. The offset lives in the hidden-header transform
       now, as --zw-nav-lift, written by layout() above. */
    var carry = function (h, instant) {
      clearTimeout(hideTimer);
      barEl.style.display = 'flex';
      barEl.style.transition = (instant || reduce) ? 'none'
        : 'transform .35s var(--zw-ease-standard, cubic-bezier(.22,.61,.36,1))';
      barEl.style.transform = h ? 'translateY(-100%)' : '';
      barEl.style.willChange = h ? 'transform' : '';
    };

    if (!hidesItself) {
      // The header's handle on the bar. Idempotent: the header calls show()
      // on every tick near the top, not only on the frame it changes.
      window.zwBarSetHidden = function (h) {
        h = !!h;
        if (h === hidden) return;
        hidden = h; carry(h);
      };
      // The header may already be hidden by the time this config lands — a
      // fast scroll during load. Match it, without sliding in from nowhere.
      if (navEl && navEl.classList.contains('zw-nav-hidden')) { hidden = true; carry(true, true); }
      return;   // static: it leaves only when the header does
    }
    _scrollHandler = function () {
      var y = window.scrollY;
      if (document.body.dataset.scrollLocked || window.__zwScrollLocking || window.__zwScrollRestoring) { last = y; return; }
      if (Date.now() < at) { last = y; return; }
      if (mode !== 'scrolloff' && y <= 16) { if (hidden) { hidden = false; sync(false); } }
      else if (y > 40 && y > last + 6) { if (!hidden) { hidden = true; sync(true); if (mode === 'scrolloff') teardownScroll(); } }
      last = y;
    };
    window.addEventListener('scroll', _scrollHandler, { passive: true });
  }

  // Re-measure the mobile bar-top on resize / orientation change. When the viewport
  // CROSSES the 900px breakpoint, fully re-apply so the desktop-slide vs mobile-fade
  // scroll handler (and the nav offset) is swapped cleanly instead of stranded.
  var _wasMobile = isMobile();
  window.addEventListener('resize', function () {
    if (!window.__zwBarCfg) return;
    var nowMobile = isMobile();
    if (nowMobile !== _wasMobile) { _wasMobile = nowMobile; apply(window.__zwBarCfg); return; }
    var navEl = getNav();
    if (nowMobile) { if (navEl) { var h = Math.round(navEl.getBoundingClientRect().height); if (h) document.documentElement.style.setProperty('--zw-bar-top', h + 'px'); } }
    else { document.documentElement.style.removeProperty('--zw-bar-top'); }
  }, { passive: true });

  /* Held in a preview until the draft has answered — see ZWPreviewHold. The bar
     is the most conspicuous of these: it is one line of text at the very top,
     so the published message being replaced by the draft one is the first thing
     anyone notices about a canvas that loads the old page first. */
  var gate = (window.ZWPreviewHold || function (f) {
    return { preview: false, published: f, draft: function (v) { if (v != null) f(v); } };
  })(function (cfg) { window.__zwBarCfg = cfg; apply(cfg); });

  function boot() {
    /* A ?zwpreview= link resolves to the DRAFT settings. Taking the bar from
       there is what makes "Preview live" show the message you saved but have not
       published -- otherwise the draft sections rendered around a published bar,
       and the one button meant to show unpublished work was the one place this
       edit never appeared. Last word, so it beats the fetch below whenever it
       arrives. */
    if (window.__zwPreviewReady && window.__zwPreviewReady.then) {
      window.__zwPreviewReady.then(function (pv) {
        gate.draft(pv ? (pv.announcement_bar || null) : null);
      }).catch(function () { gate.draft(null); });
    }
    // Cache-first (instant), then refresh from site_settings. Both go through
    // the gate, because the CACHE is the one that arrives first — skipping only
    // the fetch would leave the preview showing the published bar anyway.
    try { var c = localStorage.getItem('zw_announce_cfg'); if (c) gate.published(JSON.parse(c)); } catch (_) {}
    fetch(REST, { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        if (!rows || !rows[0]) return;
        var cfg = rows[0].value;
        if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch (_) { return; } }
        if (!cfg || typeof cfg !== 'object') return;
        // Cached either way: the published value is still what the NEXT normal
        // page load should paint from, preview or not.
        try { localStorage.setItem('zw_announce_cfg', JSON.stringify(cfg)); } catch (_) {}
        gate.published(cfg);
      })
      .catch(function () {});
  }

  /* Draft copy for the bar arrives from the builder over postMessage, for the
     same reason the nav's does: announcement_bar_draft is not in the
     public-read policy, so unpublished promo copy is not fetchable by anyone
     who reads this file for the key name. */
  if (window.__ZW_BUILDER_PREVIEW__) {
    window.addEventListener('message', function (e) {
      if (e.origin !== location.origin) return;
      var d = e.data;
      if (!d || d.type !== 'ZW_BAR_PREVIEW' || !d.value || typeof d.value !== 'object') return;
      try { gate.draft(d.value); } catch (_) {}
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
