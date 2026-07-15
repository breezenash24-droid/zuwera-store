/**
 * storefront-features.js — opt-in customer-facing storefront features, each gated
 * behind a feature flag (Admin → Feature Flags). SHIPS DARK: every flag defaults
 * OFF, so nothing here appears on the site until you enable it in the admin.
 *
 * Self-contained by design: it injects its own styles + UI and reuses the site's
 * global helpers where present (window.productHref). It does NOT modify
 * storefront.js, so it can't regress the existing render paths.
 *
 * Flags implemented here:
 *   feature_search           → header search launcher + instant results overlay
 *   feature_recently_viewed  → "recently viewed" row (home + product pages)
 *   feature_recommendations  → "you may also like" row on product pages
 *
 * The product page (product.html) announces its product via a
 *   window.dispatchEvent(new CustomEvent('zw-product-loaded', { detail: product }))
 * and window.__zwCurrentProduct — both optional; this module degrades gracefully.
 */
(function () {
  'use strict';

  var SUPA = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

  /* ───────────────────────── shared helpers ───────────────────────── */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function nameOf(p) { return p.title || p.name || ''; }
  function typeOf(p) { return p.subtitle || p.category || ''; }
  function imgOf(p) {
    var u = p.image_url || p.image || (Array.isArray(p.images) && p.images[0]) || '';
    if (u && typeof window.optimizeImage === 'function') { try { u = window.optimizeImage(u, 600); } catch (_) {} }
    return u;
  }
  function priceOf(p) {
    var v = p.current_price != null ? p.current_price : (p.price != null ? p.price : p.msrp);
    return Number(v) || 0;
  }
  function money(v) {
    v = Number(v) || 0;
    return '$' + (Number.isInteger(v) ? v : v.toFixed(2));
  }
  function isLive(p) { return p && p.status !== 'Legacy' && p.status !== 'Archived'; }
  function hrefOf(p) {
    if (typeof window.productHref === 'function') { try { return window.productHref(p); } catch (_) {} }
    return 'product.html?id=' + encodeURIComponent(p.id || '');
  }
  function reduced() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  }
  function debounce(fn, ms) {
    var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); };
  }

  // Lightweight product card — visually mirrors .pcard but stands alone (no
  // quick-add / swatch / review machinery, which live inside storefront.js).
  function card(p) {
    var img = imgOf(p);
    return '<a class="zwf-card" href="' + esc(hrefOf(p)) + '">'
      + '<div class="zwf-card-img">'
      + (img ? '<img src="' + esc(img) + '" alt="' + esc(nameOf(p)) + '" loading="lazy" decoding="async">' : '')
      + '</div>'
      + '<div class="zwf-card-info">'
      + '<p class="zwf-card-name">' + esc(nameOf(p)) + '</p>'
      + (typeOf(p) ? '<p class="zwf-card-type">' + esc(typeOf(p)) + '</p>' : '')
      + '<p class="zwf-card-price">' + money(priceOf(p)) + '</p>'
      + '</div></a>';
  }

  // Same card, but using the site's REAL product-card text classes (.pcard-name /
  // .pcard-cat / .pcard-price) so the fonts/sizes/colours match the homepage grid
  // EXACTLY (including light-mode overrides). Used by the on-page strips
  // (recently-viewed, recommendations) — NOT the search overlay, whose cream panel
  // needs its own dark text.
  function timeCaption(p) {
    var ms = Number(p && p.ms) || 0;
    if (ms < 3000) return '';
    var s = Math.round(ms / 1000);
    var label = s < 60 ? (s + 's') : (Math.round(s / 60) + ' min');
    return '<p class="zwf-rv-time">Viewed for ' + label + '</p>';
  }
  function pcardCard(p, showTime) {
    var img = imgOf(p);
    return '<a class="zwf-card zwf-card--pcard" href="' + esc(hrefOf(p)) + '">'
      + '<div class="zwf-card-img">'
      + (img ? '<img src="' + esc(img) + '" alt="' + esc(nameOf(p)) + '" loading="lazy" decoding="async">' : '')
      + '</div>'
      + '<div class="zwf-card-info">'
      + '<p class="zwf-pc-name">' + esc(nameOf(p)) + '</p>'
      + (typeOf(p) ? '<p class="zwf-pc-cat">' + esc(typeOf(p)) + '</p>' : '')
      + '<p class="zwf-pc-price">' + money(priceOf(p)) + '</p>'
      + (showTime ? timeCaption(p) : '')
      + '</div></a>';
  }

  // Catalog: fetched once, memoized. Falls back to the homepage's session cache.
  var _catalog = null, _catalogPromise = null;
  function catalog() {
    if (_catalog) return Promise.resolve(_catalog);
    if (_catalogPromise) return _catalogPromise;
    _catalogPromise = fetch(SUPA + '/rest/v1/products?select=id,title,subtitle,gender,colorway,material_composition,category,tags,current_price,member_price,msrp,sku,image_url,status,sort_order,low_stock_threshold,created_at&order=sort_order.asc.nullslast', {
      headers: { apikey: ANON, Authorization: 'Bearer ' + ANON }
    })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) { _catalog = (rows || []).filter(isLive); return _catalog; })
      .catch(function () {
        try {
          var c = JSON.parse(sessionStorage.getItem('zw_home_products') || '[]');
          _catalog = (c || []).filter(isLive);
        } catch (_) { _catalog = []; }
        return _catalog;
      });
    return _catalogPromise;
  }

  // Insert a section just before the page footer (a safe, non-disruptive spot).
  function insertBeforeFooter(node) {
    var foot = document.querySelector('footer, .footer, #footer');
    if (foot && foot.parentNode) { foot.parentNode.insertBefore(node, foot); return true; }
    var main = document.querySelector('main') || document.body;
    if (main) { main.appendChild(node); return true; }
    return false;
  }

  function strip(title, html) {
    var sec = document.createElement('section');
    sec.className = 'zwf-strip';
    sec.innerHTML = '<div class="zwf-strip-inner">'
      + '<h2 class="zwf-strip-title">' + esc(title) + '</h2>'
      + '<div class="zwf-row">' + html + '</div></div>';
    return sec;
  }

  /* ───────────────────────── styles (injected once) ───────────────────────── */

  var _styled = false;
  function ensureStyles() {
    if (_styled) return; _styled = true;
    var css = [
      /* shared card + strip — inherit page theme (color/background from page) */
      '.zwf-strip{padding:2.5rem 0;color:inherit}',
      '.zwf-strip-inner{max-width:1400px;margin:0 auto;padding:0 clamp(1rem,4vw,2.5rem)}',
      '.zwf-strip-title{font-family:var(--fw,inherit);font-weight:900;font-style:italic;text-transform:uppercase;letter-spacing:.06em;font-size:clamp(1.1rem,3vw,1.6rem);margin:0 0 1.2rem}',
      '.zwf-row{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(150px,1fr);gap:1rem;overflow-x:auto;scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch;padding-bottom:.5rem;scrollbar-width:thin}',
      '@media(min-width:900px){.zwf-row{grid-auto-columns:minmax(200px,1fr)}}',
      '.zwf-card{scroll-snap-align:start;text-decoration:none;color:inherit;display:block}',
      '.zwf-card-img{position:relative;aspect-ratio:3/4;background:rgba(128,128,128,.10);overflow:hidden;border-radius:2px}',
      '.zwf-card-img img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .5s cubic-bezier(.2,.7,.2,1)}',
      '.zwf-card:hover .zwf-card-img img{transform:scale(1.04)}',
      '.zwf-card-info{padding:.7rem .1rem 0}',
      '.zwf-card-name{font-family:var(--fw,inherit);font-weight:700;font-size:.9rem;letter-spacing:.02em;margin:0 0 .15rem;line-height:1.2}',
      '.zwf-card-type{font-family:var(--fm,var(--fb,inherit));font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;opacity:.55;margin:0 0 .3rem}',
      '.zwf-card-price{font-family:var(--fb,inherit);font-size:.85rem;opacity:.85;margin:0}',
      /* on-page strip cards (recently-viewed / recommendations) — match the real
         .pcard text EXACTLY (font/size/weight/style/tracking); colour adapts to the
         page theme via inherit + opacity so it works on light and dark. */
      '.zwf-pc-name{font-family:var(--fw,inherit);font-weight:700;font-style:italic;font-size:1.4rem;letter-spacing:.03em;line-height:1.1;margin:0 0 .3rem;color:inherit}',
      '.zwf-pc-cat{font-family:var(--fm,var(--fb,inherit));font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;font-weight:500;opacity:.6;margin:0 0 .35rem}',
      '.zwf-pc-price{font-family:var(--fw,inherit);font-size:1.05rem;font-weight:700;letter-spacing:.01em;opacity:.95;margin:0}',
      '.zwf-rv-time{font-family:var(--fm,var(--fb,inherit));font-size:.55rem;letter-spacing:.1em;text-transform:uppercase;opacity:.45;margin:.35rem 0 0}',
      '.zwf-strip{scroll-margin-top:96px}',
      '@media(prefers-reduced-motion:reduce){.zwf-card-img img{transition:none}.zwf-card:hover .zwf-card-img img{transform:none}}',

      /* search launcher — inherits .nbtn look from the nav */
      '.zwf-search-btn{background:none;border:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:.35rem}',
      '.zwf-search-btn svg{width:20px;height:20px;display:block}',

      /* search overlay — deliberate cream "spotlight" panel that reads on both themes */
      /* No dim, no blur: a full-viewport backdrop-filter repaints every frame and
         is the main thing that makes this animation stutter. The overlay is just
         an invisible click-catcher, clipped so the panel can hide above it. It
         doesn't fade either — one moving thing (the panel) reads smoother than a
         slide and a cross-fade fighting each other. */
      '.zwf-search{position:fixed;inset:0;z-index:990;display:flex;flex-direction:column;background:transparent;pointer-events:none;overflow:hidden}',
      '.zwf-search.open{pointer-events:auto}',
      /* translate3d + will-change keeps this on the compositor — no layout or
         paint per frame, so it stays at 60fps. */
      '.zwf-search-panel{background:var(--ink,#09090b);color:var(--paper,#f4f1eb);width:100%;max-height:min(72vh,560px);display:flex;flex-direction:column;transform:translate3d(0,-101%,0);will-change:transform;transition:transform .44s cubic-bezier(.32,.72,0,1);box-shadow:0 22px 48px rgba(0,0,0,.22)}',
      '.zwf-search.open .zwf-search-panel{transform:translate3d(0,0,0)}',
      /* ── bag panel ── shares the search panel's mechanics: no dim, no blur,
         compositor-only slide, clipped so it hides above. */
      '.zwf-bag{position:fixed;inset:0;z-index:989;display:flex;flex-direction:column;background:transparent;pointer-events:none;overflow:hidden}',
      '.zwf-bag.open{pointer-events:auto}',
      '.zwf-bag-panel{background:var(--zw-page,#fff);color:var(--zw-ink,#09090b);width:100%;max-height:min(76vh,620px);display:flex;flex-direction:column;overflow:hidden;transform:translate3d(0,-101%,0);will-change:transform;transition:transform .44s cubic-bezier(.32,.72,0,1);box-shadow:0 22px 48px rgba(0,0,0,.18)}',
      '.zwf-bag.open .zwf-bag-panel{transform:translate3d(0,0,0)}',
      '.zwf-bag-inner{overflow-y:auto;padding:clamp(1.2rem,3vw,2rem) clamp(1rem,4vw,2.5rem) clamp(1.6rem,4vw,2.4rem);max-width:1100px;margin:0 auto;width:100%}',
      '.zwf-bag-hd{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1.2rem}',
      '.zwf-bag-hd h2{font-family:var(--fw,inherit);font-weight:900;font-style:italic;text-transform:uppercase;letter-spacing:.03em;font-size:clamp(1.3rem,3vw,1.9rem);margin:0}',
      '.zwf-bag-review{border:none;border-radius:100px;background:var(--zw-ink,#09090b);color:var(--zw-page,#fff);padding:.72rem 1.5rem;cursor:pointer;font-family:var(--fm,inherit);font-size:.64rem;letter-spacing:.14em;text-transform:uppercase;font-weight:700;text-decoration:none;display:inline-flex;align-items:center;white-space:nowrap}',
      '.zwf-bag-review:hover{opacity:.85}',
      '.zwf-bag-items{display:flex;flex-direction:column;gap:.9rem;margin-bottom:1.6rem}',
      '.zwf-bag-item{display:flex;align-items:center;gap:1rem;text-decoration:none;color:inherit}',
      '.zwf-bag-thumb{width:62px;height:62px;border-radius:6px;object-fit:cover;background:rgba(128,128,128,.12);flex-shrink:0}',
      '.zwf-bag-nm{font-family:var(--fb,inherit);font-size:.92rem;font-weight:500}',
      '.zwf-bag-meta{font-family:var(--fm,inherit);font-size:.62rem;letter-spacing:.08em;text-transform:uppercase;opacity:.5;margin-top:2px}',
      '.zwf-bag-price{margin-left:auto;font-family:var(--fb,inherit);font-size:.9rem;font-weight:600;white-space:nowrap}',
      '.zwf-bag-empty{font-family:var(--fb,inherit);opacity:.55;font-size:.95rem;margin:0 0 1.6rem}',
      '.zwf-bag-links{border-top:1px solid rgba(128,128,128,.22);padding-top:1.1rem}',
      '.zwf-bag-links h3{font-family:var(--fb,inherit);font-size:.9rem;font-weight:400;opacity:.55;margin:0 0 .7rem}',
      '.zwf-bag-link{display:flex;align-items:center;gap:.7rem;padding:.5rem 0;text-decoration:none;color:inherit;font-family:var(--fb,inherit);font-size:.95rem}',
      '.zwf-bag-link:hover{opacity:.65}',
      '.zwf-bag-link svg{width:17px;height:17px;opacity:.55;flex-shrink:0}',
      /* The account button moves INTO this panel, so hide the header one while
         the feature is on (both header systems). */
      'body.zwf-bagpanel-on :is(#login-btn,#account-btn,#hdr-login){display:none!important}',
      '.zwf-search-bar{display:flex;align-items:center;gap:.9rem;padding:1.1rem clamp(1rem,4vw,2.5rem);border-bottom:1px solid var(--line,rgba(128,128,128,.2))}',
      '.zwf-search-bar svg{width:22px;height:22px;flex:0 0 auto;opacity:.6}',
      '.zwf-search-input{flex:1;background:none;border:none;outline:none;color:inherit;font-family:var(--fw,inherit);font-weight:700;font-size:clamp(1.1rem,3vw,1.7rem);letter-spacing:.02em}',
      /* storefront-cohesion.css gives every focused input a 2px accent ring.
         On a field that's auto-focused the moment the panel opens it's pure
         noise — the caret already says where you are. Killed here only. */
      '.zwf-search-input:focus,.zwf-search-input:focus-visible{outline:none!important;box-shadow:none!important}',
      '.zwf-search-input::-webkit-search-cancel-button,.zwf-search-input::-webkit-search-decoration{-webkit-appearance:none;appearance:none}',
      '.zwf-search-input::placeholder{color:currentColor;opacity:.38}',
      /* Our own clear button: the native type=search one renders in the UA's own
         blue, which appears nowhere else on the site. */
      '.zwf-search-clear{background:none;border:none;padding:.3rem;margin:0;cursor:pointer;color:inherit;display:inline-flex;align-items:center;justify-content:center;opacity:.45;transition:opacity .15s}',
      // [hidden] is only a UA display:none, so the display above beat it and the
      // button sat there permanently — clicking it on an empty field cleared
      // nothing, which read as a close button that does not work. It may only
      // appear when there is something to clear.
      '.zwf-search-clear[hidden]{display:none}',
      '.zwf-search-clear:hover{opacity:.9}',
      '.zwf-search-clear svg{width:17px;height:17px;display:block}',
      '.zwf-search-results{overflow-y:auto;overscroll-behavior:contain;padding:1.4rem clamp(1rem,4vw,2.5rem) 2.4rem}',
      '.zwf-search-meta{font-family:var(--fm,inherit);font-size:.62rem;letter-spacing:.16em;text-transform:uppercase;opacity:.5;margin:0 0 1.1rem}',
      /* Text rows, Apple-style — a name and a price read faster than a wall of
         thumbnails when you're mid-keystroke. */
      '.zwf-sr{display:flex;align-items:center;gap:.85rem;padding:.72rem .2rem;text-decoration:none;color:inherit;border-bottom:1px solid var(--line,rgba(128,128,128,.14))}',
      '.zwf-sr:last-child{border-bottom:none}',
      '.zwf-sr:hover{opacity:.62}',
      '.zwf-sr-arrow{width:13px;height:13px;flex-shrink:0;opacity:.4}',
      '.zwf-sr-nm{font-family:var(--fb,inherit);font-size:1rem;font-weight:500}',
      '.zwf-sr-meta{margin-left:auto;font-family:var(--fm,inherit);font-size:.6rem;letter-spacing:.1em;text-transform:uppercase;opacity:.5;white-space:nowrap}',
      '.zwf-search-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:1.1rem}',
      '@media(min-width:900px){.zwf-search-grid{grid-template-columns:repeat(auto-fill,minmax(190px,1fr))}}',
      '.zwf-search .zwf-card-name,.zwf-search .zwf-card-price{color:inherit}',
      '.zwf-empty{padding:3rem 1rem;text-align:center;opacity:.55;font-family:var(--fb,inherit)}',
      '@media(prefers-reduced-motion:reduce){.zwf-search,.zwf-search-panel{transition:none}}',
      /* Apple-ish: the panel slides out from beneath the header, which stays put
         and shrinks slightly. The overlay's top is set in JS to the header's
         measured bottom, so the header is never covered and stays clickable. */
      'body.zwf-searching :is(nav#nav,nav.nav,header.nav,nav.zw-nav){padding-top:.3rem!important;padding-bottom:.3rem!important}',
      'body.zwf-searching :is(.nav-logo,.zw-nav-logo) img{transform:scale(.86);transition:transform .34s cubic-bezier(.22,.61,.36,1)}',
      '.zwf-search-panel{overflow:hidden}',
      '@media(max-width:899px){.zwf-search-panel{max-height:100%}}',

      /* low-stock chip on homepage product cards (the collection page + product page
         already show their own stock cues, so this only targets .pcard grids) */
      '.zwf-lowstock-badge{position:absolute;top:.8rem;left:.8rem;z-index:2;pointer-events:none;background:#e05252;color:#fff;font-family:var(--fm,var(--fb,inherit));font-size:.55rem;font-weight:700;letter-spacing:.11em;text-transform:uppercase;padding:.3rem .5rem;border-radius:3px;box-shadow:0 2px 8px rgba(0,0,0,.18)}',

      /* fit-finder trigger (next to size guide) */
      '.zwf-fit-btn{background:none;border:none;cursor:pointer;font-family:var(--fm,var(--fb,inherit));font-size:.66rem;letter-spacing:.14em;text-transform:uppercase;color:inherit;opacity:.7;text-decoration:underline;text-underline-offset:3px;padding:0;margin-left:1.1rem}',
      '.zwf-fit-btn:hover{opacity:1}',

      /* shared modal (fit finder) — cream panel that reads on both themes */
      '.zwf-modal{position:fixed;inset:0;z-index:4100;display:flex;align-items:center;justify-content:center;padding:1.2rem;background:rgba(9,9,11,.55);opacity:0;pointer-events:none;transition:opacity .22s ease}',
      '.zwf-modal.open{opacity:1;pointer-events:auto}',
      '.zwf-modal-box{position:relative;background:#f4f1eb;color:#09090b;width:100%;max-width:440px;border-radius:4px;padding:2rem 1.8rem;max-height:90vh;overflow-y:auto;transform:translateY(10px);transition:transform .26s cubic-bezier(.2,.7,.2,1)}',
      '.zwf-modal.open .zwf-modal-box{transform:none}',
      '.zwf-modal-x{position:absolute;top:.9rem;right:1.1rem;background:none;border:none;font-size:1.5rem;line-height:1;cursor:pointer;color:inherit;opacity:.5}',
      '.zwf-modal-x:hover{opacity:1}',
      '.zwf-modal-title{font-family:var(--fw,inherit);font-weight:900;font-style:italic;text-transform:uppercase;letter-spacing:.04em;font-size:1.35rem;margin:0 0 .3rem}',
      '.zwf-modal-sub{font-family:var(--fb,inherit);font-size:.85rem;opacity:.6;margin:0 0 1.4rem;line-height:1.5}',
      '.zwf-field{margin-bottom:1.05rem}',
      '.zwf-field label{display:block;font-family:var(--fm,inherit);font-size:.6rem;letter-spacing:.14em;text-transform:uppercase;opacity:.6;margin-bottom:.45rem}',
      '.zwf-field input,.zwf-field select{width:100%;padding:.7rem .8rem;background:rgba(9,9,11,.04);border:1px solid rgba(9,9,11,.16);border-radius:3px;color:inherit;font-family:var(--fb,inherit);font-size:.95rem;outline:none}',
      '.zwf-seg{display:flex;gap:.5rem}',
      '.zwf-seg button{flex:1;padding:.6rem .3rem;background:rgba(9,9,11,.04);border:1px solid rgba(9,9,11,.16);border-radius:3px;color:inherit;font-family:var(--fm,inherit);font-size:.6rem;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}',
      '.zwf-seg button.on{background:var(--ink,#09090b);color:var(--paper,#f4f1eb);border-color:var(--ink,#09090b)}',
      '.zwf-btn{width:100%;padding:.9rem;background:var(--ink,#09090b);color:var(--paper,#f4f1eb);border:none;border-radius:3px;font-family:var(--fm,inherit);font-size:.7rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;cursor:pointer;margin-top:.5rem}',
      '.zwf-btn:hover{opacity:.9}',
      '.zwf-result{text-align:center;padding:.6rem 0 .2rem}',
      '.zwf-result-size{font-family:var(--fw,inherit);font-weight:900;font-style:italic;font-size:3.2rem;line-height:1;margin:.3rem 0}',
      '.zwf-result-note{font-family:var(--fb,inherit);font-size:.82rem;opacity:.6;margin:.2rem 0 1.4rem;line-height:1.5}',

      /* support widget (floating) */
      '.zwf-support{position:fixed;right:20px;bottom:20px;z-index:900;display:flex;flex-direction:column;align-items:flex-end;gap:12px}',
      '.zwf-support-fab{display:inline-flex;align-items:center;gap:.5rem;background:var(--ink,#09090b);color:var(--paper,#f4f1eb);border:none;border-radius:100px;padding:.7rem 1.1rem;font-family:var(--fm,inherit);font-size:.64rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.22)}',
      '.zwf-support-fab svg{width:16px;height:16px}',
      '.zwf-support-panel{background:#f4f1eb;color:#09090b;width:250px;border-radius:10px;padding:1.2rem;box-shadow:0 12px 40px rgba(0,0,0,.28);opacity:0;transform:translateY(8px) scale(.98);transform-origin:bottom right;pointer-events:none;transition:opacity .2s ease,transform .2s ease}',
      '.zwf-support.open .zwf-support-panel{opacity:1;transform:none;pointer-events:auto}',
      '.zwf-support-panel h4{font-family:var(--fw,inherit);font-weight:900;font-style:italic;text-transform:uppercase;letter-spacing:.03em;font-size:1.05rem;margin:0 0 .2rem}',
      '.zwf-support-panel p{font-family:var(--fb,inherit);font-size:.78rem;opacity:.6;margin:0 0 .9rem;line-height:1.5}',
      '.zwf-support-panel a{display:block;padding:.55rem .7rem;margin:0 -.7rem;border-radius:5px;text-decoration:none;color:inherit;font-family:var(--fm,inherit);font-size:.7rem;letter-spacing:.05em}',
      '.zwf-support-panel a:hover{background:rgba(9,9,11,.07)}',
      '@media(prefers-reduced-motion:reduce){.zwf-modal,.zwf-modal-box,.zwf-support-panel{transition:none}}'
    ].join('');
    var s = document.createElement('style');
    s.id = 'zwf-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* ───────────────────────── feature: product search ───────────────────────── */

  var SEARCH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
  // Ours, so it inherits the page's ink instead of the browser's blue.
  var CLEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

  function scoreProduct(p, tokens) {
    var hay = [nameOf(p), p.subtitle, p.gender, p.colorway, p.category,
      Array.isArray(p.tags) ? p.tags.join(' ') : p.tags, p.material_composition]
      .join(' ').toLowerCase();
    var name = nameOf(p).toLowerCase();
    var score = 0;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (hay.indexOf(t) === -1) return 0;          // every token must match (AND)
      if (name.indexOf(t) === 0) score += 3;        // title prefix
      else if (name.indexOf(t) !== -1) score += 2;  // title contains
      else score += 1;                              // matched elsewhere
    }
    return score;
  }

  function initSearch() {
    ensureStyles();

    // Launcher — sits immediately before the bag, whichever header this page uses.
    // Three variants exist: index/product wrap actions in .nav-right with a
    // #cart-btn; everything else groups them in .zw-hdr-group with a .zw-hdr-bag.
    // Only .nav-right was handled before, so the icon silently never appeared on
    // the .zw-hdr-group pages (drop001 included, despite loading this module).
    var host = null, before = null, cls = 'nbtn';
    var navRight = document.querySelector('.nav-right');
    var cart = navRight && navRight.querySelector('#cart-btn');
    if (navRight && cart) {
      host = navRight; before = cart;                       // index, product
    } else {
      var group = document.querySelector('.zw-hdr-group');
      if (group) {
        host = group; before = group.querySelector('.zw-hdr-bag'); cls = 'zw-hdr-action';
      } else if (navRight) {
        host = navRight;                                    // bag: no bag icon to sit before
      }
    }
    if (host && !document.querySelector('.zwf-search-btn')) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = cls + ' zwf-search-btn';
      btn.setAttribute('aria-label', 'Search');
      btn.innerHTML = SEARCH_SVG;
      if (before) host.insertBefore(btn, before); else host.appendChild(btn);
      btn.addEventListener('click', openSearch);
    }

    // "/" opens search (unless typing in a field).
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '')) && !e.target.isContentEditable) {
        e.preventDefault(); openSearch();
      }
    });
  }

  var _overlay = null, _input = null, _results = null;
  function buildOverlay() {
    if (_overlay) return;
    _overlay = document.createElement('div');
    _overlay.className = 'zwf-search';
    _overlay.setAttribute('role', 'dialog');
    _overlay.setAttribute('aria-label', 'Product search');
    _overlay.innerHTML =
      '<div class="zwf-search-panel">'
      + '<div class="zwf-search-bar">' + SEARCH_SVG
      + '<input class="zwf-search-input" type="text" autocomplete="off" spellcheck="false" placeholder="Search products…" aria-label="Search products">'
      + '<button class="zwf-search-clear" type="button" aria-label="Clear search" hidden>' + CLEAR_SVG + '</button>'
      + '</div>'
      + '<div class="zwf-search-results"></div>'
      + '</div>';
    document.body.appendChild(_overlay);
    _input = _overlay.querySelector('.zwf-search-input');
    _results = _overlay.querySelector('.zwf-search-results');

    _overlay.addEventListener('click', function (e) { if (e.target === _overlay) closeSearch(); });
    var clearBtn = _overlay.querySelector('.zwf-search-clear');
    clearBtn.addEventListener('click', function () { _input.value = ''; clearBtn.hidden = true; runSearch(); _input.focus(); });
    // Enter → the full catalogue, filtered. The panel is a peek; this is the
    // "show me everything" escape hatch.
    _input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var q = (_input.value || '').trim();
      if (!q) return;
      e.preventDefault();
      location.assign('/drop001.html?q=' + encodeURIComponent(q));
    });
    _input.addEventListener('input', function () { clearBtn.hidden = !_input.value; });
    _input.addEventListener('input', debounce(runSearch, 120));
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && _overlay && _overlay.classList.contains('open')) closeSearch(); });
    _results.innerHTML = '<p class="zwf-empty">Start typing to search the collection.</p>';
  }

  function headerEl() {
    return document.querySelector('nav#nav, nav.nav, header.nav, nav.zw-nav');
  }
  function isDesktop() { return window.matchMedia('(min-width:900px)').matches; }

  // Where a panel's top edge goes: flush under the header. Measured rather than
  // hardcoded — the header shrinks when a panel opens and its height differs per
  // page (index stacks a fixed announcement bar above the nav; drop001 doesn't).
  //
  // Deliberately overlap the header's bottom edge by a pixel.
  //
  // rect.bottom is a border-box measurement, so it sits UNDER nav#nav's
  // border-bottom (1px). Landing the panel exactly there leaves the sub-pixel
  // remainder of that border peeking out as a hairline — measured on the
  // homepage: nav.bottom 87.4, panel 87, so 0.6px of border still showed. It
  // surfaces only on pages with an announcement bar because the bar offsets the
  // nav (top:27px), which changes where the bottom edge lands between pixels.
  //
  // floor() gets us to the edge; it can't cover a border inside it. Panels paint
  // at z-index 989 over the nav's 220, so eating that last pixel is free and the
  // seam goes away on every page. Both panels share this so they can't drift.
  function headerBottom() {
    var h = headerEl();
    if (!h) return 0;
    return Math.max(0, Math.floor(h.getBoundingClientRect().bottom) - 1);
  }

  function syncSearchTop() {
    if (!_overlay) return;
    if (!isDesktop()) { _overlay.style.top = '0px'; return; }
    _overlay.style.top = headerBottom() + 'px';
  }

  // The page must not move behind an open panel, but a scroll gesture is still
  // how you dismiss one. Both are possible because the two are different things:
  // the page is frozen, and the *gesture* (wheel/touchmove) is read directly.
  // A plain scroll listener cannot do this — once the page is locked there is no
  // scroll event left to hear.
  //
  // The lock uses overflow:hidden rather than body{position:fixed}: modal-lock.js
  // spells out why the latter is wrong — it breaks position:sticky, and
  // journal/about/account/returns all have sticky headers, which matters here
  // because the header stays visible behind the panel. iOS still needs the fixed
  // dance, hence the mobile branch.
  var _lockedRoot = false, _padded = false, _scrollY = 0;
  function lockScroll() {
    if (isDesktop()) {
      var sw = window.innerWidth - document.documentElement.clientWidth;
      if (sw > 0) { document.documentElement.style.paddingRight = sw + 'px'; _padded = true; }
      document.documentElement.style.overflow = 'hidden';
      _lockedRoot = true;
    } else {
      _scrollY = window.scrollY || 0;
      document.body.style.top = '-' + _scrollY + 'px';
      document.body.style.position = 'fixed';
      document.body.style.width = '100%';
    }
  }
  function unlockScroll() {
    if (_lockedRoot) {
      document.documentElement.style.overflow = '';
      if (_padded) { document.documentElement.style.paddingRight = ''; _padded = false; }
      _lockedRoot = false;
    } else if (document.body.style.position === 'fixed') {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, _scrollY);
    }
  }

  // The header shrinks over ~350ms. Re-measure every frame while it moves so the
  // panel stays glued to it — sampling at a couple of timeouts instead left the
  // panel hanging in a gap and snapping into place at the end.
  var _trackRaf = 0;
  function trackHeader(sync, ms) {
    var fn = typeof sync === 'function' ? sync : syncSearchTop;
    var until = (window.performance ? performance.now() : Date.now()) + (ms || 520);
    cancelAnimationFrame(_trackRaf);
    (function step() {
      fn();
      var now = window.performance ? performance.now() : Date.now();
      if (now < until) _trackRaf = requestAnimationFrame(step);
    })();
  }

  /* ── One panel at a time ───────────────────────────────────────────────────
     Search, bag and the category mega-menu all hang off the same header, so two
     of them open at once just buries one behind the other. Everything that opens
     dismisses whatever else is open first.

     Scrolling past a panel dismisses it, which is why neither locks the page:
     a scroll lock is exactly what forced a Close button to exist. The bag used
     to lock (overflow:hidden on the root), so it alone couldn't be scrolled
     away — the same rule, two behaviours. */
  function isOpen(el) { return !!el && el.classList.contains('open'); }

  function closePanels(except) {
    if (except !== 'search' && isOpen(_overlay)) closeSearch();
    if (except !== 'bag' && isOpen(_bagOverlay)) closeBag();
  }

  // Scrolling anywhere past the panel dismisses it. Gestures that start inside a
  // panel are left alone — the results list and the bag's contents scroll on
  // their own, and closing the thing you're reading would be absurd.
  function onPanelGesture(e) {
    var t = e.target;
    if (t && t.closest && t.closest('.zwf-search-panel, .zwf-bag-panel')) return;
    closePanels();
  }
  function armScrollClose() {
    window.addEventListener('wheel', onPanelGesture, { passive: true });
    window.addEventListener('touchmove', onPanelGesture, { passive: true });
  }
  function disarmScrollClose() {
    window.removeEventListener('wheel', onPanelGesture);
    window.removeEventListener('touchmove', onPanelGesture);
  }

  // The mega-menu opens on CSS :hover, so it can't be gated — get out of its way
  // instead. Guarded by isOpen() so a mouseover storm costs one class check.
  function watchCategoryHover() {
    document.addEventListener('mouseover', function (e) {
      if (!isOpen(_overlay) && !isOpen(_bagOverlay)) return;
      if (e.target && e.target.closest && e.target.closest('.zw-navitem, #nav-category-links')) closePanels();
    }, { passive: true });
  }

  function openSearch() {
    closePanels('search');
    lockScroll();
    buildOverlay();
    catalog(); // warm the cache
    document.body.classList.add('zwf-searching');   // shrinks the header
    syncSearchTop();
    requestAnimationFrame(function () { _overlay.classList.add('open'); _input.focus(); });
    trackHeader(syncSearchTop);
    armScrollClose();
    window.addEventListener('resize', syncSearchTop);
  }

  function closeSearch() {
    if (!_overlay) return;
    _overlay.classList.remove('open');
    document.body.classList.remove('zwf-searching');
    unlockScroll();
    disarmScrollClose();
    window.removeEventListener('resize', syncSearchTop);
    // Keep tracking on the way out too: the header grows back while the panel
    // slides up, and they should move together.
    trackHeader(syncSearchTop);
  }

  var ARROW_SVG = '<svg class="zwf-sr-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
  function searchRow(p) {
    // subtitle is the human label ("Jackets"); the category column holds internal
    // codes (MOT / UOT), which is what shoppers were being shown. The product
    // cards and the collection page both use subtitle — match them.
    var meta = [p.subtitle || p.category || '', p.current_price != null ? '$' + p.current_price : ''].filter(Boolean).join(' · ');
    return '<a class="zwf-sr" href="' + esc(hrefOf(p)) + '">' + ARROW_SVG
      + '<span class="zwf-sr-nm">' + esc(p.title || 'Product') + '</span>'
      + (meta ? '<span class="zwf-sr-meta">' + esc(meta) + '</span>' : '')
      + '</a>';
  }

  function runSearch() {
    var q = (_input.value || '').trim().toLowerCase();
    if (!q) { _results.innerHTML = '<p class="zwf-empty">Start typing to search the collection.</p>'; return; }
    var tokens = q.split(/\s+/).filter(Boolean);
    catalog().then(function (all) {
      var hits = all.map(function (p) { return { p: p, s: scoreProduct(p, tokens) }; })
        .filter(function (x) { return x.s > 0; })
        .sort(function (a, b) { return b.s - a.s; })
        .slice(0, 30);
      if (!hits.length) {
        _results.innerHTML = '<p class="zwf-empty">No products match “' + esc(_input.value.trim()) + '”.</p>';
        return;
      }
      _results.innerHTML = '<p class="zwf-search-meta">' + hits.length + ' result' + (hits.length === 1 ? '' : 's') + '</p>'
        + hits.map(function (x) { return searchRow(x.p); }).join('');
    });
  }

  /* ───────────────────── feature: recently viewed ───────────────────── */

  var RV_KEY = 'zw_recently_viewed';
  function rvGet() { try { return JSON.parse(localStorage.getItem(RV_KEY) || '[]') || []; } catch (_) { return []; } }
  function rvSave(list) { try { localStorage.setItem(RV_KEY, JSON.stringify(list.slice(0, 12))); } catch (_) {} }
  function rvRecord(p) {
    if (!p || !p.id) return;
    var prev = rvGet(), existing = null;
    var list = prev.filter(function (x) { if (x.id === p.id) { existing = x; return false; } return true; });
    list.unshift({ id: p.id, title: nameOf(p), subtitle: typeOf(p), price: priceOf(p), image_url: imgOf(p), sku: p.sku || '', ts: Date.now(), ms: (existing && existing.ms) || 0 });
    rvSave(list);
  }
  // Accumulate how long this visitor looked at the product (for the optional
  // "Viewed for …" caption). Saved on tab-hide / page-leave.
  function rvTrackDwell(p) {
    if (!p || !p.id) return;
    var start = Date.now(), done = false;
    function flush() {
      if (done) return; done = true;
      var ms = Date.now() - start;
      var list = rvGet();
      for (var i = 0; i < list.length; i++) { if (list[i].id === p.id) { list[i].ms = (Number(list[i].ms) || 0) + ms; break; } }
      rvSave(list);
    }
    window.addEventListener('pagehide', flush, { once: true });
    document.addEventListener('visibilitychange', function onVis() {
      if (document.visibilityState === 'hidden') { flush(); document.removeEventListener('visibilitychange', onVis); }
    });
  }
  // Render the "recently viewed" row. opts: { count, show_time, heading, excludeId,
  // container }. With a container it fills it in place (used by the builder section);
  // without one it inserts a strip before the footer (used on the product page).
  // Returns the element, or null when there's nothing worth showing.
  function renderRecentlyViewed(excludeId, opts) {
    opts = opts || {};
    var count = Math.max(1, Math.min(24, parseInt(opts.count, 10) || 5));
    var list = rvGet().filter(function (x) { return x.id !== (opts.excludeId != null ? opts.excludeId : excludeId); }).slice(0, count);
    if (list.length < 2) return null; // not worth a row for 0–1 items
    ensureStyles();
    var showTime = opts.show_time === true;
    var heading = opts.heading != null ? opts.heading : 'Recently viewed';
    var rowHtml = list.map(function (p) { return pcardCard(p, showTime); }).join('');
    if (opts.container) {
      opts.container.classList.add('zwf-strip');
      opts.container.setAttribute('data-zwf', 'recently-viewed');
      opts.container.innerHTML = '<div class="zwf-strip-inner">'
        + (heading ? '<h2 class="zwf-strip-title">' + esc(heading) + '</h2>' : '')
        + '<div class="zwf-row">' + rowHtml + '</div></div>';
      return opts.container;
    }
    var sec = strip(heading, rowHtml);
    sec.setAttribute('data-zwf', 'recently-viewed');
    insertBeforeFooter(sec);
    return sec;
  }
  // Exposed so the homepage builder's "Recently Viewed" section can render into its
  // own placed container (position, count, and time toggle all controlled there).
  // Defers until flags load and respects the feature_recently_viewed master switch;
  // hides the placed container when off or when there's nothing to show.
  window.zwRenderRecentlyViewed = function (container, opts) {
    opts = opts || {};
    function go() {
      if (window.zwFlag && !window.zwFlag('feature_recently_viewed')) { container.style.display = 'none'; return; }
      var done = renderRecentlyViewed(opts.excludeId != null ? opts.excludeId : null, Object.assign({ container: container }, opts));
      if (!done) container.style.display = 'none';
    }
    if (typeof window.zwWhenFlags === 'function') window.zwWhenFlags(go); else go();
  };

  /* ───────────────────── feature: recommendations ───────────────────── */

  function pickRelated(all, current, n) {
    var g = (current.gender || '').toLowerCase();
    var cat = (current.category || '').toLowerCase();
    var sub = (current.subtitle || '').toLowerCase();
    var pool = all.filter(function (p) { return p.id !== current.id; });
    function tier(p) {
      var sameG = (p.gender || '').toLowerCase() === g;
      var sameC = cat && (p.category || '').toLowerCase() === cat;
      var sameS = sub && (p.subtitle || '').toLowerCase() === sub;
      if (sameG && (sameC || sameS)) return 3;      // best: same audience + type
      if (sameC || sameS) return 2;                 // same type
      if (sameG) return 1;                          // same audience
      return 0;                                     // fallback filler
    }
    return pool.map(function (p) { return { p: p, t: tier(p) }; })
      .sort(function (a, b) { return b.t - a.t; })
      .slice(0, n).map(function (x) { return x.p; });
  }

  function renderRecommendations(current) {
    if (!current) return;
    catalog().then(function (all) {
      var rel = pickRelated(all, current, 8);
      if (rel.length < 2) return;
      ensureStyles();
      var sec = strip('You may also like', rel.map(function (p) { return pcardCard(p, false); }).join(''));
      sec.setAttribute('data-zwf', 'recommendations');
      insertBeforeFooter(sec);
    });
  }

  /* ─────────────────────── feature: bundles ("complete the set") ───────────────────
     Admin-defined sets (bundles table; anon reads active rows only). On a product
     page that belongs to a set, show the set's other pieces plus the set's promo
     code when one is configured. The code goes through the existing promo path,
     which is recomputed server-side at payment time — nothing here touches pricing. */

  // Same rule the server uses (normalizePromoCode), so a set saved as "SET 10"
  // matches the coupon SET10.
  function normPromo(v) {
    return String(v || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  }
  // Codes that actually exist right now. sanitizeCommerceConfig drops inactive
  // promos, so anything returned here is live. Used so a set never advertises a
  // code that would fail at checkout (e.g. it was deleted, or never created).
  var _promoCodesPromise = null;
  function livePromoCodes() {
    if (_promoCodesPromise) return _promoCodesPromise;
    _promoCodesPromise = fetch('/api/commerce-config')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var list = (j && j.config && j.config.promotions) || [];
        return list.map(function (p) { return normPromo(p && p.code); }).filter(Boolean);
      })
      .catch(function () { return []; });
    return _promoCodesPromise;
  }

  var _bundlesPromise = null;
  function fetchBundles() {
    if (_bundlesPromise) return _bundlesPromise;
    _bundlesPromise = fetch(SUPA + '/rest/v1/bundles?select=id,name,blurb,product_ids,promo_code&active=eq.true&order=sort_order.asc', {
      headers: { apikey: ANON, Authorization: 'Bearer ' + ANON }
    }).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
    return _bundlesPromise;
  }

  var _bundleStyled = false;
  function ensureBundleStyles() {
    if (_bundleStyled) return;
    _bundleStyled = true;
    var s = document.createElement('style');
    s.textContent = '.zwf-bundle-meta{margin:-4px 0 16px}'
      + '.zwf-bundle-blurb{margin:0;font-size:.9rem;opacity:.7;line-height:1.55;max-width:60ch}'
      + '.zwf-bundle-promo{margin:8px 0 0;font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;opacity:.85}'
      + '.zwf-bundle-promo strong{letter-spacing:.14em;border-bottom:1px dashed currentColor;padding-bottom:1px}';
    document.head.appendChild(s);
  }

  function renderBundle(current) {
    if (!current) return;
    Promise.all([fetchBundles(), catalog(), livePromoCodes()]).then(function (res) {
      var bundles = res[0] || [], all = res[1] || [], codes = res[2] || [];
      var cid = String(current.id);
      var b = null;
      for (var i = 0; i < bundles.length; i++) {
        var ids = (bundles[i].product_ids || []).map(String);
        if (ids.indexOf(cid) >= 0) { b = bundles[i]; break; }
      }
      if (!b) return;
      var others = (b.product_ids || []).map(String)
        .filter(function (id) { return id !== cid; })
        .map(function (id) { var m = null; all.forEach(function (p) { if (String(p.id) === id) m = p; }); return m; })
        .filter(Boolean);
      if (!others.length) return;

      ensureStyles();
      ensureBundleStyles();
      var sec = strip(b.name || 'Complete the set', others.map(function (p) { return pcardCard(p, false); }).join(''));
      sec.setAttribute('data-zwf', 'bundle');
      var titleEl = sec.querySelector('.zwf-strip-title');
      // Only advertise the set's code if that coupon really exists and is live —
      // otherwise the row would promise a discount that fails at checkout. The
      // set still renders, just without the offer line.
      var code = normPromo(b.promo_code);
      var codeIsLive = code && codes.indexOf(code) >= 0;
      var metaHtml = (b.blurb ? '<p class="zwf-bundle-blurb">' + esc(b.blurb) + '</p>' : '')
        + (codeIsLive ? '<p class="zwf-bundle-promo">Use code <strong>' + esc(code) + '</strong> at checkout</p>' : '');
      if (titleEl && metaHtml) {
        var meta = document.createElement('div');
        meta.className = 'zwf-bundle-meta';
        meta.innerHTML = metaHtml;
        titleEl.insertAdjacentElement('afterend', meta);
      }
      insertBeforeFooter(sec);
    });
  }

  /* ── optional block: new arrivals ──────────────────────────────────────────
     Newest products by created_at (falls back to the admin's sort order when a
     row has no timestamp), excluding the one being viewed. */
  function renderNewArrivals(current) {
    catalog().then(function (all) {
      var list = all.filter(function (p) { return !current || String(p.id) !== String(current.id); });
      var dated = list.filter(function (p) { return p.created_at; });
      if (dated.length >= 2) {
        dated.sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
        list = dated;
      }
      list = list.slice(0, 8);
      if (list.length < 2) return;
      ensureStyles();
      var sec = strip('New arrivals', list.map(function (p) { return pcardCard(p, false); }).join(''));
      sec.setAttribute('data-zwf', 'new-arrivals');
      insertBeforeFooter(sec);
    });
  }

  /* ── optional block: from the journal ──────────────────────────────────────
     Latest published posts (RLS only exposes published rows). Silent when there
     are none, so an empty journal never leaves a bare heading. */
  function renderJournalRow() {
    fetch(SUPA + '/rest/v1/journal_posts?select=title,slug,excerpt,cover_image,published_at&status=eq.published&order=published_at.desc.nullslast&limit=6', {
      headers: { apikey: ANON, Authorization: 'Bearer ' + ANON }
    })
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; })
      .then(function (posts) {
        if (!posts || !posts.length) return;
        ensureStyles();
        var cards = posts.map(function (p) {
          var date = p.published_at ? new Date(p.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
          return '<a class="zwf-card zwf-card--pcard" href="/journal.html?slug=' + encodeURIComponent(p.slug) + '">'
            + '<div class="zwf-card-img">' + (p.cover_image ? '<img src="' + esc(p.cover_image) + '" alt="' + esc(p.title) + '" loading="lazy" decoding="async">' : '') + '</div>'
            + '<div class="zwf-card-info">'
            + '<p class="zwf-pc-name">' + esc(p.title) + '</p>'
            + (date ? '<p class="zwf-pc-cat">' + esc(date) + '</p>' : '')
            + '</div></a>';
        }).join('');
        var sec = strip('From the journal', cards);
        sec.setAttribute('data-zwf', 'journal');
        insertBeforeFooter(sec);
      });
  }

  /* ── optional block: newsletter signup ─────────────────────────────────────
     Same capture endpoint as the footer form, so signups land in Admin →
     Subscribers with a source that says where they came from. */
  var _nlStyled = false;
  function ensureNewsletterStyles() {
    if (_nlStyled) return; _nlStyled = true;
    var st = document.createElement('style');
    st.textContent = '.zwf-nl{max-width:1400px;margin:0 auto;padding:2.5rem clamp(1rem,4vw,2.5rem)}'
      + '.zwf-nl-box{border:1px solid var(--line,rgba(128,128,128,.22));border-radius:6px;padding:clamp(1.4rem,4vw,2.2rem);display:flex;flex-wrap:wrap;align-items:center;gap:1rem;justify-content:space-between}'
      + '.zwf-nl-copy{flex:1;min-width:240px}'
      + '.zwf-nl-copy h3{font-family:var(--fw,inherit);font-weight:900;font-style:italic;text-transform:uppercase;letter-spacing:.04em;font-size:1.2rem;margin:0 0 .25rem}'
      + '.zwf-nl-copy p{font-family:var(--fb,inherit);font-size:.85rem;opacity:.6;margin:0}'
      + '.zwf-nl-form{display:flex;gap:.5rem;flex:1;min-width:260px;max-width:420px}'
      + '.zwf-nl-form input{flex:1;background:none;border:1px solid var(--line,rgba(128,128,128,.3));border-radius:3px;color:inherit;padding:.7rem .8rem;font-family:var(--fb,inherit);font-size:.9rem;outline:none}'
      + '.zwf-nl-form button{border:none;border-radius:3px;background:currentColor;padding:.7rem 1.1rem;cursor:pointer;font-family:var(--fm,inherit);font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;font-weight:700}'
      + '.zwf-nl-form button span{color:var(--zw-page,#fff);mix-blend-mode:difference}'
      + '.zwf-nl-done{font-family:var(--fm,inherit);font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;opacity:.75}';
    document.head.appendChild(st);
  }
  function renderNewsletterBlock() {
    ensureStyles(); ensureNewsletterStyles();
    var sec = document.createElement('section');
    sec.className = 'zwf-nl';
    sec.setAttribute('data-zwf', 'newsletter');
    sec.innerHTML = '<div class="zwf-nl-box">'
      + '<div class="zwf-nl-copy"><h3>Stay in the loop</h3><p>Drops, restocks and the occasional story. No spam.</p></div>'
      + '<form class="zwf-nl-form"><input type="email" required autocomplete="email" placeholder="your@email.com" aria-label="Email address">'
      + '<button type="submit"><span>Subscribe</span></button></form></div>';
    insertBeforeFooter(sec);
    var form = sec.querySelector('form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = form.querySelector('input');
      var email = (input.value || '').trim();
      if (!email || email.indexOf('@') === -1) { input.focus(); return; }
      fetch('/api/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, source: 'product_page' })
      })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.ok) form.outerHTML = '<p class="zwf-nl-done">&#10003; You\'re on the list.</p>';
          else input.style.borderColor = '#e05252';
        })
        .catch(function () { input.style.borderColor = '#e05252'; });
    });
  }

  /* ───────────────────── feature: low-stock (homepage cards) ─────────────────────
     The product page and the collection page (drop001) already show their own
     low-stock / sold-out cues, so this only adds a "Low Stock" chip to the HOMEPAGE
     .pcard grid (collection cards use .product-card and are left untouched — no
     duplication). Stock is summed from one batched product_sizes fetch (no-store). */

  var _stockTotalsPromise = null;
  function stockTotals() {
    if (_stockTotalsPromise) return _stockTotalsPromise;
    _stockTotalsPromise = fetch(SUPA + '/rest/v1/product_sizes?select=product_id,stock_quantity', {
      headers: { apikey: ANON, Authorization: 'Bearer ' + ANON }, cache: 'no-store'
    })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        var t = {};
        (rows || []).forEach(function (row) { t[row.product_id] = (t[row.product_id] || 0) + (parseInt(row.stock_quantity, 10) || 0); });
        return t;
      })
      .catch(function () { return {}; });
    return _stockTotalsPromise;
  }

  function initLowStock() {
    ensureStyles();
    Promise.all([stockTotals(), catalog()]).then(function (res) {
      var totals = res[0], cat = res[1];
      var threshOf = {};
      cat.forEach(function (p) { threshOf[p.id] = parseInt(p.low_stock_threshold, 10) || 10; });
      var low = {}; // product_id -> true when 0 < stock <= threshold
      Object.keys(totals).forEach(function (pid) {
        var t = totals[pid];
        if (t > 0 && t <= (threshOf[pid] || 10)) low[pid] = true;
      });

      function decorate() {
        var cards = document.querySelectorAll('.pcard');
        for (var i = 0; i < cards.length; i++) {
          var card = cards[i];
          if (card.querySelector('.zwf-lowstock-badge')) continue;
          var heart = card.querySelector('.heart-btn[data-product-id]');
          var pid = heart && heart.getAttribute('data-product-id');
          if (!pid || !low[pid]) continue;
          var wrap = card.querySelector('.pcard-img') || card;
          var b = document.createElement('span');
          b.className = 'zwf-lowstock-badge';
          b.textContent = 'Low Stock';
          wrap.appendChild(b);
        }
      }

      decorate();
      // Homepage cards render from cache then re-render on fresh data (and on
      // category switches); re-decorate on those. childList only (no subtree) so
      // appending our own chip inside a card doesn't retrigger the observer.
      var first = document.querySelector('.pcard');
      var grid = (first && first.parentElement) || document.querySelector('.products-grid, #products-grid');
      if (grid) { try { new MutationObserver(decorate).observe(grid, { childList: true }); } catch (_) {} }
      // A couple of late passes in case the grid populates after us.
      setTimeout(decorate, 800);
      setTimeout(decorate, 2000);
    });
  }

  /* ───────────────────── feature: fit finder ───────────────────── */

  // Honest starting-point heuristic (weight-led, height-nudged, fit-adjusted) —
  // snapped to a size the product actually offers. Never presented as a guarantee.
  function fitRecommend(heightIn, weightLb, fit, sizes) {
    var order = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
    var w = weightLb || 0;
    var idx = w < 120 ? 0 : w < 140 ? 1 : w < 165 ? 2 : w < 190 ? 3 : w < 220 ? 4 : w < 250 ? 5 : 6;
    if (heightIn >= 74) idx++; else if (heightIn && heightIn <= 64) idx--;
    if (fit === 'relaxed') idx++; else if (fit === 'snug') idx--;
    idx = Math.max(0, Math.min(order.length - 1, idx));
    var rec = order[idx];
    if (sizes && sizes.length) {
      var up = sizes.map(function (s) { return String(s).toUpperCase(); });
      if (up.indexOf(rec) === -1) {
        for (var d = 1; d < order.length; d++) {
          var lo = order[idx - d], hi = order[idx + d];
          if (lo && up.indexOf(lo) !== -1) { rec = lo; break; }
          if (hi && up.indexOf(hi) !== -1) { rec = hi; break; }
        }
      }
    }
    return rec;
  }

  function initFitFinder(p) {
    var header = document.querySelector('.size-header');
    if (!header || header.querySelector('.zwf-fit-btn')) return;
    ensureStyles();
    var sizes = (Array.isArray(p.inventory) ? p.inventory : []).map(function (x) { return x.size; }).filter(Boolean);
    sizes = sizes.filter(function (s, i) { return sizes.indexOf(s) === i; });
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'zwf-fit-btn'; btn.textContent = 'Find your size';
    btn.addEventListener('click', function () { openFitFinder(sizes); });
    header.appendChild(btn);
  }

  var _fitModal = null, _fitState = { fit: 'true' }, _fitSizes = [];
  var FORM_HTML =
    '<div class="zwf-modal-box">'
    + '<button class="zwf-modal-x" type="button" aria-label="Close">×</button>'
    + '<div class="zwf-fit-body"></div>'
    + '</div>';

  function fitFormMarkup() {
    return '<h3 class="zwf-modal-title">Find your size</h3>'
      + '<p class="zwf-modal-sub">Answer three quick questions for a starting point. Still unsure? Check the size guide.</p>'
      + '<div class="zwf-field"><label>Height</label><select class="zwf-h">'
      + ['Under 5′0', '5′0–5′3', '5′4–5′7', '5′8–5′11', '6′0–6′3', '6′4 +']
        .map(function (t, i) { return '<option value="' + [62, 64, 67, 70, 73, 76][i] + '"' + (i === 2 ? ' selected' : '') + '>' + t + '</option>'; }).join('')
      + '</select></div>'
      + '<div class="zwf-field"><label>Weight (lb)</label><input class="zwf-w" type="number" inputmode="numeric" min="70" max="400" placeholder="e.g. 160"></div>'
      + '<div class="zwf-field"><label>Preferred fit</label><div class="zwf-seg">'
      + [['snug', 'Snug'], ['true', 'True to size'], ['relaxed', 'Relaxed']]
        .map(function (o) { return '<button type="button" data-fit="' + o[0] + '"' + (o[0] === _fitState.fit ? ' class="on"' : '') + '>' + o[1] + '</button>'; }).join('')
      + '</div></div>'
      + '<button class="zwf-btn zwf-fit-go" type="button">See my size</button>';
  }

  function openFitFinder(sizes) {
    _fitSizes = sizes || [];
    if (!_fitModal) {
      _fitModal = document.createElement('div');
      _fitModal.className = 'zwf-modal';
      _fitModal.innerHTML = FORM_HTML;
      document.body.appendChild(_fitModal);
      _fitModal.addEventListener('click', function (e) { if (e.target === _fitModal) closeFit(); });
      _fitModal.querySelector('.zwf-modal-x').addEventListener('click', closeFit);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && _fitModal.classList.contains('open')) closeFit(); });
    }
    var body = _fitModal.querySelector('.zwf-fit-body');
    _fitState = { fit: 'true' };
    body.innerHTML = fitFormMarkup();
    body.querySelectorAll('.zwf-seg button').forEach(function (b) {
      b.addEventListener('click', function () {
        _fitState.fit = b.getAttribute('data-fit');
        body.querySelectorAll('.zwf-seg button').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      });
    });
    body.querySelector('.zwf-fit-go').addEventListener('click', function () {
      var h = parseInt(body.querySelector('.zwf-h').value, 10) || 0;
      var w = parseInt(body.querySelector('.zwf-w').value, 10) || 0;
      if (!w) { body.querySelector('.zwf-w').focus(); return; }
      var rec = fitRecommend(h, w, _fitState.fit, _fitSizes);
      body.innerHTML = '<div class="zwf-result"><h3 class="zwf-modal-title">Your size</h3>'
        + '<div class="zwf-result-size">' + esc(rec) + '</div>'
        + '<p class="zwf-result-note">A starting point based on your answers — fit varies by cut. Check the size guide if you’re between sizes.</p>'
        + '<button class="zwf-btn zwf-fit-again" type="button">Start over</button></div>';
      body.querySelector('.zwf-fit-again').addEventListener('click', function () { openFitFinder(_fitSizes); });
    });
    requestAnimationFrame(function () { _fitModal.classList.add('open'); });
  }
  function closeFit() { if (_fitModal) _fitModal.classList.remove('open'); }

  /* ───────────────────── feature: support widget ───────────────────── */

  var CHAT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>';

  function initSupport() {
    if (document.querySelector('.zwf-support')) return;
    ensureStyles();
    var wrap = document.createElement('div');
    wrap.className = 'zwf-support';
    wrap.innerHTML =
      '<div class="zwf-support-panel" role="dialog" aria-label="Help">'
      + '<h4>Need help?</h4><p>We usually reply within 24 hours.</p>'
      + '<a href="mailto:nasirubreeze@zuwera.store">✉︎  Email us</a>'
      + '<a href="/account.html#orders">📦  Track my order</a>'
      + '<a href="/returns.html">↩︎  Returns &amp; exchanges</a>'
      + '<a href="/policies.html">❔  Shipping &amp; FAQ</a>'
      + '</div>'
      + '<button class="zwf-support-fab" type="button" aria-label="Help">' + CHAT_SVG + 'Help</button>';
    document.body.appendChild(wrap);
    wrap.querySelector('.zwf-support-fab').addEventListener('click', function (e) {
      e.stopPropagation(); wrap.classList.toggle('open');
    });
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) wrap.classList.remove('open'); });
  }

  /* ───────────────────── feature: product Q&A ───────────────────── */

  function ensureQAStyles() {
    if (document.getElementById('zwf-qa-styles')) return;
    var css = [
      '.zwf-qa .zwf-strip-inner{max-width:820px}',
      '.zwf-qa-list{display:flex;flex-direction:column;gap:1rem;margin-bottom:2rem}',
      '.zwf-qa-item{border-bottom:1px solid rgba(128,128,128,.18);padding-bottom:1rem}',
      '.zwf-qa-q,.zwf-qa-a{display:flex;gap:.6rem;margin:0 0 .4rem;font-family:var(--fb,inherit);font-size:.95rem;line-height:1.55}',
      '.zwf-qa-q{font-weight:600}.zwf-qa-a{opacity:.8}',
      '.zwf-qa-q b,.zwf-qa-a b{flex:0 0 1.1rem;font-family:var(--fw,inherit);font-weight:900;font-style:italic}',
      '.zwf-qa-a b{opacity:.5}',
      '.zwf-qa-empty{opacity:.55;font-family:var(--fb,inherit);margin:0 0 2rem}',
      '.zwf-qa-form{border-top:1px solid rgba(128,128,128,.18);padding-top:1.4rem}',
      '.zwf-qa-label{display:block;font-family:var(--fm,var(--fb,inherit));font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;opacity:.6;margin-bottom:.5rem}',
      '.zwf-qa-input,.zwf-qa-name{width:100%;background:rgba(128,128,128,.08);border:1px solid rgba(128,128,128,.25);color:inherit;font-family:var(--fb,inherit);font-size:.95rem;padding:.7rem .8rem;border-radius:3px;outline:none;box-sizing:border-box}',
      '.zwf-qa-input{margin-bottom:.6rem;resize:vertical}',
      '.zwf-qa-row{display:flex;gap:.6rem;flex-wrap:wrap}',
      '.zwf-qa-name{flex:1;min-width:160px}',
      '.zwf-qa-submit{background:var(--ink,#09090b);color:var(--paper,#f4f1eb);border:none;border-radius:3px;padding:.7rem 1.4rem;font-family:var(--fm,inherit);font-size:.68rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;white-space:nowrap}',
      '.zwf-qa-submit:disabled{opacity:.6;cursor:default}',
      '.zwf-qa-msg{font-family:var(--fb,inherit);font-size:.82rem;margin:.6rem 0 0;min-height:1rem}',
      '.zwf-qa-msg.err{color:#d64545}',
      '.zwf-qa-thanks{font-family:var(--fb,inherit);font-size:.95rem;opacity:.85;margin:0}'
    ].join('');
    var s = document.createElement('style'); s.id = 'zwf-qa-styles'; s.textContent = css;
    document.head.appendChild(s);
  }

  function initQA(p) {
    if (!p || !p.id || document.querySelector('.zwf-qa')) return;
    var pid = String(p.id);
    fetch(SUPA + '/rest/v1/product_questions?select=question,answer,asker_name&product_id=eq.' + encodeURIComponent(pid) + '&status=eq.published&order=answered_at.desc.nullslast&limit=25', {
      headers: { apikey: ANON, Authorization: 'Bearer ' + ANON }, cache: 'no-store'
    })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) { renderQA(pid, rows || []); })
      .catch(function () { renderQA(pid, []); });
  }

  function renderQA(pid, rows) {
    if (document.querySelector('.zwf-qa')) return;
    ensureStyles(); ensureQAStyles();
    var list = rows.length
      ? rows.map(function (q) {
          return '<div class="zwf-qa-item"><p class="zwf-qa-q"><b>Q</b>' + esc(q.question) + '</p>'
            + (q.answer ? '<p class="zwf-qa-a"><b>A</b>' + esc(q.answer) + '</p>' : '') + '</div>';
        }).join('')
      : '<p class="zwf-qa-empty">No questions yet — be the first to ask.</p>';
    var sec = document.createElement('section');
    sec.className = 'zwf-strip zwf-qa';
    sec.setAttribute('data-zwf', 'qa');
    sec.innerHTML = '<div class="zwf-strip-inner">'
      + '<h2 class="zwf-strip-title">Questions &amp; Answers</h2>'
      + '<div class="zwf-qa-list">' + list + '</div>'
      + '<form class="zwf-qa-form">'
      + '<label class="zwf-qa-label" for="zwf-qa-input">Ask a question</label>'
      + '<textarea class="zwf-qa-input" id="zwf-qa-input" rows="2" maxlength="1000" placeholder="e.g. How does this fit? Is the fabric breathable?"></textarea>'
      + '<div class="zwf-qa-row"><input class="zwf-qa-name" type="text" maxlength="60" placeholder="Your name (optional)">'
      + '<button type="submit" class="zwf-qa-submit">Submit question</button></div>'
      + '<p class="zwf-qa-msg" aria-live="polite"></p>'
      + '</form></div>';
    insertBeforeFooter(sec);
    sec.querySelector('.zwf-qa-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var form = e.currentTarget;
      var input = sec.querySelector('.zwf-qa-input');
      var nameEl = sec.querySelector('.zwf-qa-name');
      var msg = sec.querySelector('.zwf-qa-msg');
      var btn = sec.querySelector('.zwf-qa-submit');
      var question = (input.value || '').trim();
      if (question.length < 3) { msg.textContent = 'Please enter a question.'; msg.className = 'zwf-qa-msg err'; return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      fetch(SUPA + '/rest/v1/product_questions', {
        method: 'POST',
        headers: { apikey: ANON, Authorization: 'Bearer ' + ANON, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ product_id: pid, question: question, asker_name: (nameEl.value || '').trim() || null, status: 'pending' })
      }).then(function (r) {
        if (r.ok) { form.innerHTML = '<p class="zwf-qa-thanks">Thanks! Your question was submitted — it\'ll appear here once our team answers it.</p>'; }
        else { msg.textContent = 'Could not submit — please try again.'; msg.className = 'zwf-qa-msg err'; btn.disabled = false; btn.textContent = 'Submit question'; }
      }).catch(function () {
        msg.textContent = 'Could not submit — please try again.'; msg.className = 'zwf-qa-msg err'; btn.disabled = false; btn.textContent = 'Submit question';
      });
    });
  }

  /* ───────────────────────── page wiring ───────────────────────── */

  function isHome() {
    var p = location.pathname;
    return p === '/' || /\/index\.html$/i.test(p) || !!document.querySelector('.hero, #hero');
  }

  // The product page announces its product; also poll the global as a fallback.
  function onProduct(cb) {
    var done = false;
    function fire(p) { if (done || !p || !p.id) return; done = true; cb(p); }
    window.addEventListener('zw-product-loaded', function (e) { fire(e && e.detail); });
    if (window.__zwCurrentProduct) fire(window.__zwCurrentProduct);
    else {
      var tries = 0, iv = setInterval(function () {
        if (window.__zwCurrentProduct) { clearInterval(iv); fire(window.__zwCurrentProduct); }
        else if (++tries > 40) clearInterval(iv); // ~10s then give up
      }, 250);
    }
  }

  // zwFlag() can't tell "not configured" from "off" — both are false. The raw map
  // can, so this honours an explicit off while letting a never-configured flag use
  // the default the admin registry advertises.
  function flagOrDefault(f, key, dflt) {
    var raw = window.__zwFlags && window.__zwFlags[key];
    if (raw === undefined || raw === null) return dflt;
    return f(key);
  }

  function init(zwFlag) {
    var f = (typeof zwFlag === 'function') ? zwFlag : function () { return false; };
    var wantSearch = f('feature_search');
    var wantRV = f('feature_recently_viewed');
    var wantRec = f('feature_recommendations');
    var wantLowStock = f('feature_low_stock');
    var wantFit = f('feature_fit_finder');
    var wantSupport = f('feature_support_widget');
    var wantQA = f('feature_qa');
    var wantBundles = f('feature_bundles');
    // Flags the admin registry seeds ON are still absent from site_settings until
    // someone opens Feature Flags and hits Save — so "seeded on" silently meant
    // OFF on the storefront. __zwFlags is the raw map, so an unconfigured flag is
    // distinguishable from one that's been deliberately switched off: fall back to
    // the seeded default only when the store has never had an opinion.
    var wantBagPanel = flagOrDefault(f, 'feature_bag_panel', true);
    // NB: no early return on "nothing flagged" — the product page still needs to
    // apply its builder layout, which can contain unflagged optional blocks.

    if (wantSearch) initSearch();
    if (wantSupport) initSupport();
    if (wantBagPanel) initBagPanel();
    // Either panel can collide with the category mega-menu, so this arms as soon
    // as one of them is on.
    if (wantSearch || wantBagPanel) watchCategoryHover();
    if (wantLowStock) initLowStock(); // decorates homepage .pcard grids; no-op elsewhere

    // The optional blocks (new arrivals / journal / newsletter) have no flag of
    // their own — they're on when the builder's Product layout includes them — so
    // the product-page runner must start even if every flagged feature is off.
    var wantPdp = true;
    var onPdp = /\/product(\.html|\/)/i.test(location.pathname) || !!document.querySelector('.product-detail, #product-detail, .size-section');
    if (wantPdp && (onPdp || window.__zwCurrentProduct)) {
      onProduct(function (p) {
        if (wantRV) { rvRecord(p); rvTrackDwell(p); }
        if (wantFit) initFitFinder(p);
        // Layout comes from the Page Builder's Product tab: which blocks show and
        // in what order. A block still needs its feature flag on — the flag is the
        // global switch, this is just the page's arrangement. If the config can't
        // be read we fall back to the default order, so the page never loses
        // content because of a settings hiccup.
        var DEFAULT_PDP = [{ id: 'bundle', on: true }, { id: 'recently_viewed', on: true }, { id: 'recommendations', on: true }, { id: 'qa', on: true }];
        var run = {
          bundle: function () { if (wantBundles) renderBundle(p); },
          recently_viewed: function () { if (wantRV) renderRecentlyViewed(p.id); },
          recommendations: function () { if (wantRec) renderRecommendations(p); },
          qa: function () { if (wantQA) initQA(p); },
          // Optional blocks — added from the builder's Product tab, so they carry
          // no separate feature flag: being in the layout IS the switch.
          new_arrivals: function () { renderNewArrivals(p); },
          journal: function () { renderJournalRow(); },
          newsletter: function () { renderNewsletterBlock(); },
        };
        fetch('/api/product-page-config')
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; })
          .then(function (cfg) {
            var list = (cfg && Array.isArray(cfg.sections) && cfg.sections.length) ? cfg.sections : DEFAULT_PDP;
            list.forEach(function (s) {
              if (!s || s.on === false) return;
              var fn = run[s.id];
              if (fn) fn();
            });
          });
      });
    }
    // Homepage placement is controlled by the builder's "Recently Viewed" section
    // (storefront.js calls window.zwRenderRecentlyViewed into the container the admin
    // positions) — so there is no auto-insert on the homepage anymore.
  }

  /* ─────────────────────────── feature: bag panel ───────────────────────────
     Clicking the bag opened bag.html. This opens a panel under the header
     instead: what's in the bag, Review Bag, and the account/support links that
     used to sit as a separate header button — so the header loses a control
     rather than gaining one.

     Reuses the search panel's mechanics deliberately: no dim, no blur,
     compositor-only slide, and it tracks the header while that shrinks. */

  var _bagOverlay = null, _bagPanel = null;

  function bagCart() {
    try { return JSON.parse(localStorage.getItem('cart') || '[]') || []; } catch (_) { return []; }
  }
  function bagMoney(n) {
    var v = Number(n) || 0;
    return '$' + (Number.isInteger(v) ? v : v.toFixed(2));
  }
  // Two header systems, two ways to tell. __zwSessionUser is the pre-read some
  // pages do; elsewhere the visible account button is the signal.
  function bagUser() {
    if (window.__zwSessionUser) {
      var u = window.__zwSessionUser;
      return { name: (u.user_metadata && u.user_metadata.full_name) || (u.email || '').split('@')[0] || 'Account' };
    }
    // Read index's own signed-in marker (updateNav() in storefront.js adds .show
    // to #account-btn), NOT visibility: zwf-bagpanel-on display:none's this very
    // button, so an offsetParent check reads every signed-in visitor as signed
    // out — the panel offered "Sign in" to people who were already signed in.
    var ab = document.getElementById('account-btn');
    if (ab && ab.classList.contains('show')) return { name: (ab.textContent || 'Account').trim() };
    var hl = document.getElementById('hdr-login');
    if (hl && /account\.html/.test(hl.getAttribute('href') || '')) return { name: (hl.textContent || 'Account').trim() };
    return null;
  }

  var ICON = {
    orders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
    saves:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
    acct:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M6.7 19a5.5 5.5 0 0 1 10.6 0"/></svg>',
    // linecap=round is load-bearing: the dot under the question mark is a
    // zero-length line, which renders nothing under the default butt cap.
    help:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 1 1 4 2.8c-.7.3-1.1 1-1.1 1.7v.5"/><line x1="12" y1="17.5" x2="12" y2="17.5"/></svg>',
  };

  function buildBagPanel() {
    if (_bagOverlay) return;
    ensureStyles();
    _bagOverlay = document.createElement('div');
    _bagOverlay.className = 'zwf-bag';
    _bagOverlay.innerHTML = '<div class="zwf-bag-panel"><div class="zwf-bag-inner"></div></div>';
    document.body.appendChild(_bagOverlay);
    _bagPanel = _bagOverlay.querySelector('.zwf-bag-inner');
    _bagOverlay.addEventListener('click', function (e) { if (e.target === _bagOverlay) closeBag(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && _bagOverlay.classList.contains('open')) closeBag();
    });
  }

  function renderBagPanel() {
    var cart = bagCart();
    var user = bagUser();
    var total = cart.reduce(function (n, i) { return n + (Number(i.price) || 0) * (Number(i.quantity) || 1); }, 0);

    var items = cart.length ? '<div class="zwf-bag-items">' + cart.slice(0, 6).map(function (i) {
      var meta = [i.color, i.size].filter(Boolean).join(' · ');
      var qty = (Number(i.quantity) || 1) > 1 ? ' × ' + i.quantity : '';
      return '<a class="zwf-bag-item" href="/bag.html">'
        + '<img class="zwf-bag-thumb" src="' + esc(i.image || '') + '" alt="" loading="lazy">'
        + '<div><div class="zwf-bag-nm">' + esc(i.title || 'Item') + '</div>'
        + (meta || qty ? '<div class="zwf-bag-meta">' + esc(meta) + qty + '</div>' : '') + '</div>'
        + '<div class="zwf-bag-price">' + bagMoney((Number(i.price) || 0) * (Number(i.quantity) || 1)) + '</div></a>';
    }).join('') + (cart.length > 6 ? '<a class="zwf-bag-meta" style="text-decoration:none;color:inherit" href="/bag.html">+ ' + (cart.length - 6) + ' more</a>' : '') + '</div>'
      : '<p class="zwf-bag-empty">Your bag is empty.</p>';

    var links = user
      ? '<a class="zwf-bag-link" href="/account.html#orders">' + ICON.orders + 'Orders</a>'
        + '<a class="zwf-bag-link" href="/account.html#saved">' + ICON.saves + 'Your saves</a>'
        + '<a class="zwf-bag-link" href="/account.html#profile">' + ICON.acct + 'Account</a>'
      : '<a class="zwf-bag-link" href="/?auth=signin&next=' + encodeURIComponent(location.pathname) + '">' + ICON.acct + 'Sign in</a>';

    _bagPanel.innerHTML = '<div class="zwf-bag-hd"><h2>Bag' + (cart.length ? ' · ' + bagMoney(total) : '') + '</h2>'
      + '<a class="zwf-bag-review" href="/bag.html">' + (cart.length ? 'Review bag' : 'Start shopping') + '</a></div>'
      + items
      + '<div class="zwf-bag-links"><h3>' + (user ? esc(user.name) : 'My profile') + '</h3>'
      + links
      + '<a class="zwf-bag-link" href="mailto:nasirubreeze@zuwera.store">' + ICON.help + 'Support</a>'
      + '</div>';
  }

  function syncBagTop() {
    if (!_bagOverlay) return;
    if (!isDesktop()) { _bagOverlay.style.top = '0px'; return; }
    _bagOverlay.style.top = headerBottom() + 'px';
  }

  function openBag() {
    closePanels('bag');
    lockScroll();
    buildBagPanel();
    renderBagPanel();
    document.body.classList.add('zwf-searching');   // same header shrink as search
    syncBagTop();
    requestAnimationFrame(function () { _bagOverlay.classList.add('open'); });
    trackHeader(syncBagTop);
    armScrollClose();
    window.addEventListener('resize', syncBagTop);
  }
  function closeBag() {
    if (!_bagOverlay) return;
    _bagOverlay.classList.remove('open');
    document.body.classList.remove('zwf-searching');
    window.removeEventListener('resize', syncBagTop);
    unlockScroll();
    disarmScrollClose();
    trackHeader(syncBagTop);
  }

  function initBagPanel() {
    ensureStyles();
    document.body.classList.add('zwf-bagpanel-on');   // hides the header account button

    // The bag is wired three different ways:
    //   index    — inline onclick → window.__zwOpenCart() → location.assign('/bag.html')
    //   product  — a click listener → goToBagPage()
    //   the rest — a plain <a href="bag.html">
    // The first two navigate PROGRAMMATICALLY, so preventDefault() on a listener
    // of our own can't stop them — we were racing them and losing, which is why
    // clicking the bag still jumped to the page. Intercepting in the capture
    // phase on document runs before all three, and stopping propagation there
    // means none of them ever fire. One hook, no per-page special-casing.
    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest && e.target.closest('#cart-btn, .zw-hdr-bag');
      if (!t) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;  // new-tab still works
      if (/\/bag(\.html)?$/.test(location.pathname)) return;               // already on the bag page
      e.preventDefault();
      e.stopPropagation();
      if (_bagOverlay && _bagOverlay.classList.contains('open')) closeBag(); else openBag();
    }, true);
  }

  /* ── Builder preview: jump to a block ──────────────────────────────────────
     The Page Builder's Product tab posts a block id when you click a row, so the
     panel and the preview stay on the same thing instead of making you hunt for
     it. Blocks render async, so we retry briefly before giving up.
     SECURITY: same-origin only — mirrors storefront.js's builder listener. Without
     it any site that framed us could drive this. */
  (function builderScrollBridge() {
    if (window.top === window.self) return;   // not framed → nothing to do
    var SEL = {
      more_from_release: '#related-products',
      bundle: '[data-zwf="bundle"]',
      recently_viewed: '[data-zwf="recently-viewed"]',
      recommendations: '[data-zwf="recommendations"]',
      qa: '[data-zwf="qa"]',
      new_arrivals: '[data-zwf="new-arrivals"]',
      journal: '[data-zwf="journal"]',
      newsletter: '[data-zwf="newsletter"]',
    };
    function flash(el) {
      el.style.transition = 'outline-color .25s';
      el.style.outline = '2px solid rgba(248,145,165,.9)';
      el.style.outlineOffset = '4px';
      setTimeout(function () { el.style.outlineColor = 'transparent'; }, 1200);
      setTimeout(function () { el.style.outline = ''; el.style.outlineOffset = ''; }, 1600);
    }
    function go(id, tries) {
      var sel = SEL[id];
      if (!sel) return;
      var el = document.querySelector(sel);
      if (!el || el.offsetParent === null) {
        if ((tries || 0) < 12) return setTimeout(function () { go(id, (tries || 0) + 1); }, 250);
        return;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      flash(el);
    }
    window.addEventListener('message', function (e) {
      if (e.origin !== window.location.origin) return;
      if (e.data && e.data.type === 'ZW_SCROLL_TO_PDP_BLOCK') go(String(e.data.blockId || ''), 0);
    });
  })();

  if (typeof window.zwWhenFlags === 'function') window.zwWhenFlags(init);
  else if (document.readyState !== 'loading') init(window.zwFlag);
  else document.addEventListener('DOMContentLoaded', function () { init(window.zwFlag); });
})();
