/* ────────────────────────────────────────────────────────────────────────────
   header-layouts.js — WHERE things sit in the header, not what they look like.

   The header has always had exactly one arrangement: logo left, category links
   centred, actions right. Every other arrangement a shop might want — a centred
   logo, the account button on the far left, the links pushed left with the logo
   in the middle — needed markup edits on fourteen pages.

   A layout here is nothing but POSITION. Three slots, and which items sit in
   each, in order:

       { left: ['logo'], center: ['links'], right: ['search','account','bag'] }

   No colours, no sizes, no fonts. Those belong to the theme, which already owns
   them, and mixing the two is how a "layout" quietly becomes a second styling
   system nobody can find the switch for.

   ── ONE DEFINITION, TWO READERS ─────────────────────────────────────────────

   The builder draws a miniature of each layout in its picker; the storefront
   rearranges the real header. Both read the SAME array below, and the miniature
   is generated FROM the slots rather than drawn by hand — so a tile cannot
   promise an arrangement the applier does not produce. A picker whose pictures
   disagree with the result is worse than no picker.

   ── ITEMS ARE FOUND, NOT ASSUMED ────────────────────────────────────────────

   This storefront has more than one header dialect: index.html and product.html
   ship `.nav-right` with `.nbtn` buttons, other pages get `.zw-hdr-group` with
   `.zw-hdr-action`. Each item therefore has a LIST of candidate selectors and
   the first one present wins. An item that does not exist on a page is skipped,
   never faked — a layout is a preference about the things that are there.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* An item that is in no slot is HIDDEN from the header rather than left where
     it was — "the account button lives in the bag panel" is a real arrangement,
     and it is expressed by leaving `account` out. */
  var ITEMS = {
    logo:    { label: 'Logo',       sel: ['.nav-logo', '.zw-hdr-logo', '.nav-brand'] },
    links:   { label: 'Categories', sel: ['#nav-category-links', '.nav-center', '.zw-hdr-nav'] },
    search:  { label: 'Search',     sel: ['.zwf-search-btn'] },
    account: { label: 'Account',    sel: ['#account-btn', '#login-btn', '.zw-hdr-account'] },
    bag:     { label: 'Bag',        sel: ['#cart-btn', '.zw-hdr-bag', '.nav-cart'] },
    menu:    { label: 'Menu',       sel: ['.hamburger-btn', '#mobile-menu-btn'] },
  };

  /* The order here is the order they appear in the picker, and it runs from the
     most familiar to the least, so the first thing you see is the one you
     already have. */
  var LAYOUTS = [
    { id: 'classic', name: 'Classic',
      note: 'Logo left, categories centred, actions right. What the site uses today.',
      slots: { left: ['logo'], center: ['links'], right: ['search', 'account', 'bag', 'menu'] } },

    { id: 'account-in-bag', name: 'Account in the bag panel',
      note: 'Same as Classic, but the account button is left out of the header — you reach your account from inside the bag panel.',
      slots: { left: ['logo'], center: ['links'], right: ['search', 'bag', 'menu'] } },

    { id: 'links-left', name: 'Categories beside the logo',
      note: 'Logo and categories together on the left, everything else on the right.',
      slots: { left: ['logo', 'links'], center: [], right: ['search', 'account', 'bag', 'menu'] } },

    { id: 'logo-center', name: 'Centred logo',
      note: 'Categories move left and the logo takes the middle.',
      slots: { left: ['links'], center: ['logo'], right: ['search', 'account', 'bag', 'menu'] } },

    { id: 'logo-center-split', name: 'Centred logo, split actions',
      note: 'Categories and search on the left, logo centred, account and bag on the right.',
      slots: { left: ['links', 'search'], center: ['logo'], right: ['account', 'bag', 'menu'] } },

    { id: 'account-first', name: 'Account on the far left',
      note: 'Account leads the header, then the logo; categories stay centred.',
      slots: { left: ['account', 'logo'], center: ['links'], right: ['search', 'bag', 'menu'] } },

    { id: 'actions-left', name: 'Actions on the left',
      note: 'Search, account and bag lead; the logo is centred and categories sit right.',
      slots: { left: ['search', 'account', 'bag'], center: ['logo'], right: ['links', 'menu'] } },

    { id: 'logo-right', name: 'Logo on the right',
      note: 'Actions lead, categories in the middle, logo closes the header.',
      slots: { left: ['search', 'account', 'bag'], center: ['links'], right: ['logo', 'menu'] } },

    { id: 'links-right', name: 'Everything right',
      note: 'Logo alone on the left; categories join the actions on the right.',
      slots: { left: ['logo'], center: [], right: ['links', 'search', 'account', 'bag', 'menu'] } },

    { id: 'stacked-center', name: 'Logo and categories centred',
      note: 'Nothing on the left; logo and categories share the middle, actions right.',
      slots: { left: [], center: ['logo', 'links'], right: ['search', 'account', 'bag', 'menu'] } },
  ];

  var SLOTS = ['left', 'center', 'right'];

  function byId(id) {
    for (var i = 0; i < LAYOUTS.length; i++) if (LAYOUTS[i].id === id) return LAYOUTS[i];
    return null;
  }

  /* ── The miniature ─────────────────────────────────────────────────────────
     Built from the slots, so it cannot show an arrangement the applier would
     not produce. Deliberately abstract — a bar for the logo, three rules for
     the categories, a circle per action — because the question this answers is
     WHERE things are, and drawing a realistic header would invite the reader to
     judge the colours instead. */
  function shape(item) {
    if (item === 'logo') return '<span class="zwhl-logo" title="Logo"></span>';
    if (item === 'links') return '<span class="zwhl-links" title="Categories"><i></i><i></i><i></i></span>';
    if (item === 'menu') return '<span class="zwhl-menu" title="Menu"></span>';
    return '<span class="zwhl-dot zwhl-' + item + '" title="' + (ITEMS[item] ? ITEMS[item].label : item) + '"></span>';
  }
  function miniature(layout) {
    var l = typeof layout === 'string' ? byId(layout) : layout;
    if (!l) return '';
    return '<span class="zwhl-bar">' + SLOTS.map(function (s) {
      return '<span class="zwhl-slot zwhl-' + s + '">' + (l.slots[s] || []).map(shape).join('') + '</span>';
    }).join('') + '</span>';
  }

  /* The stylesheet for the miniatures. Shipped with the definitions so anything
     that draws one gets the same picture without copying CSS around. */
  var MINI_CSS =
    '.zwhl-bar{display:flex;align-items:center;gap:6px;width:100%;height:38px;padding:0 10px;'
  + 'border:1px solid var(--zwhl-bd,rgba(255,255,255,.14));border-radius:4px;background:var(--zwhl-bg,rgba(255,255,255,.03));box-sizing:border-box}'
  + '.zwhl-slot{display:flex;align-items:center;gap:6px;flex:1;min-width:0}'
  + '.zwhl-center{justify-content:center}.zwhl-right{justify-content:flex-end}'
  + '.zwhl-logo{width:22px;height:12px;border-radius:2px;background:var(--zwhl-fg,#f4f1eb);flex:none}'
  + '.zwhl-links{display:flex;gap:4px;flex:none}'
  + '.zwhl-links i{display:block;width:14px;height:4px;border-radius:2px;background:var(--zwhl-mu,rgba(244,241,235,.5))}'
  + '.zwhl-dot{width:9px;height:9px;border-radius:50%;background:var(--zwhl-mu,rgba(244,241,235,.5));flex:none}'
  + '.zwhl-dot.zwhl-bag{background:var(--zwhl-ac,#F891A5)}'
  + '.zwhl-menu{width:12px;height:9px;flex:none;border-top:2px solid var(--zwhl-mu,rgba(244,241,235,.5));border-bottom:2px solid var(--zwhl-mu,rgba(244,241,235,.5))}';

  /* ── Applying it to a real header ──────────────────────────────────────────
     Slot wrappers are created once and the items MOVED into them. Nothing is
     cloned: a cloned bag button is a bag button whose click handler and count
     belong to a node no longer on the page. */
  function findNav() {
    return document.querySelector('nav#nav, header.nav, nav.nav, nav.zw-nav, .zw-hdr');
  }
  function findItem(nav, key) {
    var sels = (ITEMS[key] || {}).sel || [];
    for (var i = 0; i < sels.length; i++) {
      var el = nav.querySelector(sels[i]);
      if (el) return el;
    }
    return null;
  }
  function ensureSlots(nav) {
    var made = {};
    SLOTS.forEach(function (s) {
      var el = nav.querySelector(':scope > .zw-hdr-slot[data-slot="' + s + '"]');
      if (!el) {
        el = document.createElement('div');
        el.className = 'zw-hdr-slot';
        el.setAttribute('data-slot', s);
        nav.appendChild(el);
      }
      made[s] = el;
    });
    return made;
  }

  var applied = '';
  function apply(id) {
    var l = byId(id);
    var nav = findNav();
    if (!nav) return false;
    if (!l) {                       // no layout chosen: leave the markup alone
      nav.classList.remove('zw-hdr-arranged');
      return false;
    }
    var slots = ensureSlots(nav);
    SLOTS.forEach(function (s) {
      (l.slots[s] || []).forEach(function (key) {
        var el = findItem(nav, key);
        if (!el) return;            // not on this page; skip rather than invent
        el.removeAttribute('data-zw-hdr-off');
        el.style.removeProperty('display');
        slots[s].appendChild(el);   // appendChild MOVES, it does not copy
      });
    });
    /* Anything the layout did not name is hidden rather than left floating in
       whatever container it started in — that is what "the account button lives
       in the bag panel" means. */
    var named = {};
    SLOTS.forEach(function (s) { (l.slots[s] || []).forEach(function (k) { named[k] = 1; }); });
    Object.keys(ITEMS).forEach(function (k) {
      if (named[k]) return;
      var el = findItem(nav, k);
      if (!el) return;
      el.setAttribute('data-zw-hdr-off', '1');
      el.style.display = 'none';
    });
    nav.classList.add('zw-hdr-arranged');
    applied = l.id;
    return true;
  }

  window.ZWHeaderLayouts = {
    list: LAYOUTS, items: ITEMS, slots: SLOTS,
    byId: byId, miniature: miniature, css: MINI_CSS,
    apply: apply, applied: function () { return applied; },
  };

  /* ── Everything below runs on a real page, not in the builder's picker ─────
     The builder loads this file for `list` and `miniature` only. It has no
     storefront nav, so findNav() returns nothing there and the boot below stops
     before it asks the server for anything. */

  /* Slot layout, scoped to .zw-hdr-arranged so a header with no chosen layout
     is left entirely alone — the default path keeps whatever CSS it always had
     and this file cannot regress it. */
  var st = document.createElement('style');
  st.textContent =
    'nav.zw-hdr-arranged{display:flex;align-items:center;gap:0}'
  + '.zw-hdr-arranged>.zw-hdr-slot{display:flex;align-items:center;gap:clamp(.6rem,1.6vw,1.6rem);flex:1 1 0;min-width:0}'
  + '.zw-hdr-arranged>.zw-hdr-slot[data-slot="center"]{justify-content:center}'
  + '.zw-hdr-arranged>.zw-hdr-slot[data-slot="right"]{justify-content:flex-end}'
  /* The old containers become plain groups once their children have been moved
     out; without this the centre container keeps centring an empty box and eats
     a third of the bar. */
  + '.zw-hdr-arranged .nav-center,.zw-hdr-arranged .nav-right,.zw-hdr-arranged .zw-hdr-group{flex:0 0 auto;min-width:0}'
  + '.zw-hdr-arranged .zw-hdr-slot .nav-center{display:flex;align-items:center;gap:clamp(.6rem,1.6vw,1.6rem)}'
  + '.zw-hdr-arranged [data-zw-hdr-off]{display:none!important}';
  document.head.appendChild(st);

  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
  var CACHE = 'zw_header_layout';
  var fromDraft = false;

  function set(id, isDraft) {
    if (fromDraft && !isDraft) return;   // a draft outranks the published value
    if (isDraft) fromDraft = true;
    apply(id);
  }

  function bootStorefront() {
    if (!findNav()) return;          // the builder, an admin page, anything else

    /* Cache first so a chosen layout does not visibly rearrange itself on every
       load, then confirm from the server. */
    try { var c = localStorage.getItem(CACHE); if (c) set(c); } catch (_) {}

    /* nav-menu.js builds #nav-category-links AFTER this runs on most pages, and
       the search button is injected later still. Re-applying when the nav's own
       children change puts each item in its slot as it arrives, rather than
       leaving whatever was late in the container it was born in. */
    try {
      var nav = findNav(), t = 0;
      new MutationObserver(function () {
        if (!applied) return;
        clearTimeout(t);
        t = setTimeout(function () { apply(applied); }, 40);
      }).observe(nav, { childList: true, subtree: true });
    } catch (_) {}

    fetch('https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/site_settings?select=value&key=eq.header_layout',
    { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        var v = rows && rows[0] && rows[0].value;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) {} }
        var id = v && typeof v === 'object' ? v.id : v;
        if (!id) return;
        try { localStorage.setItem(CACHE, id); } catch (_) {}
        set(id);
      })
      .catch(function () {});

    /* A ?zwpreview= link carries the draft, and the builder pushes it live over
       postMessage — the same two routes the nav, the bar and page copy use. */
    if (window.__zwPreviewReady && window.__zwPreviewReady.then) {
      window.__zwPreviewReady.then(function (pv) {
        var v = pv && pv.header_layout;
        var id = v && typeof v === 'object' ? v.id : v;
        if (id) set(id, true);
      }).catch(function () {});
    }
    window.addEventListener('message', function (e) {
      if (e.origin !== location.origin) return;
      var d = e.data;
      if (!d || d.type !== 'ZW_HEADER_LAYOUT') return;
      set(d.id, true);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootStorefront);
  else bootStorefront();
})();
