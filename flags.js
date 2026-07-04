/**
 * flags.js — Feature flags with gradual rollouts + kill switches.
 *
 * Flags are managed in Admin → Feature Flags and stored in
 * site_settings.feature_flags (public-read), e.g.
 *   { "checkout_v2": { "enabled": true, "rollout": 25, "description": "…" } }
 *
 * Evaluation is deterministic and sticky per visitor: a stable id in
 * localStorage is hashed together with the flag name to a 0–99 bucket; the flag
 * is ON when that bucket is below the rollout %. So the SAME visitor always gets
 * the same answer, raising the % only ever adds people, and each flag buckets
 * independently. Works for EVERY visitor (no cookie consent needed) because
 * site_settings is public data.
 *
 * API (all on window):
 *   zwFlag('name')        → boolean (respects enabled + rollout)
 *   zwWhenFlags(cb)       → cb(zwFlag) once flags have loaded (or immediately)
 *   zwBucket('name')      → this visitor's 0–99 bucket for a flag (for previews)
 *   __zwFlags             → the raw flag map
 *   event 'zw-flags-ready'
 *
 * Usage:
 *   zwWhenFlags(() => { if (zwFlag('checkout_v2')) mountNewCheckout(); });
 */
(function () {
  var SUPA = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
  // Public, RLS-gated anon key (same one shipped in supabase-client.js).
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

  window.__zwFlags = window.__zwFlags || {};
  var loaded = false;
  var waiters = [];

  function visitorId() {
    try {
      var id = localStorage.getItem('zw_vid');
      if (!id) {
        id = (window.crypto && crypto.randomUUID)
          ? crypto.randomUUID()
          : (Date.now() + '-' + Math.random().toString(36).slice(2));
        localStorage.setItem('zw_vid', id);
      }
      return id;
    } catch (_) { return 'anon'; }
  }

  function bucket(name) {
    var s = String(name) + '|' + visitorId(), h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 100;
  }
  window.zwBucket = bucket;

  // Report each flag's evaluated variant to PostHog ONCE per page (after flags
  // have loaded) so any funnel/metric can be broken down by variant and PostHog
  // Experiments can measure it. Routes through zwTrack + posthog.register — both
  // consent-gated — so nothing is sent unless the visitor accepted cookies.
  var _reported = {};
  function reportFlag(name, result) {
    if (!loaded || _reported[name] !== undefined) return;
    _reported[name] = result;
    // Exposure event (PostHog's convention; queues via zwTrack until PostHog loads).
    try {
      if (typeof window.zwTrack === 'function') {
        window.zwTrack('$feature_flag_called', { $feature_flag: name, $feature_flag_response: result });
      }
    } catch (_) {}
    // Super property so EVERY later event carries $feature/<name> = variant.
    var tries = 0;
    (function register() {
      if (window.posthog && typeof window.posthog.register === 'function') {
        try { var p = {}; p['$feature/' + name] = result; window.posthog.register(p); } catch (_) {}
      } else if (tries++ < 40) { setTimeout(register, 500); } // PostHog loads late (idle + post-consent)
    })();
  }

  function evalFlag(name) {
    var f = window.__zwFlags[name];
    if (!f || f.enabled === false) return false;
    if (typeof f.rollout === 'number' && f.rollout < 100) return bucket(name) < f.rollout;
    return true; // enabled with no/100% rollout
  }

  window.zwFlag = function (name) {
    var result = evalFlag(name);
    reportFlag(name, result);
    return result;
  };

  // Every defined flag evaluated for this visitor, e.g. { checkout_v2: true }.
  // Used to stamp the order at checkout so revenue can be split by variant for
  // ALL buyers (no consent needed). Pure — does not report to PostHog.
  window.zwActiveFlags = function () {
    var out = {};
    for (var k in window.__zwFlags) {
      if (Object.prototype.hasOwnProperty.call(window.__zwFlags, k)) out[k] = evalFlag(k);
    }
    return out;
  };

  window.zwWhenFlags = function (cb) {
    if (typeof cb !== 'function') return;
    if (loaded) { try { cb(window.zwFlag); } catch (_) {} }
    else waiters.push(cb);
  };

  function ready() {
    loaded = true;
    try { window.dispatchEvent(new Event('zw-flags-ready')); } catch (_) {}
    waiters.splice(0).forEach(function (cb) { try { cb(window.zwFlag); } catch (_) {} });
  }

  function apply(v) {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
    if (v && typeof v === 'object') window.__zwFlags = v;
  }

  // A page that already fetched site_settings can hand the flags over to avoid a
  // second request by setting window.__zwFlagsPreloaded before this script runs.
  if (window.__zwFlagsPreloaded) { apply(window.__zwFlagsPreloaded); ready(); return; }

  fetch(SUPA + '/rest/v1/site_settings?key=eq.feature_flags&select=value', {
    headers: { apikey: ANON, Authorization: 'Bearer ' + ANON }
  })
    .then(function (r) { return r.ok ? r.json() : []; })
    .then(function (rows) { if (rows && rows[0]) apply(rows[0].value); })
    .catch(function () {})
    .finally(ready);
})();
