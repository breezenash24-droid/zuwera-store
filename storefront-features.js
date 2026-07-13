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
    _catalogPromise = fetch(SUPA + '/rest/v1/products?select=id,title,subtitle,gender,colorway,material_composition,category,tags,current_price,member_price,msrp,sku,image_url,status,sort_order,low_stock_threshold&order=sort_order.asc.nullslast', {
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
      '.zwf-search{position:fixed;inset:0;z-index:4000;display:flex;flex-direction:column;background:rgba(9,9,11,.55);opacity:0;pointer-events:none;transition:opacity .22s ease}',
      '.zwf-search.open{opacity:1;pointer-events:auto}',
      '.zwf-search-panel{background:var(--paper,#f4f1eb);color:var(--ink,#09090b);width:100%;max-height:88vh;display:flex;flex-direction:column;transform:translateY(-14px);transition:transform .26s cubic-bezier(.2,.7,.2,1)}',
      '.zwf-search.open .zwf-search-panel{transform:translateY(0)}',
      '.zwf-search-bar{display:flex;align-items:center;gap:.9rem;padding:1.1rem clamp(1rem,4vw,2.5rem);border-bottom:1px solid rgba(9,9,11,.12)}',
      '.zwf-search-bar svg{width:22px;height:22px;flex:0 0 auto;opacity:.6}',
      '.zwf-search-input{flex:1;background:none;border:none;outline:none;color:inherit;font-family:var(--fw,inherit);font-weight:700;font-size:clamp(1.1rem,3vw,1.7rem);letter-spacing:.02em}',
      '.zwf-search-input::placeholder{color:rgba(9,9,11,.35)}',
      '.zwf-search-close{background:none;border:1px solid rgba(9,9,11,.2);color:inherit;border-radius:100px;padding:.35rem .8rem;cursor:pointer;font-family:var(--fm,inherit);font-size:.62rem;letter-spacing:.14em;text-transform:uppercase}',
      '.zwf-search-close:hover{background:rgba(9,9,11,.06)}',
      '.zwf-search-results{overflow-y:auto;padding:1.4rem clamp(1rem,4vw,2.5rem) 2.4rem}',
      '.zwf-search-meta{font-family:var(--fm,inherit);font-size:.62rem;letter-spacing:.16em;text-transform:uppercase;opacity:.5;margin:0 0 1.1rem}',
      '.zwf-search-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:1.1rem}',
      '@media(min-width:900px){.zwf-search-grid{grid-template-columns:repeat(auto-fill,minmax(190px,1fr))}}',
      '.zwf-search .zwf-card-name,.zwf-search .zwf-card-price{color:var(--ink,#09090b)}',
      '.zwf-empty{padding:3rem 1rem;text-align:center;opacity:.55;font-family:var(--fb,inherit)}',
      '@media(prefers-reduced-motion:reduce){.zwf-search,.zwf-search-panel{transition:none}}',

      /* low-stock chip on homepage product cards (the collection page + product page
         already show their own stock cues, so this only targets .pcard grids) */
      '.zwf-lowstock-badge{position:absolute;top:.8rem;left:.8rem;z-index:2;pointer-events:none;background:#e05252;color:#fff;font-family:var(--fm,var(--fb,inherit));font-size:.55rem;font-weight:700;letter-spacing:.11em;text-transform:uppercase;padding:.3rem .5rem;border-radius:3px;box-shadow:0 2px 8px rgba(0,0,0,.18)}',

      /* fit-finder trigger (next to size guide) */
      '.zwf-fit-btn{background:none;border:none;cursor:pointer;font-family:var(--fm,var(--fb,inherit));font-size:.66rem;letter-spacing:.14em;text-transform:uppercase;color:inherit;opacity:.7;text-decoration:underline;text-underline-offset:3px;padding:0;margin-left:1.1rem}',
      '.zwf-fit-btn:hover{opacity:1}',

      /* shared modal (fit finder) — cream panel that reads on both themes */
      '.zwf-modal{position:fixed;inset:0;z-index:4100;display:flex;align-items:center;justify-content:center;padding:1.2rem;background:rgba(9,9,11,.55);opacity:0;pointer-events:none;transition:opacity .22s ease}',
      '.zwf-modal.open{opacity:1;pointer-events:auto}',
      '.zwf-modal-box{position:relative;background:var(--paper,#f4f1eb);color:var(--ink,#09090b);width:100%;max-width:440px;border-radius:4px;padding:2rem 1.8rem;max-height:90vh;overflow-y:auto;transform:translateY(10px);transition:transform .26s cubic-bezier(.2,.7,.2,1)}',
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
      '.zwf-support-panel{background:var(--paper,#f4f1eb);color:var(--ink,#09090b);width:250px;border-radius:10px;padding:1.2rem;box-shadow:0 12px 40px rgba(0,0,0,.28);opacity:0;transform:translateY(8px) scale(.98);transform-origin:bottom right;pointer-events:none;transition:opacity .2s ease,transform .2s ease}',
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

    // Launcher — inject into the nav's right actions, before the cart button.
    var navRight = document.querySelector('.nav-right');
    if (navRight && !navRight.querySelector('.zwf-search-btn')) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nbtn zwf-search-btn';
      btn.setAttribute('aria-label', 'Search');
      btn.innerHTML = SEARCH_SVG;
      var cart = navRight.querySelector('#cart-btn');
      if (cart) navRight.insertBefore(btn, cart); else navRight.appendChild(btn);
      btn.addEventListener('click', openSearch);
    }

    // "/" opens search (unless typing in a field).
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '')) && !e.target.isContentEditable) {
        e.preventDefault(); openSearch();
      }
    });
  }

  var _overlay = null, _input = null, _results = null, _scrollY = 0;
  function buildOverlay() {
    if (_overlay) return;
    _overlay = document.createElement('div');
    _overlay.className = 'zwf-search';
    _overlay.setAttribute('role', 'dialog');
    _overlay.setAttribute('aria-label', 'Product search');
    _overlay.innerHTML =
      '<div class="zwf-search-panel">'
      + '<div class="zwf-search-bar">' + SEARCH_SVG
      + '<input class="zwf-search-input" type="search" autocomplete="off" spellcheck="false" placeholder="Search products…" aria-label="Search products">'
      + '<button class="zwf-search-close" type="button">Close</button>'
      + '</div>'
      + '<div class="zwf-search-results"></div>'
      + '</div>';
    document.body.appendChild(_overlay);
    _input = _overlay.querySelector('.zwf-search-input');
    _results = _overlay.querySelector('.zwf-search-results');

    _overlay.addEventListener('click', function (e) { if (e.target === _overlay) closeSearch(); });
    _overlay.querySelector('.zwf-search-close').addEventListener('click', closeSearch);
    _input.addEventListener('input', debounce(runSearch, 120));
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && _overlay && _overlay.classList.contains('open')) closeSearch(); });
    _results.innerHTML = '<p class="zwf-empty">Start typing to search the collection.</p>';
  }

  function openSearch() {
    buildOverlay();
    catalog(); // warm the cache
    _scrollY = window.scrollY || 0;
    document.body.style.top = '-' + _scrollY + 'px';
    document.body.style.position = 'fixed';
    document.body.style.width = '100%';
    requestAnimationFrame(function () { _overlay.classList.add('open'); _input.focus(); });
  }

  function closeSearch() {
    if (!_overlay) return;
    _overlay.classList.remove('open');
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
    window.scrollTo(0, _scrollY);
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
        + '<div class="zwf-search-grid">' + hits.map(function (x) { return card(x.p); }).join('') + '</div>';
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

  function init(zwFlag) {
    var f = (typeof zwFlag === 'function') ? zwFlag : function () { return false; };
    var wantSearch = f('feature_search');
    var wantRV = f('feature_recently_viewed');
    var wantRec = f('feature_recommendations');
    var wantLowStock = f('feature_low_stock');
    var wantFit = f('feature_fit_finder');
    var wantSupport = f('feature_support_widget');
    if (!(wantSearch || wantRV || wantRec || wantLowStock || wantFit || wantSupport)) return;

    if (wantSearch) initSearch();
    if (wantSupport) initSupport();
    if (wantLowStock) initLowStock(); // decorates homepage .pcard grids; no-op elsewhere

    var wantPdp = wantRV || wantRec || wantFit;
    var onPdp = /\/product(\.html|\/)/i.test(location.pathname) || !!document.querySelector('.product-detail, #product-detail, .size-section');
    if (wantPdp && (onPdp || window.__zwCurrentProduct)) {
      onProduct(function (p) {
        if (wantRV) { rvRecord(p); rvTrackDwell(p); }
        if (wantFit) initFitFinder(p);
        if (wantRec) renderRecommendations(p);
        if (wantRV) renderRecentlyViewed(p.id);
      });
    }
    // Homepage placement is controlled by the builder's "Recently Viewed" section
    // (storefront.js calls window.zwRenderRecentlyViewed into the container the admin
    // positions) — so there is no auto-insert on the homepage anymore.
  }

  if (typeof window.zwWhenFlags === 'function') window.zwWhenFlags(init);
  else if (document.readyState !== 'loading') init(window.zwFlag);
  else document.addEventListener('DOMContentLoaded', function () { init(window.zwFlag); });
})();
