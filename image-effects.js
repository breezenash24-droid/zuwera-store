/* ────────────────────────────────────────────────────────────────────────────
   image-effects.js — admin-controlled image hover behavior.

   site_settings.image_effects = { hoverZoom: { enabled: bool, scale: number } }
     • enabled — turn the subtle zoom-in-on-hover on/off for images
     • scale   — how far images zoom on hover (1.0 = none, 1.04 = default)

   Sets the CSS custom property --zw-img-hover-zoom on <html>; the hover rules
   (product cards, category tiles, homepage media grid) read it via
   `transform: scale(var(--zw-img-hover-zoom, <default>))`. When no setting
   exists the CSS fallback keeps today's behavior. Cached in localStorage
   (zw_img_fx) for instant, flash-free apply, then refreshed from site_settings.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
  var REST = 'https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/site_settings?select=value&key=eq.image_effects';
  var CACHE = 'zw_img_fx';

  function apply(cfg) {
    try {
      var hz = (cfg && cfg.hoverZoom) || {};
      var scale = (hz.enabled === false) ? 1 : Number(hz.scale);
      if (!(scale >= 1 && scale <= 1.3)) scale = (hz.enabled === false) ? 1 : 1.04;
      document.documentElement.style.setProperty('--zw-img-hover-zoom', String(scale));
    } catch (_) {}
  }

  // Instant apply from cache so there's no flash before the network responds.
  try { var c = JSON.parse(localStorage.getItem(CACHE) || 'null'); if (c && typeof c === 'object') apply(c); } catch (_) {}

  // Refresh from site_settings in the background, cache, re-apply.
  try {
    fetch(REST, { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        if (!rows || !rows[0]) return;
        var cfg = rows[0].value;
        if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch (_) {} }
        if (!cfg || typeof cfg !== 'object') return;
        try { localStorage.setItem(CACHE, JSON.stringify(cfg)); } catch (_) {}
        apply(cfg);
      })
      .catch(function () {});
  } catch (_) {}
})();
