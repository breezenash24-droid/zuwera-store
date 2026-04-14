/**
 * apple-pay-native.js — Zuwera Sportswear
 *
 * Stripe PaymentRequest button — shows Apple Pay on Safari,
 * Google Pay on Chrome/Android, and NOTHING on unsupported browsers.
 *
 * Buttons with [data-action="qr"] are hidden immediately via CSS and
 * only replaced with a live Stripe button when stripe.canMakePayment()
 * confirms the browser supports a wallet method.
 *
 * Does NOT require the Apple Developer merchant cert.
 * Does NOT require any change to index.html — discovers the Stripe
 * instance automatically by scanning window properties.
 */
(function () {
  'use strict';

  var PAYMENT_INTENT_URL = '/api/create-payment-intent';
  var CONFIRM_URL        = '/confirm.html';
  var BUTTON_SELECTOR    = 'button[data-action="qr"]';
  var STORE_LABEL        = 'Zuwera Sportswear';

  // Hide wallet buttons immediately — shown only when wallet is confirmed available
  var s = document.createElement('style');
  s.textContent = BUTTON_SELECTOR + '{display:none!important}';
  (document.head || document.documentElement).appendChild(s);

  function getCart() {
    try { return JSON.parse(localStorage.getItem('cart') || '[]'); } catch (_) { return []; }
  }

  function totalCents(cart) {
    return cart.reduce(function (sum, item) {
      return sum + Math.round((parseFloat(item.price) || 0) * 100) * (parseInt(item.qty, 10) || 1);
    }, 0);
  }

  function isStripe(obj) {
    return obj && typeof obj === 'object' &&
      typeof obj.paymentRequest === 'function' &&
      typeof obj.elements === 'function' &&
      typeof obj.confirmCardPayment === 'function';
  }

  function findStripeInstance() {
    var names = ['stripe', '_stripe', 'stripeClient', 'stripeInstance'];
    for (var i = 0; i < names.length; i++) {
      if (isStripe(window[names[i]])) return window[names[i]];
    }
    for (var k in window) {
      try { if (isStripe(window[k])) return window[k]; } catch (_) {}
    }
    return null;
  }

  function waitForStripe(cb, n) {
    var inst = findStripeInstance();
    if (inst) { cb(inst); return; }
    if ((n || 0) >= 60) return;
    setTimeout(function () { waitForStripe(cb, (n || 0) + 1); }, 100);
  }

  function mount(stripe, amountCents) {
    var pr = stripe.paymentRequest({
      country: 'US', currency: 'usd',
      total: { label: STORE_LABEL, amount: amountCents },
      requestPayerName: true, requestPayerEmail: true,
    });

    pr.canMakePayment().then(function (result) {
      if (!result) return; // No wallet — buttons stay hidden
      var buttons = document.querySelectorAll(BUTTON_SELECTOR);
      if (!buttons.length) return;
      var els = stripe.elements();
      buttons.forEach(function (btn, i) {
        var id = 'zw-pr-' + i;
        var wrap = document.createElement('div');
        wrap.id = id;
        wrap.style.cssText = 'display:block;min-height:44px;width:100%;';
        btn.parentNode.insertBefore(wrap, btn);
        els.create('paymentRequestButton', {
          paymentRequest: pr,
          style: { paymentRequestButton: { type: 'buy', theme: 'dark', height: '44px' } },
        }).mount('#' + id);
      });
    });

    pr.on('paymentmethod', function (ev) {
      var cart = getCart();
      var cents = totalCents(cart);
      if (cents <= 0) { ev.complete('fail'); return; }

      fetch(PAYMENT_INTENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: cents, currency: 'usd', cart: cart }),
      })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        if (!data.clientSecret) { ev.complete('fail'); return null; }
        return stripe.confirmCardPayment(data.clientSecret,
          { payment_method: ev.paymentMethod.id }, { handleActions: false })
        .then(function (res) {
          if (res.error) { ev.complete('fail'); return null; }
          ev.complete('success');
          if (res.paymentIntent.status === 'requires_action')
            return stripe.confirmCardPayment(data.clientSecret);
          return res;
        });
      })
      .then(function (final) {
        if (!final || final.error) return;
        localStorage.removeItem('cart');
        window.location.href = CONFIRM_URL + '?id=' + final.paymentIntent.id;
      })
      .catch(function () { ev.complete('fail'); });
    });
  }

  function boot() {
    var cents = totalCents(getCart());
    if (cents <= 0) return;
    waitForStripe(function (stripe) { mount(stripe, cents); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
}());
