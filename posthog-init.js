/**
 * PostHog analytics for Zuwera
 *
 * CONSENT-GATED: window.zwTrack stays callable at all times (queues in memory —
 * no network, no cookies), but PostHog's library load + init + user identify
 * happen ONLY after the visitor accepts cookies (consent.js). Decline / no
 * choice => PostHog never loads.
 *
 * Include in <head> on every page.
 */
(function () {
  'use strict';

  // Skip analytics inside iframes (size-guide modal embed, admin preview) — the
  // parent already tracked the view. zwTrack stays a no-op so callers never break.
  try {
    if (window.self !== window.top) {
      window.zwTrack = function () {};
      return;
    }
  } catch (_) {}

  var KEY  = 'phc_mCL2GmGPncq5Twg7vK6FesuQHQZVTojTxHTpc4Bwp9yT';
  var HOST = 'https://us.i.posthog.com';

  /* zwTrack callable immediately; queues until PostHog loads (post-consent). */
  var _queue = [];
  var _ph    = null;
  window.zwTrack = function (event, props) {
    if (_ph) { try { _ph.capture(event, props || {}); } catch (_) {} }
    else { _queue.push([event, props || {}]); }
  };

  function start() {
    /* Load PostHog's array.js directly from CDN, deferred to idle/first interaction. */
    var script = document.createElement('script');
    script.src   = HOST.replace('.i.posthog.com', '-assets.i.posthog.com') + '/static/array.js';
    script.async = true;

    script.onload = function () {
      if (typeof window.posthog === 'undefined') return;
      window.posthog.init(KEY, {
        api_host:          HOST,
        defaults:          '2026-01-30',
        person_profiles:   'identified_only',
        autocapture:       true,
        capture_pageview:  true,
        capture_pageleave: true,
        loaded: function (ph) {
          _ph = ph;
          for (var i = 0; i < _queue.length; i++) {
            try { ph.capture(_queue[i][0], _queue[i][1]); } catch (_) {}
          }
          _queue = [];
          window.zwTrack = function (event, props) {
            try { ph.capture(event, props || {}); } catch (_) {}
          };
        }
      });
    };

    function loadPostHog() {
      var first = document.getElementsByTagName('script')[0];
      if (first && first.parentNode) first.parentNode.insertBefore(script, first);
      else document.head.appendChild(script);
    }
    if (typeof window.zwWhenIdle === 'function') window.zwWhenIdle(loadPostHog);
    else if ('requestIdleCallback' in window) requestIdleCallback(loadPostHog, { timeout: 3000 });
    else setTimeout(loadPostHog, 2500);

    /* Identify Supabase users when auth is ready. */
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
          try { (ph.reset || function () {})(); } catch (_) {}
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
  }

  // Consent gate (no dependency on consent.js load order).
  function consent() { try { return localStorage.getItem('zw_cookie_consent'); } catch (_) { return null; } }
  if (consent() === 'accepted') start();
  else if (consent() !== 'declined') {
    window.addEventListener('zw-consent-accepted', function h() {
      window.removeEventListener('zw-consent-accepted', h); start();
    }, { once: true });
  }
}());
