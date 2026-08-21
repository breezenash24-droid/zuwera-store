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

  /* Either id may be stamped empty by scripts/stamp-project-config.js, meaning
     this store does not use that destination — a fork sets ZW_GA_MEASUREMENT_ID
     or ZW_GOOGLE_ADS_ID to `off`. They are independent: running GA4 with no ads
     account is the normal case, and the pair is only loaded at all if at least
     one survives. Without this, a fork's traffic reported into the original
     store's property and nothing anywhere said so. */
  var LIB = GA4 || ADS;

  // Only load + configure Google once consent is granted.
  function start() {
    if (!LIB) return;
    var needLib = !document.querySelector('script[src*="googletagmanager.com/gtag/js"]');
    if (needLib) gtag('js', new Date());
    if (GA4) gtag('config', GA4);
    if (ADS) gtag('config', ADS);
    if (needLib) {
      var loadGtag = function () {
        if (document.querySelector('script[src*="googletagmanager.com/gtag/js"]')) return;
        var s = document.createElement('script');
        s.async = true;
        s.src = 'https://www.googletagmanager.com/gtag/js?id=' + LIB;
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
