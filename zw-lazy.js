/**
 * zw-lazy.js — run the modules nobody is waiting for after the page has painted.
 *
 * ── HOW A MODULE IS DECLARED LAZY ────────────────────────────────────────────
 *
 *     <script type="text/zw-lazy" src="/email-popup.js?v=abc123"></script>
 *
 * A <script> with a type the browser does not recognise is neither executed nor
 * FETCHED — it is inert markup. This file finds those tags and turns each one
 * into a real script the moment the page is idle or the visitor first touches
 * it, whichever comes first.
 *
 * The `src` attribute is the whole reason for that shape rather than a
 * `data-src`. scripts/bump-cache-version.js rewrites `src="/name.js?v=…"` and
 * nothing else, so a lazy module declared any other way would ship with a stale
 * or missing hash — and _headers serves JS as `immutable, max-age=31536000`,
 * which has already pinned pages to a year-old copy of a file once.
 *
 * ── WHAT IS NOT LAZY, AND WHY THE LIST IS SHORT ──────────────────────────────
 *
 * Almost nothing on this site can be. An audit of all 44 scripts the homepage
 * loads found that nearly every one of them is either called synchronously by
 * another module while the page settles, or does work at load time that the
 * page's appearance depends on. storefront.js and storefront-features.js —
 * 144 KB and 60 KB minified, by far the two biggest — are both called into by
 * half a dozen others, so neither can move.
 *
 * The honest set is the modules that talk to nobody:
 *
 *   integrations.js   injects third-party chat and pixel widgets (Crisp, Tawk,
 *                     Pinterest). Sets vendor globals; nothing on the storefront
 *                     reads them. A support widget that appears a moment after
 *                     the page is usable is a support widget behaving correctly.
 *
 *   email-popup.js    a timed / exit-intent popup, and the largest module here
 *                     that no storefront code calls into. Its only consumer is
 *                     the ADMIN preview, which is why admin.html keeps loading
 *                     it normally. Its delay now starts from idle rather than
 *                     from parse, so the popup appears a fraction later — which
 *                     is the intended direction for something designed to
 *                     interrupt.
 *
 * A module that another one calls synchronously must NOT be added here. The
 * loader has no stub and cannot replay a call it was not there for.
 *
 * ── AND ONE GLOBAL THAT WAS LIVING IN THE WRONG FILE ─────────────────────────
 *
 * `zwWhenIdle` was defined in meta-pixel.js, and google-tag.js and
 * posthog-init.js both reach for it with their own timers as a fallback — three
 * analytics modules sharing a scheduler that belonged to whichever of them
 * happened to parse first. It lives here now. meta-pixel.js keeps its
 * definition, guarded by `||` exactly as before, so a page that loads it
 * without this file is unaffected.
 */
(function () {
  'use strict';

  /**
   * Run cb at the first of: any deliberate interaction, browser idle, or 3s.
   *
   * Interaction is in the list because a visitor who has started using the page
   * has told you the load is over more definitively than any heuristic — and
   * because requestIdleCallback never fires at all on a page that stays busy.
   */
  window.zwWhenIdle = window.zwWhenIdle || function (cb) {
    var done = false;
    function run() { if (done) return; done = true; cb(); }
    ['pointerdown', 'keydown', 'scroll', 'touchstart', 'visibilitychange'].forEach(function (ev) {
      (ev === 'visibilitychange' ? document : window).addEventListener(ev, run, { once: true, passive: true });
    });
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 3000 });
    else setTimeout(run, 2500);
  };

  /* One promise per URL. Two callers asking for the same module get the same
     load rather than two copies of it executing. */
  var inflight = {};

  /**
   * Fetch and run one script, once.
   * @returns {Promise<boolean>} true if it ran, false if it failed to load.
   *   It RESOLVES on failure rather than rejecting: a lazy module is by
   *   definition one the page works without, and an unhandled rejection in a
   *   loader would be reported as a page error it is not.
   */
  function load(src) {
    var url = String(src || '');
    if (!url) return Promise.resolve(false);
    if (inflight[url]) return inflight[url];
    inflight[url] = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = url;
      /* Not async: these keep the relative order they were declared in, which
         costs nothing here and means a module that quietly depends on an
         earlier one does not become order-dependent on the network. */
      s.async = false;
      s.onload = function () { resolve(true); };
      s.onerror = function () { resolve(false); };
      (document.body || document.head).appendChild(s);
    });
    return inflight[url];
  }

  window.zwLazy = { load: load, whenIdle: window.zwWhenIdle };

  function start() {
    var tags = document.querySelectorAll('script[type="text/zw-lazy"][src]');
    for (var i = 0; i < tags.length; i++) load(tags[i].getAttribute('src'));
  }

  /* The tags have to exist before they can be found. This file is deferred, so
     the document is parsed by the time it runs — but the readyState guard keeps
     it correct if it is ever loaded some other way, which is the trap an async
     module here fell into once already. */
  function schedule() { window.zwWhenIdle(start); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule, { once: true });
  } else {
    schedule();
  }
}());
