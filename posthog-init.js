/**
 * PostHog analytics for Zuwera
 *
 * Loads PostHog directly (no bootstrap snippet), exposes window.zwTrack
 * immediately (queuing events until array.js is ready), and identifies
 * Supabase users on auth-state changes.  Include in <head> on every page.
 */

(function () {
  'use strict';

  // Skip analytics inside iframes (size-guide modal embed, admin preview):
  // the parent page already tracked the view, so iframe loads would double-
  // count pageviews. Keep zwTrack callable as a no-op so callers never break.
  try {
    if (window.self !== window.top) {
      window.zwTrack = function () {};
      return;
    }
  } catch (_) {}

  var KEY  = 'phc_mCL2GmGPncq5Twg7vK6FesuQHQZVTojTxHTpc4Bwp9yT';
  var HOST = 'https://us.i.posthog.com';

  /* ── 1. Expose zwTrack immediately; queue calls until PostHog is loaded ── */
  var _queue = [];
  var _ph    = null;

  window.zwTrack = function (event, props) {
    if (_ph) {
      try { _ph.capture(event, props || {}); } catch (_) {}
    } else {
      _queue.push([event, props || {}]);
    }
  };

  /* ── 2. Load PostHog's array.js directly from CDN ──
     Deferred to idle / first interaction (via window.zwWhenIdle, defined in
     meta-pixel.js with a setTimeout fallback) so the ~50KB library doesn't
     compete with the page's own resources during load. zwTrack() queues events
     until it loads, so nothing is lost. */
  var script = document.createElement('script');
  script.src   = HOST.replace('.i.posthog.com', '-assets.i.posthog.com') + '/static/array.js';
  script.async = true;

  script.onload = function () {
    if (typeof window.posthog === 'undefined') return;

    window.posthog.init(KEY, {
      api_host:        HOST,
      defaults:        '2026-01-30',
      person_profiles: 'identified_only',
      autocapture:     true,
      capture_pageview: true,
      capture_pageleave: true,
      loaded: function (ph) {
        _ph = ph;

        /* Flush queued events */
        for (var i = 0; i < _queue.length; i++) {
          try { ph.capture(_queue[i][0], _queue[i][1]); } catch (_) {}
        }
        _queue = [];

        /* Upgrade zwTrack to call PostHog directly */
        window.zwTrack = function (event, props) {
          try { ph.capture(event, props || {}); } catch (_) {}
        };
      },
    });
  };

  function loadPostHog() {
    var first = document.getElementsByTagName('script')[0];
    if (first && first.parentNode) {
      first.parentNode.insertBefore(script, first);
    } else {
      document.head.appendChild(script);
    }
  }
  if (typeof window.zwWhenIdle === 'function') window.zwWhenIdle(loadPostHog);
  else if ('requestIdleCallback' in window) requestIdleCallback(loadPostHog, { timeout: 3000 });
  else setTimeout(loadPostHog, 2500);

  /* ── 3. Identify Supabase users when auth is ready ── */
  function tryIdentify() {
    var sb = window.sb || window._sb;
    if (!sb || !sb.auth) return false;
    sb.auth.onAuthStateChange(function (event, session) {
      var ph = _ph || window.posthog;
      if (!ph) return;
      if (session && session.user) {
        var u    = session.user;
        var meta = u.user_metadata || {};
        try {
          ph.identify(u.id, {
            email:      u.email        || '',
            name:       meta.full_name || meta.name || '',
            created_at: u.created_at   || '',
          });
        } catch (_) {}
        if (event === 'SIGNED_IN') window.zwTrack('user_signed_in', { email: u.email });
        if (event === 'SIGNED_UP') window.zwTrack('user_signed_up', { email: u.email });
      } else {
        try { (ph.reset || function(){})(); } catch (_) {}
      }
    });
    return true;
  }

  if (!tryIdentify()) {
    var _tries = 0;
    var _poll  = setInterval(function () {
      if (tryIdentify() || ++_tries > 20) clearInterval(_poll);
    }, 250);
  }
}());
