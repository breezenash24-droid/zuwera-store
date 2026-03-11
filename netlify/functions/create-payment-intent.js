/**
 * Netlify Function: create-payment-intent
 *
 * Creates a real Stripe PaymentIntent with:
 *  - Automatic tax calculation via Stripe Tax
 *  - Shipping amount included
 *  - Idempotency key to prevent double charges
 *
 * POST body (JSON):
 *  {
 *    items:        [{ name, price, quantity }],
 *    shippingRate: { amount, provider, servicelevel },
 *    address: { name, email, line1, line2, city, state, zip, country }
 *  }
 *
 * Response: { clientSecret, orderId, subtotal, shipping }
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { ok, err, preflight } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST')    return err(405, 'Method not allowed');

  try {
    const { items, shippingRate, address } = JSON.parse(event.body);

    if (!items?.length || !address?.email)
      return err(400, 'Missing required fields: items and address.email');

    // ── Subtotal in cents ─────────────────────────────────────────
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

    // ── Deterministic idempotency key ─────────────────────────────
    const cartFingerprint = items
      .map(i => `${i.name}:${i.quantity}:${Math.round(i.price * 100)}`)
      .sort()
      .join('|');
    const idempotencyKey = `pi_${address.email}_${shippingCents}_${Buffer.from(cartFingerprint).toString('base64').slice(0, 32)}`;

    // ── Create PaymentIntent ──────────────────────────────────────
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
          customer_email: address.email,
          customer_name:  address.name,
          items:          JSON.stringify(lineItems),
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

    return ok({
      clientSecret: paymentIntent.client_secret,
      orderId:      paymentIntent.id,
      subtotal:     (subtotalCents / 100).toFixed(2),
      shipping:     (shippingCents  / 100).toFixed(2),
    });
  } catch (e) {
    console.error('create-payment-intent error:', e);
    return err(500, e.message);
  }
};
