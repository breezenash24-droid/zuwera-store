/**
 * Vercel Serverless Function: /api/create-payment-intent
 *
 * Creates a Stripe PaymentIntent with shipping + automatic tax.
 * Same business logic as the Netlify version — only the handler
 * signature differs (Express-style req/res instead of event/context).
 *
 * Environment variables (set in Vercel Dashboard → Settings → Environment):
 *   STRIPE_SECRET_KEY, SITE_URL
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const CORS = {
  'Access-Control-Allow-Origin':  process.env.SITE_URL || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async function handler(req, res) {
  // Apply CORS headers to every response
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { items, shippingRate, address } = req.body;

    if (!items?.length || !address?.email)
      return res.status(400).json({ error: 'Missing required fields: items and address.email' });

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

    // Deterministic idempotency key — prevents double charges on retry
    const cartFingerprint = items
      .map(i => `${i.name}:${i.quantity}:${Math.round(i.price * 100)}`)
      .sort()
      .join('|');
    const idempotencyKey = `pi_${address.email}_${shippingCents}_${Buffer.from(cartFingerprint).toString('base64').slice(0, 32)}`;

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

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      orderId:      paymentIntent.id,
      subtotal:     (subtotalCents / 100).toFixed(2),
      shipping:     (shippingCents  / 100).toFixed(2),
    });
  } catch (e) {
    console.error('create-payment-intent error:', e);
    return res.status(500).json({ error: e.message });
  }
};
