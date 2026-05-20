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
  void initStripe().catch((error) => console.error('Stripe init failed:', error));
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

function initPaymentRequest(subtotalCents) {
  // If a paymentRequest already exists (user opened checkout a second time),
  // just update the amount instead of creating a duplicate button.
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
      // Silently store the cheapest rate for fulfillment — customer pays $0 shipping.
      if (data.rates?.length) selectedShippingRate = data.rates[0];
      prTaxCents = window.ZWCheckoutTax ? window.ZWCheckoutTax.taxCents(subtotalCents, addr.region || '') : 0;
      ev.updateWith({
        status: 'success',
        shippingOptions: [{ id: 'free', label: 'Free Shipping', detail: 'Standard delivery', amount: 0 }],
        total: { label: 'Zuwera', amount: subtotalCents + prTaxCents },
      });
    } catch { ev.updateWith({ status: 'fail' }); }
  });

  paymentRequest.on('shippingoptionchange', (ev) => {
    // Shipping is always free — total never includes a shipping cost.
    ev.updateWith({
      status: 'success',
      total: { label: 'Zuwera', amount: subtotalCents + prTaxCents },
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
      showOrderConfirmed(finalIntent.id || piData.orderId, ev.payerEmail);
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
  });
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
  if (data.rates?.length) {
    selectedShippingRate = data.rates[0];
  } else if (data.error) {
    console.error('Shippo rates error:', data.error);
  }
}

function maybeLoadRates() {
  const zip   = _pay.zipInput.value.trim();
  const state = _pay.stateInput.value.trim();
  if (zip.length < 5 || state.length < 2) return;

  clearTimeout(ratesFetchTimeout);
  ratesFetchTimeout = setTimeout(() => {
    _pay.ratesField.style.display   = 'none';
    _pay.ratesLoading.style.display = 'block';
    ratesFetchPromise = doFetchRates(zip, state).catch(err => {
      console.error('Rate fetch error:', err);
    }).finally(() => {
      _pay.ratesLoading.style.display = 'none';
      ratesFetchPromise = null;
    });
  }, 600);
}

function updateCartSummaryShipping(amount) {
  // Shipping is always free to the customer — amount is used for internal metadata only.
  if (_pay.shippingEl) {
    _pay.shippingEl.textContent = 'Free';
    _pay.shippingEl.classList.remove('dash');
  }
  if (_pay.totalEl) {
    const parse = el => parseFloat(el?.textContent?.replace(/[^0-9.]/g, '') || '0');
    _pay.totalEl.textContent = `$${(parse(_cart.subtotalEl) + parse(_pay.taxEl)).toFixed(2)}`;
    _pay.totalEl.classList.remove('dash');
  }
}

function refreshTaxDisplay() {
  if (!window.ZWCheckoutTax) return;
  const parse = el => parseFloat(el?.textContent?.replace(/[^0-9.]/g, '') || '0');
  const subtotal = parse(_cart.subtotalEl);
  if (!subtotal) return;
  const state = (_pay.stateInput?.value || '').trim().toUpperCase().slice(0, 2);
  const tax = window.ZWCheckoutTax.taxDollars(subtotal, state);
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

_pay.zipInput?.addEventListener('input', maybeLoadRates);
_pay.stateInput?.addEventListener('input', () => { maybeLoadRates(); refreshTaxDisplay(); });

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
  const get   = id => document.getElementById(id).value.trim();
  const name  = get('pay-name');
  const email = get('pay-email');
  const addr1 = get('pay-addr1');
  const addr2 = get('pay-addr2');
  const city  = get('pay-city');
  const state = _pay.stateInput.value.trim();
  const zip   = _pay.zipInput.value.trim();

  _pay.errEl.textContent = '';
  if (!name || !email)                   { _pay.errEl.textContent = 'Please enter your name and email.'; return; }
  if (!addr1 || !city || !state || !zip) { _pay.errEl.textContent = 'Please enter your full shipping address.'; return; }

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
      _pay.errEl.textContent = error.message;
      _pay.btn.disabled = false;
      _pay.btnTxt.textContent = 'Pay Now';
      return;
    }

    _closeModal('payment-modal');
    showOrderConfirmed(paymentIntent.id, email);
  } catch (err) {
    _pay.errEl.textContent = 'Something went wrong. Please try again.';
    console.error('Checkout error:', err);
    _pay.btn.disabled = false;
    _pay.btnTxt.textContent = 'Pay Now';
  }
});

// ===================== ORDER CONFIRMED =====================
function showOrderConfirmed(paymentIntentId, email) {
  const orderId = (paymentIntentId || '').slice(-8).toUpperCase();
  document.getElementById('success-order').textContent = orderId ? `Order #${orderId}` : '';
  document.getElementById('success-msg').textContent =
    `Thank you for your purchase. A confirmation has been sent to ${email || 'your email'}.`;
  _openModal('payment-success');

  const _purchaseTotal = cartItems.reduce((s, i) => s + (parseFloat(i.price) * i.quantity), 0);

  if (typeof gtag === 'function') {
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

  // Clear cart
  cartItems = [];
  _cart.itemsList.innerHTML = '';
  _cart.emptyMsg.style.display = 'block';
  if (_cart.cartCount) _cart.cartCount.textContent = '0';
}

document.getElementById('success-continue')?.addEventListener('click', () => {
  _closeModal('payment-success');
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
