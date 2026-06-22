/* ────────────────────────────────────────────────────────────────────────────
   scroll-reveal.js — fade/slide content in as it scrolls into view.

   Opt-in: mark elements with [data-reveal]. At load we add .zw-reveal ONLY to
   the ones currently below the fold (so above-fold content is never hidden — no
   LCP hit, no flash), then .zw-revealed when they enter the viewport.

   Hard-degrades to "everything visible":
     • prefers-reduced-motion: reduce → no hiding, no observer.
     • no IntersectionObserver → no hiding.
     • elements already in view at load → left visible (no animation).
   The CSS lives in storefront-cohesion.css (.zw-reveal / .zw-revealed).
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  function run() {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var els = document.querySelectorAll('[data-reveal]');
    if (!els.length) return;

    // Reduced motion or no IO support: reveal everything immediately, no motion.
    if (reduce || !('IntersectionObserver' in window)) {
      for (var i = 0; i < els.length; i++) els[i].classList.add('zw-revealed');
      return;
    }

    var vh = window.innerHeight || document.documentElement.clientHeight;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('zw-revealed');
          io.unobserve(e.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });

    Array.prototype.forEach.call(els, function (el) {
      // Only animate elements that start BELOW the fold. Anything already visible
      // stays visible (prevents hiding above-fold content / a load flash).
      if (el.getBoundingClientRect().top > vh * 0.88) {
        el.classList.add('zw-reveal');
        io.observe(el);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
