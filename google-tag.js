/*
 * google-tag.js — Google tag (gtag.js) for GA4 + Google Ads.
 *
 * CONSENT-GATED: gtag() stays callable at all times (it only buffers into
 * dataLayer — no network, no cookies), but the GA4/Ads config and the gtag.js
 * library download happen ONLY after the visitor accepts cookies (consent.js).
 * Decline / no choice => nothing loads or sends.
 *
 *   - GA4         G-DCVWDZ8ZBC    (analytics)
 *   - Google Ads  AW-18239653983  (conversion tracking + remarketing)
 *
 * Google Ads conversions are EVENT-BASED: the existing
 *   gtag('event','purchase', { value, currency, transaction_id })
 * fired at checkout doubles as the Ads Purchase conversion once the AW
 * destination below is configured.
 */
(function () {
  'use strict';
  var GA4 = 'G-DCVWDZ8ZBC';
  var ADS = 'AW-18239653983';

  // gtag() callable always so call sites never throw; buffers to dataLayer only.
  window.dataLayer = window.dataLayer || [];
  if (typeof window.gtag !== 'function') {
    window.gtag = function () { window.dataLayer.push(arguments); };
  }

  // Only load + configure Google once consent is granted.
  function start() {
    var needLib = !document.querySelector('script[src*="googletagmanager.com/gtag/js"]');
    if (needLib) gtag('js', new Date());
    gtag('config', GA4);
    gtag('config', ADS);
    if (needLib) {
      var loadGtag = function () {
        if (document.querySelector('script[src*="googletagmanager.com/gtag/js"]')) return;
        var s = document.createElement('script');
        s.async = true;
        s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4;
        document.head.appendChild(s);
      };
      if (typeof window.zwWhenIdle === 'function') window.zwWhenIdle(loadGtag);
      else if ('requestIdleCallback' in window) requestIdleCallback(loadGtag, { timeout: 3000 });
      else setTimeout(loadGtag, 2500);
    }
  }

  // Consent gate (no dependency on consent.js load order): run now if already
  // accepted, do nothing if declined, otherwise start the moment they accept.
  function consent() { try { return localStorage.getItem('zw_cookie_consent'); } catch (_) { return null; } }
  if (consent() === 'accepted') start();
  else if (consent() !== 'declined') {
    window.addEventListener('zw-consent-accepted', function h() {
      window.removeEventListener('zw-consent-accepted', h); start();
    }, { once: true });
  }
})();
