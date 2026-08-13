/* ────────────────────────────────────────────────────────────────────────────
   paypal-button.js — the PayPal button on the checkout.

   Both server halves already existed and neither was reachable: an endpoint
   that creates a PayPal order and an endpoint that captures it, with nothing on
   any page calling either. This is what calls them.

   ── WHAT THIS FILE IS NOT ALLOWED TO DECIDE ─────────────────────────────────

   Not the price. It sends the cart, the address and the promo code; what the
   order costs is settled by quoteCart() on the server, from the catalog, the
   same call the card path makes. The totals coming back are for display and are
   never sent onward as an amount to charge.

   Not whether PayPal is offered. /api/paypal-config answers that, and it wants
   two things to be true: credentials in the environment AND an admin having
   switched it on. Credentials alone would not do, because PAYPAL_ENV defaults
   to sandbox — the first credentials a store adds are nearly always sandbox
   ones, and lighting the button then would hand every real shopper a PayPal
   window that cannot take their money.

   ── THE ORDER OF THE TWO CALLS ──────────────────────────────────────────────

   createOrder runs before the buyer sees PayPal's window, and the amount it
   returns is the amount they approve. So everything that can move the total —
   the shipping rate in particular, which arrives from a debounced fetch — has
   to be settled BEFORE it. A rate landing afterwards changes a figure the buyer
   has already agreed to, and the capture endpoint would then refuse the whole
   payment for a mismatch it was right to refuse.

   onApprove sends the same cart back, and capture re-prices it and compares.
   That comparison is the safety of the entire flow, which is why this file
   sends the cart rather than a total: a browser that could name its own price
   would make the comparison meaningless.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var SDK_ID = 'zw-paypal-sdk';
  var mounted = false;

  function el(id) { return document.getElementById(id); }

  /* PayPal's SDK is a script tag with the client id in the URL. Loaded once,
     and only after the config says the button is being offered — a store that
     does not take PayPal should not be fetching PayPal's JavaScript. */
  function loadSdk(clientId) {
    return new Promise(function (resolve, reject) {
      if (window.paypal) { resolve(window.paypal); return; }
      var existing = el(SDK_ID);
      if (existing) {
        existing.addEventListener('load', function () { resolve(window.paypal); });
        existing.addEventListener('error', function () { reject(new Error('PayPal SDK failed to load')); });
        return;
      }
      var s = document.createElement('script');
      s.id = SDK_ID;
      s.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(clientId) +
        '&currency=USD&intent=capture&components=buttons&disable-funding=credit';
      s.async = true;
      s.onload = function () {
        if (window.paypal) resolve(window.paypal);
        else reject(new Error('PayPal SDK loaded without paypal global'));
      };
      s.onerror = function () { reject(new Error('PayPal SDK failed to load')); };
      document.head.appendChild(s);
    });
  }

  function showError(message) {
    var errEl = el('pay-error');
    if (errEl) errEl.textContent = message;
    /* The button sits above the fold on a long form and the error message sits
       with the card fields, so a failure could land entirely off screen. */
    if (errEl && errEl.scrollIntoView) {
      try { errEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
    }
  }

  function post(url, body) {
    /* Deliberately window.postJSON and not fetch: commerce-checkout.js wraps
       that helper to inject the active promo code, the delivery method and the
       feature-flag snapshot. Calling fetch directly here would bypass the
       wrapper, and the first thing anyone would notice is a discount that
       applies on a card and not through PayPal. */
    if (typeof window.postJSON === 'function') return window.postJSON(url, body);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  function mount(cfg) {
    var host = el('paypal-button');
    var form = window.ZWCheckoutForm;
    if (!host || !form || mounted) return;

    return loadSdk(cfg.clientId).then(function (paypal) {
      mounted = true;
      host.style.display = 'block';
      host.removeAttribute('aria-hidden');

      /* Sandbox credentials on a live storefront take real-looking payments
         that are not real. Said on the page rather than only in the panel,
         because the person who needs to see it is whoever opens the checkout
         to test — matching the Stripe test-mode banner already on this page. */
      if (cfg.mode !== 'live') {
        var banner = el('paypal-test-banner');
        if (banner) banner.style.display = 'block';
      }

      var divider = el('pay-divider');
      if (divider) divider.style.display = 'block';

      /* Held between createOrder and onApprove. The order number is minted on
         the server at create time, and the confirmation screen needs it — but
         capture returns it too, so this is a fallback rather than the source. */
      var pending = { orderNumber: '', address: null };

      paypal.Buttons({
        style: { layout: 'horizontal', color: 'gold', shape: 'rect', height: 45, tagline: false },

        /* Runs before PayPal's window opens, which is the only moment an
           incomplete form can be reported without the buyer having already
           been sent somewhere. */
        onClick: function (data, actions) {
          var collected = form.collect();
          if (collected.error) {
            showError(collected.error);
            return actions.reject();
          }
          showError('');
          return actions.resolve();
        },

        createOrder: function () {
          var collected = form.collect();
          if (collected.error) return Promise.reject(new Error(collected.error));
          var address = collected.address;

          /* Before the buyer is shown an amount, not after. */
          return form.ensureRate(address.zip, address.state)
            .then(function () { return form.auth(); })
            .then(function (auth) {
              return post('/api/paypal-create-order', form.payload(address, auth.accessToken));
            })
            .then(function (res) {
              if (!res || res.error || !res.paypalOrderId) {
                throw new Error((res && res.error) || 'PayPal could not start that payment.');
              }
              pending.orderNumber = res.orderNumber || '';
              pending.address = address;
              return res.paypalOrderId;
            });
        },

        onApprove: function (data, actions) {
          var address = pending.address || (form.collect().address);
          if (!address) { showError('Please complete your address and try again.'); return; }

          return form.auth().then(function (auth) {
            var body = form.payload(address, auth.accessToken);
            body.paypalOrderId = data.orderID;
            return post('/api/paypal-capture', body);
          }).then(function (res) {
            /* PayPal's documented recovery for a declined funding source:
               reopen the window so the buyer can pick another. The capture
               endpoint flags exactly this case and nothing else, because
               restarting on any other failure would loop a buyer through a
               window that will refuse them again. */
            if (res && res.retryable && actions && typeof actions.restart === 'function') {
              showError(res.error || 'That payment method was declined. Please choose another.');
              return actions.restart();
            }
            if (!res || res.error || !res.ok) {
              throw new Error((res && res.error) || 'PayPal could not complete that payment.');
            }
            form.confirmed(res.orderNumber || pending.orderNumber, address.email,
              res.captureId || data.orderID);
          });
        },

        /* Closing the window is a decision, not a fault. Saying nothing at all
           leaves a buyer looking at a checkout that gave no sign it noticed. */
        onCancel: function () { showError(''); },

        onError: function (err) {
          console.error('PayPal button error:', err);
          showError((err && err.message) || 'PayPal could not complete that payment. Nothing has been charged.');
        },
      }).render('#paypal-button').catch(function (err) {
        console.warn('PayPal button did not render:', err);
        host.style.display = 'none';
      });
    }).catch(function (err) {
      /* PayPal's script being blocked or unreachable must not take the card
         path down with it. The button simply never appears. */
      console.warn('PayPal unavailable:', err && err.message);
    });
  }

  function init() {
    if (!el('paypal-button')) return;
    fetch('/api/paypal-config', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (!cfg || !cfg.enabled || !cfg.clientId) return;
        mount(cfg);
      })
      .catch(function (err) { console.warn('PayPal config unavailable:', err && err.message); });
  }

  window.ZWPayPal = { init: init, mount: mount };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
