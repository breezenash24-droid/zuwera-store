/* ────────────────────────────────────────────────────────────────────────────
   pdp-gallery.js — product gallery arrangement, admin-configurable.

   site_settings.product_page.gallery = {
     layout:       'single' | 'dual',            // product page image area
     thumbs:       'bottom' | 'left' | 'none',   // product page thumbnails
     arrows:       'overlay' | 'below' | 'none', // product page arrows
     modal_thumbs: 'bottom' | 'left' | 'none',   // quick-add modal
     modal_arrows: 'overlay',
     modal_style:  'compact' | 'product'        // quick-add modal look | 'below' | 'none'
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
    modal_thumbs: 'bottom', modal_arrows: 'overlay', modal_style: 'compact'
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
      // Only arrows OUTSIDE the row are "fresh". The modals rebuild their arrow
      // markup with innerHTML on every render, but the previous set had already
      // been moved into the row — so it survives that rebuild. Appending
      // everything querySelectorAll found (row + media) put the old ones back
      // AND added the new ones, growing the row by two per render: ten arrows
      // after five renders.
      var all = section.querySelectorAll(arrowSel);
      var fresh = [];
      for (var i = 0; i < all.length; i++) {
        if (!row.contains(all[i])) fresh.push(all[i]);
      }
      if (fresh.length) {
        // Something rebuilt them: the ones sitting in the row are now stale
        // duplicates with dead handlers, so drop them and take the new set.
        while (row.firstChild) row.removeChild(row.firstChild);
        for (var j = 0; j < fresh.length; j++) row.appendChild(fresh[j]);
      }
      // else: nothing was rebuilt (the product page reuses #prevImg/#nextImg),
      // so the row already holds the live arrows — leave them alone. Clearing
      // here would delete them for good, since nothing recreates them.
    } else if (row) {
      // Switching back: return the arrows to the image before dropping the row.
      // Where the arrows live when they're overlaid, per surface: product page,
      // quick-add modal, collection quick-add modal.
      var main = section.querySelector('.gallery-main, .quick-add-review-media, .collection-review-media');
      var kids = row.querySelectorAll(arrowSel);
      for (var j = 0; j < kids.length; j++) (main || section).appendChild(kids[j]);
      row.remove();
    }
  }

  /**
   * In the dual arrangement the photos take most of the width, which leaves the
   * buy column narrow and the page ending abruptly under the strip. Move the
   * accordion stack (size & fit, materials, shipping, reviews…) out of that
   * column and run it full width beneath the layout — the arrangement On uses,
   * and what stops the page looking unfinished.
   *
   * The element is MOVED, not re-rendered: the accordions' inline onclick and
   * the #reviewsContent target both survive being reparented, so nothing needs
   * re-binding. Its original position is remembered so switching back restores
   * it exactly, including if it wasn't the last child.
   */
  function applyAccordionPlacement(layout) {
    var acc = document.querySelector('.accordions-section');
    var layoutEl = document.querySelector('.product-layout');
    if (!acc || !layoutEl || !layoutEl.parentElement) return;

    if (layout === 'dual') {
      if (acc.parentElement === layoutEl) return;                 // already moved
      acc._zwHome = { parent: acc.parentElement, next: acc.nextElementSibling };
      acc.classList.add('accordions-below');
      // INTO the layout grid, not after it. Sitting after the whole layout, the
      // stack was capped and centred while the photos began at the far left —
      // so the band directly under the photos stayed empty and the accordions
      // started a couple of hundred pixels further in. As a grid item in column
      // one it lands right beneath the photos and lines up with them, which is
      // where On puts theirs.
      layoutEl.appendChild(acc);
    } else if (acc._zwHome) {
      acc.classList.remove('accordions-below');
      acc._zwHome.parent.insertBefore(acc, acc._zwHome.next);
      acc._zwHome = null;
    }
  }

  function applyProductPage(g) {
    // The dual filmstrip is paged BY the arrows, so they always sit in the row
    // beneath it — the 'overlay' and 'none' choices don't apply there. Forcing it
    // here rather than relying on renderDualGallery running last means the cached
    // path and the network path can't fight over where the arrows live.
    var arrows = g.layout === 'dual' ? 'below' : g.arrows;
    applyTo(
      document.querySelector('.gallery-section'),
      g.thumbs, arrows, g.layout,
      '.gallery-arrow'
    );
    applyAccordionPlacement(g.layout);
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

  window.ZWPdpGallery = {
    get: get, ready: ready, applyTo: applyTo, DEFAULTS: DEFAULTS,
    // Exposed so the placement can be re-asserted after the page re-renders
    // parts of the info column, and so it can be exercised in isolation.
    applyAccordionPlacement: applyAccordionPlacement,
  };
})();
