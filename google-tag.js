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
  // Load the library once — only if no page-level gtag snippet already did.
  if (!document.querySelector('script[src*="googletagmanager.com/gtag/js"]')) {
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4;
    document.head.appendChild(s);
    gtag('js', new Date());
  }
  gtag('config', GA4);
  gtag('config', ADS);
})();
