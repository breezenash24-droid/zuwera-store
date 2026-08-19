/* THEME PRE-PAINT — the single answer to "what colour is this page?"
 *
 * NOT A SERVED FILE. scripts/sync-preboot.js inlines this verbatim into the
 * <head> of every storefront page, between the zw:preboot markers. It has to be
 * inline: it must run before the first frame, and a <script src> in <head>
 * blocks the parser for a whole round trip to save 1 KB — which is the opposite
 * of the trade we want. Inlining it costs bytes once per page; a request costs
 * every visitor a paint delay.
 *
 * So it is copied fourteen times, and it USED to be maintained fourteen times.
 * That is the whole reason this file exists. tests/theme-preboot.test.js fails
 * the build if any page's copy differs from this one by a single byte.
 *
 * ── What went wrong, and why it took so long to see ──────────────────────────
 *
 * There were two separate questions being answered by two different pieces of
 * code that had never agreed on an answer:
 *
 *   "What is the page's BACKGROUND?"  — answered here, from zw_theme_mode,
 *                                       defaulting to 'super-light'.
 *   "What is the page's TEXT?"        — answered by theme-engine.js, from the
 *                                       cached theme config, defaulting to
 *                                       whatever config.default said.
 *
 * On a visitor with a theme cache but no explicit choice, the first said WHITE
 * and the second said DARK. Both then wrote what they believed:
 *
 *   here:   <style>body{background:#FFFFFF!important}</style>
 *   engine: body.classList.toggle('light-mode', false)  +  --fg-rgb: 244 241 235
 *
 * and because the ground was painted with !important and the engine only sets
 * html.style.backgroundColor, the engine could not take it back. The page kept
 * the white ground and got the dark theme's near-white text on top of it. Every
 * colour in the store derives from --fg-rgb through the alpha ladder in
 * base.css (--c70 is rgb(var(--fg-rgb) / 70%)), so this was not one bad element
 * — it was every piece of text on the page at once, at whatever opacity its
 * rule happened to use. The bag page showed it worst because it is mostly text.
 *
 * Three rules come out of that, and all three are enforced by the test:
 *
 *   1. ONE BASE, decided once, at the top. Ground, text tokens and body classes
 *      are all derived from it. They cannot disagree because there is nothing
 *      for them to disagree about.
 *
 *   2. THE LAST-RESORT DEFAULT IS WHAT THE STYLESHEET SHIPS — dark. When this
 *      file knows nothing, painting anything other than what base.css already
 *      paints CREATES the mismatch it exists to prevent. The build knows better
 *      and says so: stamp-theme-default.js puts the store's real default on
 *      <html data-zw-theme-default>, which is consulted before the fallback.
 *
 *   3. THE GROUND OVERRIDE IS RETRACTABLE. It carries an id, and
 *      theme-engine.js removes it the moment it applies a real theme. A
 *      pre-paint guess must never outlive the answer it was standing in for.
 */
try {
  var h = document.documentElement;

  /* AM I A BUILDER PREVIEW? Answered from the URL, on every page.
   *
   * This flag used to be set in storefront.js — and only index.html and
   * drop001.html load that file. So on the product and landing previews it was
   * undefined, and storefront-theme.js's legacy-theme path reads it as
   * `apply(mode, !window.__ZW_BUILDER_PREVIEW__)`, i.e. `apply(mode, TRUE)`.
   * The second argument means REMEMBER.
   *
   * So opening a product or landing page in the page builder wrote
   * zw_theme_mode into the real localStorage — the builder was silently
   * choosing the visitor's theme for them, from a legacy settings row, and the
   * preboot then honoured that choice on every page forever after. It is why a
   * store whose default is white renders dark everywhere except the homepage,
   * which is the one page that skips the fetch entirely.
   *
   * Every preview iframe carries ?builder=1 — index, drop001, product and
   * landing alike — so the URL is the one signal all four share. Set here
   * because this block is inlined into all fourteen pages and runs before any
   * script that reads it. */
  try {
    if (/[?&]builder=1(?:&|$)/.test(location.search)) window.__ZW_BUILDER_PREVIEW__ = true;
  } catch (_) {}

  /* ── WHERE THE HEADER'S PARTS SIT, BEFORE THE FIRST FRAME ──────────────────
   *
   * Same shape of problem as the theme, and the same two answers.
   * header-layouts.js is deferred: it cannot run until the document is parsed,
   * so the header painted in the arrangement the MARKUP happens to be in —
   * logo left, categories centred — and then jumped to the chosen one. On a
   * store whose logo is centred, that was every page load.
   *
   * TWO SOURCES, AND THE ONE THAT IS NEWER WINS.
   *
   *   BAKED    stamp-header-layout.js writes the four attributes straight onto
   *            <html> at build time, so the first frame is right with no
   *            JavaScript at all — including for a first-ever visitor, which is
   *            the case no cache can ever help with, because the whole problem
   *            is that there is no cache. Already applied before this runs.
   *   CACHED   what this browser last saw the server say.
   *
   * Neither is reliably fresher. Publishing without deploying leaves the bake
   * stale; a visitor who has not been back since a change has a stale cache.
   * Both carry the row's updated_at, so this compares them instead of picking a
   * favourite — and a tie needs no work, which is the common case.
   *
   * WHAT IS CACHED IS THE ANSWER, NOT THE QUESTION. The cache holds the four
   * placement values, not the layout's name, so this block knows nothing about
   * what layouts exist or what any is called. Adding an arrangement never
   * touches this file, and there is no second copy of the layout table here to
   * drift from the real one.
   *
   * Values are checked against the same small vocabulary theme-engine.js
   * accepts. An attribute the stylesheet has no rule for still counts as
   * "placed" and suppresses the arrangement the page shipped with, so junk
   * would produce a header with NO placement rather than no change — the
   * failure this guards is a blank header, not a wrong one.
   *
   * Not in a builder preview: there the published arrangement is exactly what
   * must NOT be shown, and header-layouts.js holds it back for the draft. So
   * the bake is stripped as well as the cache being ignored. */
  try {
    if (window.__ZW_BUILDER_PREVIEW__) {
      h.removeAttribute('data-zw-hdr');
      h.removeAttribute('data-zw-hdr-logo');
      h.removeAttribute('data-zw-hdr-links');
      h.removeAttribute('data-zw-hdr-actions');
      h.removeAttribute('data-zw-hdr-linksrow');
    } else {
      var _hc = (localStorage.getItem('zw_hdr_attrs') || '').split('|');
      var _hs = { left: 1, center: 1, right: 1 };
      /* values|updated_at, both from the same PostgREST column, so comparing
         them as strings is comparing the timestamps. WITH NOTHING BAKED THE
         CACHE ALWAYS APPLIES — otherwise an undated cache from a build before
         this existed, or any local build that does no stamping, would be
         thrown away in favour of nothing at all. */
      var _hb = h.getAttribute('data-zw-hdr-at') || '';
      if (_hc.length >= 4 && _hs[_hc[0]] && (_hs[_hc[1]] || _hc[1] === 'none')
          && _hs[_hc[2]] && (_hc[3] === '1' || _hc[3] === '2')
          && (!_hb || (_hc[4] || '') > _hb)) {
        h.setAttribute('data-zw-hdr', '1');
        h.setAttribute('data-zw-hdr-logo', _hc[0]);
        h.setAttribute('data-zw-hdr-links', _hc[1]);
        h.setAttribute('data-zw-hdr-actions', _hc[2]);
        h.setAttribute('data-zw-hdr-linksrow', _hc[3]);
        h.setAttribute('data-zw-hdr-at', _hc[4] || '');
      }
    }
  } catch (_) {}

  /* ── ONE-TIME RESET OF A CHOICE NOBODY MADE ────────────────────────────────
   *
   * Six pages used to apply the legacy site_settings.theme row through
   * ZWTheme.apply(mode) with `remember` left to default — which is TRUE. So a
   * value the admin panel's own light/dark chrome toggle wrote, possibly years
   * ago, was recorded in zw_theme_mode as though this visitor had picked it.
   *
   * Once written it is read FIRST, here and in theme-engine.js, on every page,
   * forever. It outranks the store's configured default, so the Themes panel
   * stops having any visible effect and the shop renders in a theme nobody
   * selected. Fixing the six writers stops it happening again; it does nothing
   * for the browsers that already ran the old code, and those are the only
   * browsers anybody has been testing in.
   *
   * So: cleared exactly once, marked so it never repeats. Somebody who really
   * did pick a theme picks it again — the alternative is a store that can never
   * show its own default to anyone who has already visited it.
   *
   * Placed here rather than in storefront-theme.js because that file is
   * deferred, and a reset that lands after the key has been read is a reset
   * that takes an extra page load to matter. */
  try {
    if (!localStorage.getItem('zw_theme_choice_reset')) {
      localStorage.setItem('zw_theme_choice_reset', '1');
      localStorage.removeItem('zw_theme_mode');
      localStorage.removeItem('zw_homepage_theme_mode');
    }
  } catch (_) {}

  /* What this visitor chose. A landing page narrows the question — it can carry
     its own theme per slug — and defines __zwLM above this block when it does. */
  var _sel = '';
  try { _sel = (typeof window.__zwLM === 'function' ? (window.__zwLM() || '') : ''); } catch (_) {}
  if (!_sel) {
    try {
      _sel = localStorage.getItem('zw_theme_mode')
          || localStorage.getItem('zw_homepage_theme_mode') || '';
    } catch (_) {}
  }

  /* The theme RECORD, which is the only thing that knows a CUSTOM theme's
     colours. Absent on a first visit, in a private window, and after a clear —
     which is exactly when getting this wrong is most visible. */
  var _rec = null;
  var _id = '';
  try {
    var _tc = JSON.parse(localStorage.getItem('zw_theme_modes') || 'null');
    _id = _sel || (_tc && _tc.default) || '';
    _rec = (_tc && _tc.modes && _tc.modes.filter(function (x) { return x && x.id === _id; })[0]) || null;
  } catch (_) {}

  /* THE BAKED DEFAULT, AND THE ONE MOMENT TO STOP BELIEVING IT.
     stamp-theme-default.js writes the store's default theme into the page as a
     real stylesheet rule, scoped to html[data-zw-theme-stamp], so a visitor
     with nothing stored gets the right colours, scale and density on the first
     frame without waiting for theme-engine.js to arrive over the network.
     It is the whole answer for that visitor and the wrong answer for a visitor
     who picked something else — and removing this one attribute is what says
     so, before a single rule has been matched. Compared by ID, not by base:
     two themes can share a base and share nothing else. */
  var _stamp = h.getAttribute('data-zw-theme-stamp') || '';
  if (_stamp && _id && _id !== _stamp) h.removeAttribute('data-zw-theme-stamp');

  /* THE BASE. Everything below reads this and nothing below re-decides it.
     _known tracks whether it was actually LEARNED or merely fallen back to —
     the difference matters, see the class block. */
  var _known = true;
  var _base = (_rec && _rec.base) || '';
  /* The three built-in ids ARE their own base, and base.css already declares
     their token sets against the body classes — so for these the class alone is
     the whole answer and no colours need restating here. */
  if (!_base && (_sel === 'dark' || _sel === 'light' || _sel === 'super-light')) _base = _sel;
  /* What the build baked in, for a visitor with nothing stored at all. */
  if (!_base) _base = h.getAttribute('data-zw-theme-default') || '';
  if (_base !== 'light' && _base !== 'super-light' && _base !== 'dark') { _base = ''; }
  /* And finally what ships in the stylesheet. See rule 2 above. */
  if (!_base) { _base = 'dark'; _known = false; }

  var _tt = (_rec && _rec.tokens) || null;
  var _light = _base !== 'dark';

  if (_known) {
    h.setAttribute('data-zw-base', _base);
    h.style.colorScheme = _light ? 'light' : 'dark';
  }

  /* GROUND AND TEXT MOVE TOGETHER — the classes come from the same _base as the
     background. The old version set them only when it had a token cache to
     read, so the common case (no cache) painted a light ground under dark-mode
     rules. <body> does not exist yet in <head>, so this applies at the first
     moment it does. Idempotent: the engine toggles the same two.

     KNOWING NOTHING IS NOT THE SAME AS KNOWING DARK, and conflating them is its
     own bug. stamp-theme-default.js bakes the store's default onto <body> at
     build time, and in a srcdoc iframe or anywhere localStorage is unreadable
     that stamp is the ONLY signal there is. Toggling from the fallback would
     strip it and turn a light store dark on exactly the loads that have nothing
     else to go on — the same mistake theme-engine.js's shippedBase() exists to
     avoid, made one step earlier. So when nothing was learned, the stamp is
     read rather than overwritten. */
  (function () {
    var go = function () {
      if (!document.body) return false;
      /* RUN ONCE, AND NEVER AFTER THE ENGINE HAS SPOKEN.
       *
       * This was registered with { once: false }, and readystatechange fires
       * more than once — 'interactive' and then 'complete'. Deferred scripts run
       * BEFORE readyState becomes 'interactive', so theme-engine.js has already
       * applied a theme by the time the first of those fires, and the second
       * lands even later. Traced live on the policy page:
       *
       *     +456ms [interactive] toggle(light-mode, true)   <- this block
       *     +466ms [interactive] toggle(light-mode, true)   <- theme-engine
       *     +573ms [complete]    toggle(light-mode, true)   <- this block, again
       *     +619ms               apply('dark')              <- legacy row
       *
       * The engine sets the theme's TOKENS as inline styles on <body> and the
       * CLASSES together, so they always agree — until this block puts a stale
       * class back on its own. Then the two halves of the header come from
       * different themes: body.super-light-mode pins the bar to #FFFFFF through
       * an !important literal, while the inline --fg-rgb is still the dark
       * theme's 244 241 235. White bar, near-white links, and a logo that
       * inverts the wrong way. Present, focusable, clickable, invisible.
       *
       * The listener is detached on the first successful run, and the engine's
       * own marker is honoured if it got there first. */
      document.removeEventListener('readystatechange', go);
      if (h.hasAttribute('data-zw-theme')) return true;
      if (_known) {
        document.body.classList.toggle('light-mode', _light);
        document.body.classList.toggle('super-light-mode', _base === 'super-light');
      } else {
        var cl = document.body.classList;
        var shipped = cl.contains('super-light-mode') ? 'super-light'
                    : cl.contains('light-mode') ? 'light' : 'dark';
        h.setAttribute('data-zw-base', shipped);
        h.style.colorScheme = shipped === 'dark' ? 'dark' : 'light';
      }
      return true;
    };
    if (!go()) document.addEventListener('readystatechange', go);
  }());

  /* The ground. Dark is left alone deliberately: it is what base.css already
     paints, so writing it again can only be a chance to write it wrong. */
  var _ground = !_known ? ''
              : (_tt && _tt.bg) ? ('rgb(' + _tt.bg + ')')
              : _base === 'super-light' ? '#FFFFFF'
              : _base === 'light' ? '#F0EEE9' : '';
  if (_ground) {
    h.style.background = _ground;
    h.style.setProperty('--zw-notch-bar', _ground);
    var _mt = document.querySelector('#zw-theme-meta, meta[name="theme-color"]');
    if (_mt) _mt.setAttribute('content', _ground);
    var _cs = document.querySelector('meta[name="color-scheme"]');
    if (_cs) _cs.setAttribute('content', _light ? 'light' : 'dark');
    if (_light) {
      /* !important, because it has to beat html{background:#09090b} in
         storefront-cohesion.css before any class exists to do it properly — and
         therefore ID'd, because theme-engine.js has to be able to take it back.
         Without the id this override is a one-way ratchet: see rule 3. */
      var _st = document.createElement('style');
      _st.id = 'zw-preboot-ground';
      _st.textContent = 'body{background:' + _ground + '!important}html::before{background:' + _ground + '!important}';
      document.head.appendChild(_st);
    }
  }

  /* A custom theme's own colours, for the same reason the ground is painted:
     the alpha ladder in base.css hangs off --fg-rgb, so a page that paints the
     background early and the foreground late shows every piece of text in the
     previous theme's colour until the engine loads. Set on <html>; the engine
     later sets them on <body>, which is nearer, so nothing here fights it. */
  if (_tt) {
    /* WHERE A TOKEN HAS TO BE WRITTEN TO SURVIVE.
     *
     * These used to be set on <html>, and every one of them was thrown away the
     * instant the stylesheet loaded. base.css declares --fg-rgb, --paper, --ink
     * and the rest on `body.light-mode` / `body.super-light-mode`, and a
     * declaration on the nearer ancestor beats an inherited one from <html>.
     * theme-engine.js documents exactly this at the top of apply() — "setting
     * the triplet on :root would lose to that class every time, and a custom
     * theme's colours would be silently replaced by the built-in light ones" —
     * and then this file went and set them on :root.
     *
     * So a custom theme's colours never survived to first paint. They arrived
     * only when theme-engine.js had downloaded and set the same tokens as
     * inline styles on <body>. That file is deferred and cache-busted, so every
     * deploy guarantees one cold fetch of it, which is precisely why the first
     * load after a deploy looked wrong and a refresh fixed it.
     *
     * A rule wins where a root property lost: html[data-zw-preboot] body is
     * (0,1,2) against the built-in block's (0,1,1), and theme-engine.js still
     * outranks both because an inline style beats any selector. Same shape as
     * the baked default above, one source of authority, three tiers.
     *
     * Removed by theme-engine.js the moment it applies the real theme — a
     * pre-paint guess must never outlive the answer it stood in for. */
    var _d = '';
    var _rd = '';
    /* Values come from this visitor's own localStorage, but they are being
       written into a stylesheet, so anything that could close the declaration
       or the element is dropped rather than escaped. */
    var _put = function (p, v) {
      /* Falsy is UNSET, matching theme-engine.js set(). A 0 that means
         something — motion — is handled on its own below. */
      if (!v) return;
      v = String(v);
      if (/[{}<>;]/.test(v)) return;
      _d += p + ':' + v + ';';
    };

    /* THE NAV IS A PAIR AND HAS TO MOVE AS ONE.
       This set --zw-nav-bg and not --zw-nav-fg, and four rules read the second
       one. A two-tone theme paints a dark bar over a light page, so on the
       first frame the bar got its dark background while its links fell through
       `color: var(--zw-nav-fg, inherit)` to the PAGE's foreground — dark text
       on a dark bar, until theme-engine.js loaded and set the other half. The
       same ground-without-text mistake as the page itself, one element in. */
    _put('--zw-nav-bg', _tt.navBg);
    _put('--zw-nav-fg', _tt.navFg);
    _put('--fg-rgb', _tt.fg);
    _put('--bg-rgb', _tt.bg);
    /* A DEFAULT for --zw-nav-fg when the theme names none.
       Without one the header falls through `color: var(--zw-nav-fg, …)` to
       whatever the page hands down — and on the light modes that is --paper,
       which resolves to a SURFACE (#f5f5f5). Near-white links on a white bar.
       Only on the first load after a deploy, because that is the one time the
       stylesheet carrying the corrected fallback is not already in cache; on
       every later load it arrives fast enough that nobody sees the gap.
       Set here rather than per page: index and landing carry their own inline
       .nav-link colour, product carries none and inherits, and patching each
       dialect is how this reached three pages and missed the rest. This runs
       before the first frame on all fourteen. */
    if (!_tt.navFg && _tt.fg && _light) _put('--zw-nav-fg', 'rgb(' + _tt.fg + ')');
    _put('--ink', _tt.ink);
    _put('--paper', _tt.paper);
    /* --zw-theme-surface, which is the name base.css declares and cart.css
       reads. This wrote `--surface`, a name nothing on the storefront has ever
       looked at, so a custom theme's panel colour simply did not arrive before
       the engine ran. A token written under the wrong name fails silently and
       forever — nothing errors, the value is just never asked for. */
    _put('--zw-theme-surface', _tt.surface);
    _put('--accent', _tt.accent);
    _put('--zw-accent', _tt.accent);
    _put('--err', _tt.err);
    _put('--zw-bar-bg', _tt.barBg);
    _put('--zw-bar-fg', _tt.barFg);
    /* SHAPE AND SPACING, not just colour. A custom theme carries a type scale
       and a density, and leaving them to theme-engine.js meant the first frame
       was laid out at the built-in 1.0 and then RELAID OUT when the real value
       arrived. A palette that changes late is a flicker; a type scale that
       changes late moves every line on the page. */
    _put('--zw-radius', _tt.radius);
    _put('--zw-density', _tt.density);
    _put('--zw-ease', _tt.ease);
    if (_tt.bg) _put('--black', 'rgb(' + _tt.bg + ')');
    if (_tt.fg) _put('--white', 'rgb(' + _tt.fg + ')');

    /* --zw-type-scale is read where it is DECLARED, not where it is used:
       base.css computes --text-hero and its siblings in :root as
       `calc(clamp(…) * var(--zw-type-scale, 1))`. Putting it on body would
       change nothing, which is why theme-engine.js sets it on root too. */
    var _sc = parseFloat(_tt.typeScale);
    if (isFinite(_sc) && _sc > 0) _rd += '--zw-type-scale:' + _sc + ';';
    var _mo = parseFloat(_tt.motion);
    if (isFinite(_mo) && _mo >= 0) _rd += '--zw-motion:' + _mo + ';';

    if (_d || _rd) {
      h.setAttribute('data-zw-preboot', '1');
      var _ts = document.createElement('style');
      _ts.id = 'zw-preboot-tokens';
      _ts.textContent = (_rd ? 'html[data-zw-preboot]{' + _rd + '}' : '')
        + (_d ? 'html[data-zw-preboot] body{' + _d + '}' : '');
      document.head.appendChild(_ts);
    }
  }
} catch (_) {}
