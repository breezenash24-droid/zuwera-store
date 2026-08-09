/* ────────────────────────────────────────────────────────────────────────────
   motion.js — reveals things as they enter the viewport.

   Deliberately small and deliberately fail-safe. The classic way scroll
   animation takes a site down is CSS that hides everything and JavaScript that
   was supposed to show it again not running: a blank page, and no error to
   explain it. So nothing is hidden until this file has run and confirmed it
   can do the revealing — that is what the zw-motion-ready class on <html>
   means, and it is the only thing that turns the hiding rules on.

   Everything else is one IntersectionObserver, unobserving as it goes.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var SELECTOR = '[data-zw-reveal], [data-zw-reveal-group]';

  // Someone who has asked their system for less motion gets none, and this file
  // does not participate at all — no class, so the hiding rules never apply.
  var quiet = false;
  try {
    quiet = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {}
  if (quiet || typeof IntersectionObserver === 'undefined') return;

  var io = null;

  function reveal(el) {
    el.classList.add('is-in');
    if (io) io.unobserve(el);
  }

  function start() {
    document.documentElement.classList.add('zw-motion-ready');

    io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) reveal(entries[i].target);
      }
    }, {
      // A little before it arrives, so the movement finishes about when the
      // element reaches a comfortable reading position rather than starting there.
      rootMargin: '0px 0px -8% 0px',
      threshold: 0.05,
    });

    scan(document);
  }

  function scan(root) {
    var nodes = root.querySelectorAll ? root.querySelectorAll(SELECTOR) : [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.__zwWatched) continue;
      el.__zwWatched = true;
      // Anything already on screen at load reveals immediately rather than
      // animating in behind the viewport — an animation nobody sees is a
      // paint nobody needed.
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) el.classList.add('is-in');
      else io.observe(el);
    }
  }

  /* The storefront builds sections after load, so new content has to be picked
     up. Exposed rather than observed with a MutationObserver: the callers know
     when they have finished rendering, and a mutation observer on the whole
     document to catch it would cost more than it saves. */
  window.ZWMotion = {
    scan: function (root) { if (io) scan(root || document); },
    reveal: reveal,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
