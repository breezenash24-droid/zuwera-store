/* ────────────────────────────────────────────────────────────────────────────
   header-layouts.js — WHERE the header's three parts sit, as a named choice.

   ── THIS FILE USED TO MOVE THE DOM. IT WAS WRONG. ───────────────────────────

   The first version of this picker found the logo, the categories and each
   action button and appendChild'd them into slot wrappers it created. It did
   not work, and the way it failed is worth keeping written down, because the
   reason was not a detail:

     .nav-center is `position:absolute; left:0; right:0; margin:0 auto`.

   The categories are centred by being taken OUT OF FLOW and stretched across
   the whole bar. Move that element into a "left" wrapper and it does not go
   left — it stays exactly where it was, because an absolutely positioned box
   is placed against its containing block, not against its parent's layout. So:

     - "Categories beside the logo" and "Everything right" moved nothing at all;
       every part measured at its original x.
     - Every layout that centred something else put that thing UNDERNEATH the
       still-centred categories. elementFromPoint over the logo returned a
       category link, which is the whole of "you cannot click any of the
       buttons".

   Four of ten arrangements were unclickable and two were silently no-ops.

   ── WHAT THIS FILE DOES NOW ─────────────────────────────────────────────────

   The storefront already had a header placement system, and it is a good one.
   `storefront-cohesion.css` implements placement for all five nav dialects with
   `order`, one auto margin, and the same absolute-centring trick — including a
   mobile fallback and a documented two-row mode. `theme-engine.js` drives it by
   writing four attributes on <html>:

       data-zw-hdr-logo      left | center | right
       data-zw-hdr-links     left | center | right | none
       data-zw-hdr-actions   left | center | right
       data-zw-hdr-linksrow  1 | 2

   That vocabulary is the definition of what a header can do here. A layout in
   this file is therefore nothing but a NAME for four of those values, and
   applying one calls the single writer that already exists rather than
   becoming a second one. Nothing is moved, created or hidden.

   ── THE PICTURE CANNOT DISAGREE WITH THE RESULT ─────────────────────────────

   The builder draws a tile per layout. Both the tile and the storefront read
   `zones(spec)` — one function that says which parts land in which zone — so a
   tile cannot promise an arrangement the stylesheet would not produce. That
   was the intent of the first version too; it just described the arrangement in
   a vocabulary the page did not share.

   ── ONLY ARRANGEMENTS THE STYLESHEET CAN ACTUALLY MAKE ──────────────────────

   Two parts in the same outer zone is not expressible: centring is absolute, so
   two centred parts overlap, and `margin-left:auto` on two right-hand parts
   pushes them apart instead of grouping them. `conflict()` states that rule and
   a test holds every shipped layout to it — the picker offers no arrangement
   that the header cannot hold.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var PARTS = ['logo', 'links', 'actions'];
  var SPOTS = ['left', 'center', 'right'];

  var PART_LABEL = {
    logo:    'Logo',
    links:   'Categories',
    actions: 'Search, account and bag',
  };

  /* Most familiar first: the first tile you see is the arrangement you already
     have, so the gallery reads as "and here is what else it could be". */
  var LAYOUTS = [
    { id: 'classic', name: 'Classic',
      note: 'Logo left, categories centred, actions right. What the site uses today.',
      spec: { logo: 'left', links: 'center', actions: 'right', linksRow: 1 } },

    { id: 'links-left', name: 'Categories beside the logo',
      note: 'Categories sit next to the logo on the left, actions stay right.',
      spec: { logo: 'left', links: 'left', actions: 'right', linksRow: 1 } },

    { id: 'logo-center', name: 'Centred logo',
      note: 'Categories move left and the logo takes the middle.',
      spec: { logo: 'center', links: 'left', actions: 'right', linksRow: 1 } },

    { id: 'stacked', name: 'Centred logo, categories below',
      note: 'The logo has the first row to itself and the categories run along a second row underneath.',
      spec: { logo: 'center', links: 'center', actions: 'right', linksRow: 2 } },

    { id: 'links-row', name: 'Categories on their own row',
      note: 'Logo and actions share the top row; the categories run underneath, aligned left.',
      spec: { logo: 'left', links: 'left', actions: 'right', linksRow: 2 } },

    { id: 'logo-right', name: 'Logo on the right',
      note: 'Actions lead the header, categories stay centred, the logo closes it.',
      spec: { logo: 'right', links: 'center', actions: 'left', linksRow: 1 } },

    { id: 'actions-left', name: 'Actions on the left',
      note: 'Search, account and bag lead; the logo is centred and the categories close the header.',
      spec: { logo: 'center', links: 'right', actions: 'left', linksRow: 1 } },

    { id: 'all-left', name: 'Everything to the left',
      note: 'Logo, categories and actions all gather on the left and the right side stays empty.',
      spec: { logo: 'left', links: 'left', actions: 'left', linksRow: 1 } },

    { id: 'minimal', name: 'Categories in the menu',
      note: 'The categories leave the bar for the menu drawer, which appears on desktop too. Logo left, actions right.',
      spec: { logo: 'left', links: 'none', actions: 'right', linksRow: 1 } },

    { id: 'minimal-center', name: 'Centred logo, categories in the menu',
      note: 'Just the logo in the middle and the actions on the right; the categories live in the menu drawer.',
      spec: { logo: 'center', links: 'none', actions: 'right', linksRow: 1 } },
  ];

  function byId(id) {
    for (var i = 0; i < LAYOUTS.length; i++) if (LAYOUTS[i].id === id) return LAYOUTS[i];
    return null;
  }

  /* ── The one description of an arrangement ────────────────────────────────
     Which parts land in which zone of the top row, and what (if anything) gets
     a second row. The tiles are drawn from this and the rule below is checked
     against it, so there is no second place where an arrangement is described.

     Categories are absent from the top row in two cases, and they are different
     cases: `none` means they are not in the bar at all (they move to the menu
     drawer), `linksRow:2` means they are in the bar on a row of their own. */
  function zones(spec) {
    var s = spec || {};
    var row2 = String(s.linksRow) === '2';
    var z = { left: [], center: [], right: [], row2: [] };
    PARTS.forEach(function (p) {
      var spot = s[p];
      if (p === 'links') {
        if (spot === 'none') return;
        if (row2) { z.row2.push('links'); return; }
      }
      if (z[spot]) z[spot].push(p);
    });
    z.rowAlign = SPOTS.indexOf(s.links) > -1 ? s.links : 'center';
    z.menu = s.links === 'none';
    return z;
  }

  /* ── What the header cannot do, said out loud ─────────────────────────────
     Both restrictions come from how the stylesheet places things, and both were
     found the hard way:

     centre  is absolute positioning against the nav, so two centred parts are
             two boxes at the same coordinates — they overlap, and the one
             underneath stops being clickable.
     right   is `margin-left:auto`, and a second part taking the same margin
             pushes the pair apart rather than grouping them.

     Left may repeat: only the first element takes the leading margin, so parts
     placed left simply sit in document order. */
  function conflict(spec) {
    var z = zones(spec);
    if (z.center.length > 1) {
      return 'two parts centred — centring is absolute, so they would sit on top of each other';
    }
    if (z.right.length > 1) {
      return 'two parts on the right — they would spread apart instead of sitting together';
    }
    /* Measured, not theorised. A centred part is out of flow, so an in-flow
       part beside it does not stop at the centre lane — it runs underneath.
       Only the categories can grow (the logo and the action icons are a fixed
       few characters wide), so the collision is always the same one: the
       categories in flow on the same row as something centred.

       Centring the CATEGORIES is the safe direction, because then the two
       in-flow neighbours are the narrow ones. Centring the actions while the
       categories sit in the bar was the arrangement that failed by 73px with
       the four categories this shop has today. */
    if (spec.actions === 'center' && !z.menu && !z.row2.length) {
      return 'the actions are centred out of flow while the categories stay in flow beside them — a long category list runs underneath';
    }
    return '';
  }

  /* ── The tile ──────────────────────────────────────────────────────────────
     Words and real glyphs rather than abstract bars. The earlier version drew
     grey rectangles and dots, which asked the reader to decode a legend before
     they could tell one arrangement from another — and then showed them an
     arrangement that did not happen. Showing "ZUWERA", three category words and
     the three actual action icons means the tile is read, not decoded. */
  var GLYPH = {
    search:  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>',
    account: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"></circle><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"></path></svg>',
    bag:     '<svg viewBox="0 0 24 24" class="zwhl-bagi" aria-hidden="true"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"></path><path d="M16 10a4 4 0 01-8 0"></path></svg>',
    menu:    '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>',
  };

  function part(name, withMenu) {
    if (name === 'logo') {
      return '<span class="zwhl-p zwhl-logo" title="Logo">ZUWERA</span>';
    }
    if (name === 'links') {
      return '<span class="zwhl-p zwhl-links" title="Categories"><i>Shop</i><i>New</i><i>Sale</i></span>';
    }
    /* The hamburger belongs to the actions group in the markup, so when the
       categories move to the menu it appears here — which is exactly what the
       reader needs to see to understand where the categories went. */
    return '<span class="zwhl-p zwhl-actions" title="' + PART_LABEL.actions + '">'
      + GLYPH.search + GLYPH.account + GLYPH.bag + (withMenu ? GLYPH.menu : '') + '</span>';
  }

  function miniature(layout) {
    var l = typeof layout === 'string' ? byId(layout) : layout;
    if (!l) return '';
    var z = zones(l.spec);
    var row1 = SPOTS.map(function (s) {
      return '<span class="zwhl-z zwhl-' + s + '">'
        + z[s].map(function (p) { return part(p, z.menu && p === 'actions'); }).join('')
        + '</span>';
    }).join('');
    var row2 = z.row2.length
      ? '<span class="zwhl-row2 zwhl-a-' + z.rowAlign + '">' + z.row2.map(function (p) { return part(p, false); }).join('') + '</span>'
      : '';
    return '<span class="zwhl-bar">' + '<span class="zwhl-row">' + row1 + '</span>' + row2 + '</span>';
  }

  /* Shipped beside the definitions so anything drawing a tile gets the same
     picture without a copy of the CSS travelling with it. Colours come through
     as variables with fallbacks, so the picker can sit on a light or a dark
     panel without this file knowing which. */
  var MINI_CSS =
    '.zwhl-bar{display:flex;flex-direction:column;width:100%;box-sizing:border-box;'
  + 'padding:.5rem .6rem;border:1px solid var(--zwhl-bd,rgba(255,255,255,.16));border-radius:4px;'
  + 'background:var(--zwhl-bg,rgba(255,255,255,.045))}'
  + '.zwhl-row{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:.4rem;min-height:22px}'
  + '.zwhl-z{display:flex;align-items:center;gap:.45rem;min-width:0}'
  + '.zwhl-center{justify-content:center}.zwhl-right{justify-content:flex-end}'
  + '.zwhl-row2{display:flex;align-items:center;margin-top:.34rem;min-height:14px}'
  + '.zwhl-a-left{justify-content:flex-start}.zwhl-a-center{justify-content:center}.zwhl-a-right{justify-content:flex-end}'
  + '.zwhl-logo{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:8px;font-weight:700;'
  + 'letter-spacing:.16em;line-height:1;white-space:nowrap;color:var(--zwhl-fg,#f4f1eb)}'
  + '.zwhl-links{display:flex;gap:.45rem}'
  + '.zwhl-links i{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:7px;font-style:normal;'
  + 'font-weight:500;letter-spacing:.1em;line-height:1;white-space:nowrap;color:var(--zwhl-mu,rgba(244,241,235,.62))}'
  + '.zwhl-actions{display:flex;align-items:center;gap:.32rem}'
  + '.zwhl-actions svg{width:9px;height:9px;display:block;fill:none;stroke:var(--zwhl-mu,rgba(244,241,235,.62));'
  + 'stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
  + '.zwhl-actions svg.zwhl-bagi{stroke:var(--zwhl-ac,#F891A5)}';

  /* ── Applying it ──────────────────────────────────────────────────────────
     One line of real work, and that is the point. theme-engine.js owns the four
     attributes; this hands it a spec and it writes them. An override set here
     outranks the theme's own header and survives a theme switch, so choosing a
     theme cannot silently undo an arrangement chosen in the builder. */
  /* Whether the header and the bar draw their bottom rule. Travels with the
     arrangement because it is stored beside it and chosen in the same place,
     but it is NOT part of a layout: every arrangement can have it either way,
     and a store that has chosen no arrangement can still turn it off. Putting
     it in the layout table would have meant twenty entries instead of ten and
     a picker where half the tiles differed by one pixel. */
  var LINES = { on: 1, off: 1 };
  function lineChoice(v) { return LINES[v] ? v : ''; }

  var applied = '';
  var appliedLines = '';
  function apply(id, lines) {
    var l = byId(id);
    if (!window.ZWTheme || typeof window.ZWTheme.setHeader !== 'function') return false;
    /* An unknown id is not a reason to drop the line choice on the floor —
       they are two answers, and only one of them is missing. */
    var spec = l ? l.spec : null;
    var out = {};
    if (spec) { for (var k in spec) out[k] = spec[k]; }
    out.lines = lineChoice(lines);
    window.ZWTheme.setHeader(out);
    applied = l ? l.id : '';
    appliedLines = out.lines;
    return !!l;
  }

  window.ZWHeaderLayouts = {
    list: LAYOUTS, parts: PARTS, spots: SPOTS, labels: PART_LABEL,
    byId: byId, zones: zones, conflict: conflict,
    miniature: miniature, css: MINI_CSS, lineChoice: lineChoice,
    apply: apply, applied: function () { return applied; },
    lines: function () { return appliedLines; },
  };

  /* ── Everything below runs on a storefront page, not in the builder ────────
     The builder loads this file for `list` and `miniature` only. It has no
     storefront nav, so the boot below stops before it asks the server for
     anything — and, just as importantly, before it puts a data-zw-hdr attribute
     on the BUILDER's own <html>, which would rearrange the builder's chrome. */
  function findNav() {
    return document.querySelector('nav#nav, header.nav, nav.nav, nav.zw-nav, .zw-hdr');
  }

  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
  var CACHE = 'zw_header_layout';
  /* The four placement values, resolved, for the pre-paint block in <head>.
     It stores the ANSWER rather than the layout's name so that block needs no
     copy of the layout table — see scripts/theme-preboot.head.js. Only ever
     written from the PUBLISHED value: a draft must not survive into the next
     page load, least of all a shopper's. */
  var ATTRS = 'zw_hdr_attrs';
  var fromDraft = false;

  /* The trailing field is the row's updated_at, kept so the pre-paint block can
     tell a cache that is NEWER than the build's baked answer from one that is
     older. Without it the two sources have no way to be ranked and one of them
     has to be trusted blindly — which breaks whenever the other is the fresh
     one. Same column, same format, on both sides. */
  function remember(id, at, lines) {
    var l = byId(id);
    try {
      if (!l) { localStorage.removeItem(CACHE); localStorage.removeItem(ATTRS); return; }
      localStorage.setItem(CACHE, l.id);
      localStorage.setItem(ATTRS, [l.spec.logo, l.spec.links, l.spec.actions,
        String(l.spec.linksRow) === '2' ? '2' : '1', at || '', lines || ''].join('|'));
    } catch (_) {}
  }

  function set(id, lines, isDraft) {
    if (fromDraft && !isDraft) return;   // a draft outranks the published value
    if (isDraft) fromDraft = true;
    apply(id, lines);
  }

  /* Is this page being shown INSIDE the builder? Both routes are settled before
     this file runs — `?builder=1` sets its flag in a synchronous head script and
     `?zwpreview=` has already created its promise — so the question can be
     answered now rather than after the first paint, which is the whole point. */
  function isPreview() {
    return !!(window.__ZW_BUILDER_PREVIEW__ ||
             (window.__zwPreviewReady && window.__zwPreviewReady.then));
  }

  function bootStorefront() {
    if (!findNav()) return;

    /* ── Why the published arrangement is held back in a preview ─────────────
       Everywhere else, cache-then-fetch is right: the cached value and the
       published one agree, so applying the cache immediately avoids a reflow.

       In the builder they do NOT agree — the whole reason you are looking at
       the canvas is that the draft differs from what is live. And the published
       value is the one that arrives first, because it is local, while the draft
       has to be posted in. So the canvas rearranged itself to the OLD header on
       every reload and then rearranged again a moment later. Reloading the
       builder to check your work showed you the thing you had just changed.

       So in a preview the published value is held, not applied, until the draft
       has had its say. If the draft turns out to carry no arrangement, the held
       value is released and nothing is lost. */
    var preview = isPreview();
    var held = null, draftSettled = false;

    function fromServer(id, lines) {
      if (preview && !draftSettled) { held = { id: id, lines: lines }; return; }
      set(id, lines);
    }
    function draftDone(id, lines) {
      draftSettled = true;
      /* A draft with neither answer in it is not a draft that says "no header"
         — it is a builder that had nothing to send yet. Only a draft that names
         something displaces what is live. */
      if (id || lines) { set(id, lines, true); held = null; return; }
      if (held) { set(held.id, held.lines); held = null; }
    }

    try {
      var c = localStorage.getItem(CACHE);
      var cl = (localStorage.getItem(ATTRS) || '').split('|')[5] || '';
      if (c || cl) fromServer(c, cl);
    } catch (_) {}

    fetch('https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/site_settings?select=value,updated_at&key=eq.header_layout',
    { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        var row = rows && rows[0];
        var v = row && row.value;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) {} }
        var id = v && typeof v === 'object' ? v.id : v;
        var lines = lineChoice(v && typeof v === 'object' ? v.lines : '');
        /* A store that clears its arrangement has to clear the pre-paint cache
           too, or the head keeps stamping the old one before every paint and
           the header flashes an arrangement nothing on the server still names. */
        remember(id, row && row.updated_at, lines);
        if (!id && !lines) return;
        fromServer(id, lines);
      })
      .catch(function () {});

    /* A ?zwpreview= link carries the draft, and the builder pushes it live over
       postMessage — the same two routes the nav, the bar and page copy use. */
    if (window.__zwPreviewReady && window.__zwPreviewReady.then) {
      window.__zwPreviewReady.then(function (pv) {
        var v = pv && pv.header_layout;
        var o = v && typeof v === 'object' ? v : { id: v };
        draftDone(o.id, lineChoice(o.lines));
      }).catch(function () { draftDone(null, ''); });
    }
    window.addEventListener('message', function (e) {
      if (e.origin !== location.origin) return;
      var d = e.data;
      if (!d || d.type !== 'ZW_HEADER_LAYOUT') return;
      draftDone(d.id, lineChoice(d.lines));
    });

    /* The canvas gets its draft by postMessage, and a message that never comes
       has no failure to catch. Without this, a builder that did not post one
       would leave the header showing neither the draft nor what is live — worse
       than the flash this replaces. Long enough that the message wins in
       practice; short enough that nobody reads the wrong header for long. */
    if (preview && window.__ZW_BUILDER_PREVIEW__) {
      setTimeout(function () { if (!draftSettled) draftDone(null, ''); }, 1500);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootStorefront);
  else bootStorefront();
})();
