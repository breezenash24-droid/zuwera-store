/**
 * Cloudflare Pages Function: /api/paypal-create-order
 *
 * The PayPal half of checkout, priced by the same quoteCart() the Stripe route
 * uses. The browser sends the cart; what it costs is settled here against the
 * catalog. A client that edits a price is ignored, exactly as with Stripe,
 * because neither route trusts the number it was handed.
 *
 * THIS ENDPOINT MOVES NO MONEY. It creates a PayPal order the buyer can then
 * approve. Capture — the step that actually takes the funds — is a separate
 * endpoint, deliberately, so that the two halves are reviewed separately.
 */

import { json } from './_commerce.js';
import { generateOrderNumber, quoteCart, sha256Base64Url } from './_cart-pricing.js';
import { centsToAmount, paypalConfig, paypalFetch } from './_paypal.js';

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

  try {
    const cfg = paypalConfig(env);
    /* 503, not 500: PayPal being switched off is a true statement about what
       this store currently offers, not a fault. The checkout reads it as "do
       not show the PayPal button" rather than "something is broken". */
    if (!cfg.configured) return json({ error: 'PayPal is not available.' }, 503, headers);

    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'Invalid request body.' }, 400, headers);

    const { items, address = {}, shippingRate, promoCode = '', deliveryMethod = '' } = body;
    if (!items?.length || !address?.email) {
      return json({ error: 'Missing required fields: items and address.email' }, 400, headers);
    }

    const quote = await quoteCart({
      waitUntil,
      items, address, shippingRate, promoCode, deliveryMethod,
      accessToken: body.accessToken || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, ''),
      env, request,
    });
    const { catalogItems, subtotalCents, shipping, discountCents, taxCents, totalCents, normalizedPromoCode } = quote;

    if (totalCents <= 0) return json({ error: 'Invalid payment amount.' }, 400, headers);

    const orderNumber = generateOrderNumber();

    /* PayPal validates this arithmetic and rejects the order if it is off by a
       cent: item_total must equal the sum of the line items, and the breakdown
       must sum to amount.value. That strictness is a feature here — it is a
       second opinion on the same totals the Stripe path charges, computed by
       someone who has no reason to agree with us. */
    const purchaseUnit = {
      custom_id: orderNumber,
      /* Not invoice_id. PayPal enforces uniqueness on invoice_id at CAPTURE and
         refuses a duplicate, so a buyer who abandons an approval and starts
         again — same cart, same generated number — would be blocked from paying
         by a field that exists only for our own bookkeeping. custom_id carries
         the reference with no such constraint. */
      description: 'Zuwera order ' + orderNumber,
      amount: {
        currency_code: 'USD',
        value: centsToAmount(totalCents),
        breakdown: {
          item_total: { currency_code: 'USD', value: centsToAmount(subtotalCents) },
          shipping: { currency_code: 'USD', value: centsToAmount(shipping.shippingCents) },
          tax_total: { currency_code: 'USD', value: centsToAmount(taxCents) },
          discount: { currency_code: 'USD', value: centsToAmount(discountCents) },
        },
      },
      items: catalogItems.map((item) => ({
        name: String(item.name || 'Item').slice(0, 127),
        sku: String(item.sku || '').slice(0, 127),
        quantity: String(item.quantity),
        unit_amount: { currency_code: 'USD', value: centsToAmount(item.amount) },
        category: 'PHYSICAL_GOODS',
      })),
    };

    /* Shipping address, so PayPal shows the buyer where it is going and we get
       a delivery address back on the capture that we can compare against the
       one we quoted. Omitted entirely for hand delivery — sending an address
       for something nobody is shipping invites PayPal to price or display it
       as a shipment. */
    if (!shipping.handDelivery && address.line1) {
      purchaseUnit.shipping = {
        name: { full_name: String(address.name || '').slice(0, 300) },
        address: {
          address_line_1: String(address.line1 || '').slice(0, 300),
          address_line_2: String(address.line2 || '').slice(0, 300),
          admin_area_2: String(address.city || '').slice(0, 120),
          admin_area_1: String(address.state || '').slice(0, 300),
          postal_code: String(address.zip || '').slice(0, 60),
          country_code: String(address.country || 'US').toUpperCase().slice(0, 2),
        },
      };
    }

    /* Same idea as the Stripe idempotency key, over the same facts: a
       double-submitted approval returns the original order rather than opening
       a second one the buyer could also approve. */
    const requestId = 'zw_' + (await sha256Base64Url(JSON.stringify({
      email: String(address.email || '').toLowerCase().trim(),
      items: quote.lineItems,
      promoCode: normalizedPromoCode,
      totalCents,
      zip: address.zip || '',
    }))).slice(0, 40);

    const res = await paypalFetch(env, '/v2/checkout/orders', {
      method: 'POST',
      requestId,
      body: {
        intent: 'CAPTURE',
        purchase_units: [purchaseUnit],
        payment_source: {
          paypal: {
            experience_context: {
              shipping_preference: shipping.handDelivery ? 'NO_SHIPPING' : 'SET_PROVIDED_ADDRESS',
              user_action: 'PAY_NOW',
            },
          },
        },
      },
    });

    if (!res.ok || !res.data?.id) {
      /* PayPal's own message is for us, not for the customer — it names fields
         and issue codes from its API. The detail goes to the log via
         paypalFetch; the shopper gets something they can act on. */
      return json({ error: 'PayPal could not start that payment. Please try another payment method.' }, 502, headers);
    }

    /* The totals go back so the checkout can show the same figures it will show
       for a card, and so a mismatch between what was displayed and what PayPal
       holds is visible immediately rather than at capture. */
    return json({
      paypalOrderId: res.data.id,
      orderNumber,
      subtotal: centsToAmount(subtotalCents),
      discount: centsToAmount(discountCents),
      discountCode: normalizedPromoCode,
      shipping: centsToAmount(shipping.shippingCents),
      tax: centsToAmount(taxCents),
      total: centsToAmount(totalCents),
    }, 200, headers);
  } catch (e) {
    /* Same rule as the Stripe route: only a status this code deliberately
       attached is trusted, so a sold-out size stays a 409 and anything we did
       not predict stays a 500 rather than being dressed up as the customer's
       fault. */
    const status = Number.isInteger(e?.zwStatus) ? e.zwStatus : 500;
    console.error('paypal-create-order error (' + status + '):', e);
    return json({ error: e.message || 'Could not start that payment.' }, status, headers);
  }
}
