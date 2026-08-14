/* ────────────────────────────────────────────────────────────────────────────
   theme-engine.js — themes as data.

   The site had exactly three looks and their names were compiled into it:
   'dark', 'light', 'super-light', each a hand-written block in base.css and a
   hardcoded branch in every switcher. Adding a fourth meant editing CSS,
   JavaScript and the admin. Renaming one meant finding every string.

   A theme is now seven colours and a name, stored in
   site_settings.theme_modes and applied at runtime:

     { id, label, icon, base, tokens: { fg, bg, ink, paper, surface, accent, err } }

   `base` is the bridge that makes this migratable. The stylesheets still carry
   hundreds of `body.light-mode .thing { … }` rules written against literal
   colours, and those cannot all be converted at once. So every theme declares
   whether it is fundamentally dark or light, that class goes on the body as it
   always did, and the theme's own colours are layered on top as custom
   properties. A brand-new purple theme inherits all of light mode's structural
   CSS and simply repaints it — rather than starting from nothing and rendering
   as an unstyled page.

   The three original modes are the built-in defaults here, so a store that
   never opens the theme editor behaves exactly as before, and nothing depends
   on the settings row existing.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var CACHE_KEY = 'zw_theme_modes';
  var CHOICE_KEY = 'zw_theme_mode';           // which theme this visitor picked
  var REST = 'https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/site_settings?select=value&key=eq.theme_modes';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

  /* The three that shipped. Their ids are the same strings the rest of the
     codebase already stores and compares, so an existing visitor's saved
     choice keeps working and no other file needs to know this changed. */
  var BUILTINS = [
    { id: 'dark', label: 'Dark', icon: '🌙', base: 'dark', builtin: true,
      tokens: { fg: '244 241 235', bg: '9 9 11', ink: '#09090b', paper: '#f4f1eb', surface: '#111113', accent: '#F891A5', err: '#ef4444' } },
    { id: 'light', label: 'Light', icon: '☀️', base: 'light', builtin: true,
      tokens: { fg: '10 10 10', bg: '240 238 233', ink: '#F0EEE9', paper: '#09090b', surface: '#FFFFFF', accent: '#F891A5', err: '#ef4444' } },
    { id: 'super-light', label: 'Super Light', icon: '⚪', base: 'super-light', builtin: true,
      tokens: { fg: '10 10 10', bg: '255 255 255', ink: '#FFFFFF', paper: '#09090b', surface: '#F5F5F5', accent: '#F891A5', err: '#ef4444' } },
    /* Two-tone: a light page under a black header. This look already existed by
       accident — .nav is hardcoded dark and only some pages bothered to override
       it in light mode, so whether you got it depended on which page you landed
       on. It is a good look, so it is a theme now rather than a coverage gap,
       and navBg is why: a theme can colour the header independently of the page.
       Leave navBg empty in any other theme and the header follows the page, as
       it always did. */
    { id: 'two-tone', label: 'Two-tone', icon: '◐', base: 'light', builtin: true,
      tokens: { fg: '10 10 10', bg: '240 238 233', ink: '#F0EEE9', paper: '#09090b', surface: '#FFFFFF', accent: '#F891A5', err: '#ef4444',
                navBg: '#09090b', navFg: '#f4f1eb' } },
  ];

  var config = { modes: BUILTINS.slice(), default: 'dark', pages: {} };
  var applied = null;

  /* ── The surface that never moved ──────────────────────────────────────────
     `surface` shipped as #F0EEE9 in all four built-ins, because the CSS var
     behind it was called --surface-light and predated themes: one palette, one
     light surface, a reasonable constant. As a THEME token it was wrong in
     every direction at once — identical to the page in Light and Super Light,
     so choosing it did nothing; and a cream slab on the black page in Dark,
     carrying the dark theme's cream text onto itself. Cream on cream.

     Fixing the built-ins is not enough on its own. The theme editor writes all
     seven fields whenever a theme is saved, so any store that has ever opened
     one has #F0EEE9 sitting in its settings row, and a stored token beats the
     built-in — correctly, since that is what makes a customised built-in stick.

     So the old default is read as "never chosen" rather than as a choice, and
     only for a BUILT-IN theme, where we know what the default was. The same
     reasoning storefront.js applies to legacy section colours: a literal that
     is exactly what the picker handed over was not a decision about that
     colour. Anything else the store set is left alone, and nothing is rewritten
     on disk — pick #F0EEE9 deliberately in a custom theme and it stays. */
  var LEGACY_SURFACE = '#f0eee9';

  function mergeTokens(builtin, stored) {
    var base = builtin ? builtin.tokens : BUILTINS[0].tokens;
    var t = Object.assign({}, base, stored || {});
    if (builtin && stored && String(stored.surface || '').toLowerCase() === LEGACY_SURFACE
        && String(base.surface || '').toLowerCase() !== LEGACY_SURFACE) {
      t.surface = base.surface;
    }
    return t;
  }

  // ── Normalising ──────────────────────────────────────────────────────────
  function normalise(raw) {
    if (!raw || typeof raw !== 'object') return { modes: BUILTINS.slice(), default: 'dark' };
    var modes = Array.isArray(raw.modes) ? raw.modes.filter(function (m) { return m && m.id; }) : [];
    // A store that deleted every theme still needs one to render in.
    if (!modes.length) modes = BUILTINS.slice();
    modes = modes.map(function (m) {
      var builtin = BUILTINS.filter(function (b) { return b.id === m.id; })[0];
      return {
        id: String(m.id),
        label: String(m.label || (builtin && builtin.label) || m.id),
        icon: String(m.icon || (builtin && builtin.icon) || '🎨'),
        // Unknown base → 'dark', because a theme with no structural CSS behind
        // it is unreadable, and dark is what :root already carries.
        base: m.base === 'light' || m.base === 'super-light' ? m.base : 'dark',
        builtin: !!(builtin),
        tokens: mergeTokens(builtin, m.tokens),
      };
    });
    var def = modes.filter(function (m) { return m.id === raw.default; })[0];
    /* Per-page themes. A store is rarely one look end to end — a dark shop and
       a light checkout is a normal thing to want, and until now the theme was
       one global choice that the homepage happened to own.

       pages maps a path to a theme id. Longest match wins, so '/product.html'
       beats '/', and anything unlisted falls back to the default. A page named
       here for a theme that no longer exists is ignored rather than blank. */
    var pages = {};
    if (raw.pages && typeof raw.pages === 'object') {
      Object.keys(raw.pages).forEach(function (path) {
        var id = raw.pages[path];
        if (modes.some(function (m) { return m.id === id; })) pages[String(path)] = id;
      });
    }
    return { modes: modes, default: def ? def.id : modes[0].id, pages: pages };
  }

  /* Which theme this URL should wear. A visitor's own pick still wins — someone
     who chose Dark asked for Dark, and having the checkout disagree with them
     would read as a bug rather than a design. */
  function themeForPath(path) {
    var p = String(path || '/');
    var best = '', bestId = '';
    Object.keys(config.pages || {}).forEach(function (key) {
      if (p === key || (key !== '/' && p.indexOf(key) === 0)) {
        if (key.length > best.length) { best = key; bestId = config.pages[key]; }
      }
    });
    return bestId || '';
  }

  function byId(id) {
    for (var i = 0; i < config.modes.length; i++) if (config.modes[i].id === id) return config.modes[i];
    return null;
  }

  // ── Applying ─────────────────────────────────────────────────────────────
  /* The two halves: the legacy body classes that hundreds of existing rules
     are written against, and the token overrides that repaint them. Order does
     not matter to CSS but it does to a reader — the class decides the shape,
     the tokens decide the colour. */
  /* ── Header composition ──────────────────────────────────────────────────
     `header` is either a preset NAME or an object placing each part itself.
     Both end up as the same four attributes, because a preset is only a name
     for a combination — keeping them as two mechanisms is how they drift apart
     and start disagreeing.

     The five presets are the arrangements the site shipped with, so a theme
     saved before placements existed keeps working untouched. */
  var HDR_PRESETS = {
    inline:  { logo: 'left',   links: 'center', actions: 'right', linksRow: 1 },
    tight:   { logo: 'left',   links: 'left',   actions: 'right', linksRow: 1 },
    stacked: { logo: 'center', links: 'center', actions: 'right', linksRow: 2 },
    split:   { logo: 'center', links: 'left',   actions: 'right', linksRow: 1 },
    minimal: { logo: 'left',   links: 'none',   actions: 'right', linksRow: 1 },
  };
  var HDR_SPOTS = { left: 1, center: 1, right: 1 };

  /* The header controls, by role rather than by element — the two button
     systems spell the same role differently and the stylesheet owns that
     mapping, so nothing here needs to know about .nbtn or .zw-hdr-action. */
  var ICON_KEYS = ['search', 'account', 'login', 'logout', 'shop', 'bag', 'menu'];

  function applyIcons(root, icons) {
    var spec = (icons && typeof icons === 'object') ? icons : {};
    var order = (spec.order && typeof spec.order === 'object') ? spec.order : {};
    ICON_KEYS.forEach(function (k) {
      var v = parseInt(order[k], 10);
      // Absent, not 0: every control defaults to order 0 in the stylesheet, so
      // removing the property restores DOM order rather than pinning it first.
      if (isFinite(v)) root.style.setProperty('--zw-ord-' + k, String(v));
      else root.style.removeProperty('--zw-ord-' + k);
    });
    /* 'menu' is deliberately not hideable. On a phone the hamburger is the only
       route to the categories, and a theme that hid it would strand every
       collection page behind a control that is no longer there. */
    var hidden = (Array.isArray(spec.hidden) ? spec.hidden : []).filter(function (k) {
      return ICON_KEYS.indexOf(k) !== -1 && k !== 'menu';
    });
    if (hidden.length) root.setAttribute('data-zw-hide', hidden.join(' '));
    else root.removeAttribute('data-zw-hide');
  }

  function applyHeader(root, header) {
    var attrs = ['data-zw-hdr', 'data-zw-hdr-logo', 'data-zw-hdr-links',
                 'data-zw-hdr-actions', 'data-zw-hdr-linksrow'];
    /* Nothing set means the arrangement the page shipped with, and clearing
       every attribute is what expresses that. Leaving a stale one behind is
       precisely how a header keeps the previous theme's layout after a switch —
       the attributes ARE the state, so they have to be removed, not just
       overwritten with the ones the new theme happens to mention. */
    if (!header) { attrs.forEach(function (a) { root.removeAttribute(a); }); return; }

    var spec = typeof header === 'string' ? HDR_PRESETS[header] : header;
    if (!spec || typeof spec !== 'object') {
      attrs.forEach(function (a) { root.removeAttribute(a); });
      return;
    }
    // Unknown values are dropped rather than written through: an attribute the
    // stylesheet has no rule for reads as "placed" and suppresses the default.
    var logo    = HDR_SPOTS[spec.logo] ? spec.logo : 'left';
    var links   = (HDR_SPOTS[spec.links] || spec.links === 'none') ? spec.links : 'center';
    var actions = HDR_SPOTS[spec.actions] ? spec.actions : 'right';
    root.setAttribute('data-zw-hdr', '1');
    root.setAttribute('data-zw-hdr-logo', logo);
    root.setAttribute('data-zw-hdr-links', links);
    root.setAttribute('data-zw-hdr-actions', actions);
    root.setAttribute('data-zw-hdr-linksrow', String(spec.linksRow) === '2' ? '2' : '1');
  }

  function apply(theme) {
    if (!theme || !document.documentElement) return;
    var root = document.documentElement;
    var t = theme.tokens || {};

    /* On body, not :root. The alpha ladder is declared on body so that the
       body.light-mode class can move it; setting the triplet on :root would
       lose to that class every time, and a custom theme's colours would be
       silently replaced by the built-in light ones. An inline style on body
       outranks the class, so this wins — which is the point.

       The page background is the exception and goes on :root as well, because
       the area outside body (overscroll, the notch) is painted from there. */
    var el = document.body || root;
    var set = function (name, value) {
      if (value) el.style.setProperty(name, value);
      else el.style.removeProperty(name);
    };
    set('--fg-rgb', t.fg);
    set('--bg-rgb', t.bg);
    set('--ink', t.ink);
    set('--paper', t.paper);
    /* --black and --white are ALIASES of --ink and --paper. base.css defines
       them as literally the same values in every block: :root has
       --black/--ink both #09090b, light-mode has both #F0EEE9, and so on.
       They are the older spelling, and 88 rules still use them — 35 in
       product.css, 35 in drop001.html, 17 in product.html.

       Setting only --ink and --paper here left the aliases behind. For the
       three built-in themes nobody noticed, because the body class supplies
       both pairs with matching values. Put a CUSTOM theme on and the pairs come
       apart: these inline properties beat the class rules, so --ink moves to
       the theme's colour while --white keeps whatever the built-in for that
       base said. The product page then draws its labels in one palette on a
       background from another, and washes out.

       Two names for one colour is the same fault as two answerers for one
       question — it only stays hidden while nothing moves. */
    set('--black', t.ink);
    set('--white', t.paper);
    set('--zw-theme-surface', t.surface);
    set('--accent', t.accent);
    set('--err', t.err);
    /* Optional, and the fallback matters: every nav rule reads
       var(--zw-nav-bg, <its old value>), so clearing these returns the header
       to following the page exactly as before this existed. Only a theme that
       wants a header in a different colour from its page sets them. */
    set('--zw-nav-bg', t.navBg);
    set('--zw-nav-fg', t.navFg);
    /* The announcement bar, on the same terms as the header. It was #09090b in
       announcement-bar.js on every page, with the homepage alone overriding it
       from builder_theme — so the one strip that appears above everything was
       the least themeable thing on the site. */
    set('--zw-bar-bg', t.barBg);
    set('--zw-bar-fg', t.barFg);

    /* Shape, scale and density — the three dimensions that separate one
       storefront theme from another once the colours match. A theme that only
       carries paint cannot tell a restrained editorial layout from a loud one;
       these are what make that difference expressible.

       typeScale multiplies the root font size, so every rem-based size moves
       together and the whole page reads bigger or tighter without touching a
       single rule. Blunt on purpose: a per-role scale is a typography system,
       and this store already has one of those under Appearance → Typography.
       This is the dial that says "this theme is loud".

       radius and density are read by the rules that draw cards, inputs and
       section padding, each with its current value as the fallback — so a
       theme that sets neither behaves exactly as before. */
    var scale = parseFloat(t.typeScale);
    root.style.setProperty('--zw-type-scale', isFinite(scale) && scale > 0 ? String(scale) : '1');
    set('--zw-radius', t.radius);
    set('--zw-density', t.density);

    /* Motion. A theme that carries how the site looks but not how it moves is
       half a theme — two storefronts with the same palette feel nothing alike
       if one glides and the other snaps. Durations derive from the multiplier
       in motion.css, so a theme tunes one number and the site keeps its
       internal rhythm, exactly as the alpha ladder derives from one triplet.

       Not set here: prefers-reduced-motion. That override lives at the bottom
       of motion.css where no theme can outrank it — a theme is a preference
       about taste, and that is a preference about health. */
    var motion = parseFloat(t.motion);
    if (isFinite(motion) && motion >= 0) root.style.setProperty('--zw-motion', String(motion));
    set('--zw-ease', t.ease);

    /* Header composition. An attribute rather than a custom property, because
       what changes is a grid template and a set of grid areas — a shape, not a
       value, and CSS cannot switch shapes on a variable. Absent means the
       arrangement the site shipped with, so a theme that says nothing here
       leaves the header exactly as it was. */
    applyHeader(root, t.header);
    applyIcons(root, t.icons);

    /* Icons as words. 'mobile' and 'always' are scopes the stylesheet knows;
       anything else — including the absent case — means icons, and the
       attribute is REMOVED rather than set to a value CSS has no rule for,
       since `[data-zw-iconlabels]` alone matches the shared styling rule. */
    if (t.iconLabels === 'mobile' || t.iconLabels === 'always') {
      root.setAttribute('data-zw-iconlabels', t.iconLabels);
    } else {
      root.removeAttribute('data-zw-iconlabels');
    }
    // Absent means "match the body font", which the CSS fallback already says.
    set('--zw-label-font', t.labelFont);

    /* Where the account control lives when the bag panel is on. The panel moves
       account inside itself and hides the header's button; 'header' opts out of
       the hiding half. On BODY rather than root, because the rule it answers is
       written against body.zwf-bagpanel-on — the flag class lives there. */
    if (el && el.setAttribute) {
      if (t.accountIn === 'header') el.setAttribute('data-zw-account', 'header');
      else el.removeAttribute('data-zw-account');
    }
    // --black and --white are the page background and text in the original
    // naming. Kept in step with the triplets so the many rules still using them
    // agree with the ones using the ladder.
    set('--black', t.bg ? 'rgb(' + t.bg + ')' : '');
    set('--white', t.fg ? 'rgb(' + t.fg + ')' : '');

    if (document.body) {
      document.body.classList.toggle('light-mode', theme.base !== 'dark');
      document.body.classList.toggle('super-light-mode', theme.base === 'super-light');
    }

    // The notch/status bar and the browser chrome colour follow the page.
    var pageColor = t.bg ? 'rgb(' + t.bg + ')' : '#09090b';
    root.style.backgroundColor = pageColor;
    root.style.setProperty('--zw-notch-bar', pageColor);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', pageColor);

    applied = theme;
    root.setAttribute('data-zw-theme', theme.id);
    try {
      window.dispatchEvent(new CustomEvent('zw-theme-applied', {
        detail: { mode: theme.base, theme: theme.id },
      }));
    } catch (_) {}
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (_) { return null; }
  }

  function chosenId() {
    try { return localStorage.getItem(CHOICE_KEY) || ''; } catch (_) { return ''; }
  }

  /* Cached config first so the first paint is the right colour — a theme that
     arrives after a round trip is a visible flash of the wrong site. */
  var cached = readCache();
  if (cached) config = normalise(cached);

  function resolveAndApply() {
    var theme = byId(chosenId())
             || byId(themeForPath(location.pathname))
             || byId(config.default)
             || config.modes[0];
    apply(theme);
  }

  if (document.body) resolveAndApply();
  else document.addEventListener('DOMContentLoaded', resolveAndApply, { once: true });

  fetch(REST, { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON }, cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (rows) {
      var raw = rows && rows[0] && rows[0].value;
      if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (_) { raw = null; } }
      if (!raw) return;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(raw)); } catch (_) {}
      config = normalise(raw);
      // Re-apply only if the answer actually differs, so a settled page does
      // not repaint for nothing.
      var next = byId(chosenId()) || byId(themeForPath(location.pathname))
              || byId(config.default) || config.modes[0];
      if (!applied || applied.id !== next.id || JSON.stringify(applied.tokens) !== JSON.stringify(next.tokens)) {
        apply(next);
      }
    })
    .catch(function () {});

  // ── The public surface every switcher uses ───────────────────────────────
  window.ZWTheme = {
    /* Every theme available, in order. A switcher renders this rather than
       hardcoding three buttons — which is the whole point. */
    list: function () { return config.modes.slice(); },
    current: function () { return applied ? applied.id : (chosenId() || config.default); },
    forPath: themeForPath,
    get: function (id) { return byId(id); },
    apply: function (id, remember) {
      var theme = byId(id);
      if (!theme) return false;
      if (remember !== false) { try { localStorage.setItem(CHOICE_KEY, id); } catch (_) {} }
      apply(theme);
      return true;
    },
    /* Preview without persisting — the admin editor drags a colour picker and
       wants the page to follow without committing the visitor to that theme. */
    preview: function (theme) { apply(normalise({ modes: [theme], default: theme.id }).modes[0]); },
    reload: function () { resolveAndApply(); },
  };
})();
