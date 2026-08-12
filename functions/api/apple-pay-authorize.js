/**
 * Cloudflare Pages Function: /api/apple-pay-authorize
 *
 * Exchanges an Apple Pay payment token for a Stripe token and creates
 * a confirmed PaymentIntent.
 */

import Stripe from 'stripe';
import { resolveTax } from './_tax.js';

const CORS = (env) => ({
  'Access-Control-Allow-Origin': env.SITE_URL || 'https://zuwera.store',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
});

/* Tax is NOT worked out in this file.

   It used to be, and that was the whole bug this codebase spent a day on,
   surviving in the one payment route nobody looked at. This file carried its
   own copy of the state rate table and its own getTaxRateForAddress, so an
   Apple Pay order was priced by a second, simpler implementation:

     - STATE rates only. No Ohio county lookup, no Illinois ZIP3. A Cincinnati
       order was charged Ohio's 5.75% instead of Hamilton County's 7.8% -- the
       same cart, the same address, a different total depending on whether the
       shopper tapped Apple Pay or typed a card number.
     - Environment variables only. Rates corrected in Admin -> Tax were read
       by every other path and ignored by this one, so fixing a rate appeared
       to work and left this route wrong.
     - No engine. Stripe Tax or TaxJar could be configured and selling through
       Apple Pay would still quietly use the built-in table.

   resolveTax is now the only thing that decides tax anywhere. */
function parseShippingFallbackCents(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed);
}

function toBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function getApplePkToken(applePayToken) {
  const paymentData = applePayToken?.paymentData;
  if (!paymentData) return '';
  if (typeof paymentData === 'string') return paymentData;
  return toBase64Utf8(JSON.stringify(paymentData));
}

function getItemName(item) {
  return item?.name || item?.title || 'Product';
}

function getItemPriceCents(item) {
  return Math.round(parseFloat(item?.price || 0) * 100);
}

function normalizeAddress(address = {}) {
  return {
    name: address.name || 'Apple Pay Customer',
    email: (address.email || '').trim(),
    line1: address.line1 || '',
    line2: address.line2 || '',
    city: address.city || '',
    state: address.state || '',
    zip: address.zip || '',
    country: address.country || 'US',
    phone: address.phone || '',
  };
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: CORS(env) });
}

export async function onRequestPost({ request, env }) {
  const headers = CORS(env);
  /* Guarded, and OUTSIDE the try is why it has to be. Stripe v22 throws from
     the constructor when no key is given ("Neither apiKey nor
     config.authenticator provided") where v16 constructed happily and failed
     later — so on a store without STRIPE_SECRET_KEY this threw before the try
     could catch it, and the endpoint answered with Cloudflare's uncaught
     exception page instead of JSON. The same shape that took checkout down.

     Found by running the contract suite against the dependency tree CI uses
     rather than the stale one installed locally. */
  if (!env.STRIPE_SECRET_KEY) {
    return new Response(JSON.stringify({ error: 'Payments are not configured.' }), { status: 500, headers });
  }
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });

  try {
    const { items, shippingRate, shippingAmountCents, address, userId, applePayToken } = await request.json();
    const normalizedAddress = normalizeAddress(address);

    if (!items?.length) {
      return new Response(JSON.stringify({ error: 'Missing items' }), { status: 400, headers });
    }
    if (!normalizedAddress.email) {
      return new Response(JSON.stringify({ error: 'Missing payer email' }), { status: 400, headers });
    }
    if (!applePayToken?.paymentData) {
      return new Response(JSON.stringify({ error: 'Missing Apple Pay token payload' }), { status: 400, headers });
    }

    const subtotalCents = items.reduce(
      (sum, item) => sum + getItemPriceCents(item) * (item.quantity || 1),
      0
    );
    const shippingCents = shippingRate?.amount
      ? Math.round(parseFloat(shippingRate.amount) * 100)
      : parseShippingFallbackCents(shippingAmountCents);
    /* The same call the card checkout makes, so the two cannot diverge again.
       Shipping is declared as well -- several states tax it, and the old local
       version never mentioned it. */
    const tax = await resolveTax({
      env, request,
      address: normalizedAddress,
      taxableCents: subtotalCents,
      shippingCents,
    });
    const taxStateCode = tax.stateCode;
    const taxRate = tax.rate;
    const taxCents = tax.taxCents;
    const totalCents = subtotalCents + shippingCents + taxCents;
    if (totalCents <= 0) {
      return new Response(JSON.stringify({ error: 'Invalid payment amount' }), { status: 400, headers });
    }

    const pkToken = getApplePkToken(applePayToken);
    if (!pkToken) {
      return new Response(JSON.stringify({ error: 'Could not parse Apple Pay token' }), { status: 400, headers });
    }

    const stripeToken = await stripe.tokens.create({
      pk_token: pkToken,
      pk_token_transaction_id: applePayToken.transactionIdentifier || '',
      pk_token_payment_network: applePayToken.paymentMethod?.network || '',
      pk_token_instrument_name: applePayToken.paymentMethod?.displayName || 'Apple Pay',
    });

    const transactionKeyPart = (applePayToken.transactionIdentifier || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 48);
    const idempotencyKey = `ap_${normalizedAddress.email}_${totalCents}_${transactionKeyPart || Date.now()}`;

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: totalCents,
        currency: 'usd',
        confirm: true,
        payment_method_data: {
          type: 'card',
          card: { token: stripeToken.id },
          billing_details: {
            name: normalizedAddress.name,
            email: normalizedAddress.email,
            phone: normalizedAddress.phone,
            address: {
              line1: normalizedAddress.line1,
              line2: normalizedAddress.line2,
              city: normalizedAddress.city,
              state: normalizedAddress.state,
              postal_code: normalizedAddress.zip,
              country: normalizedAddress.country,
            },
          },
        },
        receipt_email: normalizedAddress.email,
        shipping: {
          name: normalizedAddress.name,
          phone: normalizedAddress.phone,
          address: {
            line1: normalizedAddress.line1,
            line2: normalizedAddress.line2,
            city: normalizedAddress.city,
            state: normalizedAddress.state,
            postal_code: normalizedAddress.zip,
            country: normalizedAddress.country,
          },
        },
        metadata: {
          user_id: userId || '',
          customer_email: normalizedAddress.email,
          customer_name: normalizedAddress.name,
          subtotal_amount_cents: String(subtotalCents),
          shipping_amount_cents: String(shippingCents),
          tax_state: taxStateCode,
          tax_rate_bps: String(Math.round(taxRate * 10000)),
          /* Which engine answered, and its handle on the calculation, so an
             Apple Pay sale is reported for filing like any other. */
          tax_engine: tax.fallbackFrom ? (tax.fallbackFrom + '->builtin') : (tax.engine || 'builtin'),
          tax_ref: tax.ref || '',
          tax_amount_cents: String(taxCents),
          total_amount_cents: String(totalCents),
          shipping_provider: shippingRate?.provider || '',
          shipping_service: shippingRate?.servicelevel || '',
          apple_pay_network: applePayToken.paymentMethod?.network || '',
          apple_pay_transaction_id: applePayToken.transactionIdentifier || '',
        },
      },
      { idempotencyKey }
    );

    if (!['succeeded', 'processing', 'requires_capture'].includes(paymentIntent.status)) {
      return new Response(JSON.stringify({ error: `Payment failed with status: ${paymentIntent.status}` }), { status: 402, headers });
    }

    return new Response(JSON.stringify({
      orderId: paymentIntent.id,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
      total: (totalCents / 100).toFixed(2),
    }), { status: 200, headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: error?.message || 'Apple Pay authorization failed' }), { status: 500, headers });
  }
}

