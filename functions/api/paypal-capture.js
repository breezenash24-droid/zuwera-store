/**
 * Cloudflare Pages Function: /api/paypal-capture
 *
 * The half that moves money.
 *
 * paypal-create-order builds an order the buyer can approve; this takes the
 * funds and hands the result to the same fulfilment the card route uses. They
 * are separate files on purpose, so the one that can charge somebody is read on
 * its own.
 *
 * ── WHAT IS TRUSTED ─────────────────────────────────────────────────────────
 *
 * Not the browser. It sends the cart again, and the cart is re-priced here from
 * the catalog exactly as it was at create time. Two numbers then have to agree
 * before anything is captured: what this store now says the order costs, and
 * what PayPal is actually holding an approval for. PayPal's figure is the
 * authoritative one — it is what the buyer saw and agreed to — and our figure
 * is what we are willing to fulfil.
 *
 * Disagreement means something changed between approval and capture: a price
 * edit, a promo expiring, a rate moving. The answer is to refuse BEFORE taking
 * the money. Capturing first and reconciling afterwards means a customer has
 * paid an amount nobody intended, and the fix is a refund they did not ask for.
 *
 * A sold-out size refuses here too, for the same reason: resolveCatalogItems
 * throws 409 and the buyer is not charged for something that cannot ship.
 *
 * ── DOING IT ONCE ───────────────────────────────────────────────────────────
 *
 * Two guards, because they fail differently:
 *
 *   PayPal-Request-Id on the capture call. A retried request returns the
 *   original capture rather than taking the money twice.
 *
 *   processed_events, keyed on the PayPal order id. The primary key IS the
 *   claim, so two requests racing cannot both fulfil — one inserts, the other
 *   gets a duplicate-key error and reads it as "someone else has this". The
 *   same table and the same reasoning as the Stripe webhook.
 *
 * And an order PayPal already reports as COMPLETED is answered as success, not
 * as an error. The buyer's money is taken and their order exists; showing them
 * a failure would invite them to pay again.
 */

import { json } from './_commerce.js';
import {
  buildOrderMetadata, cartError, quoteCart, sha256Base64Url,
} from './_cart-pricing.js';
import { paypalConfig, paypalFetch } from './_paypal.js';
import { handleSuccessfulPayment, getSupabaseServiceKey } from './_fulfil.js';

const CORS = (env) => ({
  'Access-Control-Allow-Origin': env.SITE_URL || 'https://zuwera.store',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
});

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: CORS(env) });
}

/* Cents from PayPal's decimal string. Parsing to a float and multiplying is how
   a $0.01 discrepancy appears out of nowhere, so this reads the digits. */
export function amountToCents(value) {
  const m = String(value ?? '').trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return NaN;
  const cents = Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0'));
  return m[1] === '-' ? -cents : cents;
}

/* ── Whether to take the money, as a decision on its own ─────────────────────
 * Pulled out of the request handler so it can be run rather than read. The
 * whole safety of this endpoint is one comparison happening before one network
 * call, and an assertion that only checks the comparison is PRESENT passes just
 * as happily when it has been disabled — which is exactly what the first
 * version of the test for this did.
 *
 *   no reference   PayPal is holding something this store did not create, or
 *                  created without an order number. Nothing to fulfil against.
 *   amount changed something moved between approval and capture. Refuse while
 *                  it is still free to refuse.
 *   already        PayPal says COMPLETED. The buyer has paid; answering with an
 *                  error would invite them to pay again.
 */
export function captureDecision({ orderNumber, approvedCents, quotedCents, paypalStatus }) {
  if (!orderNumber || !Number.isFinite(approvedCents)) {
    return { action: 'refuse', status: 409, reason: 'no-reference' };
  }
  if (quotedCents !== approvedCents) {
    return { action: 'refuse', status: 409, reason: 'amount-changed' };
  }
  if (String(paypalStatus || '').toUpperCase() === 'COMPLETED') {
    return { action: 'already', status: 200, reason: 'completed' };
  }
  return { action: 'capture' };
}

/* Claim this order before fulfilling it. Returns true if somebody else already
   has it. A table that is missing or unreachable means we cannot establish
   either way, and treating that as "already done" would silently drop real
   orders — a far worse failure than the duplicate it guards against. */
async function alreadyFulfilled(env, paypalOrderId) {
  const key = getSupabaseServiceKey(env);
  if (!env.SUPABASE_URL || !key || !paypalOrderId) return false;
  try {
    const res = await fetch(env.SUPABASE_URL + '/rest/v1/processed_events', {
      method: 'POST',
      headers: {
        apikey: key, Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({ event_id: 'paypal_' + paypalOrderId, event_type: 'paypal.capture' }),
    });
    if (res.ok) return false;
    if (res.status === 409) return true;
    console.warn('PayPal dedupe unavailable (' + res.status + ') — proceeding without it');
    return false;
  } catch (e) {
    console.warn('PayPal dedupe check failed (' + e.message + ') — proceeding without it');
    return false;
  }
}

export async function onRequestPost({ request, env, waitUntil }) {
  const headers = CORS(env);

  try {
    const cfg = paypalConfig(env);
    if (!cfg.configured) return json({ error: 'PayPal is not available.' }, 503, headers);

    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'Invalid request body.' }, 400, headers);

    const paypalOrderId = String(body.paypalOrderId || '').trim();
    const { items, address = {}, shippingRate, promoCode = '', deliveryMethod = '' } = body;
    if (!paypalOrderId) return json({ error: 'Missing paypalOrderId.' }, 400, headers);
    if (!items?.length || !address?.email) {
      return json({ error: 'Missing required fields: items and address.email' }, 400, headers);
    }

    /* What PayPal is holding, before anything is charged. Its amount is what
       the buyer approved, and its custom_id is the order number minted at
       create time — recovering that rather than generating a new one keeps one
       order number across both halves. */
    const look = await paypalFetch(env, '/v2/checkout/orders/' + encodeURIComponent(paypalOrderId));
    if (!look.ok || !look.data) {
      return json({ error: 'That payment could not be found. Please try again.' }, 404, headers);
    }
    const unit = look.data.purchase_units?.[0] || {};
    const orderNumber = String(unit.custom_id || '').trim();
    const approvedCents = amountToCents(unit.amount?.value);

    /* Re-price from the catalog. The browser's numbers are ignored here exactly
       as they are at create time, and a sold-out size throws 409 out of
       resolveCatalogItems before anybody is charged for it. */
    const quote = await quoteCart({
      waitUntil,
      items, address, shippingRate, promoCode, deliveryMethod,
      accessToken: body.accessToken || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, ''),
      env, request,
    });

    /* The gate. Refusing costs the buyer a retry; capturing a figure nobody
       intended costs them money and us a refund they never asked for. */
    const decision = captureDecision({
      orderNumber,
      approvedCents,
      quotedCents: quote.totalCents,
      paypalStatus: look.data.status,
    });

    if (decision.action === 'refuse') {
      if (decision.reason === 'amount-changed') {
        console.error('PayPal amount mismatch on', paypalOrderId,
          '— approved', approvedCents, 'now quotes', quote.totalCents);
        return json({
          error: 'The price of your order changed while you were paying. Nothing has been charged — please review your bag and try again.',
        }, decision.status, headers);
      }
      return json({ error: 'That payment is missing its order reference.' }, decision.status, headers);
    }

    /* Already done: answer as success. Their money is taken and the order
       exists; a failure here would invite them to pay a second time. */
    if (decision.action === 'already') {
      return json({ ok: true, orderNumber, alreadyCaptured: true }, decision.status, headers);
    }

    if (await alreadyFulfilled(env, paypalOrderId)) {
      return json({ ok: true, orderNumber, duplicate: true }, 200, headers);
    }

    const cap = await paypalFetch(env, '/v2/checkout/orders/' + encodeURIComponent(paypalOrderId) + '/capture', {
      method: 'POST',
      /* Derived from the order id, so a resubmitted capture is the same request
         to PayPal rather than a second one. */
      requestId: 'zwc_' + (await sha256Base64Url(paypalOrderId)).slice(0, 40),
      body: {},
    });

    if (!cap.ok) {
      /* A declined instrument is the buyer's to act on and is not a fault here;
         anything else is ours to read in the log. Either way no money moved, so
         the claim above has to go back or a retry with a working card would be
         refused as a duplicate. */
      await releaseClaim(env, paypalOrderId);
      const issue = cap.data?.details?.[0]?.issue || '';
      if (issue === 'INSTRUMENT_DECLINED') {
        return json({ error: 'That payment method was declined. Please choose another in the PayPal window.', retryable: true }, 402, headers);
      }
      console.error('PayPal capture failed for', paypalOrderId, cap.status, issue);
      return json({ error: 'PayPal could not complete that payment. Nothing has been charged.' }, 502, headers);
    }

    const capture = cap.data?.purchase_units?.[0]?.payments?.captures?.[0] || {};
    const capturedCents = amountToCents(capture.amount?.value);
    const captureId = String(capture.id || paypalOrderId);

    /* Money has moved. From here nothing may throw its way out — an order that
       is paid for and not recorded is the worst state available, so fulfilment
       failures are logged loudly and the buyer is still told they succeeded. */
    const meta = buildOrderMetadata({ orderNumber, address, quote, featureFlagsMeta: '' });
    meta.payment_provider = 'paypal';
    meta.paypal_capture_id = captureId;

    /* Shaped like a PaymentIntent because that is what fulfilment reads. Only
       id and amount are used; naming it plainly rather than calling it `pi`
       keeps it obvious that no Stripe object is involved. */
    const payment = {
      id: 'paypal_' + captureId,
      amount: Number.isFinite(capturedCents) ? capturedCents : quote.totalCents,
    };

    try {
      /* No tracking callback: there is no PaymentIntent to write the number
         back to. It still lands on the order row, which is where the customer's
         status page and the admin both read it. */
      await handleSuccessfulPayment(payment, meta, env, null);
    } catch (e) {
      console.error('PayPal order captured but fulfilment failed —', orderNumber, captureId, e);
    }

    return json({ ok: true, orderNumber, captureId }, 200, headers);
  } catch (e) {
    const status = Number.isInteger(e?.zwStatus) ? e.zwStatus : 500;
    console.error('paypal-capture error (' + status + '):', e);
    return json({ error: e.message || 'Could not complete that payment.' }, status, headers);
  }
}

/* Undo the claim when no money moved. Without this a declined card would leave
   the order id marked as handled, and the buyer's second attempt with a working
   card would be waved through as a duplicate — paid for, never fulfilled. */
async function releaseClaim(env, paypalOrderId) {
  const key = getSupabaseServiceKey(env);
  if (!env.SUPABASE_URL || !key) return;
  try {
    await fetch(env.SUPABASE_URL + '/rest/v1/processed_events?event_id=eq.'
      + encodeURIComponent('paypal_' + paypalOrderId), {
      method: 'DELETE',
      headers: { apikey: key, Authorization: 'Bearer ' + key },
    });
  } catch (e) {
    console.warn('Could not release PayPal claim for', paypalOrderId, e.message);
  }
}

export { cartError };
