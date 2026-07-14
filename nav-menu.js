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
    return { byGender: byGender, tags: tags, byTag: byTag };
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
      if (!tax) return { label: label, url: landing, columns: [] };
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
      if (!tax) return { label: label, url: tlanding, columns: [] };
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
    return (navCfg || []).map(resolveItem).filter(Boolean);
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
        ? '<a href="' + esc(n.url) + '" class="nav-link">' + esc(n.label) + '</a>'
        : '<button type="button" class="nav-link zw-navtrigger">' + esc(n.label) + '</button>';
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
      return '<a href="' + esc(n.url || '#') + '" class="mobile-nav-link zw-mobile-primary-link">' + esc(n.label) + '</a>';
    }).join('');
  }

  // The full-width mega panel drops from just under the header — measure where
  // that is (varies with the announcement bar / nav height) into --zw-megatop.
  var _megaTopVal = '';
  function setMegaTop() {
    try {
      var nav = document.querySelector('nav#nav, header.nav, nav.nav, nav.zw-nav');
      if (!nav) return;
      // floor, not round: a fractional header bottom must never round UP past the
      // real edge (the panel sits below the header in z, so a sub-pixel overlap is
      // invisible but a sub-pixel gap shows a hairline of the page behind).
      var v = Math.max(0, Math.floor(nav.getBoundingClientRect().bottom)) + 'px';
      if (v !== _megaTopVal) { _megaTopVal = v; document.documentElement.style.setProperty('--zw-megatop', v); }
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

  function init() {
    navCfg = cacheGet('zw_nav_menu');
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
    function _glueStart(e) {
      if (e.target.closest && e.target.closest('.zw-navitem') && !_glue) _glue = (window.requestAnimationFrame || setTimeout)(_glueLoop);
    }
    document.addEventListener('mouseover', _glueStart, { passive: true });
    document.addEventListener('focusin', _glueStart);
    setTimeout(setMegaTop, 450); setTimeout(setMegaTop, 1300);
    // Refresh nav config + product taxonomy from the server.
    try {
      fetch(SB + 'site_settings?select=value&key=eq.nav_menu', { headers: H })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rows) {
          var v = rows && rows[0] && rows[0].value;
          if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) {} }
          navCfg = Array.isArray(v) ? v : [];
          try { localStorage.setItem('zw_nav_menu', JSON.stringify(navCfg)); } catch (_) {}
          _navSettled = true;
          render();
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
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
