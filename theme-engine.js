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
      tokens: { fg: '244 241 235', bg: '9 9 11', ink: '#09090b', paper: '#f4f1eb', surface: '#F0EEE9', accent: '#F891A5', err: '#ef4444' } },
    { id: 'light', label: 'Light', icon: '☀️', base: 'light', builtin: true,
      tokens: { fg: '10 10 10', bg: '240 238 233', ink: '#F0EEE9', paper: '#09090b', surface: '#F0EEE9', accent: '#F891A5', err: '#ef4444' } },
    { id: 'super-light', label: 'Super Light', icon: '⚪', base: 'super-light', builtin: true,
      tokens: { fg: '10 10 10', bg: '255 255 255', ink: '#FFFFFF', paper: '#09090b', surface: '#FFFFFF', accent: '#F891A5', err: '#ef4444' } },
  ];

  var config = { modes: BUILTINS.slice(), default: 'dark' };
  var applied = null;

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
        tokens: Object.assign({}, builtin ? builtin.tokens : BUILTINS[0].tokens, m.tokens || {}),
      };
    });
    var def = modes.filter(function (m) { return m.id === raw.default; })[0];
    return { modes: modes, default: def ? def.id : modes[0].id };
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
  function apply(theme) {
    if (!theme || !document.documentElement) return;
    var root = document.documentElement;
    var t = theme.tokens || {};

    /* Set on :root specifically, not on body. The alpha ladder is declared at
       :root, and custom properties compute where they are declared — so the
       ladder only picks up a new --fg-rgb if the new value is on :root too.
       base.css also sets --fg-rgb inside body.light-mode, which is what makes
       the three built-ins work with no JavaScript at all; that declaration is
       simply inert once the ladder has already computed above it. */
    var set = function (name, value) {
      if (value) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    };
    set('--fg-rgb', t.fg);
    set('--bg-rgb', t.bg);
    set('--ink', t.ink);
    set('--paper', t.paper);
    set('--surface-light', t.surface);
    set('--accent', t.accent);
    set('--err', t.err);
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
    var theme = byId(chosenId()) || byId(config.default) || config.modes[0];
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
      var next = byId(chosenId()) || byId(config.default) || config.modes[0];
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
