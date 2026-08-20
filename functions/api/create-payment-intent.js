/**
 * Cloudflare Pages Function: /api/create-payment-intent
 *
 * Creates Stripe PaymentIntents from trusted catalog data. The browser may send
 * cart display data, but final prices, shipping eligibility, tax, and idempotency
 * are calculated here.
 */

import Stripe from 'stripe';
import {
  /* json() was called five times here and defined nowhere — not locally, not
     imported. Every return path hit ReferenceError, INCLUDING the catch block,
     so the handler could not even report its own failure and Cloudflare
     answered with an uncaught-exception page (error 1101) instead of JSON.

     That is why the browser saw "Unexpected token '<'": the response was
     Cloudflare's error page, not a malformed API reply. A missing import
     presenting as a parse error three layers away.

     _commerce.js has exported json() all along and this file already imported
     from it — the local copy was dropped in e00bf78 without adding it here. */
  json,
} from './_commerce.js';
import { normalizeStateCode } from './_tax.js';
/* Pricing lives in _cart-pricing.js so a second processor can reach it without
   importing this route — and therefore without importing Stripe. See the note
   at the top of that file. This route now decides nothing about money; it
   quotes, then charges. */
import { buildOrderMetadata, generateOrderNumber, quoteCart, sha256Base64Url } from './_cart-pricing.js';
import { attributionToMeta, sanitizeMatchKeys } from './_attribution.js';
import { hold, capture, release } from './_stored-value.js';
import { handleSuccessfulPayment } from './_fulfil.js';
import { limit } from './_ratelimit.js';

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

export async function onRequestPost({ request, env, waitUntil }) {
  const headers = CORS(env);
  const limited = await limit(env, request, 'create-payment-intent', headers);
  if (limited) return limited;

  /* Outside the try, so the catch can give back what this request reserved.
     Holds expire on their own after thirty minutes — that is what makes a dead
     Worker survivable — but a shopper whose request failed should not have to
     wait out that half hour before trying the same card again. */
  let svHoldRef = '';


  try {
    if (!env.STRIPE_SECRET_KEY) return json({ error: 'Stripe is not configured.' }, 500, headers);

    const body = await request.json();
    const { items, shippingRate, address = {}, promoCode = '', deliveryMethod = '' } = body;
    // Compact snapshot of the visitor's active feature-flag variants (from
    // flags.js via commerce-checkout.js). The webhook stamps it on the order so
    // revenue/orders can be split by variant. Kept tiny for Stripe's 500-char cap.
    let featureFlagsMeta = '';
    try {
      const ff = body.featureFlags;
      if (ff && typeof ff === 'object' && Object.keys(ff).length) featureFlagsMeta = JSON.stringify(ff).slice(0, 480);
    } catch (_) {}

    /* Where this order came from, sent by attribution.js through the same
       wrapper that adds the promo code. Sanitised and capped here rather than
       trusted: none of it prices anything, but an over-long value would be
       rejected by Stripe and take the whole PaymentIntent — and therefore the
       sale — with it. See _attribution.js. */
    const attributionMeta = attributionToMeta(body.attribution);
    const matchKeys = sanitizeMatchKeys(body.attribution);

    if (!items?.length || !address?.email) {
      return json({ error: 'Missing required fields: items and address.email' }, 400, headers);
    }

    /* The quote is the same call PayPal makes. Nothing about what this cart
       costs is decided in this file any more — it asks, then charges. */
    const quote = await quoteCart({
      waitUntil,
      items, address, shippingRate, promoCode, deliveryMethod,
      storedValueCode: body.storedValueCode || '',
      accessToken: body.accessToken || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, ''),
      env, request,
    });
    const {
      attributedUser, lineItems, inventoryItems, subtotalCents,
      shipping, normalizedPromoCode, discountCents, tax, taxStateCode,
      taxRate, taxCents, totalCents, storedValue,
    } = quote;

    if (totalCents <= 0) return json({ error: 'Invalid payment amount.' }, 400, headers);

    const idempotencyPayload = JSON.stringify({
      email: String(address.email || '').toLowerCase().trim(),
      items: lineItems,
      promoCode: normalizedPromoCode,
      discountCents,
      shipping: shipping.shippingCents,
      actualShippingCents: shipping.actualShippingCents,
      rateObjectId: shipping.rateObjectId || '',
      ship: {
        line1: address.line1 || '',
        line2: address.line2 || '',
        city: address.city || '',
        state: normalizeStateCode(address.state),
        zip: address.zip || '',
        country: address.country || 'US',
      },
      taxStateCode,
      taxCents,
      totalCents,
    });
    const idempotencyHash = (await sha256Base64Url(idempotencyPayload)).slice(0, 40);
    const idempotencyKey = `pi_${idempotencyHash}`;

    const orderNumber = generateOrderNumber();

    /* ── THE CARD IS RESERVED HERE, NOT AT QUOTE TIME ─────────────────────────
       The quote runs on every keystroke in the address field; a hold taken
       there would let a shopper who typed a code and changed their mind leave
       their own money locked up. This is the moment the order becomes real.

       KEYED ON THE IDEMPOTENCY HASH, NOT THE ORDER NUMBER. A new order number
       is generated on every request, so keying on it would mean a shopper whose
       first card declined comes back with a fresh number, takes a SECOND hold
       against the same gift card, and finds half of it already reserved by the
       attempt that failed — their own money, locked against nothing, for half an
       hour. The hash is derived from the cart and the address, so every retry of
       the same purchase carries the same reference and finds the same hold.

       IF THE HOLD COMES BACK SHORT, THE CARD IS CHARGED MORE — not less. The
       balance can have moved between the quote a moment ago and now (the same
       card used in another tab), and the one outcome that must never happen is
       goods leaving for less than they cost. */
    let heldCents = 0;
    if (storedValue.appliedCents > 0 && storedValue.code) {
      svHoldRef = idempotencyKey;
      const h = await hold(env, storedValue.code, storedValue.appliedCents, svHoldRef, 1800);
      heldCents = h.heldCents;
      if (!h.ok && h.reason === 'unavailable') {
        /* The ledger could not be reached. Charging the full amount would take
           money the customer thinks their card is covering; letting it through
           at the discounted amount would give away goods. Neither, so: stop and
           say so, which is the only answer that cannot lose. */
        return json({ error: 'We could not check that gift card just now. Please try again in a moment.' }, 503, headers);
      }
    }
    const amountDueCents = Math.max(0, totalCents - heldCents);

    /* ── PAID IN FULL FROM THE CARD, SO THERE IS NO CHARGE TO MAKE ────────────
       Stripe will not create a zero PaymentIntent, and a $100 card against an
       $80 order is the ordinary case rather than an edge one. So this order is
       completed here, the same way PayPal completes one: the stored value is
       captured, a payment-shaped object is built, and fulfilment runs. The
       order has a total, owes tax on it, and reports revenue exactly as any
       other — only the tender is different.

       Captured BEFORE fulfilment. A capture that failed after the goods were
       committed would be goods given away; a fulfilment that fails after the
       capture leaves a customer who paid and an order to be recovered, which is
       the direction this codebase already chose everywhere else. */
    if (amountDueCents === 0) {
      const cap = await capture(env, svHoldRef, orderNumber);
      if (!cap.ok || cap.capturedCents < totalCents) {
        await release(env, svHoldRef);
        return json({ error: 'We could not complete that with the gift card. Please try again.' }, 409, headers);
      }
      const meta = buildOrderMetadata({ orderNumber, address, quote, featureFlagsMeta, attributionMeta, matchKeys });
      meta.payment_provider = 'stored_value';
      meta.stored_value_cents = String(cap.capturedCents);
      meta.stored_value_code = storedValue.code;
      svHoldRef = '';   // captured — nothing left to release
      const payment = { id: 'sv_' + orderNumber, amount: totalCents };
      try {
        await handleSuccessfulPayment(payment, meta, env, null);
      } catch (err) {
        console.error('stored-value order captured but fulfilment failed —', orderNumber, err);
      }
      return json({
        paidInFull: true,
        orderNumber,
        orderId: payment.id,
        subtotal: (subtotalCents / 100).toFixed(2),
        discount: (discountCents / 100).toFixed(2),
        discountCode: normalizedPromoCode,
        shipping: (shipping.shippingCents / 100).toFixed(2),
        tax: (taxCents / 100).toFixed(2),
        total: (totalCents / 100).toFixed(2),
        storedValueApplied: (cap.capturedCents / 100).toFixed(2),
        amountDue: '0.00',
        taxState: taxStateCode,
        taxRateBps: Math.round(taxRate * 10000),
      }, 200, headers);
    }

    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
    /* Named, so the retry below sends the SAME body under a new key. An
       inline literal could not be resent identically. */
    const intentParams = {
        /* What the CARD is asked for, which is the order total minus whatever a
           gift card is covering. `totalCents` is still what the order is worth
           and is still what the metadata, the tax record and the confirmation
           email report — charging and owing are different numbers the moment a
           second tender exists. */
        amount: amountDueCents,
        currency: 'usd',
        automatic_payment_methods: { enabled: true },
        receipt_email: address.email,

        /* Where the order is going, as a field Stripe can read.

           The address was already here — but only inside metadata, which is a
           key-value store for US and opaque to Stripe. So Stripe held a payment
           it could not tell the destination of, and three of its own features
           quietly had nothing to work with:

             • Tax threshold monitoring fell back to the card's billing address.
               For a store whose customers are students, that is frequently a
               parent's address in another state, so the nexus warnings were
               watching the wrong places.
             • A "product not received" dispute is answered with proof of where
               it was sent. Stripe had no shipping address to submit.
             • Radar cannot compare billing to shipping if it only has one.

           The Apple Pay route has always set this. The main checkout — the one
           nearly every order goes through — did not. Same shape as that one, so
           an order looks the same in the dashboard whichever way it was paid. */
        shipping: {
          name: address.name || '',
          ...(address.phone ? { phone: address.phone } : {}),
          address: {
            line1: address.line1 || '',
            line2: address.line2 || '',
            city: address.city || '',
            state: normalizeStateCode(address.state),
            postal_code: address.zip || '',
            country: address.country || 'US',
          },
        },
        /* The hold's reference travels ON THE PAYMENT, because the thing that
           captures it is the webhook, and the webhook knows nothing except what
           Stripe hands back. Without this the money would stay reserved until
           the hold expired and then quietly return — the customer would have
           received goods, been charged the reduced amount, and kept the gift
           card balance too. */
        metadata: {
          ...buildOrderMetadata({ orderNumber, address, quote, featureFlagsMeta, attributionMeta, matchKeys }),
          ...(heldCents > 0 ? {
            stored_value_ref: svHoldRef,
            stored_value_cents: String(heldCents),
            stored_value_code: storedValue.code,
          } : {}),
        },
    };
    const paymentIntent = await stripe.paymentIntents.create(intentParams, { idempotencyKey }
    ).catch(async (e) => {
      /* Stripe rejects a key reused with different parameters. That happens
         here because the key hashes a hand-maintained SUBSET of the request —
         cart, address, totals — while the body also carries metadata that can
         differ between attempts (feature-flag variants, the tax engine stamp).
         Same key, different body, 400.

         The shopper sees it after a declined card: they try another, the second
         attempt builds a slightly different body under the same key, and Stripe
         answers with a message about idempotency keys — which is addressed to
         the integrator, not to someone trying to buy a jacket.

         A conflict means the double-submit this key guards against did NOT
         happen: the two requests differ. So retrying once with a fresh key is
         correct, and it keeps the guarantee intact for identical resubmissions,
         which still collide and still return the original intent. */
      const conflict = e && (e.type === 'StripeIdempotencyError' ||
        /idempoten/i.test(String(e.message || '')));
      if (!conflict) throw e;
      const retryKey = idempotencyKey + '_r' + Math.random().toString(36).slice(2, 8);
      console.warn('Idempotency conflict on', idempotencyKey, '— retrying as', retryKey);
      return stripe.paymentIntents.create(intentParams, { idempotencyKey: retryKey });
    });

    return json({
      clientSecret: paymentIntent.client_secret,
      orderId: paymentIntent.id,
      orderNumber,
      subtotal: (subtotalCents / 100).toFixed(2),
      discount: (discountCents / 100).toFixed(2),
      discountCode: normalizedPromoCode,
      shipping: (shipping.shippingCents / 100).toFixed(2),
      tax: (taxCents / 100).toFixed(2),
      total: (totalCents / 100).toFixed(2),
      /* Both numbers, named for what they are. The page shows a total and a
         "gift card −$40" line and a "to pay" line; leaving it to subtract would
         be the browser computing money again. */
      storedValueApplied: (heldCents / 100).toFixed(2),
      storedValueCode: heldCents > 0 ? storedValue.code : '',
      amountDue: (amountDueCents / 100).toFixed(2),
      taxState: taxStateCode,
      taxRateBps: Math.round(taxRate * 10000),
      actualShipping: (shipping.actualShippingCents / 100).toFixed(2),
    }, 200, headers);
  } catch (e) {
    /* Only a status this file deliberately attached is trusted. Anything else —
       a Stripe throw, a fetch failure, a genuine bug like the missing json()
       import above — stays 500, because a fault we did not predict is exactly
       the thing that must not be reported as the shopper's fault.

       The log line is unconditional either way: a 409 is a normal outcome, but
       a sudden run of them still means something broke upstream. */
    if (svHoldRef) {
      try { await release(env, svHoldRef); } catch (_) { /* it expires anyway */ }
    }
    const status = Number.isInteger(e?.zwStatus) ? e.zwStatus : 500;
    console.error('create-payment-intent error (' + status + '):', e);
    return json({ error: e.message || 'Could not create payment.' }, status, headers);
  }
}
