/* ────────────────────────────────────────────────────────────────────────────
   pdp-gallery.js — product gallery arrangement, admin-configurable.

   site_settings.product_page.gallery = {
     layout:       'single' | 'dual',            // product page image area
     thumbs:       'bottom' | 'left' | 'none',   // product page thumbnails
     arrows:       'overlay' | 'below' | 'none', // product page arrows
     modal_thumbs: 'none' | 'bottom' | 'left', // quick-add modal thumbnails
     modal_arrows: 'below' | 'overlay' | 'none',
     modal_style:  'product' | 'compact',        // quick-add modal look
     modal_layout: 'dual' | 'single'             // filmstrip, or one image + arrows
   }

   The gallery arrangement defaults to today's (single image, thumbnails beneath,
   arrows over the photo). modal_style is the one exception: it defaults to
   'product', so the quick-add popup takes the product page's type and spacing
   rather than its own scale — the two were reading as different designs.
   Choosing 'compact' puts the old look back.

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
    modal_thumbs: 'none', modal_arrows: 'below', modal_style: 'product', modal_layout: 'dual'
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
   * Render a horizontal filmstrip — two photos in view, paged sideways — into a
   * container. This is the product page's dual arrangement, made reusable so the
   * quick-add modals can show the same thing.
   *
   * The modals were showing ONE image with a thumbnail rail beside it, which is
   * where their wasted space came from: a rail taller than the photo, a photo
   * narrower than its column, and an arrow row stranded under both. A strip uses
   * the full width and needs no rail.
   *
   * Returns a paging function the caller wires its arrows to, or null when there
   * is nothing to page.
   *
   * @param {Element} host    element to render the strip into
   * @param {string[]} images image/video URLs, already filtered to the colourway
   * @param {object} [opts]   { isVideo(url), alt, onIndex(idx) }
   */
  function renderStrip(host, images, opts) {
    if (!host || !images || !images.length) return null;
    opts = opts || {};
    var isVideo = opts.isVideo || function (u) { return /\.(mp4|webm|mov)(\?|#|$)/i.test(u); };

    host.innerHTML = '';
    host.classList.add('zw-strip');
    images.forEach(function (url, i) {
      var node;
      if (isVideo(url)) {
        node = document.createElement('video');
        node.src = url; node.muted = true; node.loop = true;
        node.playsInline = true; node.preload = 'metadata';
      } else {
        node = document.createElement('img');
        node.src = url;
        node.alt = (opts.alt || 'Product') + ' view ' + (i + 1);
        node.loading = i < 2 ? 'eager' : 'lazy';
        node.decoding = 'async';
      }
      host.appendChild(node);
    });

    // Measured, not assumed: the flex-basis differs between two-up and the
    // one-up fallback on narrow screens, and the gap counts.
    function step() {
      var first = host.firstElementChild;
      if (!first) return host.clientWidth / 2;
      return first.getBoundingClientRect().width + parseFloat(getComputedStyle(host).gap || 0);
    }
    function index() {
      var s = step();
      return s ? Math.round(host.scrollLeft / s) : 0;
    }
    function page(dir) { host.scrollBy({ left: dir * step(), behavior: 'smooth' }); }

    if (!host._zwStripBound) {
      host._zwStripBound = true;
      host.addEventListener('scroll', function () {
        if (opts.onIndex) opts.onIndex(index(), host.scrollWidth - host.clientWidth <= host.scrollLeft + 1);
      }, { passive: true });
    }

    // Only play a clip while it is actually on screen — otherwise every video in
    // the strip decodes at once and keeps running off to the side.
    if (host._zwStripObs) { try { host._zwStripObs.disconnect(); } catch (_) {} }
    if ('IntersectionObserver' in window) {
      host._zwStripObs = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          var v = en.target;
          if (en.isIntersecting) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
          else { try { v.pause(); } catch (_) {} }
        });
      }, { root: host, threshold: 0.35 });
      host.querySelectorAll('video').forEach(function (v) { host._zwStripObs.observe(v); });
    }

    return { page: page, index: index, total: images.length };
  }

  /**
   * Put an "n/total" position counter in the arrow row, so a gallery without
   * thumbnails still says where you are. Kept here rather than in each modal
   * because all three surfaces show the same thing — and because the counter has
   * to be re-appended AFTER applyTo on every render: applyTo rebuilds the row's
   * contents, so a counter added once ends up in front of the arrows instead of
   * after them.
   *
   * @param {Element} section  the gallery container applyTo was given
   * @param {number}  index    zero-based position of the visible image
   * @param {number}  total    how many images are in this set
   */
  function setNavCount(section, index, total) {
    if (!section) return;
    var row = section.querySelector('.gallery-nav-below');
    if (!row) return;
    var el = row.querySelector('.gallery-dual-count');
    if (!(total > 1)) {
      // One image needs no counter — "1/1" is noise — and no arrows either. The
      // modals only build arrows when there's more than one photo, so any still
      // in the row are stale from the previous product. Remove only nodes
      // WITHOUT an id: the product page's #prevImg/#nextImg are persistent and
      // deleting them would leave it with no way to page at all.
      if (el) el.remove();
      var kids = [].slice.call(row.children || []);
      for (var i = 0; i < kids.length; i++) {
        if (!kids[i].id) kids[i].remove();
      }
      if (!row.firstChild) row.remove();
      return;
    }
    if (!el) {
      el = document.createElement('span');
      el.className = 'gallery-dual-count';
    }
    el.textContent = (Math.min(Math.max(index, 0), total - 1) + 1) + '/' + total;
    row.appendChild(el);          // always last, after the arrows
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
  // The move only makes sense while the layout is genuinely TWO columns. Stacked
  // to one column, putting the accordions inside .gallery-section pushes them
  // above the whole buy section — title, price, size, Add to Bag all ended up
  // below Size & Fit and Reviews on a phone. Same breakpoint the CSS uses.
  var TWO_COL = '(min-width: 901px)';
  function isTwoColumn() {
    try { return window.matchMedia(TWO_COL).matches; } catch (_) { return true; }
  }

  function applyAccordionPlacement(layout) {
    var acc = document.querySelector('.accordions-section');
    var layoutEl = document.querySelector('.product-layout');
    if (!acc || !layoutEl || !layoutEl.parentElement) return;

    if (layout === 'dual' && isTwoColumn()) {
      var galleryEl = document.querySelector('.gallery-section');
      if (!galleryEl) return;
      if (acc.parentElement === galleryEl) return;               // already moved
      acc._zwHome = { parent: acc.parentElement, next: acc.nextElementSibling };
      acc.classList.add('accordions-below');
      // Into the GALLERY COLUMN itself, not a second grid row. As its own row it
      // had to line up with the buy column, so whenever that column ran taller
      // than the photos the grid stretched row 1 and left a band of nothing.
      // Inside .gallery-section (already flex-direction:column) the accordions
      // simply follow the arrows and absorb that height themselves.
      galleryEl.appendChild(acc);
    } else if (acc._zwHome) {
      // Covers both "switched back to single" and "narrowed to one column".
      acc.classList.remove('accordions-below');
      acc._zwHome.parent.insertBefore(acc, acc._zwHome.next);
      acc._zwHome = null;
    }
  }

  // Re-run on the breakpoint crossing, so rotating a tablet or resizing a window
  // moves the stack back into the buy column instead of leaving it stranded
  // above Add to Bag.
  try {
    var mq = window.matchMedia(TWO_COL);
    var onBp = function () { if (cfg) applyAccordionPlacement(cfg.layout); };
    if (mq.addEventListener) mq.addEventListener('change', onBp);
    else if (mq.addListener) mq.addListener(onBp);              // older Safari
  } catch (_) {}

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
    setNavCount: setNavCount,
    renderStrip: renderStrip,
  };
})();
