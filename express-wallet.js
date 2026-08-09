/* ────────────────────────────────────────────────────────────────────────────
   express-wallet.js — the one-click wallet row, shared by the bag and checkout.

   Stripe has two ways to draw a wallet button and only one of them can reach
   Apple Pay outside Safari:

     Payment Request Button   Apple Pay on Safari, iPhone and iPad. In desktop
                              Chrome, Edge and Firefox canMakePayment() answers
                              no and the row simply never appears. It also draws
                              exactly one button — whichever wallet it picked.
     Express Checkout Element with paymentMethods.applePay:'always', Apple Pay
                              offers itself in those browsers too, paying by a
                              QR code the customer scans with an iPhone running
                              iOS 18 or later. It draws every wallet the browser
                              has, side by side.

   This module is the second one. It is opt-in — Admin → APIs → More Integrations
   → "Apple Pay on Chrome & Edge" — because it only works once the domain is
   verified for Apple Pay in Stripe, and swapping the button on a live checkout
   is not something to do by accident. The flag lives in
   site_settings.integrations.apple_pay_qr, which is on the public-read allowlist
   and holds nothing secret.

   Nothing about the wallet changes what the customer gets: the same
   /api/create-payment-intent prices the order from the catalog, the same webhook
   writes it and sends the email. The caller supplies the cart and decides what
   "done" looks like, because that differs between the bag and checkout.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var CACHE_KEY = 'zw_integrations';
  var REST = 'https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/site_settings?select=value&key=eq.integrations';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

  // ── The opt-in flag ──────────────────────────────────────────────────────
  var enabledPromise = null;

  function flagOn(cfg) {
    var entry = cfg && cfg.apple_pay_qr;
    return !!(entry && entry.enabled);
  }

  function fetchIntegrations() {
    return fetch(REST, {
      headers: { apikey: ANON, Authorization: 'Bearer ' + ANON },
      cache: 'no-store',
    }).then(function (r) {
      if (!r.ok) throw new Error('integrations read failed');
      return r.json();
    }).then(function (rows) {
      var cfg = rows && rows[0] && rows[0].value;
      if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch (_) { cfg = null; } }
      cfg = (cfg && typeof cfg === 'object') ? cfg : {};
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(cfg)); } catch (_) {}
      return cfg;
    });
  }

  /* Answered once per page. A cached copy — written here, or by integrations.js
     on any other page — settles it with no round trip, so the row is not held up
     behind the network; the refresh behind that only decides which button the
     NEXT page load draws, never swaps one out from under someone mid-payment. */
  function enabled() {
    if (enabledPromise) return enabledPromise;
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (_) {}
    if (cached && typeof cached === 'object') {
      fetchIntegrations()['catch'](function () {});
      enabledPromise = Promise.resolve(flagOn(cached));
    } else {
      enabledPromise = fetchIntegrations()
        .then(flagOn)['catch'](function () { return false; });
    }
    return enabledPromise;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  /* Same exclusion the checkout form uses: apparel can't ship on printed-matter
     services, and "tender to carrier" rates need a facility drop-off. */
  function pickRate(rates) {
    var usable = (rates || []).filter(function (r) {
      return !/media mail|bound printed|library mail|tender to/i.test(String(r.servicelevel || ''));
    });
    var usps = usable.filter(function (r) { return String(r.provider || '').toUpperCase() === 'USPS'; });
    var pool = usps.length ? usps : usable;   // never lose the wallet if USPS is missing
    return pool[0] || null;                   // server sorts USPS-first, then cheapest
  }

  // A dark page wants the white button, a light one the black. Each brand only
  // accepts its own set of theme names, and these two are common to both.
  function buttonTheme() {
    return document.body.classList.contains('light-mode') ? 'black' : 'white';
  }

  var DELIVERY_ESTIMATE = {
    minimum: { unit: 'day', value: 3 },
    maximum: { unit: 'day', value: 7 },
  };

  /* ── mount ────────────────────────────────────────────────────────────────
     opts:
       stripe          a Stripe instance
       container       CSS selector of an empty element to mount into
       subtotalCents   starting total, after any promo discount
       getItems()      the cart, in the shape /api/create-payment-intent takes
       getPromoCode()  active promo code, or ''
       getAccessToken() Promise<string> — member pricing; '' for a guest
       onReady(shown)  true when the browser offered at least one wallet
       onError(msg)    a message to put in front of the customer
       onSuccess(o)    { orderNumber, email, paymentIntentId }
     Returns { update(cents) } so a promo change can move the amount, or null if
     the element could not be created. */
  function mount(opts) {
    var stripe = opts.stripe;
    if (!stripe || !document.querySelector(opts.container)) return null;

    var subtotalCents = Math.max(50, opts.subtotalCents | 0);   // Stripe's minimum
    var baseCents     = subtotalCents;
    var taxCents      = 0;
    var selectedRate  = null;
    var elements, element;

    function items() { return (opts.getItems && opts.getItems()) || []; }

    /* What the server will actually charge for shipping, mirrored here so the
       wallet sheet shows the real number instead of promising free shipping and
       then billing for it. Same rule as resolveShipping() in
       create-payment-intent: free above the threshold on the pre-discount
       subtotal, otherwise the quoted rate. */
    function shipping() {
      var policy = window._shippingPolicy || { enabled: true, threshold: 100, standardRate: 8 };
      var subtotal = items().reduce(function (s, i) {
        return s + parseFloat(i.price || 0) * (i.quantity || 1);
      }, 0);
      if (policy.enabled && subtotal >= policy.threshold) return { cents: 0, label: 'Free Shipping' };
      if (selectedRate) {
        return {
          cents: Math.round(parseFloat(selectedRate.amount || 0) * 100),
          label: String(selectedRate.servicelevel || 'Standard Shipping'),
        };
      }
      return { cents: Math.round((policy.standardRate || 8) * 100), label: 'Standard Shipping' };
    }

    /* Rows in the sheet's breakdown. Shipping is deliberately not one of them —
       the selected shipping rate is already its own row in Apple's and Google's
       UI, and listing it twice reads as a double charge. */
    function lineItems() {
      var rows = [{ name: 'Subtotal', amount: subtotalCents }];
      if (taxCents > 0) rows.push({ name: 'Tax', amount: taxCents });
      return rows;
    }

    function setAmount(cents) {
      try { elements.update({ amount: Math.max(50, cents) }); } catch (_) {}
    }

    elements = stripe.elements({ mode: 'payment', amount: subtotalCents, currency: 'usd' });
    element = elements.create('expressCheckout', {
      // 'always' is the whole point: without it Apple Pay hides itself in Chrome,
      // Edge and Firefox. With it, those browsers offer the QR code that hands
      // the payment to the customer's iPhone. Safari and iOS are untouched — the
      // same button gives them the ordinary Apple Pay sheet, and a device with no
      // Apple Pay at all just gets Google Pay instead.
      paymentMethods: { applePay: 'always' },
      // Two across, the way storefronts lay a wallet row out. Stripe sizes to
      // what the browser actually offers, so a single wallet fills the width on
      // its own rather than leaving half the row empty.
      layout: { maxColumns: 2 },
      emailRequired: true,
      shippingAddressRequired: true,
      allowedShippingCountries: ['US'],
      shippingRates: [{ id: 'standard', displayName: 'Free Shipping', amount: 0, deliveryEstimate: DELIVERY_ESTIMATE }],
      buttonType: { applePay: 'buy', googlePay: 'buy' },
      buttonTheme: { applePay: buttonTheme(), googlePay: buttonTheme() },
      buttonHeight: 48,
    });

    // No wallet in this browser → the caller leaves its row hidden and the card
    // form stands alone, exactly as canMakePayment() decides for the older button.
    element.on('ready', function (ev) {
      if (opts.onReady) opts.onReady(!!(ev && ev.availablePaymentMethods));
    });

    // Sheet dismissed: put the amount back, or re-opening it would still carry
    // the tax and shipping of the address they walked away from.
    element.on('cancel', function () { setAmount(baseCents); });

    element.on('shippingaddresschange', function (ev) {
      // Browsers redact the address until the payment is confirmed — city, state
      // and ZIP are all that arrive here, which is all tax and shipping need.
      var addr = ev.address || {};
      var state = addr.state || '';
      var zip = addr.postal_code || '';
      var cart = items();
      post('/api/shippo-rates', {
        items: cart,
        totalWeightLb: cart.reduce(function (s, i) {
          return s + ((parseFloat(i.weightLb) || 0.5) * (i.quantity || 1));
        }, 0),
        address: { name: '', line1: '', city: addr.city || '', state: state, zip: zip, country: addr.country || 'US' },
      }).then(function (data) {
        if (data && data.rates && data.rates.length) selectedRate = pickRate(data.rates) || data.rates[0];
        var ship = shipping();
        taxCents = window.ZWCheckoutTax ? window.ZWCheckoutTax.taxCents(subtotalCents, state, zip) : 0;
        setAmount(subtotalCents + taxCents + ship.cents);
        ev.resolve({
          lineItems: lineItems(),
          shippingRates: [{ id: 'standard', displayName: ship.label, amount: ship.cents, deliveryEstimate: DELIVERY_ESTIMATE }],
        });
      })['catch'](function () { ev.reject(); });
    });

    // Only one rate is ever offered, so there is no amount to recalculate — but
    // the event still has to be answered or the sheet sits there spinning.
    element.on('shippingratechange', function (ev) { ev.resolve({ lineItems: lineItems() }); });

    element.on('confirm', function (ev) {
      function fail(message, reason) {
        ev.paymentFailed({ reason: reason || 'fail' });
        if (message && opts.onError) opts.onError(message);
      }

      var ship = ev.shippingAddress || {};
      var addr = ship.address || {};
      var bill = ev.billingDetails || {};
      var email = bill.email || '';

      Promise.resolve(opts.getAccessToken ? opts.getAccessToken() : '')
        .then(function (accessToken) {
          return post('/api/create-payment-intent', {
            items: items(),
            shippingRate: selectedRate,
            promoCode: (opts.getPromoCode && opts.getPromoCode()) || '',
            accessToken: accessToken || '',
            address: {
              name: ship.name || bill.name || '', email: email,
              line1: addr.line1 || '', line2: addr.line2 || '',
              city: addr.city || '', state: addr.state || '',
              zip: addr.postal_code || '', country: addr.country || 'US',
            },
          });
        })
        .then(function (pi) {
          if (!pi || pi.error) { fail((pi && pi.error) || 'Could not start the payment.'); return; }

          // Stripe refuses to confirm when the PaymentIntent's amount and the
          // amount this Elements group carries disagree — and the server is the
          // one that decides the real total: catalog prices, promo, tax,
          // shipping. Take its number. It has to happen before submit(), which
          // freezes the group.
          var serverCents = Math.round(parseFloat(pi.total) * 100);
          if (isFinite(serverCents) && serverCents > 0) setAmount(serverCents);

          return elements.submit().then(function (res) {
            if (res && res.error) { fail(res.error.message); return; }
            return stripe.confirmPayment({
              elements: elements,
              clientSecret: pi.clientSecret,
              // Card wallets settle in place. This only matters if a card is ever
              // sent off for 3DS, and the webhook records the order either way.
              confirmParams: { return_url: opts.returnUrl || (window.location.origin + '/checkout.html') },
              redirect: 'if_required',
            }).then(function (out) {
              if (out.error) { fail(out.error.message); return; }
              var intent = out.paymentIntent;
              var ok = ['succeeded', 'processing', 'requires_capture'];
              if (!intent || ok.indexOf(intent.status) === -1) {
                fail('Payment is ' + ((intent && intent.status) || 'incomplete') + '. Please try again.');
                return;
              }
              if (opts.onSuccess) {
                opts.onSuccess({ orderNumber: pi.orderNumber, email: email, paymentIntentId: intent.id || '' });
              }
            });
          });
        })['catch'](function (err) {
          console.error('Express wallet error:', err);
          fail('Something went wrong completing the payment. Please try again.');
        });
    });

    element.mount(opts.container);

    return {
      update: function (cents) {
        subtotalCents = Math.max(50, cents | 0);
        baseCents = subtotalCents;
        setAmount(subtotalCents);
      },
    };
  }

  window.ZWExpressWallet = { enabled: enabled, mount: mount };
})();
