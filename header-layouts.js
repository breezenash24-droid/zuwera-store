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

    { id: 'logo-beside', name: 'Centred logo, categories beside it',
      note: 'The logo and the categories sit together in the middle of one row — the centred look without the extra row it usually costs.',
      spec: { logo: 'center', links: 'center', actions: 'right', linksRow: 1 } },

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
    /* ONE PAIR IS NOT A COLLISION ANY MORE. The logo and the categories are
       placed side by side in the centre lane, each pushed out by half of what
       the other measures — see the rule in storefront-cohesion.css. That is
       only possible for these two: the arithmetic needs both widths, and the
       action controls are in flow with an auto margin rather than in the lane.  */
    var paired = z.center.length === 2
      && z.center.indexOf('logo') > -1 && z.center.indexOf('links') > -1;
    if (z.center.length > 1 && !paired) {
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
    /* The account-menu rows a store can promote into the header. Same shapes
       storefront-features.js draws them with, so the tile and the header show
       the same glyph rather than two artists' versions of one idea. */
    orders:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><path d="M3 6h18"></path></svg>',
    saves:   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>',
    support: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M9.1 9a3 3 0 1 1 4 2.8c-.7.3-1.1 1-1.1 1.7v.5"></path><line x1="12" y1="17.5" x2="12" y2="17.5"></line></svg>',
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

  /* ── What a phone and a tablet actually get ───────────────────────────────
     One arrangement, the same for every layout, and it is not an approximation:
     below 900px storefront-cohesion.css sets `.nav-center { display: none }`
     and reveals the menu button, and the placement block is behind a
     min-width:901px query. So the categories are in the drawer and the logo and
     the actions are all that is left.

     Drawn rather than described because that is the honest way to say
     "arrangement is a desktop setting": ten tiles that are visibly the same
     picture make the point in a way a sentence under the gallery does not. */
  function smallMini() {
    return '<span class="zwhl-bar zwhl-sm"><span class="zwhl-row">'
      + '<span class="zwhl-z zwhl-left">' + part('logo') + '</span>'
      + '<span class="zwhl-z zwhl-center"></span>'
      + '<span class="zwhl-z zwhl-right">' + part('actions', true) + '</span>'
      + '</span></span>';
  }

  /* `flip` is passed through so a tile can draw the mirrored arrangement. The
     picture has to agree with the result -- that is the rule this whole file is
     built around -- and a gallery that drew the unflipped tiles while the
     preview showed mirrored ones would be the tiles-that-lie problem again. */
  function miniature(layout, device, flip) {
    var l = typeof layout === 'string' ? byId(layout) : layout;
    if (!l) return '';
    if (device === 'phone' || device === 'tablet') return smallMini();
    var z = zones(flip ? mirror(l.spec) : l.spec);
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

  /* ── The action controls, drawn ────────────────────────────────────────────
     The gallery tiles have always shown the arrangement as a picture. The three
     answers ABOUT those controls — order, glyphs or words, and whether account
     is one of them — had no picture at all, and a form of switches is a poor
     way to answer "what will my header look like": you have to hold the result
     in your head, which is the same demand the first version of the layout
     picker made and the reason it shipped tiles that lied.

     So the same treatment, from the same glyphs. Given what a device will
     resolve to, this draws the cluster exactly as the header will lay it out —
     same order, same words, same controls present — and the builder shows one
     per device. A control that has moved is a control you can see has moved.

     `words` uses the labels the controls carry for screen readers, which is
     also where the storefront's own labels come from, so the two cannot drift. */
  /* The names in a value, in the order given, WITHOUT completing the list.
     controlOrder completes because an order has to place every control that
     exists; drawing does not — the builder draws one chip per control and asks
     for one name at a time, and completing there would put four glyphs on every
     chip. Two callers, two genuinely different questions. */
  function seqOf(v) {
    var known = CONTROLS.concat(PROMOTABLE);
    return String(v == null ? '' : v).trim().toLowerCase().split(/[\s,]+/)
      .filter(function (n) { return known.indexOf(n) > -1; });
  }

  function actionsMini(opts) {
    var o = opts || {};
    var seq = seqOf(o.order);
    if (!seq.length) seq = CONTROLS.slice();
    var words = !!o.words;
    var out = seq.map(function (c) {
      if (c === 'account' && o.account === false) return '';
      var body = words
        ? '<i class="zwhl-w">' + CONTROL_LABEL[c] + '</i>'
        : (GLYPH[c] || GLYPH.bag);
      return '<span class="zwhl-c" data-c="' + c + '">' + body + '</span>';
    }).join('');
    if (o.menu) out += '<span class="zwhl-c">' + GLYPH.menu + '</span>';
    return '<span class="zwhl-acts' + (words ? ' zwhl-words' : '') + '">' + out + '</span>';
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
  + '.zwhl-actions svg.zwhl-bagi{stroke:var(--zwhl-ac,#F891A5)}'
  /* The phone/tablet bar is narrower than the frame it sits in, so a gallery
     switched to a small device reads as a column of phone headers rather than
     ten desktop bars that happen to look alike. */
  + '.zwhl-bar.zwhl-sm{max-width:190px;margin:0 auto;padding:.42rem .5rem}'
  /* The standalone cluster, drawn a size up from the tile glyphs: it is the
     subject here rather than one part of a bar, and at 9px the difference
     between a magnifier and a bag is a guess. */
  + '.zwhl-acts{display:flex;align-items:center;gap:.5rem;min-height:18px}'
  + '.zwhl-acts.zwhl-words{gap:.6rem}'
  + '.zwhl-c{display:flex;align-items:center;line-height:1}'
  + '.zwhl-c svg{width:14px;height:14px;display:block;fill:none;stroke:var(--zwhl-fg,#f4f1eb);'
  + 'stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}'
  + '.zwhl-w{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:8px;font-style:normal;'
  + 'font-weight:600;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap;'
  + 'color:var(--zwhl-fg,#f4f1eb)}';

  /* ── Applying it ──────────────────────────────────────────────────────────
     One line of real work, and that is the point. theme-engine.js owns the four
     attributes; this hands it a spec and it writes them. An override set here
     outranks the theme's own header and survives a theme switch, so choosing a
     theme cannot silently undo an arrangement chosen in the builder. */
  /* ── The choices that travel WITH an arrangement but are not part of one ──
     Three questions about the header that every arrangement can answer either
     way, and that a store which has chosen no arrangement can still answer:

       lines       does the header (and the bar) draw its bottom rule
       account     does the account control live in the bag panel or the header
       iconLabels  are the action controls glyphs, or words

     They are stored beside the layout and chosen in the same modal, which is
     why they travel together — but folding them INTO the layout table would
     have meant ten entries becoming a hundred and twenty, and a picker where
     most tiles differed by nothing you could see.

     '' means "not answered here", which is different from every value in the
     table: it hands the question back to the theme, which is where all three
     lived before this modal existed and where they still live for a store that
     has never opened it. */
  var EXTRAS = {
    lines:      { on: 1, off: 1 },
    account:    { bag: 1, header: 1 },
    /* Mirror the whole arrangement left-to-right. It is an EXTRA rather than
       eleven more entries in the catalogue because it is not a different
       arrangement — it is the same one, seen the other way round, and it works
       on any layout added later without anyone remembering to add its twin.

       Seven of the eleven mirrors are not in the catalogue at all today
       (links-left, logo-beside, stacked, links-row, all-left, minimal and
       minimal-center have no reversed entry), so this roughly doubles what the
       gallery can express. The other four already have their mirror by name —
       classic/logo-right and logo-center/actions-left are each other's — and
       flipping one lands exactly on the other, which is the check that the
       mirror is the right operation rather than an approximation of one. */
    flip:       { on: 1, off: 1 },
    /* How far apart the categories sit. Named steps rather than a number: every
       other answer in this modal is named, and a pixel box invites fiddling
       without giving anyone a sense of what "right" is. `normal` is the 2.4rem
       the header has always used, so an unanswered store is unchanged.

       It was the one thing about this header nobody could change -- a literal
       in three files -- and it is the first thing that looks wrong when the
       arrangement moves, because a centred strip wants air and a strip tucked
       beside the logo wants much less of it. */
    navGap:     { tight: 1, snug: 1, normal: 1, roomy: 1, wide: 1 },
    // iconLabels is not an enum — see deviceList below.
  };
  var EXTRA_KEYS = ['lines', 'account', 'iconLabels', 'order', 'flip', 'navGap'];

  /* ── The mirror ───────────────────────────────────────────────────────────
     Left and right swap; centre is its own mirror; `none` is not a position at
     all (the categories are in the menu drawer) so it stays. linksRow is a row
     count, not a side, and stays too.

     This is the ONLY definition of the operation in the browser. There is a
     second one in functions/_middleware.js, because a Worker cannot import a
     browser file and the arrangement has to be stamped into the HTML before
     any of this runs. tests/header-layout-is-position-only.test.js holds the
     two together — the same arrangement they already make for SPOTS. */
  var MIRROR = { left: 'right', right: 'left', center: 'center', none: 'none' };
  function mirror(spec) {
    var s = spec || {};
    var out = {};
    for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) out[k] = s[k];
    for (var i = 0; i < PARTS.length; i++) {
      var p = PARTS[i];
      if (MIRROR[s[p]]) out[p] = MIRROR[s[p]];
    }
    return out;
  }
  function isFlipped(o) { return extraChoice('flip', o && o.flip) === 'on'; }

  /* ── Two arrangements cannot be mirrored, and it is not an oversight ───────
     `left` may hold two parts: only the first takes the leading margin, so
     parts placed left simply sit in document order. `right` may not: right is
     expressed as margin-left:auto, and a second part claiming the same margin
     splits the free space between them and pushes the pair APART instead of
     grouping it. conflict() has said so since the placement system was written.

     So the mirror of anything with two parts on the left is an arrangement the
     stylesheet cannot build:

         links-left   logo+links left   ->  logo+links right   not expressible
         all-left     all three left    ->  all three right    not expressible

     The other nine mirror cleanly. Rather than offer a switch that would
     quietly do nothing on those two, the builder asks this and turns the
     control off with the reason on it — the same principle as the gallery
     refusing to offer an arrangement the header cannot hold.

     Making the right zone group would mean giving only the leading part the
     auto margin and assigning explicit orders to the rest, across five nav
     dialects. That is placement surgery, not a toggle, and it is the thing to
     do if these two mirrors are ever wanted. */
  function mirrorable(layout) {
    var l = typeof layout === 'string' ? byId(layout) : layout;
    if (!l) return false;
    return !conflict(mirror(l.spec));
  }
  /* Why not, in the words the modal can show. '' when it can. */
  function mirrorBlocked(layout) {
    var l = typeof layout === 'string' ? byId(layout) : layout;
    if (!l) return '';
    return conflict(mirror(l.spec)) || '';
  }

  /* ── The order the three action controls sit in ───────────────────────────
     A permutation of the three, and always all three: a partial answer would
     mean the stylesheet had to invent a place for whatever was missing, and
     "search, then whatever you like" is not a thing anyone means. Anything
     unrecognised, duplicated or missing is completed from the shipped order
     rather than rejected, so a hand-edited row cannot leave a control with no
     position at all. */
  var CONTROLS = ['search', 'account', 'bag'];
  /* Rows of the bag panel's account menu that a store can promote into the
     header. They are optional — a header has them only if someone moved them —
     so they are ALLOWED in an order but never added to complete one. The
     panel's own list is the authority on what they are called; these are the
     names the order speaks in. */
  var PROMOTABLE = ['orders', 'saves', 'support'];
  var CONTROL_LABEL = {
    search: 'Search', account: 'Account', bag: 'Bag',
    orders: 'Orders', saves: 'Saves', support: 'Support',
  };

  function controlOrder(v) {
    if (Array.isArray(v)) v = v.join(' ');
    var s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return '';
    var known = CONTROLS.concat(PROMOTABLE);
    var want = s.split(/[\s,]+/), out = [], i;
    for (i = 0; i < want.length; i++) {
      if (known.indexOf(want[i]) > -1 && out.indexOf(want[i]) < 0) out.push(want[i]);
    }
    if (!out.length) return '';
    /* The three built-ins are always in the list, because they are always in
       the header — an order that omitted one would leave the stylesheet to
       invent a place for it. The promotable ones are not completed in: their
       absence is the answer "this row is still in the panel". */
    for (i = 0; i < CONTROLS.length; i++) {
      if (out.indexOf(CONTROLS[i]) < 0) out.push(CONTROLS[i]);
    }
    return out.join(' ');
  }

  /* ── The one answer that is genuinely per-device ──────────────────────────
     The other two are whole-site questions: a phone shows the divider rule
     too, and the bag panel carries the account link at every width, so giving
     either a per-device answer would be three controls to express something
     nobody varies.

     Words instead of glyphs is different — it IS usually a phone decision and
     occasionally a whole-site one — so it carries a list of the devices that
     get words, in the vocabulary the builder's own preview already uses. Any
     subset is expressible, which the two scopes it replaces could not manage:
     they offered "phone and tablet together" or "everywhere", and no way to
     say desktop alone.

     Order is normalised so two equal answers are the same string — otherwise
     'tablet phone' and 'phone tablet' would compare as different and mark the
     draft dirty on every repaint. */
  var DEVICES = ['phone', 'tablet', 'desktop'];
  /* What the theme token has always used, and what earlier builds baked into
     the HTML. Read, never written: everything this file emits is a device list,
     and the stylesheet keeps the old spellings working as aliases so a page
     that arrives carrying one is not blank until the engine rewrites it. */
  var LEGACY = { mobile: 'phone tablet', always: 'phone tablet desktop', icons: 'none' };

  /* 'none' rather than '' for "glyphs everywhere", and the distinction is the
     three-state rule the rest of these answers keep: '' means the builder did
     not answer and the theme still owns the question, while 'none' is an
     answer — it has to be able to overrule a theme that asks for words, and an
     empty string cannot tell the difference between the two.

     It is written as a value rather than by removing the attribute because the
     build bakes this attribute too: a value that names no device overrules a
     baked one that does, where removing it would depend on reaching an element
     the earliest writer cannot always reach. */
  function deviceList(v) {
    if (Array.isArray(v)) v = v.join(' ');
    var s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return '';
    if (LEGACY[s]) return LEGACY[s];
    if (s === 'none') return 'none';
    var want = s.split(/[\s,]+/);
    var out = [];
    for (var i = 0; i < DEVICES.length; i++) {
      if (want.indexOf(DEVICES[i]) > -1) out.push(DEVICES[i]);
    }
    return out.length ? out.join(' ') : '';
  }

  function extraChoice(name, v) {
    if (name === 'iconLabels') return deviceList(v);
    if (name === 'order') return controlOrder(v);
    var t = EXTRAS[name];
    return (t && t[v]) ? v : '';
  }
  /* Every extra off one object, validated, with the missing ones as ''. Callers
     pass whatever they have — a settings row, a postMessage, a cache tuple —
     and get the same shape back, so no reader has to know which fields their
     particular source happens to carry. */
  function extras(o) {
    var src = (o && typeof o === 'object') ? o : {};
    var out = {};
    for (var i = 0; i < EXTRA_KEYS.length; i++) {
      out[EXTRA_KEYS[i]] = extraChoice(EXTRA_KEYS[i], src[EXTRA_KEYS[i]]);
    }
    return out;
  }
  function anyExtra(e) {
    for (var i = 0; i < EXTRA_KEYS.length; i++) if (e && e[EXTRA_KEYS[i]]) return true;
    return false;
  }
  // Kept from when `lines` was the only one of these, because callers outside
  // this file still ask about it by name.
  function lineChoice(v) { return extraChoice('lines', v); }

  var applied = '';
  var appliedExtras = extras(null);
  function apply(id, opts) {
    var l = byId(id);
    if (!window.ZWTheme || typeof window.ZWTheme.setHeader !== 'function') return false;
    /* An unknown id is not a reason to drop the other answers on the floor —
       they are four answers, and only one of them is missing. */
    var spec = l ? l.spec : null;
    var e = extras(opts);
    /* The mirror is applied HERE, to the named layout's spec, rather than
       stored as a second arrangement. `flip` travels with the other extras, so
       the cache, the postMessage and the settings row all carry it without any
       of them knowing what it means. */
    if (spec && e.flip === 'on') spec = mirror(spec);
    var out = {};
    if (spec) { for (var k in spec) out[k] = spec[k]; }
    for (var i = 0; i < EXTRA_KEYS.length; i++) out[EXTRA_KEYS[i]] = e[EXTRA_KEYS[i]];
    window.ZWTheme.setHeader(out);
    applied = l ? l.id : '';
    appliedExtras = e;
    return !!l;
  }

  window.ZWHeaderLayouts = {
    list: LAYOUTS, parts: PARTS, spots: SPOTS, labels: PART_LABEL,
    byId: byId, zones: zones, conflict: conflict,
    mirror: mirror, isFlipped: isFlipped,
    mirrorable: mirrorable, mirrorBlocked: mirrorBlocked,
    miniature: miniature, css: MINI_CSS, actionsMini: actionsMini,
    lineChoice: lineChoice, extraChoice: extraChoice, extras: extras,
    extraKeys: EXTRA_KEYS, extraValues: EXTRAS,
    devices: DEVICES, deviceList: deviceList,
    controls: CONTROLS, promotable: PROMOTABLE,
    controlLabels: CONTROL_LABEL, controlOrder: controlOrder,
    apply: apply, applied: function () { return applied; },
    lines: function () { return appliedExtras.lines; },
    settings: function () { return extras(appliedExtras); },
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

  /* The trailing field is the row's updated_at, kept so the pre-paint block can
     tell a cache that is NEWER than the build's baked answer from one that is
     older. Without it the two sources have no way to be ranked and one of them
     has to be trusted blindly — which breaks whenever the other is the fresh
     one. Same column, same format, on both sides. */
  /* The tuple is positional and APPEND-ONLY. Field 5 has meant `lines` since
     before there were others, and a browser holding yesterday's five-field
     copy still reads correctly here — a shorter tuple simply answers '' for
     the fields it does not have, which is exactly "not chosen". Reordering it
     would silently reinterpret every cache already in the wild. */
  var ATTR_FIELDS = ['lines', 'account', 'iconLabels', 'order', 'flip', 'navGap'];  // fields 5..10

  function remember(id, at, opts) {
    var l = byId(id);
    var e = extras(opts);
    try {
      /* A store with no arrangement can still have answered one of the other
         three, and dropping the cache because of the missing one is what would
         make those answers flash on every load. */
      if (!l && !anyExtra(e)) { localStorage.removeItem(CACHE); localStorage.removeItem(ATTRS); return; }
      if (l) localStorage.setItem(CACHE, l.id); else localStorage.removeItem(CACHE);
      /* The first four fields are what the PRE-PAINT block stamps straight onto
         <html>, so they have to be the arrangement as it will look — mirrored
         already if it is mirrored. Caching the unflipped spec and the flip flag
         separately would mean the first frame drew the unmirrored header and
         then swapped, which is the flash this cache exists to prevent. */
      var cs = (l && extras(opts).flip === 'on') ? mirror(l.spec) : (l && l.spec);
      var row = l
        ? [cs.logo, cs.links, cs.actions, String(cs.linksRow) === '2' ? '2' : '1', at || '']
        : ['', '', '', '', at || ''];
      for (var i = 0; i < ATTR_FIELDS.length; i++) row.push(e[ATTR_FIELDS[i]] || '');
      localStorage.setItem(ATTRS, row.join('|'));
    } catch (_) {}
  }

  /* set() and its fromDraft flag lived here: "a draft outranks the published
     value". That is the gate's rule now, and stating it twice is how the two
     copies would start disagreeing. */


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
    /* THE SHARED GATE, not a copy of it. This file grew the hold first and the
       reasoning was right, but keeping its own version meant keeping its own
       BUGS: both it and the shared one settled on a null from the preview-LINK
       promise, which on a ?builder=1 load resolves immediately because there is
       no link — releasing the published arrangement a fifth of a second before
       the builder's message arrived. Fixing that in one place and not the other
       is exactly how this feature already lost a day. */
    var gate = (window.ZWPreviewHold || function (f) {
      return { preview: false, published: f, draft: function (v) { if (v != null) f(v); } };
    })(function (v) { apply(v.id, v.opts); });

    function fromServer(id, opts) { gate.published({ id: id, opts: opts }); }
    function draftDone(id, opts) {
      /* A draft with none of the answers in it is not a draft that says "no
         header" — it is a builder that had nothing to send yet. Passing null
         says so, and the gate lets the held value through instead. */
      var named = id || anyExtra(extras(opts));
      gate.draft(named ? { id: id, opts: opts, draft: true } : null);
    }

    /* ── THE CACHE ONLY SPEAKS IF THE DOCUMENT DID NOT ──────────────────────
       There are two readers of this cache — the pre-paint block in <head> and
       this one — and for a long while only the first checked whether the cache
       was actually the freshest answer available. So the head would correctly
       decline to overwrite a document that already knew its arrangement, and
       then this ran a moment later and overwrote it anyway, with the same stale
       value, for the same reason the check existed.

       That is the flash that survived every previous fix: it needed a browser
       that had been here before, so it came and went depending on whose cache
       was older than what the page arrived carrying.

       Same comparison as the head, against the same attribute. A document with
       no timestamp on it made no claim, and the cache is then the best thing
       available. */
    try {
      var parts = (localStorage.getItem(ATTRS) || '').split('|');
      var docAt = document.documentElement.getAttribute('data-zw-hdr-at') || '';
      if (!docAt || (parts[4] || '') > docAt) {
        var c = localStorage.getItem(CACHE);
        var ce = {};
        for (var fi = 0; fi < ATTR_FIELDS.length; fi++) ce[ATTR_FIELDS[fi]] = parts[5 + fi] || '';
        if (c || anyExtra(extras(ce))) fromServer(c, ce);
      }
    } catch (_) {}

    /* The one shared read of site_settings (zw-data.js), rather than a twelfth
       round trip to Supabase. This module is why that endpoint now returns
       updated_at: it compares the row's timestamp against the one stamped on
       the document to decide whether its pre-paint cache is still the freshest
       thing it has, so a value without a timestamp would not do. */
    (window.zwSettings
      ? window.zwSettings.getWithMeta('header_layout')
          .then(function (m) { return m.value == null && !m.updated_at ? null : [m]; })
      : fetch('https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/site_settings?select=value,updated_at&key=eq.header_layout',
        { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON }, cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; }))
      .then(function (rows) {
        var row = rows && rows[0];
        var v = row && row.value;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) {} }
        var id = v && typeof v === 'object' ? v.id : v;
        var e = extras(v);
        /* A store that clears its arrangement has to clear the pre-paint cache
           too, or the head keeps stamping the old one before every paint and
           the header flashes an arrangement nothing on the server still names. */
        remember(id, row && row.updated_at, e);
        if (!id && !anyExtra(e)) return;
        fromServer(id, e);
      })
      .catch(function () {});

    /* A ?zwpreview= link carries the draft, and the builder pushes it live over
       postMessage — the same two routes the nav, the bar and page copy use. */
    if (window.__zwPreviewReady && window.__zwPreviewReady.then) {
      window.__zwPreviewReady.then(function (pv) {
        var v = pv && pv.header_layout;
        var o = v && typeof v === 'object' ? v : { id: v };
        draftDone(o.id, o);
      }).catch(function () { draftDone(null, null); });
    }
    window.addEventListener('message', function (ev) {
      if (ev.origin !== location.origin) return;
      var d = ev.data;
      if (!d || d.type !== 'ZW_HEADER_LAYOUT') return;
      draftDone(d.id, d);
    });

    /* The canvas gets its draft by postMessage, and a message that never comes
       has no failure to catch. Without this, a builder that did not post one
       would leave the header showing neither the draft nor what is live — worse
       than the flash this replaces. Long enough that the message wins in
       practice; short enough that nobody reads the wrong header for long. */
    /* The "a draft that never arrives must release the held value" timer used
       to be here. It belongs to the gate now, with the same 1.5s and the same
       reason — long enough that a message sent on load wins in practice, short
       enough that nobody reads the wrong header for long. */
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootStorefront);
  else bootStorefront();
})();
