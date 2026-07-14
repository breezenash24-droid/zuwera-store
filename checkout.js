let stripe, elements, cardElement;
let stripeInitPromise;

function getStripeCardTheme() {
  const isLight = document.body.classList.contains('light-mode');
  return {
    text: isLight ? '#09090b' : '#f5f5f0',
    placeholder: isLight ? 'rgba(9,9,11,0.58)' : 'rgba(245,245,240,0.38)',
    invalid: '#c0392b',
  };
}

function getStripeCardStyle() {
  const theme = getStripeCardTheme();
  return {
    base: {
      color: theme.text,
      iconColor: theme.text,
      fontFamily: '"DM Sans", sans-serif',
      fontSmoothing: 'antialiased',
      fontSize: '16px',
      fontWeight: '500',
      '::placeholder': { color: theme.placeholder },
    },
    invalid: { color: theme.invalid, iconColor: theme.invalid },
  };
}

function refreshStripeCardTheme() {
  if (cardElement?.update) {
    cardElement.update({ style: getStripeCardStyle() });
  }
}

async function getCheckoutPublishableKey() {
  if (window.zwGetStripePublishableKey) return window.zwGetStripePublishableKey();
  const resp = await fetch('/api/stripe-config', { headers: { Accept: 'application/json' } });
  const data = await resp.json();
  if (!resp.ok || !data?.publishableKey) throw new Error(data?.error || 'Unable to load Stripe configuration.');
  return data.publishableKey;
}

function cardStyleForMode(light) {
  return {
    base: {
      color: light ? '#09090b' : '#f5f5f0',
      iconColor: light ? '#09090b' : '#f5f5f0',
      fontFamily: '"DM Sans", sans-serif',
      fontSmoothing: 'antialiased',
      fontSize: '16px',
      fontWeight: '500',
      '::placeholder': { color: light ? 'rgba(9,9,11,0.58)' : 'rgba(245,245,240,0.38)' },
    },
    invalid: { color: '#c0392b', iconColor: '#c0392b' },
  };
}

function isLightMode() {
  if (document.body.classList.contains('light-mode')) return true;
  // storefront-theme.js stores the resolved mode here
  try { return localStorage.getItem('zw_theme_mode') === 'light'; } catch (_) { return false; }
}

function mountCard(light) {
  // Destroy any existing card element first — cardElement.update() does not
  // reliably re-render base.color after creation (Stripe limitation).
  if (cardElement) {
    try { cardElement.destroy(); } catch (_) {}
    cardElement = null;
  }
  const container = document.getElementById('stripe-card-element');
  if (container) container.innerHTML = '';
  const useLightColors = (light !== undefined) ? Boolean(light) : isLightMode();
  cardElement = elements.create('card', { style: cardStyleForMode(useLightColors) });
  cardElement.mount('#stripe-card-element');
}

// Called from the checkout button with the explicit current mode —
// no async detection, no race condition.
window.refreshCardStyle = function(light) {
  if (elements) mountCard(light);
};

async function initStripe() {
  if (stripe) return stripe;
  if (stripeInitPromise) return stripeInitPromise;
  stripeInitPromise = (async () => {
    if (typeof Stripe === 'undefined') throw new Error('Stripe.js is not loaded.');
    const publishableKey = await getCheckoutPublishableKey();
    stripe = Stripe(publishableKey);
    elements = stripe.elements();
    mountCard();
    return stripe;
  })().catch((error) => {
    stripeInitPromise = null;
    throw error;
  });
  return stripeInitPromise;
}

document.addEventListener('DOMContentLoaded', () => {
  initStripe()
    .then(() => {
      // The inline wallet init runs before Stripe is ready and no-ops; sync
      // here once stripe exists so the Apple Pay / Google Pay button actually
      // initializes — with the current promo-discounted total.
      if (typeof window.zwSyncWalletTotal === 'function') window.zwSyncWalletTotal();
    })
    .catch((error) => console.error('Stripe init failed:', error));
  refreshStripeCardTheme();
});

window.addEventListener('zw-theme-applied', refreshStripeCardTheme);

// ===================== HELPERS =====================

// Single reusable fetch helper
async function postJSON(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function getCheckoutAuthPayload() {
  const sb = window.sb || window._sb || null;
  if (!sb?.auth?.getSession) return { accessToken: '' };
  const result = await sb.auth.getSession().catch(() => null);
  const session = result?.data?.session || null;
  return {
    accessToken: session?.access_token || '',
  };
}

// ===================== LIVE CATALOG REPRICE =====================
// Cart items snapshot their price at add-to-bag time, so an admin price change
// left stale numbers in already-filled bags. Display-only inconsistency — the
// server always re-prices from the catalog at payment time — but the bag and
// the charge could disagree. On page load, pull the CURRENT catalog prices for
// everything in the cart, update the stored cart, and re-render whichever page
// (bag or checkout) we're on. Fails soft: any error leaves the cart untouched.
(function refreshCartCatalogPrices() {
  const SB_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
  const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

  function isLoggedIn() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        if (/^sb-.*-auth-token$/.test(localStorage.key(i))) return true;
      }
    } catch (_) {}
    return false;
  }

  async function run() {
    let cart;
    try { cart = JSON.parse(localStorage.getItem('cart') || '[]'); } catch (_) { return; }
    if (!Array.isArray(cart) || !cart.length) return;

    const ids = [...new Set(cart.map((i) => String(i.productId || '').trim())
      .filter((v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)))];
    const skus = [...new Set(cart.map((i) => String(i.sku || '').trim())
      .filter((v) => v && /^[\w-]+$/.test(v)))];
    if (!ids.length && !skus.length) return;

    const H = { apikey: SB_ANON, Authorization: 'Bearer ' + SB_ANON };
    const sel = 'select=id,sku,current_price,member_price';   // products has no bare `price` column
    const fetches = [];
    if (ids.length)  fetches.push(fetch(`${SB_URL}/rest/v1/products?${sel}&id=in.(${ids.join(',')})`, { headers: H }).then((r) => r.ok ? r.json() : []).catch(() => []));
    if (skus.length) fetches.push(fetch(`${SB_URL}/rest/v1/products?${sel}&sku=in.(${skus.join(',')})`, { headers: H }).then((r) => r.ok ? r.json() : []).catch(() => []));
    const rows = (await Promise.all(fetches)).flat();
    if (!rows.length) return;

    const byId  = new Map(rows.map((p) => [String(p.id), p]));
    const bySku = new Map(rows.filter((p) => p.sku).map((p) => [String(p.sku), p]));
    const member = isLoggedIn();

    let changed = false;
    for (const item of cart) {
      const p = byId.get(String(item.productId || '')) || bySku.get(String(item.sku || ''));
      if (!p) continue;   // product deleted — server rejects it at payment; leave display as-is
      const regular = parseFloat(p.current_price);
      const memberPrice = parseFloat(p.member_price);
      if (!(regular > 0)) continue;
      const next = (member && memberPrice > 0 && memberPrice < regular) ? memberPrice : regular;
      if (parseFloat(item.regularPrice) !== regular) { item.regularPrice = regular; changed = true; }
      if (memberPrice > 0 && parseFloat(item.memberPrice) !== memberPrice) { item.memberPrice = memberPrice; changed = true; }
      if (parseFloat(item.price) !== next) { item.price = String(next); changed = true; }
    }
    if (!changed) return;

    try { localStorage.setItem('cart', JSON.stringify(cart)); } catch (_) {}
    // Sync the in-memory array the pages render from (same objects the payment
    // call sends — mutate matching entries, don't swap the array).
    if (Array.isArray(window.cartItems)) {
      window.cartItems.forEach((it) => {
        const src = cart.find((c) =>
          String(c.productId || '') === String(it.productId || '') &&
          String(c.size || '') === String(it.size || '') &&
          String(c.colorName || '') === String(it.colorName || ''));
        if (src) { it.price = src.price; it.regularPrice = src.regularPrice; it.memberPrice = src.memberPrice; }
      });
    }
    // Re-render whichever page hosts us + downstream totals.
    try { if (typeof renderCart === 'function') renderCart(); } catch (_) {}
    try { if (typeof window._zwRenderCheckoutSummary === 'function') window._zwRenderCheckoutSummary(); } catch (_) {}
    try { if (typeof refreshTaxDisplay === 'function') refreshTaxDisplay(); } catch (_) {}
    try { if (typeof window.zwPromoUpdateSummaryTotals === 'function') window.zwPromoUpdateSummaryTotals(); } catch (_) {}
    try { if (typeof window.zwSyncWalletTotal === 'function') window.zwSyncWalletTotal(); } catch (_) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { run().catch(() => {}); });
  else run().catch(() => {});
})();

// ── Cache payment DOM refs once ───────────────────────────────────
const _pay = {
  errEl:     document.getElementById('pay-error'),
  btnTxt:    document.getElementById('pay-btn-text'),
  btn:       document.getElementById('pay-submit'),
  zipInput:  document.getElementById('pay-zip'),
  stateInput: document.getElementById('pay-state'),
  ratesField:   document.getElementById('shipping-rates-field'),
  ratesLoading: document.getElementById('shipping-rates-loading'),
  ratesList:    document.getElementById('shipping-rates-list'),
  shippingEl:   document.getElementById('summary-shipping'),
  totalEl:      document.getElementById('summary-total'),
  taxEl:        document.getElementById('summary-tax'),
  prBtn:        document.getElementById('payment-request-btn'),
  divider:      document.getElementById('pay-divider'),
};

// ===================== APPLE PAY / GOOGLE PAY =====================
let paymentRequest    = null;
let prButtonEl        = null;
let selectedShippingRate = null;
let prTaxCents = 0;
// Current sheet subtotal (after any promo discount). The shipping/tax event
// handlers read this instead of closing over initPaymentRequest's argument,
// so promo changes after init are reflected when the sheet recalculates.
let prSubtotalCents = 0;

function initPaymentRequest(subtotalCents) {
  if (!stripe) return;
  prSubtotalCents = subtotalCents;
  // If a paymentRequest already exists (user opened checkout a second time,
  // or a promo was applied/removed), update the amount instead of creating a
  // duplicate button.
  if (paymentRequest) {
    paymentRequest.update({
      total: { label: 'Zuwera', amount: subtotalCents, pending: true },
    });
    return;
  }

  paymentRequest = stripe.paymentRequest({
    country: 'US',
    currency: 'usd',
    total: { label: 'Zuwera', amount: subtotalCents, pending: true },
    requestPayerName: true,
    requestPayerEmail: true,
    requestShipping: true,
    shippingOptions: [],
  });

  paymentRequest.on('shippingaddresschange', async (ev) => {
    const addr = ev.shippingAddress;
    try {
      const data = await postJSON('/api/shippo-rates', {
        items: cartItems,
        totalWeightLb: cartItems.reduce((s, i) => s + ((parseFloat(i.weightLb) || 0.5) * (i.quantity || 1)), 0),
        address: {
          name: '',
          line1: addr.addressLine?.[0] || '',
          city: addr.city, state: addr.region,
          zip: addr.postalCode, country: addr.country,
        },
      });
      // Silently store the curated rate for fulfillment — customer pays $0
      // shipping. (Not raw rates[0]: that can be a restricted service.)
      if (data.rates?.length) selectedShippingRate = pickShippingRate(data.rates) || data.rates[0];
      prTaxCents = window.ZWCheckoutTax ? window.ZWCheckoutTax.taxCents(prSubtotalCents, addr.region || '', addr.postalCode || '') : 0;
      ev.updateWith({
        status: 'success',
        shippingOptions: [{ id: 'free', label: 'Free Shipping', detail: 'Standard delivery', amount: 0 }],
        total: { label: 'Zuwera', amount: prSubtotalCents + prTaxCents },
      });
    } catch { ev.updateWith({ status: 'fail' }); }
  });

  paymentRequest.on('shippingoptionchange', (ev) => {
    // Shipping is always free — total never includes a shipping cost.
    ev.updateWith({
      status: 'success',
      total: { label: 'Zuwera', amount: prSubtotalCents + prTaxCents },
    });
  });

  paymentRequest.on('paymentmethod', async (ev) => {
    try {
      const addr = ev.shippingAddress || {};
      const auth = await getCheckoutAuthPayload();
      const piData = await postJSON('/api/create-payment-intent', {
        items: cartItems,
        shippingRate: selectedShippingRate,
        promoCode: window.zwGetActivePromoCode?.() || '',
        accessToken: auth.accessToken,
        address: {
          name: ev.payerName || '', email: ev.payerEmail || '',
          line1: addr.addressLine?.[0] || '', line2: addr.addressLine?.[1] || '',
          city: addr.city || '', state: addr.region || '',
          zip: addr.postalCode || '', country: addr.country || 'US',
        },
      });
      if (piData.error) { ev.complete('fail'); return; }
      const initialResult = await stripe.confirmCardPayment(
        piData.clientSecret,
        { payment_method: ev.paymentMethod.id },
        { handleActions: false }
      );
      if (initialResult.error) {
        ev.complete('fail');
        _pay.errEl.textContent = initialResult.error.message;
        return;
      }

      let finalIntent = initialResult.paymentIntent;
      if (finalIntent?.status === 'requires_action') {
        const actionResult = await stripe.confirmCardPayment(piData.clientSecret);
        if (actionResult.error) {
          ev.complete('fail');
          _pay.errEl.textContent = actionResult.error.message;
          return;
        }
        finalIntent = actionResult.paymentIntent;
      }

      const successStatuses = ['succeeded', 'processing', 'requires_capture'];
      if (!finalIntent || !successStatuses.includes(finalIntent.status)) {
        ev.complete('fail');
        _pay.errEl.textContent = `Payment is ${finalIntent?.status || 'incomplete'}. Please try again.`;
        return;
      }

      ev.complete('success');
      showOrderConfirmed(piData.orderNumber, ev.payerEmail);
    } catch (err) {
      ev.complete('fail');
      console.error('Payment request error:', err);
    }
  });

  prButtonEl = elements.create('paymentRequestButton', {
    paymentRequest,
    style: { paymentRequestButton: { type: 'buy', theme: 'light', height: '48px' } },
  });
  paymentRequest.canMakePayment().then(result => {
    if (result) {
      prButtonEl.mount('#payment-request-btn');
      _pay.prBtn.style.display  = 'block';
      _pay.divider.style.display = 'block';
    }
  }).catch(err => console.warn('Apple/Google Pay unavailable:', err));
}

// ===================== LIVE SHIPPING RATES =====================
let ratesFetchTimeout = null;
let ratesFetchPromise = null;

async function doFetchRates(zip, state) {
  const totalWeightLb = cartItems.reduce((s, i) => s + ((parseFloat(i.weightLb) || 0.5) * (i.quantity || 1)), 0);
  const data = await postJSON('/api/shippo-rates', {
    items: cartItems,
    totalWeightLb,
    address: {
      name:  document.getElementById('pay-name').value.trim(),
      line1: document.getElementById('pay-addr1').value.trim(),
      city:  document.getElementById('pay-city').value.trim(),
      state, zip, country: 'US',
    },
  });
  const subtotal = cartItems.reduce((s, i) => s + parseFloat(i.price) * i.quantity, 0);
  const policy   = window._shippingPolicy || { enabled: true, threshold: 100, standardRate: 8 };
  const qualifiesFree = policy.enabled && subtotal >= policy.threshold;

  if (data.rates?.length) {
    // Keep the rate stored even during hand-delivery (harmless — the server
    // ignores it for eligible hand-delivery orders, and it's ready if the
    // shopper switches back to mail). Use the curated pick, NOT raw rates[0]
    // — the raw cheapest can be a restricted service (Media Mail).
    selectedShippingRate = pickShippingRate(data.rates) || data.rates[0];
  } else if (data.error) {
    console.error('Shippo rates error:', data.error);
  }

  // RACE GUARD: this fetch was debounced ~600ms + network, so the shopper may
  // have picked "Campus hand-delivery — Free" while it was in flight. A late
  // resolution must never overwrite the $0 summary with a mail rate (it made
  // hand-delivery orders DISPLAY a shipping charge).
  if (_deliveryMethod === 'hand_delivery') { updateCartSummaryShipping(0); return; }

  if (data.rates?.length) {
    // A picker appears ONLY when the admin pinned multiple services (the
    // server flags that with pinned:true). Auto/cheapest mode and single pins
    // stay a silent single option. Free-shipping orders never show it — the
    // customer pays $0 either way, and an open picker would let them choose an
    // expensive express label the store eats.
    const usableRates = usableShippingRates(data.rates);
    if (data.pinned && usableRates.length > 1 && !qualifiesFree) {
      // Default = the first pinned option (admin's order), matching the
      // pre-checked radio — not the USPS-first pick used in silent mode.
      selectedShippingRate = usableRates[0];
      renderPinnedRateChoices(usableRates);
    } else if (_pay.ratesField) {
      _pay.ratesField.style.display = 'none';
    }
    updateCartSummaryShipping(qualifiesFree ? 0 : parseFloat(selectedShippingRate.amount));
  } else if (!qualifiesFree) {
    // Show standard fallback rate so the customer knows what they'll pay
    updateCartSummaryShipping(policy.standardRate || 8);
  }
}

// ── Shipping options ───────────────────────────────────────────────
// The admin Shipping page decides what checkout offers
// (site_settings.shipping_preferred_service, enforced server-side): automatic
// cheapest (single, silent), one pinned service (single, silent), or several
// pinned services (radio choice, first = default). The restricted-service
// exclusion stays as belt-and-suspenders: apparel can't ship on printed-matter
// services, and "tender to carrier" rates need a facility drop-off.
function usableShippingRates(rates) {
  return (rates || []).filter((r) => !/media mail|bound printed|library mail|tender to/i.test(String(r.servicelevel || '')));
}
function pickShippingRate(rates) {
  const usable = usableShippingRates(rates);
  const usps = usable.filter((r) => String(r.provider || '').toUpperCase() === 'USPS');
  const pool = usps.length ? usps : usable;  // safety: never lose checkout if USPS is missing
  return pool[0] || null;                    // server sorts USPS-first, then cheapest
}
function _escRate(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function renderPinnedRateChoices(options) {
  if (!_pay.ratesField || !_pay.ratesList) return;
  _pay.ratesList.innerHTML = options.map((r, i) => {
    // ETA only when the provider returned one (Veeqo quotes often don't).
    const eta = r.days ? ` · ${Number(r.days) === 1 ? 'next day' : r.days + ' days'}` : '';
    const carrier = String(r.provider || '');
    let service = String(r.servicelevel || 'Shipping');
    if (!service.toUpperCase().startsWith(carrier.toUpperCase())) service = (carrier + ' ' + service).trim();
    return `
      <label class="zw-rate-opt" style="display:flex;align-items:center;gap:.6rem;padding:.62rem .8rem;border:1px solid rgba(128,128,128,.35);cursor:pointer;font-size:.85rem;${i > 0 ? 'border-top:none;' : ''}">
        <input type="radio" name="shipping-rate-choice" value="${i}" ${i === 0 ? 'checked' : ''} style="margin:0;flex-shrink:0;">
        <span style="flex:1;min-width:0;">${_escRate(service)}<span style="opacity:.55;">${eta}</span></span>
        <span style="font-weight:700;white-space:nowrap;">$${parseFloat(r.amount).toFixed(2)}</span>
      </label>`;
  }).join('');
  _pay.ratesField.style.display = 'block';

  _pay.ratesList.querySelectorAll('input[name="shipping-rate-choice"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const rate = options[parseInt(radio.value, 10)];
      if (!rate) return;
      selectedShippingRate = rate;
      if (_deliveryMethod !== 'hand_delivery') updateCartSummaryShipping(parseFloat(rate.amount));
    });
  });
}

// 'ship' (mail, default) or 'hand_delivery' (free in-person campus delivery).
let _deliveryMethod = 'ship';
window.zwDeliveryMethod = () => _deliveryMethod;

function maybeLoadRates() {
  // Hand-delivery is free and needs no shipping rate — never fetch/overwrite it.
  if (_deliveryMethod === 'hand_delivery') { updateCartSummaryShipping(0); return; }
  const zip   = (_pay.zipInput?.value   || '').trim();
  const state = (_pay.stateInput?.value || '').trim();
  if (zip.length < 5 || state.length < 2) return;

  clearTimeout(ratesFetchTimeout);
  ratesFetchTimeout = setTimeout(() => {
    if (_pay.ratesField)   _pay.ratesField.style.display   = 'none';
    // No loading text — the rate fetch is sub-second; just show nothing until it resolves.
    ratesFetchPromise = doFetchRates(zip, state).catch(err => {
      console.error('Rate fetch error:', err);
      // Same race guard as the success path: never overwrite a hand-delivery $0.
      if (_deliveryMethod === 'hand_delivery') { updateCartSummaryShipping(0); return; }
      // Show fallback rate so user isn't stuck with no shipping option
      const fallback = (window._shippingPolicy?.standardRate) || 8;
      updateCartSummaryShipping(fallback);
      // Write into the inner list, NOT the field — replacing the field's HTML
      // would destroy the #shipping-rates-list node the picker renders into.
      if (_pay.ratesField && _pay.ratesList) {
        _pay.ratesField.style.display = 'block';
        _pay.ratesList.innerHTML = `<p style="font-size:.78rem;color:rgba(244,241,235,.5);margin:.4rem 0">Standard shipping: $${fallback.toFixed(2)}</p>`;
      }
    }).finally(() => {
      if (_pay.ratesLoading) _pay.ratesLoading.style.display = 'none';
      ratesFetchPromise = null;
    });
  }, 600);
}

function updateCartSummaryShipping(amount) {
  const dollarAmt = Number(amount) || 0;
  const shippingText = dollarAmt > 0 ? `$${dollarAmt.toFixed(2)}` : 'Free';
  if (_pay.shippingEl) {
    _pay.shippingEl.textContent = shippingText;
    _pay.shippingEl.classList.remove('dash');
  }
  if (_pay.totalEl) {
    const parse = el => parseFloat(el?.textContent?.replace(/[^0-9.]/g, '') || '0');
    _pay.totalEl.textContent = `$${(parse(document.getElementById('pm-subtotal')) + parse(_pay.taxEl) + dollarAmt).toFixed(2)}`;
    _pay.totalEl.classList.remove('dash');
  }
  // Keep payment modal summary in sync
  const pmShipping = document.getElementById('pm-shipping');
  const pmTotal    = document.getElementById('pm-total');
  const pmToggle   = document.getElementById('pm-toggle-total');
  if (pmShipping) pmShipping.textContent = shippingText;
  if (pmTotal || pmToggle) {
    const parse = el => parseFloat(el?.textContent?.replace(/[^0-9.]/g, '') || '0');
    const tot = `$${(parse(document.getElementById('pm-subtotal')) + parse(document.getElementById('pm-tax')) + dollarAmt).toFixed(2)}`;
    if (pmTotal)  pmTotal.textContent  = tot;
    if (pmToggle) pmToggle.textContent = tot;
  }
}

function refreshTaxDisplay() {
  if (!window.ZWCheckoutTax) return;
  const parse = el => parseFloat(el?.textContent?.replace(/[^0-9.]/g, '') || '0');
  const subtotal = parse(document.getElementById('pm-subtotal'));
  if (!subtotal) return;
  const state = (_pay.stateInput?.value || '').trim().toUpperCase().slice(0, 2);
  const zip   = (_pay.zipInput?.value   || '').trim();
  const tax = window.ZWCheckoutTax.taxDollars(subtotal, state, zip);
  const total = subtotal + tax;

  // Update cart sidebar elements (kept in sync even though hidden behind modal)
  if (_pay.taxEl) _pay.taxEl.textContent = tax > 0 ? `$${tax.toFixed(2)}` : (state ? '$0.00' : '—');
  if (_pay.totalEl) _pay.totalEl.textContent = `$${total.toFixed(2)}`;

  // Update payment modal order summary panel
  const pmTax        = document.getElementById('pm-tax');
  const pmTaxLbl     = document.getElementById('pm-tax-label');
  const pmTotal      = document.getElementById('pm-total');
  const pmToggleTot  = document.getElementById('pm-toggle-total');
  const pmSubtotal   = document.getElementById('pm-subtotal');
  if (pmSubtotal)   pmSubtotal.textContent   = `$${subtotal.toFixed(2)}`;
  if (pmTax)        pmTax.textContent        = tax > 0 ? `$${tax.toFixed(2)}` : (state ? '$0.00' : '—');
  if (pmTaxLbl)     pmTaxLbl.textContent     = state && tax > 0 ? `Tax (${state})` : 'Tax';
  if (pmTotal)      pmTotal.textContent      = `$${total.toFixed(2)}`;
  if (pmToggleTot)  pmToggleTot.textContent  = `$${total.toFixed(2)}`;
}

_pay.zipInput?.addEventListener('input', () => { updateDeliveryOptions(); maybeLoadRates(); if ((_pay.zipInput?.value || '').length >= 5) refreshTaxDisplay(); });
_pay.stateInput?.addEventListener('input', () => { maybeLoadRates(); refreshTaxDisplay(); });

// ===================== CAMPUS HAND-DELIVERY =====================
// Reveal a free in-person delivery option when the ZIP is on the admin-managed
// allow-list (config comes from /api/commerce-config via commerce-checkout.js).
function _localDeliveryConfig() {
  try {
    const cfg = (typeof window.zwLocalDelivery === 'function') ? window.zwLocalDelivery() : null;
    return (cfg && typeof cfg === 'object') ? cfg : { enabled: false, zips: [] };
  } catch (_) { return { enabled: false, zips: [] }; }
}
function _zipEligibleForHandDelivery() {
  const cfg = _localDeliveryConfig();
  const zip = (_pay.zipInput?.value || '').trim().slice(0, 5);
  return !!(cfg.enabled && Array.isArray(cfg.zips) && cfg.zips.includes(zip));
}
function updateDeliveryOptions() {
  const field = document.getElementById('delivery-method-field');
  if (!field) return;
  const cfg = _localDeliveryConfig();
  if (!_zipEligibleForHandDelivery()) {
    field.style.display = 'none';
    if (_deliveryMethod === 'hand_delivery') {        // ZIP changed to an ineligible one
      _deliveryMethod = 'ship';
      const shipRadio = field.querySelector('input[value="ship"]');
      if (shipRadio) shipRadio.checked = true;
      _syncDeliverySelected();
      const note = document.getElementById('delivery-hand-note');
      if (note) note.style.display = 'none';
      maybeLoadRates();
    }
    return;
  }
  field.style.display = 'block';
  const lbl = document.getElementById('delivery-hand-label');
  if (lbl) lbl.textContent = (cfg.label || 'Campus hand-delivery') + ' — Free';
  _syncDeliverySelected();
}
function _syncDeliverySelected() {
  document.querySelectorAll('.co-delivery-opt').forEach((opt) => {
    const r = opt.querySelector('input[name="delivery-method"]');
    opt.classList.toggle('is-selected', !!(r && r.checked));
  });
}
function _onDeliveryMethodChange(e) {
  const val = e.target.value === 'hand_delivery' ? 'hand_delivery' : 'ship';
  _deliveryMethod = val;
  _syncDeliverySelected();
  const note = document.getElementById('delivery-hand-note');
  const cfg = _localDeliveryConfig();
  if (val === 'hand_delivery') {
    if (note) {
      note.textContent = cfg.instructions || "You'll be contacted to arrange a campus drop-off. No package will be mailed.";
      note.style.display = 'block';
    }
    if (_pay.ratesField) _pay.ratesField.style.display = 'none';  // no mail options needed
    updateCartSummaryShipping(0);                     // free
  } else {
    if (note) note.style.display = 'none';
    maybeLoadRates();                                 // recompute mail shipping
  }
}
document.querySelectorAll('input[name="delivery-method"]').forEach((r) => r.addEventListener('change', _onDeliveryMethodChange));
// Re-check once the commerce config has had time to load (covers autocompleted ZIPs).
setTimeout(updateDeliveryOptions, 1500);

// ===================== PAYMENT MODAL CLOSE =====================
document.getElementById('payment-close')?.addEventListener('click', () => {
  _closeModal('payment-modal');
  if (_pay.errEl) _pay.errEl.textContent = '';
});
document.getElementById('payment-modal')?.addEventListener('click', e => {
  if (e.target === e.currentTarget) _closeModal('payment-modal');
});

// ===================== PAY SUBMIT (CARD) =====================
_pay.btn?.addEventListener('click', async () => {
  const get   = id => (document.getElementById(id)?.value || '').trim();
  const name  = get('pay-name');
  const email = get('pay-email');
  const addr1 = get('pay-addr1');
  const addr2 = get('pay-addr2');
  const city  = get('pay-city');
  const state = (_pay.stateInput?.value || '').trim();
  const zip   = (_pay.zipInput?.value   || '').trim();

  if (_pay.errEl) _pay.errEl.textContent = '';
  if (!name || !email)                   { if (_pay.errEl) _pay.errEl.textContent = 'Please enter your name and email.'; return; }
  if (!addr1 || !city || !state || !zip) { if (_pay.errEl) _pay.errEl.textContent = 'Please enter your full shipping address.'; return; }

  _pay.btn.disabled = true;
  _pay.btnTxt.textContent = 'Processing…';

  try {
    // If the debounced rate fetch hasn't fired or finished yet, resolve it now
    // before creating the payment intent so the correct Shippo rate is used.
    if (!selectedShippingRate && zip.length >= 5 && state.length >= 2) {
      clearTimeout(ratesFetchTimeout);
      if (ratesFetchPromise) {
        await ratesFetchPromise;
      } else {
        try { await doFetchRates(zip, state); } catch (_) {}
      }
    }

    const auth = await getCheckoutAuthPayload();
    const piData = await postJSON('/api/create-payment-intent', {
      items: cartItems,
      shippingRate: selectedShippingRate,
      promoCode: window.zwGetActivePromoCode?.() || '',
      accessToken: auth.accessToken,
      address: { name, email, line1: addr1, line2: addr2, city, state, zip, country: 'US' },
    });
    if (piData.error) {
      _pay.errEl.textContent = piData.error;
      _pay.btn.disabled = false;
      _pay.btnTxt.textContent = 'Pay Now';
      return;
    }

    const { error, paymentIntent } = await stripe.confirmCardPayment(piData.clientSecret, {
      payment_method: { card: cardElement, billing_details: { name, email } },
      receipt_email: email,
      shipping: { name, address: { line1: addr1, line2: addr2, city, state, postal_code: zip, country: 'US' } },
    });
    if (error) {
      console.error('Stripe confirmCardPayment error:', error);
      _pay.errEl.textContent = error.message;
      _pay.btn.disabled = false;
      _pay.btnTxt.textContent = 'Pay Now';
      return;
    }

    showOrderConfirmed(piData.orderNumber, email);
  } catch (err) {
    _pay.errEl.textContent = 'Something went wrong. Please try again.';
    console.error('Checkout error:', err);
    _pay.btn.disabled = false;
    _pay.btnTxt.textContent = 'Pay Now';
  }
});

// ===================== ORDER CONFIRMED =====================
function showOrderConfirmed(orderNumber, email) {
  document.getElementById('success-order').textContent = orderNumber ? `Order #${orderNumber}` : '';
  document.getElementById('success-msg').textContent =
    `Thank you for your purchase. A confirmation has been sent to ${email || 'your email'}.`;
  _openModal('payment-success');

  const _purchaseTotal = cartItems.reduce((s, i) => s + (parseFloat(i.price) * i.quantity), 0);

  if (typeof gtag === 'function') {
    // Enhanced Conversions: hand the Google tag the customer email (unhashed —
    // the tag SHA-256 hashes it client-side before sending). Lifts Google Ads
    // match rates, the equivalent of Meta's CAPI advanced matching. Inert until
    // Enhanced Conversions is switched on in the Google Ads conversion settings.
    if (email) gtag('set', 'user_data', { email: email });
    gtag('event', 'purchase', {
      transaction_id: paymentIntentId,
      value: _purchaseTotal,
      currency: 'USD',
      items: cartItems.map(item => ({
        item_id: item.productId,
        item_name: item.title,
        price: item.price,
        quantity: item.quantity
      }))
    });
  }

  if (typeof zwTrack === 'function') {
    zwTrack('purchase_completed', {
      order_id:   paymentIntentId,
      value:      _purchaseTotal,
      currency:   'USD',
      item_count: cartItems.reduce((n, i) => n + i.quantity, 0),
      items:      cartItems.map(i => ({
        product_id:   i.productId,
        product_name: i.title,
        price:        i.price,
        quantity:     i.quantity,
        size:         i.size  || '',
      })),
    });
  }

  if (window.zwPixel) window.zwPixel.purchase(cartItems, _purchaseTotal, paymentIntentId);

  // Clear cart from storage and update header count
  cartItems = [];
  localStorage.removeItem('cart');
  const _bagCountEl = document.getElementById('co-bag-count');
  if (_bagCountEl) _bagCountEl.textContent = '0';
}

document.getElementById('success-continue')?.addEventListener('click', () => {
  window.location.href = '/';
});

// Countdown is handled by the inline script in index.html
// to avoid two intervals racing on the same DOM elements.

// ===================== DROP 001 NOTIFY =====================
async function homeNotifyMe() {
  const emailInput = document.getElementById('home-notify-email');
  const email = emailInput.value.trim();
  if (!email || !email.includes('@')) { emailInput.style.borderColor = '#e07060'; return; }
  emailInput.style.borderColor = '';
  if (_sb) {
    try { await _sb.from('waitlist').upsert({ email, source: 'drop001_home' }); }
    catch { /* silently ignore */ }
  }
  document.querySelector('.notify-form-inline').style.display = 'none';
  document.querySelector('.notify-note').style.display = 'none';
  document.getElementById('home-notify-success').style.display = 'block';
}

/* ── Abandoned-cart capture ──────────────────────────────────────────────────
   When the shopper enters their email at checkout, remember their email + cart so
   /api/abandoned-cart can trigger a recovery email if they don't complete. Purely
   additive + fire-and-forget — it never touches or blocks the payment flow. */
(function () {
  function attach() {
    var el = document.getElementById('pay-email');
    if (!el || el.dataset.zwAcHooked) return;
    el.dataset.zwAcHooked = '1';
    var last = '';
    el.addEventListener('blur', function () {
      var email = (el.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
      var cart; try { cart = JSON.parse(localStorage.getItem('cart') || '[]'); } catch (_) { cart = []; }
      if (!Array.isArray(cart) || !cart.length) return;
      var sig = email + '|' + cart.length;
      if (sig === last) return; last = sig;
      try {
        fetch('/api/abandoned-cart', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
          body: JSON.stringify({ email: email, cart: cart })
        }).catch(function () {});
      } catch (_) {}
    });
  }
  if (document.readyState !== 'loading') attach();
  else document.addEventListener('DOMContentLoaded', attach);
})();
