/**
 * Netlify Function: apple-pay-authorize
 *
 * Exchanges Apple Pay token payload for a Stripe token and confirms
 * a PaymentIntent in one server-side step.
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { ok, err, preflight } = require('./_shared');

const SALES_TAX_RATE = 0.08;

function parseShippingFallbackCents(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed);
}

function getApplePkToken(applePayToken) {
  const paymentData = applePayToken?.paymentData;
  if (!paymentData) return '';
  if (typeof paymentData === 'string') return paymentData;
  return Buffer.from(JSON.stringify(paymentData), 'utf8').toString('base64');
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return err(405, 'Method not allowed');

  try {
    const { items, shippingRate, shippingAmountCents, address, userId, applePayToken } = JSON.parse(event.body || '{}');
    const normalizedAddress = normalizeAddress(address);

    if (!items?.length) return err(400, 'Missing items');
    if (!normalizedAddress.email) return err(400, 'Missing payer email');
    if (!applePayToken?.paymentData) return err(400, 'Missing Apple Pay token payload');

    const subtotalCents = items.reduce(
      (sum, item) => sum + getItemPriceCents(item) * (item.quantity || 1),
      0
    );
    const shippingCents = shippingRate?.amount
      ? Math.round(parseFloat(shippingRate.amount) * 100)
      : parseShippingFallbackCents(shippingAmountCents);
    const taxCents = subtotalCents > 0 ? Math.round(subtotalCents * SALES_TAX_RATE) : 0;
    const totalCents = subtotalCents + shippingCents + taxCents;
    if (totalCents <= 0) return err(400, 'Invalid payment amount');

    const pkToken = getApplePkToken(applePayToken);
    if (!pkToken) return err(400, 'Could not parse Apple Pay token');

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
          tax_amount_cents: String(taxCents),
          total_amount_cents: String(totalCents),
          shipping_provider: shippingRate?.provider || '',
          shipping_service: shippingRate?.servicelevel || '',
          apple_pay_network: applePayToken.paymentMethod?.network || '',
          apple_pay_transaction_id: applePayToken.transactionIdentifier || '',
          items: JSON.stringify(items.map(item => ({
            name: getItemName(item),
            amount: getItemPriceCents(item),
            quantity: item.quantity || 1,
          }))),
        },
      },
      { idempotencyKey }
    );

    if (!['succeeded', 'processing', 'requires_capture'].includes(paymentIntent.status)) {
      return err(402, `Payment failed with status: ${paymentIntent.status}`);
    }

    return ok({
      orderId: paymentIntent.id,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
      total: (totalCents / 100).toFixed(2),
    });
  } catch (error) {
    return err(500, error?.message || 'Apple Pay authorization failed');
  }
};

