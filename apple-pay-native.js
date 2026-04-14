/**
 * apple-pay-native.js — Zuwera Sportswear
 * Native Apple Pay session for Safari/iPhone.
 * On Chrome/Firefox desktop, falls back to showApplePayQrModal().
 *
 * Loaded by index.html and product.html via <script src="/apple-pay-native.js">
 */

(function () {
  'use strict';

  /* ── config ─────────────────────────────────────────── */
  var VALIDATE_URL = '/api/apple-pay-validate';
  var CHARGE_URL   = '/api/apple-pay-charge';

  /* ── detect native vs QR ─────────────────────────────── */
  function applePayMode() {
    if (typeof ApplePaySession === 'undefined') return 'none';
    if (!ApplePaySession.supportsVersion(3))   return 'none';
    if (ApplePaySession.canMakePayments())     return 'native';
    return 'qr';
  }
  window.applePayMode = applePayMode;

  /* ── get cart total ──────────────────────────────────── */
  function getCartTotal() {
    try {
      var cart = JSON.parse(localStorage.getItem('cart') || '[]');
      return cart.reduce(function (s, i) {
        return s + (parseFloat(i.price) || 0) * (parseInt(i.quantity) || 1);
      }, 0);
    } catch (e) { return 0; }
  }

  /* ── show toast (re-uses existing showToast if present) ─ */
  function toast(msg) {
    if (typeof showToast === 'function') showToast(msg);
    else console.warn('[apple-pay]', msg);
  }

  /* ── native Apple Pay session ────────────────────────── */
  function startNativeApplePay(totalOverride) {
    var total = totalOverride != null ? totalOverride : getCartTotal();
    if (!total) { toast('Your cart is empty.'); return; }

    if (typeof ApplePaySession === 'undefined' || !ApplePaySession.supportsVersion(3)) {
      toast('Apple Pay is not available.'); return;
    }

    var session = new ApplePaySession(3, {
      countryCode:          'US',
      currencyCode:         'USD',
      merchantCapabilities: ['supports3DS'],
      supportedNetworks:    ['visa', 'masterCard', 'amex', 'discover'],
      total: {
        label:  'Zuwera Sportswear',
        amount: total.toFixed(2),
        type:   'final'
      }
    });

    /* merchant validation */
    session.onvalidatemerchant = function (event) {
      fetch(VALIDATE_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ validationURL: event.validationURL })
      })
      .then(function (r) {
        if (!r.ok) throw new Error('Validation failed: ' + r.status);
        return r.json();
      })
      .then(function (ms) { session.completeMerchantValidation(ms); })
      .catch(function (err) {
        console.error('[apple-pay] validation error:', err);
        session.abort();
        toast('Apple Pay unavailable. Please try another payment method.');
      });
    };

    /* payment authorised — extract real token and charge */
    session.onpaymentauthorized = function (event) {
      /*
       * event.payment.token.paymentData is the encrypted Apple Pay token:
       * {
       *   version:   "EC_v1",
       *   data:      "<base64 encrypted>",
       *   signature: "<base64 CMS>",
       *   header: {
       *     ephemeralPublicKey: "<base64>",
       *     publicKeyHash:      "<base64>",
       *     transactionId:      "<hex>",
       *   }
       * }
       * We send it verbatim to our Worker which passes it to Stripe.
       * Stripe decrypts it server-side using your registered Apple Pay cert.
       */
      var applePayToken = event.payment.token.paymentData;

      fetch(CHARGE_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          applePayToken: applePayToken,
          order: {
            amount:   Math.round(total * 100),
            currency: 'usd'
          }
        })
      })
      .then(function (r) {
        if (!r.ok) throw new Error('Charge failed: ' + r.status);
        return r.json();
      })
      .then(function (result) {
        session.completePayment(ApplePaySession.STATUS_SUCCESS);
        localStorage.removeItem('cart');
        window.location.href = '/confirm.html?id=' + (result.paymentIntentId || '');
      })
      .catch(function (err) {
        console.error('[apple-pay] charge error:', err);
        session.completePayment(ApplePaySession.STATUS_FAILURE);
        toast('Payment failed. Please try again.');
      });
    };

    session.oncancel = function () { toast('Apple Pay cancelled.'); };
    session.begin();
  }

  /* ── exported entry point ────────────────────────────── */
  window.startNativeApplePay = startNativeApplePay;

  /* ── auto-wire existing Apple Pay QR buttons ─────────── */
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('button[data-action="qr"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var mode = applePayMode();
        if (mode === 'native') {
          startNativeApplePay();
        } else if (typeof showApplePayQrModal === 'function') {
          showApplePayQrModal();
        }
      });
    });
  });

})();
