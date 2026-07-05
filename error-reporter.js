/* error-reporter.js — lightweight, self-hosted runtime error tracking.
   Captures uncaught errors + unhandled promise rejections and POSTs a compact
   record to /api/log-error (which writes to Supabase `error_log` via the service
   key). Fully defensive: never throws, never blocks the page, throttled + deduped
   so an error loop can't flood. No external SDK, no cookies, no dependencies. */
(function () {
  'use strict';
  var ENDPOINT = '/api/log-error';
  var MAX_PER_SESSION = 20;          // hard cap so a runaway loop can't spam
  var sent = 0;
  var seen = Object.create(null);    // dedupe key -> last-sent timestamp
  var release = '';
  try { var mt = document.querySelector('meta[name="zuwera-deployment"]'); if (mt) release = mt.content || ''; } catch (_) {}

  function post(rec) {
    try {
      if (sent >= MAX_PER_SESSION) return;
      var key = (rec.message || '') + '|' + (rec.line || '') + '|' + (rec.source || '');
      var now = Date.now();
      if (seen[key] && now - seen[key] < 10000) return;   // same error within 10s → skip
      seen[key] = now;
      sent++;
      rec.url = String(location.href).slice(0, 500);
      rec.user_agent = String(navigator.userAgent || '').slice(0, 300);
      rec.release = release;
      var body = JSON.stringify(rec);
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      } else {
        fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
      }
    } catch (_) {}
  }

  window.addEventListener('error', function (e) {
    try {
      post({
        source: 'error',
        message: String((e && e.message) || 'error').slice(0, 500),
        line: (e && e.lineno) || 0,
        col: (e && e.colno) || 0,
        stack: (e && e.error && e.error.stack ? String(e.error.stack) : '').slice(0, 2000),
      });
    } catch (_) {}
  });

  window.addEventListener('unhandledrejection', function (e) {
    try {
      var r = e && e.reason;
      post({
        source: 'unhandledrejection',
        message: String((r && r.message) || r || 'unhandledrejection').slice(0, 500),
        stack: (r && r.stack ? String(r.stack) : '').slice(0, 2000),
      });
    } catch (_) {}
  });
})();
