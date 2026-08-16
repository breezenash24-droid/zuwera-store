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
  try {
    var _tc = JSON.parse(localStorage.getItem('zw_theme_modes') || 'null');
    var _id = _sel || (_tc && _tc.default) || '';
    _rec = (_tc && _tc.modes && _tc.modes.filter(function (x) { return x && x.id === _id; })[0]) || null;
  } catch (_) {}

  /* THE BASE. Everything below reads this and nothing below re-decides it. */
  var _base = (_rec && _rec.base) || '';
  /* The three built-in ids ARE their own base, and base.css already declares
     their token sets against the body classes — so for these the class alone is
     the whole answer and no colours need restating here. */
  if (!_base && (_sel === 'dark' || _sel === 'light' || _sel === 'super-light')) _base = _sel;
  /* What the build baked in, for a visitor with nothing stored at all. */
  if (!_base) _base = h.getAttribute('data-zw-theme-default') || '';
  /* And finally what ships in the stylesheet. See rule 2 above. */
  if (_base !== 'light' && _base !== 'super-light') _base = 'dark';

  var _tt = (_rec && _rec.tokens) || null;
  var _light = _base !== 'dark';

  h.setAttribute('data-zw-base', _base);
  h.style.colorScheme = _light ? 'light' : 'dark';

  /* GROUND AND TEXT MOVE TOGETHER — the classes are set from the same _base as
     the background, unconditionally. The old version set them only when it had
     a token cache to read, so the common case (no cache) painted a light ground
     under dark-mode rules. <body> does not exist yet in <head>, so this applies
     at the first moment it does. Idempotent: the engine toggles the same two. */
  (function () {
    var go = function () {
      if (!document.body) return false;
      document.body.classList.toggle('light-mode', _light);
      document.body.classList.toggle('super-light-mode', _base === 'super-light');
      return true;
    };
    if (!go()) document.addEventListener('readystatechange', go, { once: false });
  }());

  /* The ground. Dark is left alone deliberately: it is what base.css already
     paints, so writing it again can only be a chance to write it wrong. */
  var _ground = (_tt && _tt.bg) ? ('rgb(' + _tt.bg + ')')
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
    if (_tt.navBg) h.style.setProperty('--zw-nav-bg', _tt.navBg);
    if (_tt.fg) h.style.setProperty('--fg-rgb', _tt.fg);
    if (_tt.bg) h.style.setProperty('--bg-rgb', _tt.bg);
    if (_tt.ink) h.style.setProperty('--ink', _tt.ink);
    if (_tt.paper) h.style.setProperty('--paper', _tt.paper);
    if (_tt.surface) h.style.setProperty('--surface', _tt.surface);
    if (_tt.accent) h.style.setProperty('--accent', _tt.accent);
    if (_tt.bg) h.style.setProperty('--black', 'rgb(' + _tt.bg + ')');
    if (_tt.fg) h.style.setProperty('--white', 'rgb(' + _tt.fg + ')');
  }
} catch (_) {}
