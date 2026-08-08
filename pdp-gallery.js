/* ────────────────────────────────────────────────────────────────────────────
   pdp-gallery.js — product gallery arrangement, admin-configurable.

   site_settings.product_page.gallery = {
     layout:       'single' | 'dual',            // product page image area
     thumbs:       'bottom' | 'left' | 'none',   // product page thumbnails
     arrows:       'overlay' | 'below' | 'none', // product page arrows
     modal_thumbs: 'bottom' | 'left' | 'none',   // quick-add modal
     modal_arrows: 'overlay' | 'below' | 'none'
   }

   Everything defaults to today's arrangement (single image, thumbnails beneath,
   arrows over the photo), so a store that never opens the setting sees no change.

   The arrows are NEVER re-created for the 'below' option — the existing button
   nodes are MOVED into a row, so their click handlers, SVG icons and styling all
   carry over. Rebuilding them would mean re-binding whatever each page wired up.

   Read through /api/product-page-config (product_page is not anon-readable, so it
   cannot be fetched straight from Supabase by the browser). Cached in
   localStorage and applied before the network resolves, so the arrangement does
   not visibly rearrange on load.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var CACHE = 'zw_pdp_gallery';
  var DEFAULTS = {
    layout: 'single', thumbs: 'bottom', arrows: 'overlay',
    modal_thumbs: 'bottom', modal_arrows: 'overlay'
  };
  var cfg = null;
  var waiting = [];

  function normalize(g) {
    var out = {}, k;
    for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
      out[k] = (g && typeof g[k] === 'string' && g[k]) ? g[k] : DEFAULTS[k];
    }
    return out;
  }

  /**
   * Stamp the arrangement onto a gallery container and relocate its arrows.
   * @param {Element} section   the flex container holding image + thumbs
   * @param {string}  thumbs    bottom | left | none
   * @param {string}  arrows    overlay | below | none
   * @param {string}  [layout]  single | dual
   * @param {string}  arrowSel  selector matching this surface's arrow buttons
   */
  function applyTo(section, thumbs, arrows, layout, arrowSel) {
    if (!section) return;
    section.setAttribute('data-thumbs', thumbs);
    section.setAttribute('data-arrows', arrows);
    if (layout) section.setAttribute('data-layout', layout);

    var row = section.querySelector('.gallery-nav-below');

    if (arrows === 'below') {
      if (!row) {
        row = document.createElement('div');
        row.className = 'gallery-nav-below';
        section.appendChild(row);
      }
      // Move (not clone) so listeners survive. Order matters: prev then next.
      var btns = section.querySelectorAll(arrowSel);
      for (var i = 0; i < btns.length; i++) row.appendChild(btns[i]);
    } else if (row) {
      // Switching back: return the arrows to the image before dropping the row.
      var main = section.querySelector('.gallery-main, .quick-add-media, .quick-add-gallery');
      var kids = row.querySelectorAll(arrowSel);
      for (var j = 0; j < kids.length; j++) (main || section).appendChild(kids[j]);
      row.remove();
    }
  }

  function applyProductPage(g) {
    applyTo(
      document.querySelector('.gallery-section'),
      g.thumbs, g.arrows, g.layout,
      '.gallery-arrow'
    );
  }

  function get() { return cfg ? cfg : normalize(null); }

  /** Run fn once the config is known (immediately if it already is). */
  function ready(fn) {
    if (cfg) { try { fn(cfg); } catch (_) {} return; }
    waiting.push(fn);
  }

  function settle(g) {
    cfg = normalize(g);
    try { applyProductPage(cfg); } catch (_) {}
    var q = waiting; waiting = [];
    for (var i = 0; i < q.length; i++) { try { q[i](cfg); } catch (_) {} }
  }

  // Cached first — avoids the gallery visibly rearranging a moment after load.
  var cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE) || 'null'); } catch (_) {}
  if (cached) {
    cfg = normalize(cached);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { applyProductPage(cfg); }, { once: true });
    } else applyProductPage(cfg);
  }

  fetch('/api/product-page-config', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      var g = data && data.gallery ? data.gallery : null;
      try { localStorage.setItem(CACHE, JSON.stringify(g || {})); } catch (_) {}
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { settle(g); }, { once: true });
      } else settle(g);
    })
    .catch(function () { settle(cached); });

  window.ZWPdpGallery = { get: get, ready: ready, applyTo: applyTo, DEFAULTS: DEFAULTS };
})();
