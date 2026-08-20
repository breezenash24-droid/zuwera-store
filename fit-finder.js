/* ────────────────────────────────────────────────────────────────────────────
   fit-finder.js — the "Find your size" form and its recommendation, in one
   place, driven by an admin-editable table.

   Two surfaces used to answer the same question differently: the product page's
   fit-finder modal (height band / weight / preferred fit) and the size guide's
   own calculator (gender / category / height + unit toggle / weight + unit
   toggle / chest). Same question, different inputs, different answers. Both now
   render this form and call this function.

   site_settings.fit_finder = {
     bands:      [{ max: 120, size: 'XS' }, …]   // ordered, first match wins
     tallOver:   72,   // inches — at or above this, size up
     shortUnder: 64,   // inches — at or below this, size down
     relaxed:     1,   // steps to add for a relaxed fit
     snug:       -1    // steps to add for a snug fit
   }

   Absent or invalid config falls back to DEFAULT_RULES, which are the numbers
   that were hardcoded in storefront-features.js — so a store that never opens
   the setting gets exactly today's answers.

   The recommendation is a starting point, not a promise: it is weight-led,
   height-nudged, fit-adjusted, then snapped to a size the product actually
   stocks.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];

  var DEFAULT_RULES = {
    bands: [
      { max: 120, size: 'XS' },
      { max: 140, size: 'S'  },
      { max: 165, size: 'M'  },
      { max: 190, size: 'L'  },
      { max: 220, size: 'XL' },
      { max: 250, size: 'XXL' },
      { max: null, size: '3XL' }   // null = no upper bound, the catch-all
    ],
    tallOver: 72,
    shortUnder: 64,
    relaxed: 1,
    snug: -1
  };

  var rules = DEFAULT_RULES;

  /** Validate whatever the admin saved; anything malformed falls back. */
  function normalizeRules(r) {
    if (!r || typeof r !== 'object') return DEFAULT_RULES;
    var bands = Array.isArray(r.bands) ? r.bands.filter(function (b) {
      return b && ORDER.indexOf(String(b.size).toUpperCase()) !== -1;
    }).map(function (b) {
      return { max: (b.max === null || b.max === '' ) ? null : Number(b.max), size: String(b.size).toUpperCase() };
    }) : [];
    // A table with no catch-all can't answer for the heaviest shopper, so an
    // incomplete one is worse than none.
    if (!bands.length || !bands.some(function (b) { return b.max === null || !isFinite(b.max); })) {
      bands = DEFAULT_RULES.bands;
    }
    var num = function (v, d) { var n = Number(v); return isFinite(n) ? n : d; };
    return {
      bands: bands,
      tallOver:   num(r.tallOver,   DEFAULT_RULES.tallOver),
      shortUnder: num(r.shortUnder, DEFAULT_RULES.shortUnder),
      relaxed:    num(r.relaxed,    DEFAULT_RULES.relaxed),
      snug:       num(r.snug,       DEFAULT_RULES.snug)
    };
  }

  function setRules(r) { rules = normalizeRules(r); return rules; }
  function getRules() { return rules; }

  /**
   * @param {number} heightIn  height in inches (0 / falsy = no height nudge)
   * @param {number} weightLb  weight in pounds
   * @param {string} fit       'snug' | 'true' | 'relaxed'
   * @param {string[]} sizes   sizes this product actually stocks
   */
  function recommend(heightIn, weightLb, fit, sizes) {
    var w = Number(weightLb) || 0;

    // Weight leads: first band whose ceiling the shopper is under. The catch-all
    // (max null) ends the list, so this always resolves.
    var idx = rules.bands.length - 1;
    for (var i = 0; i < rules.bands.length; i++) {
      var b = rules.bands[i];
      if (b.max === null || !isFinite(b.max) || w < b.max) {
        idx = ORDER.indexOf(b.size);
        break;
      }
    }
    if (idx < 0) idx = 0;

    // Height nudge — only at the extremes, so average heights let weight lead.
    if (heightIn >= rules.tallOver) idx++;
    else if (heightIn && heightIn <= rules.shortUnder) idx--;

    if (fit === 'relaxed') idx += rules.relaxed;
    else if (fit === 'snug') idx += rules.snug;

    idx = Math.max(0, Math.min(ORDER.length - 1, idx));
    var rec = ORDER[idx];

    // Snap to something actually stocked, searching outward from the ideal.
    if (sizes && sizes.length) {
      var up = sizes.map(function (s) { return String(s).toUpperCase(); });
      if (up.indexOf(rec) === -1) {
        for (var d = 1; d < ORDER.length; d++) {
          var lo = ORDER[idx - d], hi = ORDER[idx + d];
          if (lo && up.indexOf(lo) !== -1) { rec = lo; break; }
          if (hi && up.indexOf(hi) !== -1) { rec = hi; break; }
        }
      }
    }
    return rec;
  }

  var HEIGHT_OPTIONS = [
    ['Under 5′0', 62], ['5′0–5′3', 64], ['5′4–5′7', 67],
    ['5′8–5′11', 70], ['6′0–6′3', 73], ['6′4 +', 76]
  ];

  /**
   * The form, identical on both surfaces. Class names are the ones
   * storefront-features.js already styles (.zwf-*), so the size guide gets the
   * same look by using the same markup rather than a copy of it.
   */
  function formMarkup(currentFit) {
    var fit = currentFit || 'true';
    return '<h3 class="zwf-modal-title">Find your size</h3>'
      + '<p class="zwf-modal-sub">Answer three quick questions for a starting point. Still unsure? Check the size guide.</p>'
      + '<div class="zwf-field"><label>Height</label><select class="zwf-h">'
      + HEIGHT_OPTIONS.map(function (o, i) {
          return '<option value="' + o[1] + '"' + (i === 2 ? ' selected' : '') + '>' + o[0] + '</option>';
        }).join('')
      + '</select></div>'
      + '<div class="zwf-field"><label>Weight (lb)</label>'
      + '<input class="zwf-w" type="number" inputmode="numeric" min="70" max="400" placeholder="e.g. 160"></div>'
      + '<div class="zwf-field"><label>Preferred fit</label><div class="zwf-seg">'
      + [['snug', 'Snug'], ['true', 'True to size'], ['relaxed', 'Relaxed']].map(function (o) {
          return '<button type="button" data-fit="' + o[0] + '"' + (o[0] === fit ? ' class="on"' : '') + '>' + o[1] + '</button>';
        }).join('')
      + '</div></div>'
      + '<button class="zwf-btn zwf-fit-go" type="button">See my size</button>';
  }

  // Pull the admin's table. fit_finder is a public content key (see the
  // site_settings allow-list SQL), so the anon client can read it. Cached so a
  // shopper who opens the finder before the request lands still gets the
  // configured bands rather than the defaults.
  var CACHE = 'zw_fit_finder';
  try {
    var cached = JSON.parse(localStorage.getItem(CACHE) || 'null');
    if (cached) setRules(cached);
  } catch (_) {}
  try {
    var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
    /* ONE read of site_settings for the whole page, shared with every other
       module on it - see zw-data.js. This used to be its own round trip to
       Supabase, and twelve modules each having one is what put the last of
       them 3.5 seconds into the page load.

       The module's own request stays as the fallback, so this never depends
       on another file having loaded first. Both paths resolve to the same
       PostgREST row shape, and both reject rather than resolve empty when the
       read fails - so nothing below this line changes. */
    function zwCfgRows() {
      if (window.zwSettings) {
        return window.zwSettings.get('fit_finder')
          .then(function (v) { return v == null ? [] : [{ value: v }]; });
      }
      return fetch('https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/site_settings?select=value&key=eq.fit_finder',
        { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON }, cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; });
    }
    zwCfgRows()
      .then(function (rows) {
        var v = rows && rows[0] && rows[0].value;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
        if (!v) return;
        setRules(v);
        try { localStorage.setItem(CACHE, JSON.stringify(v)); } catch (_) {}
      })
      .catch(function () {});
  } catch (_) {}

  window.ZWFitFinder = {
    recommend: recommend,
    formMarkup: formMarkup,
    setRules: setRules,
    getRules: getRules,
    normalizeRules: normalizeRules,
    DEFAULT_RULES: DEFAULT_RULES,
    ORDER: ORDER
  };
})();
