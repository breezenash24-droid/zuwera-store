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

    /* ── HOW MANY PHOTOS ARE IN VIEW IS THE ELEMENT'S OWN BUSINESS ──────────
     *
     * The product page wants two side by side; the quick-add modal wants one,
     * whole. That was expressed as a stylesheet rule scoped to
     * `.collection-product-gallery[data-layout="dual"] .collection-review-media
     * .zw-strip > *` — four classes deep, and DEPENDENT ON AN ATTRIBUTE THIS
     * FILE'S CALLER SETS. It is in the served CSS, it is valid, it is outside
     * any media query, nothing in the nine stylesheets that page loads competes
     * with it, and the modal still rendered two photos at half width each.
     *
     * Reported three times — "cut in half", "cut off" — because two shots of the
     * same garment separated by a hairline read as one photo sliced down the
     * middle, which is exactly what it looks like.
     *
     * So the strip stops asking. `perView` is set on the elements themselves,
     * where no selector has to match and no ancestor attribute has to have been
     * written yet. The stylesheet rule stays: it says the same thing, it is the
     * right home for it, and when it does apply the two agree.
     *
     * Only the properties that decide "how many, and whole or cropped" are set
     * here. Height, background and snapping stay in CSS, where they can be
     * responsive — the modal is not trying to own the whole layout, only the
     * one thing that kept coming out wrong. */
    var perView = Number(opts.perView) > 0 ? Number(opts.perView) : 0;

    /* !important, on an inline style, is the top of the cascade — nothing in any
       stylesheet can reach past it. That is a heavy hammer and it is deliberate:
       this is the third round on the same pane. The stylesheet said one photo
       per view, it was served, valid and uncontested, and the modal still drew
       two. Twice more I shipped a fix that was correct in the repository and
       correct in the deployed bundle, and twice more the photos came back cut.
       So this stops being a request. */
    var pin = function (el, prop, val) {
      try { el.style.setProperty(prop, val, 'important'); }
      catch (_) { el.style[prop] = val; }          // older engines, no setProperty
    };

    host.innerHTML = '';
    host.classList.add('zw-strip');
    if (perView) {
      /* Without these the container is not a scroll container at all and the
         photos simply shrink to share the width — which is the two-up the
         modal was showing. */
      pin(host, 'display', 'flex');
      pin(host, 'overflow-x', 'auto');
      pin(host, 'scroll-snap-type', 'x mandatory');
      /* .collection-review-media centres its content, which is right for a
         single photo and wrong for a strip: on an overflowing flex row,
         justify-content:center pushes the overflow out BOTH ends, and the part
         that goes off the left cannot be reached by scrolling at all — there is
         no negative scrollLeft. The first photo becomes unreachable. */
      pin(host, 'justify-content', 'flex-start');
      pin(host, 'align-items', 'flex-start');
    }
    images.forEach(function (url, i) {
      var node;
      if (isVideo(url)) {
        node = document.createElement('video');
        node.src = url; node.muted = true; node.loop = true;
        node.playsInline = true; node.preload = 'metadata';
        /* A frame to show while it buffers. Without one the slide is a black
           rectangle until enough of the file has arrived — which looks exactly
           like the video not loading, and is indistinguishable from it if
           something upstream really has gone wrong. videoPosterUrl asks
           Cloudinary for frame 0 as a JPEG, so it arrives on the image path
           rather than the media one and is already cached by the time the
           shopper pages to it. */
        try {
          if (typeof window.videoPosterUrl === 'function') {
            var poster = window.videoPosterUrl(url, 900);
            if (poster) node.poster = poster;
          }
        } catch (_) { /* a slide with no poster is still a slide */ }
      } else {
        node = document.createElement('img');
        node.src = url;
        node.alt = (opts.alt || 'Product') + ' view ' + (i + 1);
        node.loading = i < 2 ? 'eager' : 'lazy';
        node.decoding = 'async';
      }
      if (perView) {
        /* flex-basis AND width, because a flex item with a percentage basis
           still consults width when the container's own sizing is in doubt, and
           a photo that is 100% of the pane cannot be beside another one. */
        pin(node, 'flex', '0 0 ' + (100 / perView) + '%');
        pin(node, 'width', (100 / perView) + '%');
        pin(node, 'min-width', '0');
        /* contain, not cover: the whole shot, letterboxed against the pane's own
           background rather than trimmed to fill it. The photos on this store
           are 2000x2000 — square — so in a pane wider than it is tall `cover`
           crops a tall sliver out of the middle of each one, which is exactly
           what "the images are getting cut off" looks like. */
        pin(node, 'object-fit', 'contain');
        pin(node, 'scroll-snap-align', 'start');
        pin(node, 'scroll-snap-stop', 'always');
      }
      host.appendChild(node);
    });

    /* ── PAGE TO A PHOTO, NOT BY A NUMBER OF PIXELS ─────────────────────────
     *
     * This used to be `scrollBy(dir * step())`, where step() measured the first
     * child and added the gap. Every part of that is a chance to land BETWEEN
     * two photos, and the modal did — half of one shot on the left, a band of
     * the pane's own background, half of the next on the right. Reported twice
     * as "the product images are cut in half in the mini product modal".
     *
     * Three ways it drifted, and a fourth that snapping could not correct:
     *
     *   • step() ran before layout settled, so it measured a child that did not
     *     yet have its flex-basis and paged by a fraction of a slide;
     *   • sub-pixel widths accumulated, one scrollBy at a time, until the error
     *     was visible;
     *   • the fallback for an empty host is clientWidth/2, which is the PRODUCT
     *     PAGE's two-up assumption applied to a one-up modal;
     *   • collectionRenderGallery re-renders when the colourway fetch lands. A
     *     smooth scroll already in flight keeps travelling to an absolute offset
     *     that the new children do not line up with, and mandatory snapping has
     *     nothing to pull it back to once it has finished.
     *
     * Scrolling to a child's own offsetLeft has none of those. There is no
     * measurement, no gap arithmetic and no accumulated error: the target is a
     * position an element actually occupies, so the strip can only ever come to
     * rest showing a whole photo. .collection-review-media is position:relative,
     * so it is the offsetParent and offsetLeft is already relative to it.
     */
    var current = 0;

    function count() { return host.children.length; }

    function goTo(i, behavior) {
      var n = count();
      if (!n) return;
      current = Math.max(0, Math.min(n - 1, i | 0));
      var el = host.children[current];
      if (!el) return;
      var left = (el.offsetLeft || 0) - (host.offsetLeft || 0);
      /* A layout that has not happened yet reports nothing useful, and writing
         NaN to scrollLeft would park the strip somewhere no photo is. Falling
         back to the measured slot keeps the old behaviour for that one frame
         rather than making it worse than it was. */
      if (!isFinite(left)) left = current * slotWidth();
      /* scrollTo with a behavior is not universally supported on elements; the
         property assignment is, and is what an instant jump wants anyway. */
      if (behavior === 'auto' || typeof host.scrollTo !== 'function') host.scrollLeft = left;
      else host.scrollTo({ left: left, behavior: behavior || 'smooth' });
    }

    function slotWidth() {
      var first = host.firstElementChild;
      if (!first) return host.clientWidth || 0;
      var w = first.getBoundingClientRect().width;
      return (w > 0 ? w : host.clientWidth) + (parseFloat(getComputedStyle(host).gap) || 0);
    }

    /* Still measured, because a SWIPE is not one of ours to place — this only
       has to name which photo the shopper has landed on, for the counter.
       Clamped, so a rubber-band overscroll cannot report a photo that is not
       there. */
    function index() {
      var s = slotWidth();
      if (!s) return 0;
      var i = Math.round(host.scrollLeft / s);
      if (!isFinite(i)) return 0;
      return Math.max(0, Math.min(count() - 1, i));
    }

    function page(dir) { goTo(current + (dir > 0 ? 1 : -1)); }

    // The listener is bound once per host, but this function runs again on every
    // render — a modal opens with the product card's single photo and re-renders
    // with the colourway's full set the moment the fetches land. Binding once
    // meant the handler kept the FIRST call's opts for good, so it went on
    // reporting a total of one for a seven-photo product. The first scroll then
    // told setNavCount there was nothing to page and it removed the arrows and
    // the counter. Keep the current opts on the host and read them at event
    // time, so the handler always describes what is actually in the strip.
    host._zwStripOpts = opts;
    if (!host._zwStripBound) {
      host._zwStripBound = true;
      host.addEventListener('scroll', function () {
        /* A swipe moves the strip without going through goTo, so the arrows
           have to learn where the shopper left it or the next press would page
           from a photo nobody is looking at. */
        current = index();
        var o = host._zwStripOpts;
        if (o && o.onIndex) o.onIndex(current, host.scrollWidth - host.clientWidth <= host.scrollLeft + 1);
      }, { passive: true });
    }

    /* ── THE PANE TAKES THE SHAPE OF THE PHOTOS IN IT ───────────────────────
     *
     * object-fit:contain never crops, which is the whole point — but it has to
     * put the leftover space SOMEWHERE, and a fixed-height pane holding a photo
     * of a different shape puts it in bands above and below.
     *
     * The pane could instead be told a ratio. It must not be told a CONSTANT
     * one: this store alone ships 1:1 (2000x2000, 880x880, 750x750), 4:5
     * (1070x1338) and 1836x1950, and four of its eleven products mix ratios
     * inside themselves. A licensee's catalogue is whatever their photographer
     * handed them, and a `4/5` written in here would be a guess about somebody
     * else's shoot that nothing would ever correct.
     *
     * So it is MEASURED, from the first photo, once. Per PRODUCT, deliberately
     * not per photo: every slide is in one flex row and a flex row has one
     * height, so a per-photo pane would resize the modal as the shopper pages —
     * moving Add to Bag out from under a cursor that is already on its way to
     * it. A shape that is chosen at open and then held is the version of this
     * that is worth having.
     *
     * Nothing is waited for. A cached photo already knows its size and the pane
     * is right on the first frame; one that does not measures on `load`, which
     * is the same moment the photo appears, so there is no interval where a
     * visible photo sits in a pane of the wrong shape.
     */
    function fitPane() {
      var first = host.querySelector('img');
      if (!first) return;                    // a video-first strip keeps the CSS
      var apply = function () {
        var w = first.naturalWidth, h = first.naturalHeight;
        if (!(w > 0 && h > 0)) return;
        var r = w / h;
        /* Outside anything a product photo plausibly is, the measurement is
           more likely to be a tracking pixel or a broken decode than a shape
           worth reshaping the modal to. Left alone rather than clamped: the
           stylesheet's own answer is a better wrong answer than a squashed
           pane. */
        if (!isFinite(r) || r < 0.4 || r > 2.5) return;
        pin(host, 'aspect-ratio', w + ' / ' + h);
        pin(host, 'height', 'auto');
        /* A very tall photo would otherwise make a pane taller than the screen.
           Through a custom property so a licensee's theme can change the cap
           without touching this file — the literal here is only the fallback. */
        pin(host, 'max-height', 'var(--zw-strip-max-h, min(78vh, 760px))');
        pin(host, 'min-height', '0');
        /* The slides carry their own height from CSS, which would fight the
           ratio the pane has just taken. Follow it instead. */
        for (var i = 0; i < host.children.length; i++) pin(host.children[i], 'height', '100%');
      };
      if (first.complete && first.naturalWidth) apply();
      else first.addEventListener('load', apply, { once: true });
    }
    if (perView) fitPane();

    /* Land on a photo boundary before anyone can see otherwise. Instant, not
       smooth: this is the strip arriving, not the shopper moving it — and it is
       also what stops a re-render inheriting the tail of a smooth scroll that
       was aimed at the previous set of children. */
    goTo(opts.startIndex || 0, 'auto');

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

    return { page: page, goTo: goTo, index: index, total: images.length };
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
   * @param {object}  [opts]   { prune: true } to also clear arrows left over
   *                           from a previous product. RENDER CALLERS ONLY.
   */
  function setNavCount(section, index, total, opts) {
    if (!section) return;
    var row = section.querySelector('.gallery-nav-below');
    if (!row) return;
    var el = row.querySelector('.gallery-dual-count');
    if (!(total > 1)) {
      // One image needs no counter — "1/1" is noise.
      if (el) el.remove();
      // Clearing the ARROWS as well is a render-time decision, and only the
      // caller that just rebuilt the surface can make it: the modals build
      // arrows only when there's more than one photo, so any still in the row
      // are stale from the previous product. Nodes WITHOUT an id only — the
      // product page's #prevImg/#nextImg are persistent, and deleting those
      // would leave it no way to page at all.
      //
      // A scroll handler must never reach this: it reports where the strip is,
      // not what the gallery holds, and one stale count from it deleted live,
      // wired arrows that nothing was going to recreate.
      if (opts && opts.prune) {
        var kids = [].slice.call(row.children || []);
        for (var i = 0; i < kids.length; i++) {
          if (!kids[i].id) kids[i].remove();
        }
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

  // Carry the admin preview token through, so a preview of a product page shows
  // the unpublished product layout rather than the live one.
  // preview-mode.js strips the parameter from the address bar as soon as it has
  // read it, so ask it first and fall back to the URL for the case where this
  // runs before it does.
  var _pv = window.__zwPreviewToken || '';
  try { if (!_pv) _pv = new URLSearchParams(location.search).get('zwpreview') || ''; } catch (_) {}
  fetch('/api/product-page-config' + (_pv ? '?zwpreview=' + encodeURIComponent(_pv) : ''), { cache: 'no-store' })
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
