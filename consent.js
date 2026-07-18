/* consent.js — cookie consent manager (GDPR/ePrivacy).
 *
 * ONE source of truth for cookie consent, loaded on every customer-facing page:
 *   • Shows the consent banner on EVERY page until the visitor Accepts or Declines
 *     (persisted in localStorage 'zw_cookie_consent' = 'accepted' | 'declined').
 *   • Exposes window.zwConsent so the analytics/marketing scripts can gate
 *     themselves — nothing non-essential runs until 'accepted'. Decline (or no
 *     choice yet) => no GA4 / Google Ads / Meta Pixel / Meta CAPI relay / PostHog.
 *   • Fires window events 'zw-consent-accepted' / 'zw-consent-declined' so the
 *     tracking scripts (which load independently) can start the moment consent is
 *     granted, without any load-order dependency on this file.
 *
 * Essential things (cart, auth, checkout, the consent choice itself) are NOT
 * gated — only analytics + advertising.
 */
(function () {
  'use strict';
  var KEY = 'zw_cookie_consent';

  function get() { try { return localStorage.getItem(KEY); } catch (_) { return null; } }
  function fire(name) { try { window.dispatchEvent(new Event(name)); } catch (_) {} }
  function hide() { var b = document.getElementById('cookie-banner'); if (b) b.style.display = 'none'; }

  function save(v) {
    try { localStorage.setItem(KEY, v); } catch (_) {}
    hide();
    fire(v === 'accepted' ? 'zw-consent-accepted' : 'zw-consent-declined');
  }

  window.zwConsent = {
    state: get,
    granted: function () { return get() === 'accepted'; },
    accept: function () { save('accepted'); },
    decline: function () { save('declined'); },
    // Run cb when consent is (or becomes) granted; never runs if declined.
    onGrant: function (cb) {
      if (get() === 'accepted') { setTimeout(cb, 0); return; }
      if (get() === 'declined') return;
      window.addEventListener('zw-consent-accepted', function h() {
        window.removeEventListener('zw-consent-accepted', h); cb();
      }, { once: true });
    },
    // Let the visitor re-open their choice later (e.g. a footer "Cookie settings" link).
    reopen: function () { try { localStorage.removeItem(KEY); } catch (_) {} show(); }
  };

  // Build the banner if the page doesn't already ship one (index.html's inline
  // banner was removed in favour of this). Self-styled (dark bar) so it looks
  // right on every page; #cookie-banner CSS in storefront-cohesion.css still wins.
  function build() {
    var b = document.createElement('div');
    b.id = 'cookie-banner';
    // role="region" (NOT "dialog") on purpose: a cookie bar is a non-blocking
    // notice, and modal-lock.js scroll-locks the page for any visible
    // [role="dialog"]. This bar must let the visitor scroll + click while it's up.
    b.setAttribute('role', 'region');
    b.setAttribute('aria-label', 'Cookie consent');
    b.style.cssText = 'display:none;position:fixed;bottom:0;left:0;right:0;z-index:9999;padding:1rem 2rem;font-size:.8rem;line-height:1.5;background:#0f0f0f;color:rgba(244,241,235,.72);border-top:1px solid rgba(244,241,235,.12);align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.8rem;font-family:var(--fb,var(--font-body,sans-serif))';
    b.innerHTML =
      '<p style="margin:0;flex:1;min-width:200px">We use cookies for analytics and marketing to improve your experience. You can accept or decline — essential cookies (cart, checkout) always work. See our <a href="/policies.html#privacy" style="color:currentColor;text-decoration:underline;opacity:.85">Privacy Policy</a>.</p>' +
      '<div style="display:flex;gap:.5rem;flex-shrink:0">' +
        '<button type="button" data-zwc="accept" style="padding:.5rem 1.2rem;background:#f4f1eb;color:#09090b;border:none;font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;font-family:inherit">Accept</button>' +
        '<button type="button" data-zwc="decline" style="padding:.5rem 1.2rem;background:transparent;color:rgba(244,241,235,.62);border:1px solid rgba(244,241,235,.22);font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;font-family:inherit">Decline</button>' +
      '</div>';
    return b;
  }

  function show() {
    var b = document.getElementById('cookie-banner');
    if (!b) { b = build(); (document.body || document.documentElement).appendChild(b); }
    b.style.display = 'flex';
    b.querySelectorAll('[data-zwc]').forEach(function (btn) {
      if (btn._zwcBound) return; btn._zwcBound = 1;
      btn.addEventListener('click', function () {
        btn.getAttribute('data-zwc') === 'accept' ? window.zwConsent.accept() : window.zwConsent.decline();
      });
    });
  }

  function init() {
    // Never surface the banner in an embedded context (e.g. the size-guide iframe on the
    // product page). The visitor makes their choice once on the top-level site; a second
    // banner inside an iframe is redundant and confusing. zwConsent still reads the shared
    // localStorage choice here, so anything gating on it behaves correctly.
    try { if (window.self !== window.top) { hide(); return; } } catch (_) { hide(); return; }
    var s = get();
    if (s === 'accepted') { fire('zw-consent-accepted'); hide(); return; } // returning consenter → let trackers start
    if (s === 'declined') { hide(); return; }
    show(); // no choice yet → banner on this (and every) page
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
