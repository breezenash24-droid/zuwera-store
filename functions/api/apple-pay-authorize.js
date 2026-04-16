/**
 * Cloudflare Pages Function: /api/apple-pay-authorize
 *
 * Exchanges an Apple Pay payment token for a Stripe token and creates
 * a confirmed PaymentIntent.
 */

import Stripe from 'stripe';

const CORS = (env) => ({
  'Access-Control-Allow-Origin': env.SITE_URL || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
});

const US_STATE_NAME_TO_CODE = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA',
  HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA',
  KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
  MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO',
  MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND',
  OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT',
  VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI',
  WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC'
};

const DEFAULT_US_STATE_TAX_RATES = {
  AL: 0.04, AK: 0, AZ: 0.056, AR: 0.065, CA: 0.0725,
  CO: 0.029, CT: 0.0635, DE: 0, FL: 0.06, GA: 0.04,
  HI: 0.04, ID: 0.06, IL: 0.0625, IN: 0.07, IA: 0.06,
  KS: 0.065, KY: 0.06, LA: 0.0445, ME: 0.055, MD: 0.06,
  MA: 0.0625, MI: 0.06, MN: 0.06875, MS: 0.07, MO: 0.04225,
  MT: 0, NE: 0.055, NV: 0.0685, NH: 0, NJ: 0.06625,
  NM: 0.05125, NY: 0.04, NC: 0.0475, ND: 0.05, OH: 0.0575,
  OK: 0.045, OR: 0, PA: 0.06, RI: 0.07, SC: 0.06,
  SD: 0.042, TN: 0.07, TX: 0.0625, UT: 0.061, VT: 0.06,
  VA: 0.053, WA: 0.065, WV: 0.06, WI: 0.05, WY: 0.04,
  DC: 0.06
};

function normalizeRate(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed > 1 ? parsed / 100 : parsed;
}

function normalizeStateCode(value) {
  if (!value) return '';
  const upper = String(value).trim().toUpperCase().replace(/\./g, '');
  if (upper.length === 2) return upper;
  return US_STATE_NAME_TO_CODE[upper] || '';
}

function parseConfiguredStateRates(rawValue) {
  const parsed = {};
  const raw = String(rawValue || '').trim();
  if (!raw) return parsed;

  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      Object.entries(obj || {}).forEach(([key, value]) => {
        const state = normalizeStateCode(key);
        const rate = normalizeRate(value);
        if (state && rate !== null) parsed[state] = rate;
      });
      return parsed;
    } catch (_) {}
  }

  raw.split(',').forEach((entry) => {
    const [keyPart, valuePart] = entry.split(/[:=]/);
    const state = normalizeStateCode(keyPart);
    const rate = normalizeRate(valuePart);
    if (state && rate !== null) parsed[state] = rate;
  });

  return parsed;
}

function detectUsStateFromRequest(request) {
  const cfCountry = request?.cf?.country;
  const headerCountry = request?.headers?.get('CF-IPCountry');
  const country = String(cfCountry || headerCountry || 'US').trim().toUpperCase();
  if (country !== 'US') return '';

  const candidates = [
    request?.cf?.regionCode,
    request?.cf?.region,
    request?.headers?.get('CF-Region-Code'),
    request?.headers?.get('CF-Region')
  ];
  for (const candidate of candidates) {
    const normalized = normalizeStateCode(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function getTaxRateForAddress(address, env, request) {
  const country = String(address?.country || 'US').trim().toUpperCase();
  if (country !== 'US') return { stateCode: '', taxRate: 0 };

  const stateCode = normalizeStateCode(address?.state) || detectUsStateFromRequest(request);
  const configuredRates = parseConfiguredStateRates(
    env.STATE_TAX_RATES || env.SALES_TAX_BY_STATE || env.TAX_RATES_BY_STATE
  );
  const mergedRates = { ...DEFAULT_US_STATE_TAX_RATES, ...configuredRates };
  const fallbackRate = normalizeRate(env.DEFAULT_SALES_TAX_RATE) ?? 0;
  const taxRate = stateCode ? (mergedRates[stateCode] ?? fallbackRate) : fallbackRate;
  return { stateCode, taxRate };
}

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
    const { stateCode: taxStateCode, taxRate } = getTaxRateForAddress(normalizedAddress, env, request);
    const taxCents = subtotalCents > 0 ? Math.round(subtotalCents * taxRate) : 0;
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

