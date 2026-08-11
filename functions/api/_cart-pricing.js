/**
 * _cart-pricing.js — what the cart is actually worth, decided here.
 *
 * Lifted OUT of create-payment-intent.js unchanged. It lived there because
 * Stripe was the only processor, and leaving it there would have forced a
 * second processor to either import the Stripe route — dragging the whole
 * Stripe SDK into a worker that has no use for it — or reimplement pricing.
 *
 * The second option is the one that matters. Two implementations of "what does
 * this cart cost" drift, and they drift silently: nobody notices PayPal is
 * charging pre-discount until a customer does. A fallback processor that
 * computes a different total is worse than no fallback at all.
 *
 * The first option is quietly fatal too. The entire point of the alternative
 * processor is to still work when Stripe does not, so it must not fail to boot
 * because a Stripe import failed.
 *
 * So: every processor calls quoteCart(). The browser sends cart display data;
 * prices, stock, shipping eligibility, promotions and tax are settled here
 * against the catalog, and a client that lies is simply ignored.
 *
 * Nothing in this file knows a processor exists.
 */

import {
  computePromotionDiscount,
  getSetting,
  normalizePromoCode,
  sanitizeCommerceConfig,
} from './_commerce.js';
import { fetchSiteSettings } from './_settings.js';
import { normalizeStateCode, resolveTax } from './_tax.js';

import { messagesFrom, shippedMessages } from './_messages.js';
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
export function cartError(message, status) {
  const e = new Error(message);
  e.zwStatus = status;
  return e;
}

export function toCents(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed * 100);
}

function parseCents(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed);
}

export function parseQuantity(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 99);
}

export function generateOrderNumber() {
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

export async function sha256Base64Url(value) {
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

/* Size labels are written inconsistently — the size button renders "XXL" while
   the inventory row may say "2XL". product.html folds them before comparing;
   this is the same fold, so the two agree. Without it the server compares raw
   strings and a size that displays as in stock is refused at the till. */
function canonSize(value) {
  const s = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^([2-5])x(s|l)$/);          // 2xl → xxl, 3xs → xxxs
  if (m) return 'x'.repeat(Number(m[1])) + m[2];
  const r = s.match(/^(x{2,5})(s|l)$/);          // already xxl form
  if (r) return r[1] + r[2];
  return s;
}

/* How much of this size, in this colour, is actually on the shelf.
 *
 * THIS MUST AGREE WITH sizeStockForColor() IN product.html. It did not, and the
 * disagreement was customer-visible: the page offered "Only 1 left in stock",
 * the shopper added it, and checkout answered "is out of stock." Three separate
 * divergences could each produce that, and all three are fixed here:
 *
 *   - the colour was matched with PostgREST eq, which is case- and
 *     whitespace-sensitive. The page lowercases both sides first, so "Yellow"
 *     in the cart against "yellow" in the row matched on the page and missed
 *     on the server.
 *   - a missed colour then fell back to the OLDEST row for that size in ANY
 *     colour. That is wrong in both directions: it can report a sold-out
 *     colourway's stock for one that has plenty (blocking a real sale, which is
 *     what happened here) and equally report a stocked colourway's for one that
 *     is empty, overselling it.
 *   - limit=1 read a single row where the page SUMS them, so a size split
 *     across rows read low.
 *
 * So the rows are fetched once and reduced here, by the page's rules. One
 * algorithm, expressed twice, is what caused this; the fix is for the server's
 * copy to be a faithful port rather than an approximation of it.
 *
 * Returns null only when availability is genuinely unknown (no inventory rows
 * at all, or the lookup failed) — the caller reads null as "no guard", matching
 * the page, which lets a product with no inventory configured be bought. Rows
 * that exist but do not match return 0, which blocks. */
async function fetchSizeStockQty(env, productId, size, colorName) {
  const headers = catalogHeaders(env);
  if (!headers || !productId || !size) return null;

  /* Asked for defensively, for the same reason /api/stock does: if the database
     rejects a SELECT naming color_name, the old code returned null and null
     means "availability unknown", which SKIPS THE STOCK GUARD ENTIRELY. A
     rejected query would quietly stop protecting inventory on the one path that
     takes money. Retrying without the column costs colour precision; not
     retrying costs oversells nobody would notice until fulfilment. */
  const base = `${env.SUPABASE_URL}/rest/v1/product_sizes`
    + `?product_id=eq.${encodeURIComponent(productId)}&select=size,stock_quantity`;
  const get = async (cols) => {
    const r = await fetch(base + cols, { headers, cache: 'no-store' }).catch(() => null);
    if (!r) return null;
    if (r.ok) return r.json().catch(() => []);
    console.error(`fetchSizeStockQty: SELECT${cols} rejected (${r.status})`);
    return undefined;                      // rejected, as distinct from unreachable
  };

  let all = await get(',color_name');
  if (all === undefined) all = await get('');   // retry colour-blind rather than give up
  if (all === undefined || all === null) return null;
  /* No inventory configured for this product at all — not "sold out". The page
     enables Add to Bag in exactly this case, so refusing here would block a
     sale the store never said was limited. */
  if (!Array.isArray(all) || all.length === 0) return null;

  const wanted = canonSize(size);
  const rows = all.filter((r) => canonSize(r?.size) === wanted);
  if (!rows.length) return 0;

  const sum = (list) => list.reduce((s, r) => s + (Number(r?.stock_quantity) || 0), 0);
  const norm = (v) => String(v || '').trim().toLowerCase();

  if (colorName) {
    const colorRows = rows.filter((r) => norm(r.color_name) === norm(colorName));
    if (colorRows.length) return sum(colorRows);
    /* Legacy products save stock colour-agnostically (color_name NULL). Those
       rows cover every colourway, so they are the correct fallback — unlike
       another colour's rows, which describe a different garment. */
    const nullRows = rows.filter((r) => !r.color_name);
    return nullRows.length ? sum(nullRows) : 0;
  }

  const nullRows = rows.filter((r) => !r.color_name);
  return nullRows.length ? sum(nullRows) : sum(rows);
}

export async function verifyAccessToken(accessToken, env) {
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

/* limitToStock defaults TRUE on every path that forgets to pass it. The setting
   permits overselling, so the unsafe value must be the one you have to ask for
   — a caller that omits it gets the guard, not a store quietly taking orders it
   cannot fill. */
export async function resolveCatalogItems(items, env, isMember, limitToStock = true, say = shippedMessages) {
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
    if (!product) throw cartError(say('checkoutUnavailable', { title: raw?.title || raw?.name || productId || sku || 'unknown item' }), 409);

    const regularCents = toCents(product.current_price ?? product.price);
    const memberCents = toCents(product.member_price);
    const priceCents = isMember && memberCents > 0 && (!regularCents || memberCents < regularCents)
      ? memberCents
      : regularCents;
    /* A merchant data problem rather than a shopper one, but the shopper is the
       one standing at the till and the item genuinely cannot be sold, so it is
       reported as a cart conflict. It stays loud in the logs either way. */
    if (priceCents <= 0) throw cartError(say('checkoutNoPrice', { title: product.title || product.name || product.id }), 409);

    /* NEVER CHARGE MORE THAN WAS SHOWN.
     *
     * The bag showed $35 and this path charged $40 — the bag had applied member
     * pricing and the server had not, because the access token did not verify.
     * Nothing anywhere compared the two, so the shopper was billed a figure
     * they had never been quoted, silently.
     *
     * The cart already sends the price it displayed on every line, so the check
     * needs nothing from the client that it was not already sending. The rule
     * is one-directional on purpose:
     *
     *   server price HIGHER than displayed  → refuse. Billing above the quote
     *     is the harm, and it is the direction a stale price, an expired
     *     session or a mispriced product all point in.
     *   server price LOWER  → proceed, and charge the lower one. The shopper
     *     benefits and there is nothing to protect them from.
     *
     * Not exploitable by sending a tiny displayed price: the charge is always
     * the SERVER's figure, and understating the display only earns a refusal.
     * A cent of tolerance absorbs float-to-cents rounding in the browser. */
    const shownCents = toCents(raw?.price);
    if (shownCents > 0 && priceCents > shownCents + 1) {
      const label = product.title || product.name || 'An item';
      console.error(
        `PRICE MISMATCH ${product.id} (${label}): shown ${shownCents}c, would charge ${priceCents}c` +
        `${isMember ? ' [member]' : ' [non-member]'} — refused rather than billing above the quote.`
      );
      throw cartError(say('checkoutPriceChanged', { title: label }), 409);
    }

    const itemSize = String(raw?.size || '').trim();
    const itemQty = parseQuantity(raw?.quantity);

    if (itemSize && limitToStock) {
      const available = await fetchSizeStockQty(env, product.id, itemSize, String(raw?.colorName || '').trim() || null);
      if (available !== null && available < itemQty) {
        const name = product.title || product.name || 'An item';
        /* The SAME message the product page and the bag use for a sold-out
           line. It had its own wording here, which is how a shopper could read
           "Only 1 left" on one screen and a differently-phrased refusal on the
           next. */
        throw cartError(
          available <= 0
            ? say('soldOutItem', { title: name, size: itemSize })
            : say('checkoutNotEnough', { count: available, title: name, size: itemSize }),
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

export function getExpectedParcelWeight(catalogItems) {
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

export async function resolveShipping({ shippingRate, address, subtotalCents, catalogItems, env, deliveryMethod, say = shippedMessages }) {
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
      throw cartError(say('checkoutRateExpired'), 409);
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
    throw cartError(say('checkoutRateInvalid'), 400);
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

/* The one trusted quote. Every processor asks this and none of them price
   anything themselves.

   It returns the pieces rather than a total, because a processor needs the
   breakdown: Stripe stamps it into PaymentIntent metadata, PayPal has to send
   an itemised amount whose parts must sum exactly or the API rejects the order,
   and the webhook writes it to the order record. A single number would force
   each of them to re-derive the split, which is the drift this file exists to
   prevent.

   Throws cartError() for anything the shopper can fix — the caller's catch is
   expected to honour e.zwStatus so a sold-out size stays a 409 rather than
   becoming a fake server outage. */
export async function quoteCart({ items, address = {}, shippingRate, promoCode = '', deliveryMethod = '', accessToken = '', env, request }) {
  const verifiedUser = await verifyAccessToken(accessToken, env);
  const isMember = Boolean(verifiedUser?.id);

  /* Admin → Commerce may permit ordering beyond stock (backorders). Read here
     rather than in the loop so one setting read covers the whole cart, and
     defaulted ON so an unreadable setting cannot become permission to oversell.
     The storefront reads the same value off /api/stock, so the quantity a
     shopper is allowed to pick and the quantity checkout accepts come from one
     switch — the two disagreeing is what "Only 1 left" then "out of stock" was. */
  /* One settings read covers both the rule and the words it is explained in.
     Two reads would let them arrive out of step, and this is the request that
     takes money. */
  const { limitToStock, say } = await (async () => {
    try {
      const cfg = sanitizeCommerceConfig(await getSetting(env, 'commerce_config', {}));
      return {
        limitToStock: cfg?.customerExperience?.limitQtyToStock !== false,
        say: messagesFrom(cfg),
      };
    } catch (_) {
      // Unreadable settings must not become permission to oversell, nor silence.
      return { limitToStock: true, say: shippedMessages };
    }
  })();

  const catalogItems = await resolveCatalogItems(items, env, isMember, limitToStock, say);
  const subtotalCents = catalogItems.reduce((sum, item) => sum + item.amount * item.quantity, 0);
  const shipping = await resolveShipping({ shippingRate, address, subtotalCents, catalogItems, env, deliveryMethod, say });

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
  /* The cart as lines the provider can price individually, scaled to what is
     actually being charged after any promo.

     Both halves matter. Per-item rules need real lines — New York exempts
     clothing under $110 A GARMENT, so three $80 shirts are exempt and one $240
     line is not, and only one of those is true. And the lines have to add up to
     the discounted total, or the provider taxes money nobody paid. The last
     line absorbs the rounding remainder so the sum is exact rather than a cent
     out, which over a year of orders is a reconciliation someone has to do by
     hand.

     Engines that cannot take lines (the table, Zip-Tax) ignore this entirely. */
  const taxLineItems = (() => {
    if (!catalogItems.length || subtotalCents <= 0) return null;
    const lines = catalogItems.map((item) => ({
      sku: item.sku,
      name: item.name,
      quantity: item.quantity || 1,
      amountTotal: Math.round(item.amount * (item.quantity || 1) * (discountedSubtotalCents / subtotalCents)),
      /* What it is, in our vocabulary — each engine maps it to its own code. */
      taxCategory: item.taxCategory || '',
    }));
    const allocated = lines.reduce((sum, l) => sum + l.amountTotal, 0);
    const remainder = discountedSubtotalCents - allocated;
    if (remainder !== 0 && lines.length) lines[lines.length - 1].amountTotal += remainder;
    return lines.filter((l) => l.amountTotal > 0);
  })();

  const tax = await resolveTax({
    env, request, address, dbOverrides,
    taxableCents: discountedSubtotalCents,
    shippingCents: shipping.shippingCents,
    lineItems: taxLineItems,
  });

  const totalCents = discountedSubtotalCents + shipping.shippingCents + tax.taxCents;

  /* Two projections of the same items, both needed downstream by every
     processor: what the customer bought, and what to take off the shelf. */
  const lineItems = catalogItems.map((item) => ({
    sku: item.sku, name: item.name, size: item.size,
    color: item.colorName, amount: item.amount, quantity: item.quantity,
  }));
  const inventoryItems = catalogItems.map((item) => ({
    p: String(item.productId || ''), s: String(item.size || ''),
    q: item.quantity || 1, c: String(item.colorName || ''),
  }));

  return {
    verifiedUser, isMember, catalogItems, lineItems, inventoryItems,
    subtotalCents, shipping, promotion, normalizedPromoCode, discountCents,
    discountedSubtotalCents, tax,
    taxStateCode: tax.stateCode, taxRate: tax.rate, taxCents: tax.taxCents,
    totalCents,
  };
}
