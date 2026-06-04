/**
 * Cloudflare Pages Function: /api/create-payment-intent
 *
 * Creates Stripe PaymentIntents from trusted catalog data. The browser may send
 * cart display data, but final prices, shipping eligibility, tax, and idempotency
 * are calculated here.
 */

import Stripe from 'stripe';
import {
  computePromotionDiscount,
  getSetting,
  normalizePromoCode,
  sanitizeCommerceConfig,
} from './_commerce.js';
import { fetchSiteSettings } from './_settings.js';

const CORS = (env) => ({
  'Access-Control-Allow-Origin': env.SITE_URL || 'https://zuwera.store',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
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
  WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC',
};

const DEFAULT_US_STATE_TAX_RATES = {
  AL: 0.04, AK: 0, AZ: 0.056, AR: 0.065, CA: 0.0725,
  CO: 0.029, CT: 0.0635, DE: 0, FL: 0.06, GA: 0.04,
  HI: 0.04, ID: 0.06, IL: 0.0625, IN: 0.07, IA: 0.06,
  KS: 0.065, KY: 0.06, LA: 0.05, ME: 0.055, MD: 0.06,
  MA: 0.0625, MI: 0.06, MN: 0.06875, MS: 0.07, MO: 0.04225,
  MT: 0, NE: 0.055, NV: 0.0685, NH: 0, NJ: 0.06625,
  NM: 0.05125, NY: 0.04, NC: 0.0475, ND: 0.05, OH: 0.0575,
  OK: 0.045, OR: 0, PA: 0.06, RI: 0.07, SC: 0.06,
  SD: 0.042, TN: 0.07, TX: 0.0625, UT: 0.061, VT: 0.06,
  VA: 0.053, WA: 0.065, WV: 0.06, WI: 0.05, WY: 0.04,
  DC: 0.06,
};

// Ohio county combined rates (state 5.75% + county levy)
const OH_COUNTY_RATES = {
  Adams:0.0725,Allen:0.0675,Ashland:0.07,Ashtabula:0.07,Athens:0.07,
  Auglaize:0.0725,Belmont:0.0725,Brown:0.0725,Butler:0.07,Carroll:0.0725,
  Champaign:0.0725,Clark:0.0725,Clermont:0.07,Clinton:0.0725,Columbiana:0.0725,
  Coshocton:0.0725,Crawford:0.0725,Cuyahoga:0.08,Darke:0.0725,Defiance:0.0725,
  Delaware:0.07,Erie:0.0675,Fairfield:0.0675,Fayette:0.0725,Franklin:0.075,
  Fulton:0.0725,Gallia:0.0725,Geauga:0.07,Greene:0.0675,Guernsey:0.0725,
  Hamilton:0.07,Hancock:0.0675,Hardin:0.0725,Harrison:0.0725,Henry:0.0725,
  Highland:0.0725,Hocking:0.0725,Holmes:0.0725,Huron:0.0725,Jackson:0.0725,
  Jefferson:0.0725,Knox:0.0725,Lake:0.0725,Lawrence:0.0725,Licking:0.0725,
  Logan:0.0725,Lorain:0.065,Lucas:0.0725,Madison:0.07,Mahoning:0.0725,
  Marion:0.0725,Medina:0.0675,Meigs:0.0725,Mercer:0.0725,Miami:0.0675,
  Monroe:0.0725,Montgomery:0.075,Morgan:0.0725,Morrow:0.0725,Muskingum:0.0725,
  Noble:0.0725,Ottawa:0.07,Paulding:0.0725,Perry:0.0725,Pickaway:0.0725,
  Pike:0.0725,Portage:0.0725,Preble:0.07,Putnam:0.0725,Richland:0.0725,
  Ross:0.0725,Sandusky:0.0725,Scioto:0.0725,Seneca:0.0725,Shelby:0.0725,
  Stark:0.065,Summit:0.0675,Trumbull:0.0725,Tuscarawas:0.0725,Union:0.07,
  VanWert:0.0725,Vinton:0.0725,Warren:0.0675,Washington:0.0725,Wayne:0.0675,
  Williams:0.0725,Wood:0.0675,Wyandot:0.0725,
};

const OH_ZIP3_TO_COUNTY = {
  '430':'Franklin','431':'Franklin','432':'Franklin','433':'Marion','434':'Wood',
  '435':'Defiance','436':'Lucas','437':'Muskingum','438':'Coshocton',
  '440':'Lorain','441':'Cuyahoga','442':'Summit','443':'Summit',
  '444':'Mahoning','445':'Mahoning','446':'Stark','447':'Stark','448':'Stark',
  '449':'Richland',
  '450':'Hamilton','451':'Clermont','452':'Hamilton','453':'Miami','454':'Montgomery',
  '455':'Clark','456':'Ross','457':'Athens','458':'Allen','459':'Allen',
};

const IL_ZIP3_RATES = {
  '600':0.0825,'601':0.0725,'602':0.0725,'603':0.07,'604':0.0825,'605':0.0725,
  '606':0.1025,'607':0.1025,'608':0.0825,'609':0.075,
  '610':0.0825,'611':0.08,'612':0.0825,'613':0.0625,'614':0.085,'615':0.085,
  '616':0.0825,'617':0.0625,'618':0.0725,'619':0.0725,
  '620':0.0835,'621':0.0725,'622':0.0625,'623':0.085,'624':0.085,'625':0.09,
  '626':0.085,'627':0.085,'628':0.0625,'629':0.0725,
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

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
  const country = String(request?.cf?.country || request?.headers?.get('CF-IPCountry') || 'US').trim().toUpperCase();
  if (country !== 'US') return '';
  const candidates = [
    request?.cf?.regionCode,
    request?.cf?.region,
    request?.headers?.get('CF-Region-Code'),
    request?.headers?.get('CF-Region'),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeStateCode(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function getTaxRateForAddress(address, env, request, dbOverrides = {}) {
  const country = String(address?.country || 'US').trim().toUpperCase();
  if (country !== 'US') return { stateCode: '', taxRate: 0 };
  const stateCode = normalizeStateCode(address?.state) || detectUsStateFromRequest(request);
  const configuredRates = parseConfiguredStateRates(env.STATE_TAX_RATES || env.SALES_TAX_BY_STATE || env.TAX_RATES_BY_STATE);
  const ohCounty = { ...OH_COUNTY_RATES, ...(dbOverrides.ohCountyRates || {}) };
  const ilZip3   = { ...IL_ZIP3_RATES,   ...(dbOverrides.ilZip3Rates   || {}) };
  const flat     = { KY: 0.06, IN: 0.07, ...(dbOverrides.flatRates     || {}) };
  const mergedRates = { ...DEFAULT_US_STATE_TAX_RATES, ...configuredRates, ...(dbOverrides.stateRates || {}) };
  const fallbackRate = normalizeRate(env.DEFAULT_SALES_TAX_RATE) ?? 0;

  if (!stateCode) return { stateCode: '', taxRate: fallbackRate };

  // KY/IN: flat statewide rates, no county add-ons
  if (flat[stateCode] !== undefined) return { stateCode, taxRate: flat[stateCode] };

  const zip = String(address?.zip || address?.postal_code || '').replace(/\D/g, '');

  // Ohio: county-level lookup via ZIP3 prefix
  if (stateCode === 'OH' && zip.length >= 3) {
    const county = OH_ZIP3_TO_COUNTY[zip.slice(0, 3)];
    const taxRate = (county && ohCounty[county]) ? ohCounty[county] : (mergedRates.OH || 0.0725);
    return { stateCode, taxRate };
  }

  // Illinois: ZIP3-level lookup
  if (stateCode === 'IL' && zip.length >= 3) {
    const taxRate = ilZip3[zip.slice(0, 3)] ?? (mergedRates.IL || 0.0625);
    return { stateCode, taxRate };
  }

  const taxRate = mergedRates[stateCode] ?? fallbackRate;
  return { stateCode, taxRate };
}

function toCents(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed * 100);
}

function parseCents(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed);
}

function parseQuantity(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 99);
}

function generateOrderNumber() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % 36]).join('');
}

function base64UrlEncode(value) {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return base64UrlEncode(binary);
}

function base64UrlDecode(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value || '').length / 4) * 4, '=');
  return atob(padded);
}

async function hmacSha256(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function safeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

async function verifySignedRateToken(rate, address, env, expectedParcelWeight = '') {
  if (!rate?.rateToken) return null;
  const secret = env.CHECKOUT_RATE_SECRET;
  if (!secret) return null;

  const [body, sig] = String(rate.rateToken).split('.');
  if (!body || !sig) return null;

  const expected = await hmacSha256(body, secret);
  if (!safeEqual(expected, sig)) return null;

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(body));
  } catch (_) {
    return null;
  }

  if (!payload?.rateId || Number(payload.exp || 0) < Date.now()) return null;
  if (String(payload.rateId) !== String(rate.objectId || '')) return null;
  if (String(payload.amount) !== String(rate.amount || '')) return null;
  if (normalizeStateCode(payload.state) !== normalizeStateCode(address?.state)) return null;
  if (String(payload.zip || '').trim() !== String(address?.zip || '').trim()) return null;
  if (String(payload.country || 'US').toUpperCase() !== String(address?.country || 'US').toUpperCase()) return null;
  if (payload.parcelWeight && expectedParcelWeight && String(payload.parcelWeight) !== String(expectedParcelWeight)) return null;

  return payload;
}

function catalogHeaders(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
  if (!env.SUPABASE_URL || !key) return null;
  return { apikey: key, Authorization: `Bearer ${key}` };
}

async function fetchProductByFilter(env, filterKey, filterValue) {
  const headers = catalogHeaders(env);
  if (!headers) throw new Error('Catalog pricing is not configured.');
  const url = `${env.SUPABASE_URL}/rest/v1/products?select=*&${filterKey}=eq.${encodeURIComponent(filterValue)}&limit=1`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) return null;
  const rows = await resp.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function fetchSizeStockQty(env, productId, size, colorName) {
  const headers = catalogHeaders(env);
  if (!headers || !productId || !size) return null;
  let url = `${env.SUPABASE_URL}/rest/v1/product_sizes?select=stock_quantity&product_id=eq.${encodeURIComponent(productId)}&size=eq.${encodeURIComponent(size)}`;
  if (colorName) url += `&color_name=eq.${encodeURIComponent(colorName)}`;
  url += '&limit=1';
  const resp = await fetch(url, { headers }).catch(() => null);
  if (!resp || !resp.ok) return null;
  const rows = await resp.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length) return null;
  const qty = rows[0]?.stock_quantity;
  return typeof qty === 'number' ? qty : null;
}

async function verifyAccessToken(accessToken, env) {
  const token = String(accessToken || '').trim();
  if (!token || !env.SUPABASE_URL) return null;
  const apiKey = env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!apiKey) return null;
  const resp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: apiKey, Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return null;
  return resp.json().catch(() => null);
}

async function resolveCatalogItems(items, env, isMember) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Missing cart items.');
  if (items.length > 25) throw new Error('Cart has too many line items.');

  const resolved = [];
  for (const raw of items) {
    const productId = String(raw?.productId || raw?.id || '').trim();
    const sku = String(raw?.sku || '').trim();
    let product = null;

    if (productId) product = await fetchProductByFilter(env, 'id', productId);
    if (!product && sku) product = await fetchProductByFilter(env, 'sku', sku);
    if (!product) throw new Error(`Product is no longer available: ${raw?.title || raw?.name || productId || sku || 'unknown item'}`);

    const regularCents = toCents(product.current_price ?? product.price);
    const memberCents = toCents(product.member_price);
    const priceCents = isMember && memberCents > 0 && (!regularCents || memberCents < regularCents)
      ? memberCents
      : regularCents;
    if (priceCents <= 0) throw new Error(`Product has no checkout price: ${product.title || product.name || product.id}`);

    const itemSize = String(raw?.size || '').trim();
    const itemQty = parseQuantity(raw?.quantity);

    if (itemSize) {
      const available = await fetchSizeStockQty(env, product.id, itemSize, String(raw?.colorName || '').trim() || null);
      if (available !== null && available < itemQty) {
        const name = product.title || product.name || 'An item';
        throw new Error(
          available <= 0
            ? `${name} (${itemSize}) is out of stock.`
            : `Only ${available} left in stock for ${name} (${itemSize}).`
        );
      }
    }

    resolved.push({
      productId: product.id,
      sku: sku || product.sku || '',
      name: product.title || product.name || raw?.title || raw?.name || 'Product',
      size: itemSize,
      colorName: String(raw?.colorName || '').trim(),
      quantity: itemQty,
      amount: priceCents,
      shippingWeightLb: Number.parseFloat(product.shipping_weight_lb) || Number.parseFloat(raw?.weightLb) || 0.5,
      image: product.image_url || raw?.image || raw?.imageUrl || raw?.img || '',
    });
  }

  return resolved;
}

function getShippingPolicy(env) {
  const threshold = Number(env.FREE_SHIPPING_THRESHOLD || env.SHIPPING_FREE_THRESHOLD || 100);
  const standardCents = parseCents(env.STANDARD_SHIPPING_CENTS || env.DEFAULT_SHIPPING_CENTS) || Math.round(Number(env.STANDARD_SHIPPING_RATE || env.DEFAULT_SHIPPING_RATE || 8) * 100);
  return {
    thresholdCents: Number.isFinite(threshold) && threshold > 0 ? Math.round(threshold * 100) : 10000,
    standardCents: standardCents > 0 ? standardCents : 800,
  };
}

async function getPromotionForCode(env, code) {
  const normalized = normalizePromoCode(code);
  if (!normalized) return null;
  const config = sanitizeCommerceConfig(await getSetting(env, 'commerce_config', {}));
  const promotion = config.promotions.find((promotion) => normalizePromoCode(promotion.code) === normalized) || null;
  if (!promotion) return null;

  // Validate active status
  if (promotion.active === false) return null;

  // Validate expiration date
  if (promotion.expirationDate) {
    const now = new Date();
    const expiry = new Date(promotion.expirationDate + 'T23:59:59');
    if (now > expiry) return null;
  }

  // Validate usage limit
  if (promotion.maxUsage !== undefined && promotion.maxUsage !== null && promotion.maxUsage !== '') {
    const max = parseInt(promotion.maxUsage, 10);
    const used = parseInt(promotion.usageCount || 0, 10);
    if (!isNaN(max) && used >= max) return null;
  }

  return promotion;
}

function getExpectedParcelWeight(catalogItems) {
  const totalItems = catalogItems.reduce((sum, item) => sum + (item.quantity || 1), 0) || 1;
  const totalWeight = catalogItems.reduce(
    (sum, item) => sum + ((Number.parseFloat(item.shippingWeightLb) || 0.5) * (item.quantity || 1)),
    0
  );
  return totalWeight > 0 ? totalWeight.toFixed(2) : (0.5 + totalItems * 0.5).toFixed(1);
}

async function resolveShipping({ shippingRate, address, subtotalCents, catalogItems, env }) {
  const policy = getShippingPolicy(env);
  const qualifiesFree = subtotalCents >= policy.thresholdCents;
  const signedRate = await verifySignedRateToken(shippingRate, address, env, getExpectedParcelWeight(catalogItems || []));
  const rateAmountCents = signedRate ? toCents(signedRate.amount) : 0;

  if (shippingRate?.objectId && !signedRate && !qualifiesFree) {
    // Only throw when CHECKOUT_RATE_SECRET is configured — without a secret, token
    // signing is disabled so signedRate is always null (not a real expiry).
    if (env.CHECKOUT_RATE_SECRET) {
      throw new Error('Selected shipping rate expired. Please reload shipping options.');
    }
  }

  // Without a verified token, fall back to the client-sent rate amount rather than
  // the policy standard rate, so customers pay the Shippo-quoted price.
  const fallbackCents = shippingRate?.amount ? toCents(shippingRate.amount) : 0;
  const actualShippingCents = signedRate
    ? rateAmountCents
    : (shippingRate?.objectId ? fallbackCents : policy.standardCents);
  const shippingCents = qualifiesFree ? 0 : actualShippingCents;

  return {
    qualifiesFree,
    signedRate,
    actualShippingCents,
    shippingCents,
    provider: signedRate?.provider || shippingRate?.provider || '',
    servicelevel: signedRate?.servicelevel || shippingRate?.servicelevel || '',
    rateObjectId: signedRate?.rateId || shippingRate?.objectId || '',
  };
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: CORS(env) });
}

export async function onRequestPost({ request, env }) {
  const headers = CORS(env);

  try {
    if (!env.STRIPE_SECRET_KEY) return json({ error: 'Stripe is not configured.' }, 500, headers);

    const body = await request.json();
    const { items, shippingRate, address = {}, promoCode = '' } = body;

    if (!items?.length || !address?.email) {
      return json({ error: 'Missing required fields: items and address.email' }, 400, headers);
    }

    const verifiedUser = await verifyAccessToken(body.accessToken || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, ''), env);
    const isMember = Boolean(verifiedUser?.id);
    const catalogItems = await resolveCatalogItems(items, env, isMember);
    const subtotalCents = catalogItems.reduce((sum, item) => sum + item.amount * item.quantity, 0);
    const shipping = await resolveShipping({ shippingRate, address, subtotalCents, catalogItems, env });
    const promotion = await getPromotionForCode(env, promoCode);
    const normalizedPromoCode = promotion ? normalizePromoCode(promotion.code) : normalizePromoCode(promoCode);
    const discountCents = computePromotionDiscount(promotion, subtotalCents, shipping.shippingCents, catalogItems);
    const discountedSubtotalCents = Math.max(0, subtotalCents - discountCents);
    const taxSettings = await fetchSiteSettings(['tax_rate_overrides'], env);
    const dbOverrides = (() => { try { const v = taxSettings.tax_rate_overrides; return (v && typeof v === 'object') ? v : JSON.parse(v || '{}'); } catch (_) { return {}; } })();
    const { stateCode: taxStateCode, taxRate } = getTaxRateForAddress(address, env, request, dbOverrides);
    const taxCents = discountedSubtotalCents > 0 ? Math.round(discountedSubtotalCents * taxRate) : 0;
    const totalCents = discountedSubtotalCents + shipping.shippingCents + taxCents;

    if (totalCents <= 0) return json({ error: 'Invalid payment amount.' }, 400, headers);

    // Stripe limits each metadata value to 500 chars. product_id (36-char UUID)
    // and tax_behavior are omitted — product_id is already in `inv` below.
    const lineItems = catalogItems.map((item) => ({
      sku:      item.sku,
      name:     item.name,
      size:     item.size,
      color:    item.colorName,
      amount:   item.amount,
      quantity: item.quantity,
    }));

    // Guard: if still over 490 chars (large carts / long names), drop size+color,
    // then as a last resort truncate names. Webhook only requires name/sku/amount/qty.
    let metaItems = JSON.stringify(lineItems);
    if (metaItems.length > 490) {
      metaItems = JSON.stringify(lineItems.map(({ sku, name, amount, quantity }) => ({ sku, name, amount, quantity })));
    }
    if (metaItems.length > 490) {
      metaItems = JSON.stringify(lineItems.map(({ sku, name, amount, quantity }) => ({ sku, name: name.slice(0, 28), amount, quantity })));
    }

    const inventoryItems = catalogItems.map((item) => ({
      p: String(item.productId || ''),
      s: String(item.size || ''),
      q: item.quantity || 1,
      c: String(item.colorName || ''),
    }));

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
    const paymentIntent = await stripe.paymentIntents.create(
      {
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
          actual_shipping_cost_cents: String(shipping.actualShippingCents),
          charged_shipping_cents: String(shipping.shippingCents),
          free_shipping: String(shipping.qualifiesFree),
          tax_state: taxStateCode,
          tax_rate_bps: String(Math.round(taxRate * 10000)),
          tax_amount_cents: String(taxCents),
          total_amount_cents: String(totalCents),
          ship_line1: address.line1 || '',
          ship_line2: address.line2 || '',
          ship_city: address.city || '',
          ship_state: address.state || '',
          ship_zip: address.zip || '',
          ship_country: address.country || 'US',
        },
      },
      { idempotencyKey }
    );

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
    console.error('create-payment-intent error:', e);
    return json({ error: e.message || 'Could not create payment.' }, 500, headers);
  }
}
