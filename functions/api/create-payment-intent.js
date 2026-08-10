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
  normalizePromoCode,
  sanitizeCommerceConfig,
} from './_commerce.js';
import { fetchSiteSettings } from './_settings.js';
import { normalizeStateCode, resolveTax } from './_tax.js';

/* A rejection the shopper caused and can fix, tagged with the status it should
   actually carry.

   Everything thrown in here used to land in one catch that answered 500, which
   made "your size sold out" indistinguishable from "Stripe is down" — to our
   own alerting, to any retry logic, and to anything that reads resp.ok before
   it reads the body. Out of stock is the single most ordinary reason a real
   checkout is refused, so the most common legitimate outcome was reporting
   itself as a server fault.

   The status rides on the error rather than being recovered later by matching
   the message, because the thrower is the only place that knows which kind it
   is. Untagged stays 500: a fault we did not anticipate is a fault, and this
   must never launder an unexpected throw into a tidy 4xx. */
function cartError(message, status) {
  const e = new Error(message);
  e.zwStatus = status;
  return e;
}

const CORS = (env) => ({
  'Access-Control-Allow-Origin': env.SITE_URL || 'https://zuwera.store',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
});

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
  // Provider + Veeqo booking id must match what was signed, so the webhook buys
  // the label from the right carrier and a rate can't be swapped between sources.
  if (String(payload.source || 'shippo') !== String(rate.source || 'shippo')) return null;
  if (String(payload.remoteShipmentId || '') !== String(rate.remoteShipmentId || '')) return null;

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
  const base = `${env.SUPABASE_URL}/rest/v1/product_sizes?select=stock_quantity&product_id=eq.${encodeURIComponent(productId)}&size=eq.${encodeURIComponent(size)}`;
  const q = async (url) => {
    const resp = await fetch(url, { headers, cache: 'no-store' }).catch(() => null);
    if (!resp || !resp.ok) return null;
    const rows = await resp.json().catch(() => []);
    return Array.isArray(rows) && rows.length ? rows : null;
  };
  // Try an exact colour match first; if none exists, fall back to the product+size
  // row regardless of colour. Stock is saved color-agnostically (color_name NULL),
  // so without this fallback the colour filter matches nothing → returns null →
  // the stock guard is skipped and a sold-out item can be oversold. Mirrors the
  // decrement_stock RPC's fallback so availability and decrement stay consistent.
  let rows = colorName ? await q(`${base}&color_name=eq.${encodeURIComponent(colorName)}&limit=1`) : null;
  if (!rows) rows = await q(`${base}&order=created_at.asc&limit=1`);
  if (!rows) return null;
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
  if (!Array.isArray(items) || items.length === 0) throw cartError('Missing cart items.', 400);
  if (items.length > 25) throw cartError('Cart has too many line items.', 400);

  const resolved = [];
  for (const raw of items) {
    const productId = String(raw?.productId || raw?.id || '').trim();
    const sku = String(raw?.sku || '').trim();
    let product = null;

    if (productId) product = await fetchProductByFilter(env, 'id', productId);
    if (!product && sku) product = await fetchProductByFilter(env, 'sku', sku);
    /* 409, not 404: the request is well-formed and the route is right — it is
       the cart that has gone stale against the catalog. */
    if (!product) throw cartError(`Product is no longer available: ${raw?.title || raw?.name || productId || sku || 'unknown item'}`, 409);

    const regularCents = toCents(product.current_price ?? product.price);
    const memberCents = toCents(product.member_price);
    const priceCents = isMember && memberCents > 0 && (!regularCents || memberCents < regularCents)
      ? memberCents
      : regularCents;
    /* A merchant data problem rather than a shopper one, but the shopper is the
       one standing at the till and the item genuinely cannot be sold, so it is
       reported as a cart conflict. It stays loud in the logs either way. */
    if (priceCents <= 0) throw cartError(`Product has no checkout price: ${product.title || product.name || product.id}`, 409);

    const itemSize = String(raw?.size || '').trim();
    const itemQty = parseQuantity(raw?.quantity);

    if (itemSize) {
      const available = await fetchSizeStockQty(env, product.id, itemSize, String(raw?.colorName || '').trim() || null);
      if (available !== null && available < itemQty) {
        const name = product.title || product.name || 'An item';
        throw cartError(
          available <= 0
            ? `${name} (${itemSize}) is out of stock.`
            : `Only ${available} left in stock for ${name} (${itemSize}).`,
          409
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

async function getLocalDeliveryConfig(env) {
  try {
    const config = sanitizeCommerceConfig(await getSetting(env, 'commerce_config', {}));
    return config.localDelivery || { enabled: false, zips: [] };
  } catch (_) {
    return { enabled: false, zips: [] };
  }
}

async function resolveShipping({ shippingRate, address, subtotalCents, catalogItems, env, deliveryMethod }) {
  const policy = getShippingPolicy(env);
  const qualifiesFree = subtotalCents >= policy.thresholdCents;

  // Campus hand-delivery: free shipping, but ONLY when the order's ZIP is on the
  // admin-managed allow-list. Server-authoritative — a forged deliveryMethod can
  // never unlock free shipping for a normal mail order.
  if (deliveryMethod === 'hand_delivery') {
    const ld = await getLocalDeliveryConfig(env);
    const zip = String(address?.zip || '').trim().slice(0, 5);
    if (ld.enabled && Array.isArray(ld.zips) && ld.zips.includes(zip)) {
      return { qualifiesFree, handDelivery: true, signedRate: null, actualShippingCents: 0, shippingCents: 0, provider: '', servicelevel: '', rateObjectId: '', source: '', remoteShipmentId: '' };
    }
    // Not eligible → fall through and charge normal shipping (ignore the flag).
  }

  const signedRate = await verifySignedRateToken(shippingRate, address, env, getExpectedParcelWeight(catalogItems || []));
  const rateAmountCents = signedRate ? toCents(signedRate.amount) : 0;

  if (shippingRate?.objectId && !signedRate && !qualifiesFree) {
    // Only throw when CHECKOUT_RATE_SECRET is configured — without a secret, token
    // signing is disabled so signedRate is always null (not a real expiry).
    if (env.CHECKOUT_RATE_SECRET) {
      throw cartError('Selected shipping rate expired. Please reload shipping options.', 409);
    }
  }

  // Without a verified (signed) token we fall back to the client-sent rate so customers
  // pay the exact Shippo-quoted price — BUT a real rate is never $0 or negative, so a
  // zeroed/tampered amount is rejected rather than trusted (closes the "$0 shipping"
  // exploit). Set CHECKOUT_RATE_SECRET to sign+verify rates and reject ALL unsigned ones.
  const fallbackCents = shippingRate?.amount ? toCents(shippingRate.amount) : 0;
  if (shippingRate?.objectId && !signedRate && !qualifiesFree && fallbackCents <= 0) {
    /* 400 rather than 409: a zeroed rate is not a stale cart, it is a rejected
       input — and the one case here that may be someone probing the $0-shipping
       exploit above. Worth keeping distinguishable from ordinary staleness. */
    throw cartError('Invalid shipping rate — please reload shipping options.', 400);
  }
  const actualShippingCents = signedRate
    ? rateAmountCents
    : (shippingRate?.objectId ? fallbackCents : policy.standardCents);
  const shippingCents = qualifiesFree ? 0 : actualShippingCents;

  return {
    qualifiesFree,
    handDelivery: false,
    signedRate,
    actualShippingCents,
    shippingCents,
    provider: signedRate?.provider || shippingRate?.provider || '',
    servicelevel: signedRate?.servicelevel || shippingRate?.servicelevel || '',
    rateObjectId: signedRate?.rateId || shippingRate?.objectId || '',
    source: signedRate?.source || shippingRate?.source || 'shippo',
    remoteShipmentId: signedRate?.remoteShipmentId || shippingRate?.remoteShipmentId || '',
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

    const verifiedUser = await verifyAccessToken(body.accessToken || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, ''), env);
    const isMember = Boolean(verifiedUser?.id);
    const catalogItems = await resolveCatalogItems(items, env, isMember);
    const subtotalCents = catalogItems.reduce((sum, item) => sum + item.amount * item.quantity, 0);
    const shipping = await resolveShipping({ shippingRate, address, subtotalCents, catalogItems, env, deliveryMethod });
    const promotion = await getPromotionForCode(env, promoCode);
    const normalizedPromoCode = promotion ? normalizePromoCode(promotion.code) : normalizePromoCode(promoCode);
    const discountCents = computePromotionDiscount(promotion, subtotalCents, shipping.shippingCents, catalogItems);
    const discountedSubtotalCents = Math.max(0, subtotalCents - discountCents);
    const taxSettings = await fetchSiteSettings(['tax_rate_overrides'], env);
    const dbOverrides = (() => { try { const v = taxSettings.tax_rate_overrides; return (v && typeof v === 'object') ? v : JSON.parse(v || '{}'); } catch (_) { return {}; } })();
    /* Whichever engine the Tax page is set to — the built-in table by default,
       so a store that never touches the setting prices exactly as it always
       has. resolveTax never throws: an external provider that is slow or down
       falls back to the table and says so, because a tax API must not be able
       to stand between a customer and paying. */
    const tax = await resolveTax({
      env, request, address, dbOverrides,
      taxableCents: discountedSubtotalCents,
      shippingCents: shipping.shippingCents,
    });
    const taxStateCode = tax.stateCode;
    const taxRate = tax.rate;
    const taxCents = tax.taxCents;
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
