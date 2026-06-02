/**
 * Legacy Apple Pay helper intentionally left as a no-op.
 * Checkout wallet support now lives in index.html and product.html so it can
 * use the trusted /api/create-payment-intent payload and SCA-safe confirmation.
 */
(function () {
  'use strict';
  window.zwLegacyApplePayNativeDisabled = true;
}());