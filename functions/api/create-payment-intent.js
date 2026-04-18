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

// Base state rates. Override via env STATE_TAX_RATES (JSON or "CA:0.0725,NY:0.04").
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
  const parseShippingFallbackCents = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.round(parsed);
  };

  try {
    const { items, shippingRate, shippingAmountCents, freeShipping, address, userId } = await request.json();

    if (!items?.length || !address?.email)
      return new Response(JSON.stringify({ error: 'Missing required fields: items and address.email' }), { status: 400, headers });

    const getItemName = (item) => item.name || item.title || 'Product';
    const getItemPriceCents = (item) => Math.round(parseFloat(item.price) * 100);

    const subtotalCents = items.reduce(
      (sum, item) => sum + getItemPriceCents(item) * (item.quantity || 1),
      0
    );
    // actualShippingCents = what Nash pays the carrier (stored in metadata for fulfillment)
    const actualShippingCents = shippingRate?.amount
      ? Math.round(parseFloat(shippingRate.amount) * 100)
      : parseShippingFallbackCents(shippingAmountCents);
    // shippingCents = what the customer is charged
    // freeShipping=true  → customer pays $0 (Nash absorbs carrier cost)
    // freeShipping=false → customer pays the selected Shippo rate
    const shippingCents = freeShipping ? 0 : actualShippingCents;
    const { stateCode: taxStateCode, taxRate } = getTaxRateForAddress(address, env, request);
    const taxCents = subtotalCents > 0
      ? Math.round(subtotalCents * taxRate)
      : 0;

    const lineItems = items.map(item => ({
      name:         getItemName(item),
      amount:       getItemPriceCents(item),
      quantity:     item.quantity || 1,
      tax_behavior: 'exclusive',
    }));

    const cartFingerprint = items
      .map(i => getItemName(i) + ':' + (i.quantity || 1) + ':' + getItemPriceCents(i))
      .sort()
      .join('|');
    const encoded        = btoa(unescape(encodeURIComponent(cartFingerprint))).slice(0, 32);
    const idempotencyKey = 'pi_' + address.email + '_' + shippingCents + '_' + encoded;

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount:   subtotalCents + shippingCents + taxCents,
        currency: 'usd',
        automatic_payment_methods: { enabled: true },
        receipt_email: address.email,
        metadata: {
          customer_email:        address.email,
          customer_name:         address.name,
          user_id:               userId || '',
          items:                 JSON.stringify(lineItems),
          subtotal_amount_cents: String(subtotalCents),
          shipping_provider:            shippingRate?.provider    || '',
          shipping_service:             shippingRate?.servicelevel || '',
          shipping_rate_object_id:      shippingRate?.objectId    || '',
          actual_shipping_cost_cents:   String(actualShippingCents),
          charged_shipping_cents:       String(shippingCents),
          free_shipping:                String(!!freeShipping),
          tax_state:                    taxStateCode,
          tax_rate_bps:                 String(Math.round(taxRate * 10000)),
          tax_amount_cents:             String(taxCents),
          total_amount_cents:           String(subtotalCents + shippingCents + taxCents),
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
      clientSecret:   paymentIntent.client_secret,
      orderId:        paymentIntent.id,
      subtotal:       (subtotalCents      / 100).toFixed(2),
      shipping:       (shippingCents      / 100).toFixed(2),
      tax:            (taxCents           / 100).toFixed(2),
      actualShipping: (actualShippingCents / 100).toFixed(2),
    }), { status: 200, headers });

  } catch (e) {
    console.error('create-payment-intent error:', e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}
