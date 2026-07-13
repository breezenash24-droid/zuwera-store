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

  // Catalog: fetched once, memoized. Falls back to the homepage's session cache.
  var _catalog = null, _catalogPromise = null;
  function catalog() {
    if (_catalog) return Promise.resolve(_catalog);
    if (_catalogPromise) return _catalogPromise;
    _catalogPromise = fetch(SUPA + '/rest/v1/products?select=id,title,subtitle,gender,colorway,material_composition,category,tags,current_price,member_price,msrp,sku,image_url,status,sort_order&order=sort_order.asc.nullslast', {
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
      '@media(prefers-reduced-motion:reduce){.zwf-search,.zwf-search-panel{transition:none}}'
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
  function rvRecord(p) {
    if (!p || !p.id) return;
    var list = rvGet().filter(function (x) { return x.id !== p.id; });
    list.unshift({ id: p.id, title: nameOf(p), subtitle: typeOf(p), price: priceOf(p), image_url: imgOf(p), sku: p.sku || '', ts: Date.now() });
    try { localStorage.setItem(RV_KEY, JSON.stringify(list.slice(0, 12))); } catch (_) {}
  }
  function renderRecentlyViewed(excludeId) {
    var list = rvGet().filter(function (x) { return x.id !== excludeId; }).slice(0, 10);
    if (list.length < 2) return; // not worth a row for 0–1 items
    ensureStyles();
    var sec = strip('Recently viewed', list.map(card).join(''));
    sec.setAttribute('data-zwf', 'recently-viewed');
    insertBeforeFooter(sec);
  }

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
      var sec = strip('You may also like', rel.map(card).join(''));
      sec.setAttribute('data-zwf', 'recommendations');
      insertBeforeFooter(sec);
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

  function init(zwFlag) {
    var f = (typeof zwFlag === 'function') ? zwFlag : function () { return false; };
    var wantSearch = f('feature_search');
    var wantRV = f('feature_recently_viewed');
    var wantRec = f('feature_recommendations');
    if (!wantSearch && !wantRV && !wantRec) return;

    if (wantSearch) initSearch();

    var onPdp = /\/product(\.html|\/)/i.test(location.pathname) || !!document.querySelector('.product-detail, #product-detail');
    if (onPdp || window.__zwCurrentProduct) {
      onProduct(function (p) {
        if (wantRV) rvRecord(p);
        if (wantRec) renderRecommendations(p);
        if (wantRV) renderRecentlyViewed(p.id);
      });
    } else if (wantRV && isHome()) {
      renderRecentlyViewed(null);
    }
  }

  if (typeof window.zwWhenFlags === 'function') window.zwWhenFlags(init);
  else if (document.readyState !== 'loading') init(window.zwFlag);
  else document.addEventListener('DOMContentLoaded', function () { init(window.zwFlag); });
})();
