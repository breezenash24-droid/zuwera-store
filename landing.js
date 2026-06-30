/* ────────────────────────────────────────────────────────────────────────────
   landing.js — Nike-style gender / shop landing page (landing.html?page=<gender>).

   Auto-builds the page from the existing product taxonomy with ZERO config:
     • Hero   — gender title + tagline + "Shop all" CTA (→ drop001.html?gender=X)
     • Shop by category — tiles for every category (subtitle) that exists for the
       gender, clothing-first, each → drop001.html?gender=X&category=Y
     • Featured — a strip of product cards linking to the product page
   Men/Women include Unisex products (not Kids), matching nav-menu.js + drop001.

   If site_settings.landing_pages_published[<slug>] exists (set later by the page
   builder), its fields override the auto-defaults — so the page is editable
   without this file needing to change. Schema (all keys optional):
     { hero:{kicker,title,subtitle,ctaText,ctaUrl,image},
       categories:{heading,order:[],hidden:[],shopAllUrl},
       featured:{heading,mode:'auto'|'manual',productIds:[],limit} }
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
  var SB = 'https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/';
  var H = { apikey: ANON, Authorization: 'Bearer ' + ANON };

  // Clothing-first ordering for the "Shop by category" tiles. Unknown categories
  // sort after these (alphabetically); accessories/socks naturally land last.
  var CLOTHING_ORDER = ['Outerwear', 'Jackets', 'Coats', 'Vests', 'Hoodies', 'Sweatshirts',
    'Sweaters', 'Knitwear', 'Tops', 'T-Shirts', 'Tees', 'Shirts', 'Polos', 'Long Sleeves',
    'Sweatpants', 'Joggers', 'Pants', 'Trousers', 'Leggings', 'Shorts', 'Bottoms',
    'Sets', 'Tracksuits', 'Dresses', 'Skirts', 'Swim', 'Underwear', 'Socks',
    'Hats', 'Caps', 'Beanies', 'Gloves', 'Bags', 'Accessories'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function optImg(u, w) {
    return (typeof window.optimizeImage === 'function') ? window.optimizeImage(u, w || 600) : u;
  }
  function qp(name) { return (new URLSearchParams(window.location.search).get(name) || '').trim(); }

  // Title-case a slug; known genders mapped explicitly.
  function displayGender(slug) {
    var s = String(slug || '').trim();
    if (!s) return '';
    var low = s.toLowerCase();
    if (low === 'men') return 'Men';
    if (low === 'women') return 'Women';
    if (low === 'kids') return 'Kids';
    if (low === 'unisex') return 'Unisex';
    return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function matchGender(p, want) {
    if (!want) return true;
    var g = String((p && p.gender) || '').trim().toLowerCase();
    want = want.toLowerCase();
    if (want === 'men') return g === 'men' || g === 'unisex';
    if (want === 'women') return g === 'women' || g === 'unisex';
    return g === want;
  }
  function matchTag(p, want) {
    if (!want) return true;
    want = String(want).toLowerCase();
    var tags = (p && Array.isArray(p.tags)) ? p.tags : [];
    return tags.some(function (t) { return String(t).trim().toLowerCase() === want; });
  }

  function productSlug(title) {
    if (!title) return '';
    return String(title).replace(/^zuwera\s+/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function productHref(p) {
    var slug = productSlug(p && (p.title || p.name));
    var params = [];
    if (p && p.id) params.push('id=' + encodeURIComponent(p.id));
    if (p && p.sku) params.push('sku=' + encodeURIComponent(p.sku));
    var qs = params.length ? '?' + params.join('&') : '';
    return slug ? ('/product/' + slug + qs) : ('product.html' + qs);
  }
  function firstImage(p) {
    var img = p && p.image_url;
    var rows = (p && p.product_images) || [];
    if (rows.length) {
      rows = rows.slice().sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
      if (rows[0] && rows[0].image_url) img = rows[0].image_url;
    }
    return img || '';
  }
  function priceOf(p) { return p && (p.current_price || p.msrp || p.price); }
  function money(v) { var n = parseFloat(v); return (n || n === 0) && !isNaN(n) ? '$' + n.toFixed(2) : 'Price TBA'; }
  function catOf(p) { return String((p && p.subtitle) || '').trim(); }

  function catSortKey(name) {
    var i = CLOTHING_ORDER.findIndex(function (c) { return c.toLowerCase() === String(name).toLowerCase(); });
    return i === -1 ? 999 : i;
  }

  var ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  var IMG_PH = '<div class="lp-cat-ph"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1"><path d="M3 9l2-5h4l1 3h4l1-3h4l2 5v11H3V9z"/></svg></div>';

  function getConfig(slug) {
    try {
      var all = JSON.parse(localStorage.getItem('zw_landing_pages') || 'null');
      if (all && all[slug]) return all[slug];
    } catch (_) {}
    return null;
  }

  /* ---- PER-PAGE THEME ---------------------------------------------------------
     A landing page can override the global site theme (builder Pages tab). We
     apply it ourselves (and cache per slug for flash-free reloads) WITHOUT
     touching the global zw_theme_mode, and re-assert it if storefront-theme.js
     later applies the global theme (race-proof via the zw-theme-applied event). */
  var _slug = '', _preview = false, pageTheme = null, _tag = '';
  function lpApplyTheme(mode) {
    var resolved = mode === 'dark' ? 'dark' : mode === 'super-light' ? 'super-light' : 'light';
    if (!document.body) return;
    document.body.classList.toggle('light-mode', resolved !== 'dark');
    document.body.classList.toggle('super-light-mode', resolved === 'super-light');
    var color = resolved === 'dark' ? '#09090b' : resolved === 'super-light' ? '#FFFFFF' : '#F0EEE9';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', color);
    document.documentElement.style.backgroundColor = color;
    // Also force the BODY background so transparent sections (the lower part of
    // the page) match — overrides the head flash-prevention style, which keys off
    // the cached/global mode and would otherwise leave the bottom off-white.
    try { document.body.style.setProperty('background-color', color, 'important'); } catch (_) {}
  }
  function applyPageTheme(cfg) {
    var t = cfg && cfg.theme;
    if (t === 'dark' || t === 'light' || t === 'super-light') {
      pageTheme = t;
      lpApplyTheme(t);
      if (!_preview) { try { localStorage.setItem('zw_landing_theme_' + _slug, t); } catch (_) {} }
    } else {
      pageTheme = null;
      try { localStorage.removeItem('zw_landing_theme_' + _slug); } catch (_) {}
      // No override → leave the global theme (storefront-theme.js) in charge.
    }
  }
  // If storefront-theme.js applies the global theme after us, re-assert the override.
  window.addEventListener('zw-theme-applied', function (e) {
    if (pageTheme && e && e.detail && e.detail.mode !== pageTheme) lpApplyTheme(pageTheme);
  });

  function buildPage(products, gender, cfg) {
    cfg = cfg || {};
    // A page is filtered by either a tag (?tag=) or a gender. Tag wins.
    var isTag = !!_tag;
    var gLabel = isTag ? _tag : displayGender(gender);
    var inGender = products.filter(function (p) { return isTag ? matchTag(p, _tag) : matchGender(p, gender); });
    var base = isTag ? ('drop001.html?tag=' + encodeURIComponent(_tag))
             : (gender ? ('drop001.html?gender=' + encodeURIComponent(gLabel)) : 'drop001.html');

    /* ---- HERO ---- */
    var heroCfg = cfg.hero || {};
    var heroTitle = heroCfg.title || (gLabel || 'Shop');
    var heroKicker = heroCfg.kicker || 'Zuwera';
    var heroSub = heroCfg.subtitle || (isTag
      ? ('Explore our ' + gLabel + ' edit.')
      : (gLabel
        ? ('Explore the latest ' + gLabel + "'s pieces — built for movement, made to last.")
        : 'Browse the latest Zuwera collection.'));
    var heroImg = heroCfg.image || firstImage(inGender[0] || products[0] || {});
    var heroVideo = heroCfg.video || '';
    // Show the hero media exactly as uploaded: full quality (no Cloudinary
    // re-encode, which softens crisp logos/line-art) and either Fill (cover) or
    // Fit (contain, shows the whole image). Default Fill.
    var heroFit = (heroCfg.fit === 'contain') ? 'contain' : 'cover';
    // Optional separate mobile artwork/fit (a wide desktop logo/photo rarely
    // crops well on a tall phone). Falls back to the desktop image/fit.
    var heroMobImg = heroCfg.mobileImage || '';
    var heroMobFit = heroCfg.mobileFit || '';
    // Tablet artwork falls back to the mobile image, then the desktop image.
    var heroTabImg = heroCfg.tabletImage || '';
    var heroTabFit = heroCfg.tabletFit || '';
    var heroCtaText = heroCfg.ctaText || ('Shop all ' + (gLabel || 'products'));
    var heroCtaUrl = heroCfg.ctaUrl || base;

    // Background media: a hero video (muted/looping) takes priority over the
    // image; the image doubles as the video poster (first frame).
    var mediaHtml;
    if (heroVideo) {
      mediaHtml = '<video class="lp-hero-bg" style="object-fit:' + heroFit + '" autoplay muted loop playsinline preload="auto"' +
        (heroImg ? ' poster="' + esc(heroImg) + '"' : '') +
        '><source src="' + esc(heroVideo) + '"></video>';
    } else {
      mediaHtml = '<div class="lp-hero-bg"></div>'; // image applied via CSS vars (responsive mobile swap)
    }
    var heroEl = document.getElementById('lp-hero');
    if (heroEl && heroCfg.enabled === false) {
      heroEl.style.display = 'none';   // auto hero turned off in the builder
    } else if (heroEl) {
      heroEl.style.display = '';
      heroEl.innerHTML =
        mediaHtml +
        '<p class="lp-hero-kicker">' + esc(heroKicker) + '</p>' +
        '<h1 class="lp-hero-title">' + esc(heroTitle) + '</h1>' +
        '<p class="lp-hero-sub">' + esc(heroSub) + '</p>' +
        '<a class="lp-hero-cta" href="' + esc(heroCtaUrl) + '">' + esc(heroCtaText) + '</a>';
      if (!heroVideo && heroImg) {
        // Drive the background through CSS custom properties so media queries can
        // swap image/fit per breakpoint (set on the hero; .lp-hero-bg inherits).
        // Fallback chains: mobile → desktop; tablet → mobile → desktop.
        var _fit = function (f, fb) { return (f === 'cover' || f === 'contain') ? f : fb; };
        var _u = function (s) { return "url('" + String(s).replace(/'/g, '%27') + "')"; };
        var mobFitEff = _fit(heroMobFit, heroFit);
        var tabImgEff, tabFitEff;
        if (heroTabImg) { tabImgEff = heroTabImg; tabFitEff = _fit(heroTabFit, heroFit); }
        else if (heroMobImg) { tabImgEff = heroMobImg; tabFitEff = _fit(heroTabFit, mobFitEff); }
        else { tabImgEff = heroImg; tabFitEff = _fit(heroTabFit, heroFit); }
        heroEl.style.setProperty('--lp-hero-img', _u(heroImg));
        heroEl.style.setProperty('--lp-hero-fit', heroFit);
        heroEl.style.setProperty('--lp-hero-img-tab', _u(tabImgEff));
        heroEl.style.setProperty('--lp-hero-fit-tab', tabFitEff);
        heroEl.style.setProperty('--lp-hero-img-mob', _u(heroMobImg || heroImg));
        heroEl.style.setProperty('--lp-hero-fit-mob', mobFitEff);
      }
      // Hero text color (Auto / Light / Dark) — keeps text readable over the image.
      heroEl.classList.remove('lp-hero--lighttext', 'lp-hero--darktext');
      if (heroCfg.textColor === 'light') heroEl.classList.add('lp-hero--lighttext');
      else if (heroCfg.textColor === 'dark') heroEl.classList.add('lp-hero--darktext');
    }
    document.title = (gLabel ? gLabel + ' — Shop ' : 'Shop ') + '| ZUWERA';

    /* ---- SHOP BY CATEGORY ---- */
    var catCfg = cfg.categories || {};
    var catFirstImg = {}; // category -> representative image
    var catList = [];
    inGender.forEach(function (p) {
      var c = catOf(p); if (!c) return;
      if (!(c in catFirstImg)) { catFirstImg[c] = firstImage(p); catList.push(c); }
      else if (!catFirstImg[c]) catFirstImg[c] = firstImage(p);
    });
    var hidden = {}; (catCfg.hidden || []).forEach(function (c) { hidden[String(c).toLowerCase()] = true; });
    catList = catList.filter(function (c) { return !hidden[c.toLowerCase()]; });
    if (Array.isArray(catCfg.order) && catCfg.order.length) {
      var rank = {}; catCfg.order.forEach(function (c, i) { rank[String(c).toLowerCase()] = i; });
      catList.sort(function (a, b) {
        var ra = rank[a.toLowerCase()], rb = rank[b.toLowerCase()];
        if (ra == null) ra = 500 + catSortKey(a); if (rb == null) rb = 500 + catSortKey(b);
        return ra - rb || a.localeCompare(b);
      });
    } else {
      catList.sort(function (a, b) { return catSortKey(a) - catSortKey(b) || a.localeCompare(b); });
    }

    var catSec = document.getElementById('lp-cats-sec');
    var catGrid = document.getElementById('lp-cat-grid');
    if (catCfg.enabled === false) {
      if (catSec) catSec.hidden = true;          // category tiles turned off in the builder
    } else if (catGrid && catList.length) {
      var hCat = document.getElementById('lp-cats-h'); if (hCat && catCfg.heading) hCat.textContent = catCfg.heading;
      var allCat = document.getElementById('lp-cats-all'); if (allCat) allCat.href = catCfg.shopAllUrl || base;
      catGrid.innerHTML = catList.map(function (c) {
        var url = base + (base.indexOf('?') > -1 ? '&' : '?') + 'category=' + encodeURIComponent(c);
        var img = catFirstImg[c];
        var inner = img
          ? '<img src="' + esc(optImg(img, 600)) + '" alt="' + esc(c) + '" loading="lazy">'
          : IMG_PH;
        return '<a class="lp-cat-tile" href="' + esc(url) + '">' + inner +
          '<span class="lp-cat-label">' + esc(c) + ARROW + '</span></a>';
      }).join('');
      if (catSec) catSec.hidden = false;
    } else if (catSec) {
      catSec.hidden = true;
    }

    /* ---- BUILDER SECTIONS (Pages-tab highlights, render below the auto content) ---- */
    try {
      if (window.ZWLandingSections) {
        window.ZWLandingSections.render(document.getElementById('lp-builder-sections'), cfg.sections || []);
      }
    } catch (e) { /* non-fatal — auto content still renders */ }

    /* ---- FEATURED ---- */
    var featCfg = cfg.featured || {};
    var featSec = document.getElementById('main-content');
    if (featCfg.enabled === false) {              // featured products turned off in the builder
      if (featSec) featSec.style.display = 'none';
      return;                                     // builder sections already rendered above
    }
    if (featSec) featSec.style.display = '';
    var pool = inGender.slice();
    var featured;
    if (featCfg.mode === 'manual' && Array.isArray(featCfg.productIds) && featCfg.productIds.length) {
      var byId = {}; products.forEach(function (p) { byId[String(p.id)] = p; });
      featured = featCfg.productIds.map(function (id) { return byId[String(id)]; }).filter(Boolean);
    } else {
      featured = pool;
    }
    var limit = Number(featCfg.limit) || 8;
    featured = featured.slice(0, limit);

    var featH = document.getElementById('lp-feat-h');
    if (featH) featH.textContent = featCfg.heading || (isTag ? gLabel : (gLabel ? (gLabel + "'s featured") : 'Featured'));
    var featAll = document.getElementById('lp-feat-all'); if (featAll) featAll.href = base;
    var grid = document.getElementById('lp-feat-grid');
    if (!grid) return;
    if (!featured.length) {
      grid.innerHTML = '<div class="lp-empty" style="grid-column:1/-1">Nothing here yet — check back soon.</div>';
      return;
    }
    grid.innerHTML = featured.map(function (p) {
      var img = firstImage(p);
      var imgHtml = img
        ? '<img src="' + esc(optImg(img, 600)) + '" alt="' + esc(p.title || '') + '" loading="lazy">'
        : '<div class="lp-card-ph"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1"><path d="M3 9l2-5h4l1 3h4l1-3h4l2 5v11H3V9z"/></svg></div>';
      var st = String(p.status || '').toLowerCase();
      var badge = (st === 'live') ? '' : '<span class="lp-card-badge">' + esc(p.status || 'Coming Soon') + '</span>';
      var g = String(p.gender || '').trim().toLowerCase();
      var gp = g === 'men' ? "Men's " : g === 'women' ? "Women's " : g === 'unisex' ? 'Unisex ' : g === 'kids' ? "Kids' " : '';
      var typeLabel = (gp + (catOf(p) || '')).trim();
      return '<a class="lp-card" href="' + esc(productHref(p)) + '">' +
        '<div class="lp-card-img">' + imgHtml + badge + '</div>' +
        '<p class="lp-card-name">' + esc(p.title || '') + '</p>' +
        '<p class="lp-card-cat">' + esc(typeLabel) + '</p>' +
        '<p class="lp-card-price">' + esc(money(priceOf(p))) + '</p>' +
        '</a>';
    }).join('');
  }

  function init() {
    // A page is keyed by a tag (?tag=) or a gender (?page=/?gender=). Tag pages
    // are namespaced 'tag:<lowercase>' so their config can't collide with genders.
    var tag = qp('tag');
    var gender = tag ? '' : (qp('page') || qp('gender')).toLowerCase();
    var slug = tag ? ('tag:' + tag.toLowerCase()) : gender;
    var preview = !!qp('preview');            // builder preview → read the draft
    var key = preview ? 'landing_pages' : 'landing_pages_published';
    _slug = slug; _preview = preview; _tag = tag;
    // Shared config: whichever fetch (config / products) resolves last rebuilds
    // with the freshest data. Starts from cache (live) or null (preview).
    var loadedCfg = preview ? null : getConfig(slug);
    if (loadedCfg) applyPageTheme(loadedCfg);  // flash-free from cache

    // Refresh config from server (so builder edits show without a hard cache).
    fetch(SB + 'site_settings?select=value&key=eq.' + key, { headers: H })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        var v = rows && rows[0] && rows[0].value;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) {} }
        if (v && typeof v === 'object') {
          if (!preview) { try { localStorage.setItem('zw_landing_pages', JSON.stringify(v)); } catch (_) {} }
          if (v[slug]) { loadedCfg = v[slug]; applyPageTheme(loadedCfg); if (window.__zwProducts) buildPage(window.__zwProducts, gender, loadedCfg); }
          else { applyPageTheme(null); }  // page deleted/never set → clear any cached override
        }
      }).catch(function () {});

    var sel = 'id,title,subtitle,gender,tags,status,current_price,msrp,sku,image_url,sort_order,image_focal_y,product_images(image_url,sort_order)';
    fetch(SB + 'products?select=' + encodeURIComponent(sel) + '&status=neq.Draft&status=neq.Legacy&order=sort_order.asc', { headers: H })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (products) {
        products = Array.isArray(products) ? products : [];
        window.__zwProducts = products;
        buildPage(products, gender, loadedCfg);
      })
      .catch(function () {
        var grid = document.getElementById('lp-feat-grid');
        if (grid) grid.innerHTML = '<div class="lp-empty" style="grid-column:1/-1">Couldn’t load products. <a href="drop001.html" style="color:inherit;text-decoration:underline">Browse the collection →</a></div>';
      });

    // LIVE PREVIEW: the builder (Pages tab) postMessages its in-memory config as
    // it's edited, so unsaved hero/category/featured/section changes render here
    // immediately — no Save Draft needed. Same idea as the homepage's live cfg.
    window.addEventListener('message', function (e) {
      var d = e && e.data;
      if (!d || d.type !== 'ZW_LANDING_PREVIEW') return;
      if (d.slug && d.slug !== slug) return;          // a different page is being edited
      try {
        loadedCfg = d.cfg || loadedCfg;
        applyPageTheme(loadedCfg);
        buildPage(window.__zwProducts || [], gender, loadedCfg);
      } catch (_) {}
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
