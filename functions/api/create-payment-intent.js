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
import { generateOrderNumber, quoteCart, sha256Base64Url } from './_cart-pricing.js';

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

export async function onRequestPost({ request, env }) {
  const headers = CORS(env);

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

    if (!items?.length || !address?.email) {
      return json({ error: 'Missing required fields: items and address.email' }, 400, headers);
    }

    /* The quote is the same call PayPal makes. Nothing about what this cart
       costs is decided in this file any more — it asks, then charges. */
    const quote = await quoteCart({
      items, address, shippingRate, promoCode, deliveryMethod,
      accessToken: body.accessToken || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, ''),
      env, request,
    });
    const {
      verifiedUser, lineItems, inventoryItems, subtotalCents,
      shipping, normalizedPromoCode, discountCents, tax, taxStateCode,
      taxRate, taxCents, totalCents,
    } = quote;

    if (totalCents <= 0) return json({ error: 'Invalid payment amount.' }, 400, headers);

    /* Stripe caps each metadata value at 500 chars, so the shared line items get
       trimmed to fit — here, not in the quote, because the cap is Stripe's and
       PayPal has no equivalent. If it is still over 490 (large carts, long
       names) drop size+color, then truncate names as a last resort. The webhook
       only requires name/sku/amount/qty. */
    let metaItems = JSON.stringify(lineItems);
    if (metaItems.length > 490) {
      metaItems = JSON.stringify(lineItems.map(({ sku, name, amount, quantity }) => ({ sku, name, amount, quantity })));
    }
    if (metaItems.length > 490) {
      metaItems = JSON.stringify(lineItems.map(({ sku, name, amount, quantity }) => ({ sku, name: name.slice(0, 28), amount, quantity })));
    }

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
    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
    /* Named, so the retry below sends the SAME body under a new key. An
       inline literal could not be resent identically. */
    const intentParams = {
        amount: totalCents,
        currency: 'usd',
        automatic_payment_methods: { enabled: true },
        receipt_email: address.email,
        metadata: {
          order_number: orderNumber,
          customer_email: address.email,
          customer_name: address.name || '',
          user_id: verifiedUser?.id || '',
          items: metaItems,
          inv: JSON.stringify(inventoryItems),
          subtotal_amount_cents: String(subtotalCents),
          discount_code: normalizedPromoCode,
          discount_amount_cents: String(discountCents),
          shipping_provider: shipping.provider,
          shipping_service: shipping.servicelevel,
          shipping_rate_object_id: shipping.rateObjectId,
          shipping_source: shipping.source || 'shippo',
          veeqo_remote_shipment_id: shipping.remoteShipmentId || '',
          actual_shipping_cost_cents: String(shipping.actualShippingCents),
          charged_shipping_cents: String(shipping.shippingCents),
          free_shipping: String(shipping.qualifiesFree || shipping.handDelivery),
          delivery_method: shipping.handDelivery ? 'hand_delivery' : 'ship',
          tax_state: taxStateCode,
          tax_rate_bps: String(Math.round(taxRate * 10000)),
          tax_amount_cents: String(taxCents),
          // Which engine produced that number — not always the one configured,
          // since an external provider that failed falls back to the table. The
          // Tax page reads this so a figure at filing time can be attributed.
          tax_engine: tax.fallbackFrom ? `${tax.fallbackFrom}→builtin` : (tax.engine || 'builtin'),
          /* The provider's handle on the calculation. A tax provider only files
             sales it has been told completed, and it is told by referring back
             to this — so it has to survive from here to the webhook. Empty for
             engines with nothing to file. */
          tax_ref: tax.ref || '',
          total_amount_cents: String(totalCents),
          feature_flags: featureFlagsMeta,
          ship_line1: address.line1 || '',
          ship_line2: address.line2 || '',
          ship_city: address.city || '',
          ship_state: address.state || '',
          ship_zip: address.zip || '',
          ship_country: address.country || 'US',
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
    const status = Number.isInteger(e?.zwStatus) ? e.zwStatus : 500;
    console.error('create-payment-intent error (' + status + '):', e);
    return json({ error: e.message || 'Could not create payment.' }, status, headers);
  }
}
