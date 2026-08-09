/* ────────────────────────────────────────────────────────────────────────────
   icon-sets.js — the storefront's icons, as a set you pick and then override.

   Same shape as the type system, because it is the same problem: choose one
   thing globally, then disagree with it in the few places that need to. Fonts
   have a global head/body/mono role plus per-section overrides; icons now have
   a global set plus per-icon overrides.

     site_settings.icons = {
       set: 'outline',                       what everything uses by default
       overrides: { bag: 'solid' },          per icon, by name
       custom:    { support: '<svg …>' }     your own markup, wins over both
     }

   Three sets ship. They are drawn on the same 24×24 grid with the same optical
   weight so swapping one for another does not shift the layout by a pixel:

     outline   the current icons. Thin stroke, square-ish. The default.
     rounded   same shapes, heavier stroke and round caps. Friendlier, reads
               better at small sizes and on dark backgrounds.
     solid     filled. Highest contrast, least detail — good for a busy nav.

   A custom SVG is markup you paste, so it is inserted as-is. That is the point
   of it and also its risk: it is admin-authored, same trust level as any other
   admin-authored markup on the page, and it is stripped of <script> before it
   goes in because there is no reason for an icon to carry one.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var CACHE_KEY = 'zw_icons';
  var REST = 'https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/site_settings?select=value&key=eq.icons';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

  // Every icon the storefront can name. Adding one here is all it takes for the
  // admin grid to offer it — that screen renders this list, not a copy of it.
  var NAMES = ['bag', 'search', 'account', 'support', 'orders', 'saves', 'heart', 'close', 'menu', 'chevron'];

  var LABELS = {
    bag: 'Bag', search: 'Search', account: 'Account', support: 'Support',
    orders: 'Orders', saves: 'Saved items', heart: 'Favourite',
    close: 'Close', menu: 'Menu', chevron: 'Chevron',
  };

  function stroke(w, d) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + w +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  }
  function fill(d) {
    return '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">' + d + '</svg>';
  }

  // Shared geometry — the sets differ in weight and fill, not in shape, which is
  // what keeps them interchangeable mid-layout.
  var D = {
    bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
    search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    account: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M6.7 19a5.5 5.5 0 0 1 10.6 0"/>',
    support: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 1 1 4 2.8c-.7.3-1.1 1-1.1 1.7v.5"/><line x1="12" y1="17.5" x2="12" y2="17.5"/>',
    orders: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
    saves: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    menu: '<line x1="3" y1="7" x2="21" y2="7"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="17" x2="21" y2="17"/>',
    chevron: '<polyline points="6 9 12 15 18 9"/>',
  };

  // Solid needs its own paths: a filled outline of a stroked shape is not the
  // same drawing, and pretending otherwise gives you blobs.
  var SOLID = {
    bag: '<path d="M6.6 2h10.8l3.6 4.6V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.6zM8 9a4 4 0 0 0 8 0h-2a2 2 0 0 1-4 0z"/>',
    search: '<path d="M11 3a8 8 0 1 0 4.9 14.3l4 4a1.3 1.3 0 0 0 1.9-1.9l-4-4A8 8 0 0 0 11 3m0 2.6a5.4 5.4 0 1 1 0 10.8 5.4 5.4 0 0 1 0-10.8"/>',
    account: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 4.6a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4m0 13.2a7.4 7.4 0 0 1-5.3-2.2 6 6 0 0 1 10.6 0A7.4 7.4 0 0 1 12 19.8"/>',
    support: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 15.1a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4m.3-11a3.9 3.9 0 0 1 1.4 7.5c-.4.2-.6.5-.6.9v.6h-2.2v-.8c0-1.3.7-2.3 1.9-2.8a1.7 1.7 0 1 0-2.4-1.6H8.2A3.9 3.9 0 0 1 12.3 6.1"/>',
    orders: '<path d="M6.6 2h10.8l3.6 4.6V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.6zM8 9a4 4 0 0 0 8 0h-2a2 2 0 0 1-4 0z"/>',
    saves: '<path d="M7 2h10a2 2 0 0 1 2 2v18l-7-5-7 5V4a2 2 0 0 1 2-2"/>',
    heart: '<path d="M12 21 3.2 12.4a5.5 5.5 0 0 1 7.8-7.8l1 1.1 1-1.1a5.5 5.5 0 0 1 7.8 7.8z"/>',
    close: '<path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 0 0-1.4 1.4l4.9 4.9-4.9 4.9a1 1 0 1 0 1.4 1.4l4.9-4.9 4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4"/>',
    menu: '<path d="M3 5.8h18v2.4H3zm0 5h18v2.4H3zm0 5h18v2.4H3z"/>',
    chevron: '<path d="M12 15.6 5.4 9a1.3 1.3 0 0 1 1.8-1.8L12 12l4.8-4.8A1.3 1.3 0 0 1 18.6 9z"/>',
  };

  var SETS = {
    outline: { label: 'Outline', build: function (n) { return stroke('1.6', D[n]); } },
    rounded: { label: 'Rounded', build: function (n) { return stroke('2.2', D[n]); } },
    solid:   { label: 'Solid',   build: function (n) { return fill(SOLID[n]); } },
  };

  var config = { set: 'outline', overrides: {}, custom: {} };

  function normalise(raw) {
    var r = (raw && typeof raw === 'object') ? raw : {};
    return {
      set: SETS[r.set] ? r.set : 'outline',
      overrides: (r.overrides && typeof r.overrides === 'object') ? r.overrides : {},
      custom: (r.custom && typeof r.custom === 'object') ? r.custom : {},
    };
  }

  try {
    var cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cached) config = normalise(cached);
  } catch (_) {}

  /* An icon's markup, after the three-step resolution: your own SVG, then the
     per-icon set override, then the global set. Unknown name → empty string
     rather than a placeholder box, because a missing icon should be invisible,
     not a visible defect. */
  function get(name, setOverride) {
    if (!D[name]) return '';
    var custom = config.custom[name];
    if (custom && String(custom).trim()) {
      return String(custom).replace(/<script[\s\S]*?<\/script>/gi, '');
    }
    var setId = setOverride || config.overrides[name] || config.set;
    var set = SETS[setId] || SETS.outline;
    return set.build(name);
  }

  /* Fill any [data-zw-icon] on the page. Called on load and again when the
     config arrives, and safe to call as often as you like — it rewrites, it
     does not append. */
  function paint(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll ? scope.querySelectorAll('[data-zw-icon]') : [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var svg = get(el.getAttribute('data-zw-icon'));
      if (svg) el.innerHTML = svg;
    }
  }

  function load() {
    return fetch(REST, { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        var raw = rows && rows[0] && rows[0].value;
        if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (_) { raw = null; } }
        if (!raw) return config;
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(raw)); } catch (_) {}
        config = normalise(raw);
        paint();
        try { window.dispatchEvent(new CustomEvent('zw-icons-ready', { detail: config })); } catch (_) {}
        return config;
      })
      .catch(function () { return config; });
  }

  window.ZWIcons = {
    names: function () { return NAMES.slice(); },
    label: function (n) { return LABELS[n] || n; },
    sets: function () {
      return Object.keys(SETS).map(function (k) { return { id: k, label: SETS[k].label }; });
    },
    get: get,
    paint: paint,
    config: function () { return JSON.parse(JSON.stringify(config)); },
    /* The admin previews a set it has not saved yet. */
    preview: function (cfg) { config = normalise(cfg); paint(); },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { paint(); }, { once: true });
  } else paint();
  load();
})();
