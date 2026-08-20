/* ────────────────────────────────────────────────────────────────────────────
   nav-menu.js — admin-editable header navigation with hover mega-menu.

   Reads site_settings.nav_menu — an array of top-level items. Each item is one of:
     • Gender group — { type:"gender", label:"Men", gender:"Men", shopAll?:true,
         columns?:[{ heading, categories:[subtitle,…] }] }
       Auto-lists the product categories (subtitle) that exist for that gender,
       where Unisex products count for both Men and Women (not Kids). Empty
       categories/columns are hidden, so it grows with the catalogue. Links go to
       drop001.html?gender=<Gender>[&category=<subtitle>].
     • Tag item — { type:"tag", label:"New", tag:"New" }
       A link to drop001.html?tag=<tag> (products carry a tags[] field).
     • Custom link — { type:"link", label, url?, columns?:[{heading, links:[{text,url}]}] }
       Plain link and/or a manual mega-menu.

   Renders the desktop mega-menu into #nav-category-links (homepage) and the
   mobile accordion into #mobile-category-links (every storefront page). Falls
   back to the auto-category nav when nav_menu is empty. Cached in localStorage.
   CSS: .zw-navitem / .zw-mega / .zw-macc-* in storefront-cohesion.css.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
  var SB = 'https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/';
  var H = { apikey: ANON, Authorization: 'Bearer ' + ANON };

  var navCfg = null;   // array of raw items
  var tax = null;      // { byGender:{men:{Jackets:true,…},…}, tags:{…} }
  var _navSettled = false; // has the server nav_menu fetch resolved (or timed out)?

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function safeUrl(u) {
    u = String(u == null ? '' : u).trim();
    if (!u || u.slice(0, 2) === '//') return '#';
    if (/^(?:javascript|data|vbscript|file):/i.test(u)) return '#';
    if (/^[#/]/.test(u)) return u;
    if (/^(?:https?:\/\/|mailto:|tel:)/i.test(u)) return u;
    if (/^[\w][\w./?=&%#+-]*$/.test(u)) return u;
    return '#';
  }
  function cacheGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } }

  // Build the gender→categories + tags index from a lightweight product list.
  function buildTax(products) {
    var byGender = {}, tags = {}, byTag = {};
    function add(g, sub) { (byGender[g] = byGender[g] || {})[sub] = true; }
    function addTag(tl, sub) { (byTag[tl] = byTag[tl] || {})[sub] = true; }
    (products || []).forEach(function (p) {
      var sub = String((p && p.subtitle) || '').trim();
      var g = String((p && p.gender) || '').trim().toLowerCase();
      if (sub) {
        if (g) add(g, sub);
        if (g === 'unisex') { add('men', sub); add('women', sub); }
      }
      ((p && Array.isArray(p.tags)) ? p.tags : []).forEach(function (t) {
        t = String(t || '').trim();
        if (t) { tags[t.toLowerCase()] = t; if (sub) addTag(t.toLowerCase(), sub); }
      });
    });
    /* AUTO-HIDE IS A COMPARISON, AND AN EMPTY SHOP HAS NOTHING TO COMPARE.
     *
     * Items with no products behind them are hidden, which is right when SOME
     * categories have stock and others do not — a "Women" link leading to an
     * empty page is a dead end. It is wrong when the catalogue is empty
     * altogether: then every item hides at once and the header loses its whole
     * navigation, which does not read as "no stock", it reads as a broken site.
     *
     * That case is now reachable on purpose. An empty product preset takes the
     * entire lineup off the storefront in one click, and the first thing it did
     * was strip MEN / WOMEN / NEW out of the header.
     *
     * `empty` says the taxonomy was built and found nothing, which resolveItem
     * treats the way it already treats a taxonomy it has not loaded yet: show
     * the item, without a mega-menu. One question, one existing answer. */
    var empty = !Object.keys(byGender).length && !Object.keys(tags).length;
    return { byGender: byGender, tags: tags, byTag: byTag, empty: empty };
  }

  // Normalize any raw item to { label, url, columns:[{heading,links:[{text,url}]}] }.
  // url '' means the top is a hover trigger only. Returns null to hide the item.
  function resolveItem(item) {
    if (!item || !item.label) return null;
    var type = item.type || (item.gender ? 'gender' : (item.tag ? 'tag' : 'link'));
    var label = item.label;

    if (type === 'gender') {
      var gender = item.gender || item.label;
      var set = (tax && tax.byGender[String(gender).toLowerCase()]) || null;
      // Top link → the gender landing page; mega-menu links → the filtered PLP.
      var landing = item.url || ('landing.html?page=' + encodeURIComponent(String(gender).toLowerCase()));
      /* Not loaded yet, or loaded and completely empty — both mean "there is
         nothing here to choose between", so the item stands with no mega-menu
         rather than vanishing. */
      if (!tax || tax.empty) return { label: label, url: landing, columns: [] };
      if (!set) return null; // no products for this gender — hide it
      var avail = {}; Object.keys(set).forEach(function (s) { avail[s.toLowerCase()] = s; });
      var base = 'drop001.html?gender=' + encodeURIComponent(gender);
      var columns = [], placed = {};
      var defs = (Array.isArray(item.columns) && item.columns.length) ? item.columns : null;
      if (defs) {
        defs.forEach(function (col) {
          var links = (col.categories || []).map(function (c) {
            var actual = avail[String(c).toLowerCase()];
            if (actual) { placed[actual.toLowerCase()] = true; return { text: actual, url: base + '&category=' + encodeURIComponent(actual) }; }
            return null;
          }).filter(Boolean);
          if (links.length) columns.push({ heading: col.heading || '', links: links });
        });
      }
      var leftovers = Object.keys(avail).filter(function (k) { return !placed[k]; }).map(function (k) { return avail[k]; });
      if (leftovers.length) columns.push({ heading: defs ? 'More' : '', links: leftovers.map(function (c) { return { text: c, url: base + '&category=' + encodeURIComponent(c) }; }) });
      if (item.shopAll !== false) columns.unshift({ heading: '', links: [{ text: 'Shop all ' + label, url: base }] });
      return { label: label, url: landing, columns: columns };
    }

    if (type === 'tag') {
      // Tag top click → its editable landing page; hover → a mega of the product
      // categories that carry this tag (mirrors the gender items), linking to the
      // tag-filtered PLP.
      var tagName = item.tag || label;
      var tlanding = item.url || ('landing.html?tag=' + encodeURIComponent(tagName));
      if (!tax || tax.empty) return { label: label, url: tlanding, columns: [] };
      var tset = (tax && tax.byTag && tax.byTag[String(tagName).toLowerCase()]) || null;
      if (!tset) return null; // no products for this tag -> hide it
      var tbase = 'drop001.html?tag=' + encodeURIComponent(tagName);
      var tcats = Object.keys(tset).sort(function (a, b) { return a.localeCompare(b); });
      var tcolumns = [];
      if (item.shopAll !== false) tcolumns.push({ heading: '', links: [{ text: 'Shop all ' + label, url: tbase }] });
      if (tcats.length) tcolumns.push({ heading: '', links: tcats.map(function (c) { return { text: c, url: tbase + '&category=' + encodeURIComponent(c) }; }) });
      return { label: label, url: tlanding, columns: tcolumns };
    }

    // custom link
    var cols = (item.columns || []).map(function (col) {
      return {
        heading: col.heading || '',
        links: (col.links || []).map(function (l) { return { text: l.text || '', url: safeUrl(l.url) }; }).filter(function (l) { return l.text; })
      };
    }).filter(function (c) { return c.heading || c.links.length; });
    return { label: label, url: item.url ? safeUrl(item.url) : '', columns: cols };
  }

  function resolveAll() {
    /* Carry the index in nav_menu through to the rendered item. resolveItem can
       drop an item (a gender with no products disappears), so the position on
       screen is NOT the position in the stored array -- and an inline edit that
       wrote back by screen position would rename the wrong link. */
    return (navCfg || []).map(function (it, i) {
      var r = resolveItem(it);
      if (r) r._i = i;
      return r;
    }).filter(Boolean);
  }

  /* Builder preview only: name the exact field behind each label so an on-canvas
     edit writes to nav_menu[i].label instead of being matched by its text. The
     attribute never reaches a shopper. */
  function fieldAttr(n) {
    if (!window.__ZW_BUILDER_PREVIEW__ || typeof n._i !== 'number') return '';
    return ' data-zw-field="nav.' + n._i + '.label" data-zw-field-label="the navigation menu"';
  }

  // Ensure the desktop nav-link host exists. index/landing have
  // #nav-category-links in markup, but product/collection/about/etc. don't —
  // inject it so MEN/WOMEN/NEW appear on every page.
  function ensureDesktopNavHost() {
    var host = document.getElementById('nav-category-links');
    if (host) return host;
    var nav = document.querySelector('nav#nav, nav.nav, header.nav, nav.zw-nav, header.zw-nav, .zw-nav');
    if (!nav) return null;
    host = document.createElement('div');
    host.id = 'nav-category-links';
    host.className = 'nav-center';
    var right = null, kids = nav.children;
    for (var i = 0; i < kids.length; i++) {
      if (/\b(nav-right|nav-actions|zw-nav-right|zw-nav-actions)\b/.test(kids[i].className || '')) { right = kids[i]; break; }
    }
    if (right) nav.insertBefore(host, right); else nav.appendChild(host);
    return host;
  }
  function renderDesktop(items) {
    var host = ensureDesktopNavHost();
    if (!host) return;
    host.innerHTML = items.map(function (n) {
      var top = n.url
        ? '<a href="' + esc(n.url) + '" class="nav-link"' + fieldAttr(n) + '>' + esc(n.label) + '</a>'
        : '<button type="button" class="nav-link zw-navtrigger"' + fieldAttr(n) + '>' + esc(n.label) + '</button>';
      if (!n.columns.length) return '<div class="zw-navitem">' + top + '</div>';
      var mega = '<div class="zw-mega">' + n.columns.map(function (c) {
        var links = c.links.map(function (l) { return '<a href="' + esc(l.url) + '">' + esc(l.text) + '</a>'; }).join('');
        return '<div class="zw-mega-col">' + (c.heading ? '<h4>' + esc(c.heading) + '</h4>' : '') + links + '</div>';
      }).join('') + '</div>';
      return '<div class="zw-navitem zw-has-mega">' + top + mega + '</div>';
    }).join('');
  }

  function renderMobile(items) {
    var host = document.getElementById('mobile-category-links');
    if (!host) return;
    // Hamburger menu: every item is a plain link straight to its page.
    host.innerHTML = items.map(function (n) {
      return '<a href="' + esc(n.url || '#') + '" class="mobile-nav-link zw-mobile-primary-link"' + fieldAttr(n) + '>' + esc(n.label) + '</a>';
    }).join('');
  }

  // The full-width mega panel drops from just under the header — measure where
  // that is (varies with the announcement bar / nav height) into --zw-megatop.
  var _megaTopVal = '', _megaGapVal = '';
  function setMegaTop() {
    try {
      var nav = document.querySelector('nav#nav, header.nav, nav.nav, nav.zw-nav');
      if (!nav) return;
      // floor, not round: a fractional header bottom must never round UP past the
      // real edge (the panel sits below the header in z, so a sub-pixel overlap is
      // invisible but a sub-pixel gap shows a hairline of the page behind).
      var bottom = nav.getBoundingClientRect().bottom;
      var v = Math.max(0, Math.floor(bottom)) + 'px';
      if (v !== _megaTopVal) { _megaTopVal = v; document.documentElement.style.setProperty('--zw-megatop', v); }

      /* ── HOW FAR THE HOVER BRIDGE HAS TO REACH ────────────────────────────
       * The panel opens under the header, and the category it belongs to ends
       * well above the header's bottom edge — so moving the cursor down from
       * the word to the panel crosses dead space, and the panel would close on
       * the way. .zw-mega::before is the cover for that space.
       *
       * It was a FIXED 1.6rem, which is a guess about a distance that changes
       * with the arrangement. On a one-row header the real gap is ~15px, so the
       * bridge overhung the categories by 11px. On a TWO-ROW header the
       * categories sit at the bottom of the bar and end 3px BELOW it — the gap
       * is negative, there is nothing to bridge, and 25.6px of invisible panel
       * lay across the whole row. Measured at 1222px, categories on their own
       * row, panel open:
       *
       *     nav bottom 114.4   labels 81.4 -> 117.4   bridge 88.8 -> 114.4
       *     elementFromPoint at every label centre:  div.zw-mega
       *
       * Every category dead, in both arrangements that put them on a second
       * row, and clickable in the six that do not. That is the whole of "the
       * category buttons aren't clickable in some formats".
       *
       * So measure it rather than guessing: exactly the space between the
       * bottom of the categories and the bottom of the bar, and never less than
       * nothing. floor() under-estimates, which is the safe direction — a
       * bridge a pixel short closes on a diagonal flick; a bridge a pixel long
       * eats a click on the word above it. */
      /* The LOWEST edge anything hoverable reaches, not the item's own box.
         .nav-link carries padding that overflows .zw-navitem — measured, 36px of
         link inside 25px of item — and hovering that overflow still counts as
         hovering the item. Bridging from the item's bottom would lay 11px of
         panel across the bottom of every word. */
      var low = 0;
      document.querySelectorAll('.nav-center .zw-navitem, .nav-center .zw-navitem > .nav-link')
        .forEach(function (el) { low = Math.max(low, el.getBoundingClientRect().bottom); });
      var gap = low ? Math.max(0, Math.floor(bottom - low)) : 0;
      var g = gap + 'px';
      if (g !== _megaGapVal) { _megaGapVal = g; document.documentElement.style.setProperty('--zw-megabridge', g); }
    } catch (_) {}
  }

  function render() {
    // Reveal the nav once we've settled, clearing the no-flash hide
    // (html:not(.zw-nav-ready) #nav-category-links).
    function ready() { document.documentElement.classList.add('zw-nav-ready'); }
    if (Array.isArray(navCfg) && navCfg.length) {
      window.__zwCustomNavApplied = true;
      var items = resolveAll();
      renderDesktop(items);
      renderMobile(items);
      ready();
      setMegaTop();
      return;
    }
    // No custom nav. Keep the built-in fallback links HIDDEN until the server has
    // confirmed there's genuinely no custom menu — otherwise a first (uncached)
    // load flashes the fallback and then swaps to the real menu. _navSettled is
    // set once the fetch resolves/fails or the safety timeout fires.
    if (_navSettled) ready();
  }

  // Mobile accordion toggle (delegated).
  document.addEventListener('click', function (e) {
    var t = e.target.closest('.zw-macc-toggle');
    if (!t) return;
    e.preventDefault(); e.stopPropagation();   // toggle only — the name link still navigates
    var row = t.closest('.zw-macc-row');
    var panel = (row || t).nextElementSibling;
    var open = t.classList.toggle('open');
    t.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (panel && panel.classList.contains('zw-macc-panel')) panel.style.maxHeight = open ? (panel.scrollHeight + 'px') : '0px';
  });

  /* Held in a preview until the draft has answered — see ZWPreviewHold in
     preview-mode.js. Applying the cached nav straight away is right on the real
     storefront and wrong on the canvas, where the published labels are exactly
     what must not be shown. */
  var gate = (window.ZWPreviewHold || function (f) {
    return { preview: false, published: f, draft: function (v) { if (v != null) f(v); } };
  })(function (items) {
    navCfg = items;
    _navSettled = true;
    render();
  });

  function init() {
    /* Same as the bar: a ?zwpreview= link carries the DRAFT nav, so "Preview
       live" shows the labels you saved rather than the published ones. It wins
       over the cache and over the fetch, and sets _navSettled so the fallback
       is never shown behind it. */
    if (window.__zwPreviewReady && window.__zwPreviewReady.then) {
      window.__zwPreviewReady.then(function (pv) {
        gate.draft(pv && Array.isArray(pv.nav_menu) ? pv.nav_menu : null);
      }).catch(function () { gate.draft(null); });
    }
    var cached = cacheGet('zw_nav_menu');
    if (cached) gate.published(cached);
    var t = cacheGet('zw_nav_tax');
    if (t) tax = t;
    // If a custom nav is cached, it renders now (no flash). If not, render() holds
    // the fallback hidden until the fetch below settles. Safety net so the nav is
    // never stuck hidden on a slow/failed fetch:
    setTimeout(function () { if (!_navSettled) { _navSettled = true; render(); } }, 3000);
    render();
    var _mt = 0;
    function _onMt() { if (_mt) return; _mt = (window.requestAnimationFrame || setTimeout)(function () { _mt = 0; setMegaTop(); }); }
    window.addEventListener('resize', _onMt, { passive: true });
    window.addEventListener('scroll', _onMt, { passive: true, capture: true });
    // While a nav item (or its open panel) is hovered/focused, keep --zw-megatop
    // glued to the header EVERY FRAME. A one-shot measure at hover/scroll time
    // goes stale: the header keeps animating for ~350ms after the last scroll
    // event (.scrolled padding shrink, announcement-bar offset, auto-hide slide),
    // so a wheel scroll with the mouse resting on the item left the open panel
    // floating a few px below the header — a sliver of the page showed through.
    var _glue = 0;
    function _glueLoop() {
      setMegaTop();
      var open = false;
      try { open = !!document.querySelector('.zw-navitem:hover, .zw-navitem:focus-within'); } catch (_) {}
      _glue = open ? (window.requestAnimationFrame || setTimeout)(_glueLoop) : 0;
    }
    /* MEASURE BEFORE THE PANEL IS DRAWN, NOT ON THE NEXT FRAME.
     *
     * This only started the rAF loop, so the first frame of every open used
     * whatever --zw-megatop happened to hold — and the CSS opens the panel on
     * :hover / :focus-within immediately. When the held value was stale the
     * panel appeared UP INSIDE THE HEADER, on top of the categories, and its
     * transparent hover bridge (.zw-mega::before, full width, 1.6rem tall)
     * came with it. Measured in the builder preview at 1222px, with the panel
     * opened by focus:
     *
     *     --zw-megatop  67px      nav bottom  116.8px      49.8px out
     *     panel box     55 -> 347     category labels  40 -> 76
     *     elementFromPoint at every label centre:  div.zw-mega
     *
     * Every category in the bar was unclickable, and which ones depended on the
     * arrangement — a two-row header puts its labels lower, so a stale value
     * covered two of three instead of three of three. That is the whole of
     * "the category buttons aren't clickable in some formats": nothing was
     * wrong with the links, an invisible panel was sitting on them.
     *
     * Synchronously here, the value is right before the frame that reveals the
     * panel is composited. The loop still runs after, for the header that keeps
     * moving (scroll padding, auto-hide, the bar sliding). */
    function _glueStart(e) {
      if (!(e.target.closest && e.target.closest('.zw-navitem'))) return;
      setMegaTop();
      if (!_glue) _glue = (window.requestAnimationFrame || setTimeout)(_glueLoop);
    }
    document.addEventListener('mouseover', _glueStart, { passive: true });
    document.addEventListener('focusin', _glueStart);
    setTimeout(setMegaTop, 450); setTimeout(setMegaTop, 1300);

    /* ── AND KEEP IT HONEST WHILE NOTHING IS HOVERED ──────────────────────────
     * Two sampled measurements and a resize/scroll listener cannot see the two
     * things that actually move this header, because neither is a resize and
     * neither is a scroll:
     *
     *   the announcement bar arriving   pushes the nav down ~25px, and in a
     *                                   builder preview it is held back until
     *                                   the draft answers — after 1300ms.
     *   the arrangement changing        1 row -> 2 rows is 67px -> 89px, and it
     *                                   lands whenever the settings row does;
     *                                   in the builder that is every time you
     *                                   pick a layout.
     *
     * So watch for them instead of sampling and hoping. The observers are cheap
     * and idle: one fires when the bar or the nav changes size, the other only
     * when a data-zw-hdr-* attribute is written. */
    try {
      if (window.ResizeObserver) {
        var _ro = new ResizeObserver(_onMt);
        var _watch = function (el) { if (el) try { _ro.observe(el); } catch (_) {} };
        _watch(document.querySelector('nav#nav, header.nav, nav.nav, nav.zw-nav'));
        _watch(document.getElementById('bar'));
      }
      if (window.MutationObserver) {
        new MutationObserver(_onMt).observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-zw-hdr', 'data-zw-hdr-logo', 'data-zw-hdr-links',
            'data-zw-hdr-actions', 'data-zw-hdr-linksrow', 'data-zw-iconlabels'],
        });
      }
    } catch (_) {}
    // Refresh nav config + product taxonomy from the server.
    try {
      fetch(SB + 'site_settings?select=value&key=eq.nav_menu', { headers: H })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rows) {
          var v = rows && rows[0] && rows[0].value;
          if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) {} }
          var pub = Array.isArray(v) ? v : [];
          try { localStorage.setItem('zw_nav_menu', JSON.stringify(pub)); } catch (_) {}
          /* Cached either way — it is what the next NORMAL load should paint
             from. The gate decides whether it is also applied now: in a preview
             it is held until the draft has answered, and dropped entirely once
             one has, since this response usually lands second and would
             otherwise undo the whole point of the preview. */
          gate.published(pub);
        }).catch(function () { _navSettled = true; render(); });
      fetch(SB + 'products?select=gender,subtitle,tags&status=neq.Legacy&status=neq.Draft', { headers: H })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (products) {
          if (!Array.isArray(products)) return;
          tax = buildTax(products);
          try { localStorage.setItem('zw_nav_tax', JSON.stringify(tax)); } catch (_) {}
          render();
        }).catch(function () {});
    } catch (_) {}
  }

  /* The builder holds the nav DRAFT in memory and pushes it in here. It is not
     fetched: nav_menu_draft is deliberately absent from the site_settings
     public-read policy (migration 0026), so unpublished labels are not sitting
     behind a REST call whose key name ships in this file. */
  if (window.__ZW_BUILDER_PREVIEW__) {
    window.addEventListener('message', function (e) {
      if (e.origin !== location.origin) return;
      var d = e.data;
      if (!d || d.type !== 'ZW_NAV_PREVIEW' || !Array.isArray(d.items)) return;
      gate.draft(d.items);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

/* ── Referral link capture ───────────────────────────────────────────────────
   A friend's link looks like /?ref=CODE. Remember the code so checkout can
   prefill it in the promo box (commerce-checkout.js). Purely a convenience —
   the code is still validated server-side like any other promo. */
(function () {
  try {
    var ref = new URLSearchParams(location.search).get('ref');
    if (!ref) return;
    ref = String(ref).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20);
    if (ref) localStorage.setItem('zw_ref', ref);
  } catch (_) {}
})();

/* ── Journal footer link toggle ──────────────────────────────────────────────
   Hides the footer + mobile "Journal" link when the admin turns it off
   (site_settings.journal_settings.show_footer_link, exposed via
   /api/journal-config). Applies instantly from the shared cache, then refreshes
   from the server so first-time visitors and changes are picked up. Only exact
   /journal.html links are touched, so content links (…?slug=) are unaffected. */
(function () {
  function apply(show) {
    var links = document.querySelectorAll('a[href="/journal.html"], a[href="journal.html"]');
    for (var i = 0; i < links.length; i++) links[i].style.display = (show === false) ? 'none' : '';
  }
  function run() {
    // Instant from the shared cache (no flash for returning visitors).
    try {
      var c = JSON.parse(localStorage.getItem('zw_journal_cfg') || 'null');
      if (c && typeof c.fl === 'boolean') apply(c.fl);
    } catch (_) {}
    // Authoritative refresh — no-store so a stale HTTP-cached response can't
    // re-show a link the admin just hid.
    fetch('/api/journal-config', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (!cfg) return;
        var show = cfg.show_footer_link !== false;
        try {
          var o = JSON.parse(localStorage.getItem('zw_journal_cfg') || '{}') || {};
          o.fl = show;
          localStorage.setItem('zw_journal_cfg', JSON.stringify(o));
        } catch (_) {}
        apply(show);
      })
      .catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
