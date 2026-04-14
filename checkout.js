// ===================== STRIPE SETUP =====================
// 🔑 Replace with your live publishable key from Stripe Dashboard
let stripe, elements, cardElement;

function initStripe() {
  if (typeof Stripe === 'undefined') return;
  stripe = Stripe('pk_live_51T8ct20oFp4PJGitDcNMSLu9jQMFajtwqib8dTX4WhubBon2Pso2VgkHhTHcbuKNUi9ljfwMX8Bx2uhEp1Fp2VfY00LFKvLEy4');
  elements = stripe.elements();
  cardElement = elements.create('card', {
    style: {
      base: {
        color: '#f5f5f0',
        fontFamily: '"DM Sans", sans-serif',
        fontSmoothing: 'antialiased',
        fontSize: '15px',
        '::placeholder': { color: 'rgba(245,245,240,0.3)' }
      },
      invalid: { color: '#e07060', iconColor: '#e07060' }
    }
  });
  cardElement.mount('#stripe-card-element');
}

document.addEventListener('DOMContentLoaded', initStripe);

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
        address: {
          name: '',
          line1: addr.addressLine?.[0] || '',
          city: addr.city, state: addr.region,
          zip: addr.postalCode, country: addr.country,
        },
      });
      if (!data.rates?.length) { ev.updateWith({ status: 'invalid_shipping_address' }); return; }
      const shippingOptions = data.rates.slice(0, 4).map(r => ({
        id: r.objectId,
        label: `${r.provider} ${r.servicelevel}`,
        detail: r.days ? `Est. ${r.days} business days` : '',
        amount: Math.round(parseFloat(r.amount) * 100),
      }));
      selectedShippingRate = data.rates[0];
      ev.updateWith({
        status: 'success', shippingOptions,
        total: { label: 'Zuwera', amount: subtotalCents + shippingOptions[0].amount },
      });
    } catch { ev.updateWith({ status: 'fail' }); }
  });

  paymentRequest.on('shippingoptionchange', (ev) => {
    ev.updateWith({
      status: 'success',
      total: { label: 'Zuwera', amount: subtotalCents + ev.shippingOption.amount },
    });
  });

  paymentRequest.on('paymentmethod', async (ev) => {
    try {
      const addr = ev.shippingAddress || {};
      const piData = await postJSON('/api/create-payment-intent', {
        items: cartItems,
        shippingRate: selectedShippingRate,
        address: {
          name: ev.payerName || '', email: ev.payerEmail || '',
          line1: addr.addressLine?.[0] || '', line2: addr.addressLine?.[1] || '',
          city: addr.city || '', state: addr.region || '',
          zip: addr.postalCode || '', country: addr.country || 'US',
        },
      });
      if (piData.error) { ev.complete('fail'); return; }
      const { error } = await stripe.confirmCardPayment(
        piData.clientSecret, { payment_method: ev.paymentMethod.id }, { handleActions: false }
      );
      if (error) {
        ev.complete('fail');
        _pay.errEl.textContent = error.message;
      } else {
        ev.complete('success');
        showOrderConfirmed(piData.orderId, ev.payerEmail);
      }
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

function maybeLoadRates() {
  const zip   = _pay.zipInput.value.trim();
  const state = _pay.stateInput.value.trim();
  if (zip.length < 5 || state.length < 2) return;

  clearTimeout(ratesFetchTimeout);
  ratesFetchTimeout = setTimeout(async () => {
    _pay.ratesField.style.display   = 'none';
    _pay.ratesLoading.style.display = 'block';
    try {
      const data = await postJSON('/api/shippo-rates', {
        address: {
          name:  document.getElementById('pay-name').value.trim(),
          line1: document.getElementById('pay-addr1').value.trim(),
          city:  document.getElementById('pay-city').value.trim(),
          state, zip, country: 'US',
        },
      });
      _pay.ratesLoading.style.display = 'none';
      if (!data.rates?.length) return;

      _pay.ratesList.innerHTML = '';
      data.rates.slice(0, 5).forEach((rate, i) => {
        const id    = `rate-${i}`;
        const label = document.createElement('label');
        label.className = 'rate-option' + (i === 0 ? ' selected' : '');
        label.htmlFor = id;
        label.innerHTML = `
          <input type="radio" name="shipping-rate" id="${id}" value="${i}"
            ${i === 0 ? 'checked' : ''} style="display:none;">
          <span class="rate-name">${rate.provider} ${rate.servicelevel}</span>
          <span class="rate-meta">${rate.days ? rate.days + ' business days' : ''}</span>
          <span class="rate-price">$${parseFloat(rate.amount).toFixed(2)}</span>
        `;
        label.addEventListener('click', () => {
          document.querySelectorAll('.rate-option').forEach(el => el.classList.remove('selected'));
          label.classList.add('selected');
          selectedShippingRate = rate;
          updateCartSummaryShipping(rate.amount);
        });
        _pay.ratesList.appendChild(label);
      });
      selectedShippingRate = data.rates[0];
      updateCartSummaryShipping(data.rates[0].amount);
      _pay.ratesField.style.display = 'block';
    } catch (err) {
      _pay.ratesLoading.style.display = 'none';
      console.error('Rate fetch error:', err);
    }
  }, 600);
}

function updateCartSummaryShipping(amount) {
  const parse = el => parseFloat(el?.textContent?.replace(/[^0-9.]/g, '') || '0');
  if (_pay.shippingEl) {
    _pay.shippingEl.textContent = `$${parseFloat(amount).toFixed(2)}`;
    _pay.shippingEl.classList.remove('dash');
  }
  if (_pay.totalEl) {
    _pay.totalEl.textContent = `$${(parse(_cart.subtotalEl) + parseFloat(amount) + parse(_pay.taxEl)).toFixed(2)}`;
    _pay.totalEl.classList.remove('dash');
  }
}

_pay.zipInput.addEventListener('input', maybeLoadRates);
_pay.stateInput.addEventListener('input', maybeLoadRates);

// ===================== PAYMENT MODAL CLOSE =====================
document.getElementById('payment-close').addEventListener('click', () => {
  _closeModal('payment-modal');
  _pay.errEl.textContent = '';
});
document.getElementById('payment-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) _closeModal('payment-modal');
});

// ===================== PAY SUBMIT (CARD) =====================
_pay.btn.addEventListener('click', async () => {
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
  if (!selectedShippingRate)             { _pay.errEl.textContent = 'Please enter your ZIP code to load shipping options.'; return; }

  _pay.btn.disabled = true;
  _pay.btnTxt.textContent = 'Processing…';

  try {
    const piData = await postJSON('/api/create-payment-intent', {
      items: cartItems, shippingRate: selectedShippingRate,
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

  if (typeof gtag === 'function') {
    const totalValue = cartItems.reduce((sum, item) => sum + (parseFloat(item.price) * item.quantity), 0);
    gtag('event', 'purchase', {
      transaction_id: paymentIntentId,
      value: totalValue,
      currency: 'USD',
      items: cartItems.map(item => ({
        item_id: item.productId,
        item_name: item.title,
        price: item.price,
        quantity: item.quantity
      }))
    });
  }

  // Clear cart
  cartItems = [];
  _cart.itemsList.innerHTML = '';
  _cart.emptyMsg.style.display = 'block';
  if (_cart.cartCount) _cart.cartCount.textContent = '0';
}

document.getElementById('success-continue').addEventListener('click', () => {
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
