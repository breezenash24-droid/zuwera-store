/*
 * google-tag.js — Google tag (gtag.js) for GA4 + Google Ads.
 *
 * Loaded (deferred) on every customer-facing page. Loads the gtag.js library if
 * the page doesn't already have it, then configures BOTH destinations:
 *   - GA4         G-DCVWDZ8ZBC    (analytics)
 *   - Google Ads  AW-18239653983  (conversion tracking + remarketing)
 *
 * Why centralize: GA4 used to be inline on only a few pages, so checkout.html
 * and product.html had no gtag at all — their gtag('event','purchase') /
 * 'add_to_cart' calls were silently skipped. Loading this everywhere fixes that
 * and adds the Google Ads destination in one place.
 *
 * Google Ads conversions are EVENT-BASED: the existing
 *   gtag('event','purchase', { value, currency, transaction_id })
 * fired at checkout doubles as the Ads Purchase conversion once the AW
 * destination below is configured — no separate send_to/label snippet needed.
 * (transaction_id is the Stripe payment-intent id, so Google de-dupes refreshes.)
 *
 * Pages that still have their own inline gtag block keep working; the duplicate
 * GA4 config here is a harmless no-op and only the Ads destination is added.
 */
(function () {
  'use strict';
  var GA4 = 'G-DCVWDZ8ZBC';
  var ADS = 'AW-18239653983';

  window.dataLayer = window.dataLayer || [];
  if (typeof window.gtag !== 'function') {
    window.gtag = function () { window.dataLayer.push(arguments); };
  }
  // Queue config immediately (into dataLayer); the gtag() stub buffers these and
  // replays them once the library loads, so no events are lost.
  var needLib = !document.querySelector('script[src*="googletagmanager.com/gtag/js"]');
  if (needLib) gtag('js', new Date());
  gtag('config', GA4);
  gtag('config', ADS);

  // Defer the heavy gtag.js library download to idle / first interaction (via
  // window.zwWhenIdle from meta-pixel.js, with fallbacks) so it doesn't compete
  // with the page's own resources during the initial load.
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
})();
