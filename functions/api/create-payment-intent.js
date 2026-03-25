/**
 * Cloudflare Pages Function: /api/create-payment-intent
 *
 * Runs on Cloudflare's edge network (Workers runtime).
 * env vars are accessed via context.env -- NOT process.env.
 *
 * Environment variables (set in CF Pages Dashboard > Settings > Environment variables):
 *   STRIPE_SECRET_KEY, SITE_URL
 *
 * Note: Uses Stripe SDK v10+ which supports the Workers/edge runtime.
 */

import Stripe from 'stripe';

const CORS = (env) => ({
  'Access-Control-Allow-Origin':  env.SITE_URL || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
});

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function onRequestPost({ request, env }) {
  const headers = CORS(env);
  const stripe  = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });

  try {
    const { items, shippingRate, address } = await request.json();

    if (!items?.length || !address?.email)
      return new Response(JSON.stringify({ error: 'Missing required fields: items and address.email' }), { status: 400, headers });

    const subtotalCents = items.reduce(
      (sum, item) => sum + Math.round(item.price * 100) * (item.quantity || 1),
      0
    );
    const shippingCents = shippingRate?.amount
      ? Math.round(parseFloat(shippingRate.amount) * 100)
      : 0;

    const lineItems = items.map(item => ({
      name:         item.name,
      amount:       Math.round(item.price * 100),
      quantity:     item.quantity || 1,
      tax_behavior: 'exclusive',
    }));

    const cartFingerprint = items
      .map(i => i.name + ':' + i.quantity + ':' + Math.round(i.price * 100))
      .sort()
      .join('|');
    const encoded        = btoa(unescape(encodeURIComponent(cartFingerprint))).slice(0, 32);
    const idempotencyKey = 'pi_' + address.email + '_' + shippingCents + '_' + encoded;

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount:   subtotalCents + shippingCents,
        currency: 'usd',
        automatic_payment_methods: { enabled: true },
        automatic_tax: { enabled: true },
        receipt_email: address.email,
        shipping: {
          name: address.name,
          address: {
            line1:       address.line1,
            line2:       address.line2 || '',
            city:        address.city,
            state:       address.state,
            postal_code: address.zip,
            country:     address.country || 'US',
          },
        },
        metadata: {
          customer_email:        address.email,
          customer_name:         address.name,
          items:                 JSON.stringify(lineItems),
          shipping_provider:     shippingRate?.provider    || '',
          shipping_service:      shippingRate?.servicelevel || '',
          shipping_amount_cents: String(shippingCents),
          ship_line1:   address.line1,
          ship_line2:   address.line2 || '',
          ship_city:    address.city,
          ship_state:   address.state,
          ship_zip:     address.zip,
          ship_country: address.country || 'US',
        },
      },
      { idempotencyKey }
    );

    return new Response(JSON.stringify({
      clientSecret: paymentIntent.client_secret,
      orderId:      paymentIntent.id,
      subtotal:     (subtotalCents / 100).toFixed(2),
      shipping:     (shippingCents  / 100).toFixed(2),
    }), { status: 200, headers });

  } catch (e) {
    console.error('create-payment-intent error:', e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}
