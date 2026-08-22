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
import { resolveVariantPrice } from './_variant-price.js';
import { fetchPricingContext, resolvePrice, shopperFor, isWholesaleBuyer, wholesaleMinimumCents } from './_price-resolution.js';
import { storedValueEnabled, quoteAgainst } from './_stored-value.js';
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

/**
 * The order number. There is one of these, and this makes it.
 *
 * ── WHY THAT SENTENCE NEEDED WRITING ────────────────────────────────────────
 *
 * There used to be two. This one ran at payment time, went into the metadata,
 * and was the number printed on the customer's confirmation email. A SECOND one
 * in _fulfil.js then built `ZW-<category>-00001` from a row count and wrote THAT
 * to orders.order_number — so the number the customer had and the number the
 * database had were different strings for the same order, and the admin panel,
 * which reads the column, showed neither: the column was null on every real
 * order, because the category-based generator was skipped silently whenever the
 * first item's product had no category, which was always.
 *
 * The visible cost: a customer quoting the number from their own email could
 * not be found. guest-return.js matches on what the panel shows, so the guest
 * return form rejected people holding a correct order number.
 *
 * ── THE ALPHABET ────────────────────────────────────────────────────────────
 *
 * No vowels, so it cannot spell anything. No 0/1/O/I, because this gets read
 * down a phone line and typed by somebody who is already annoyed about their
 * order. Exactly the reasoning _stored-value.js uses for gift card codes, and
 * for exactly the same reason — it is the same act, a human reading a code
 * aloud to another human.
 *
 * ── AND THE LENGTH ──────────────────────────────────────────────────────────
 *
 * Ten characters of a 28-symbol alphabet is 2.9e14 possibilities. At ten
 * thousand orders the chance of any collision at all is about one in six
 * million. That matters because the column now carries a UNIQUE index: a
 * duplicate order number would point a refund or a return at the wrong order,
 * which is permanent, while a collision at these odds is not a thing that
 * happens. The insert path handles one anyway rather than trusting arithmetic.
 *
 * Modulo bias is not corrected: 256 % 28 leaves the first four symbols very
 * slightly likelier. That shifts the collision odds by a fraction of a percent
 * of an already negligible number, and this is an identifier, not a key.
 */
const ORDER_NO_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ';

export function generateOrderNumber() {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ORDER_NO_ALPHABET[b % ORDER_NO_ALPHABET.length]).join('');
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
/**
 * The colour row a cart line is for, or null.
 *
 * Only needed because a colourway may carry its own price (migration 0021).
 * Returning null means "price this from the product", which is both the correct
 * answer when the colour sets no price of its own and the correct FALLBACK when
 * this lookup cannot be made:
 *
 *   • Before 0021 is applied the columns do not exist and the SELECT is
 *     rejected. Falling back to the product price is exactly the behaviour that
 *     preceded this feature, and no colour can carry a price yet anyway.
 *   • If the lookup fails while a colour IS priced, the product price is used.
 *     Higher than shown → the never-bill-above-the-quote guard downstream
 *     refuses the sale loudly. Lower than shown → the shopper is charged less.
 *     Neither silently overcharges, which is the only outcome that matters.
 */
async function fetchColorVariant(env, productId, colorName) {
  const headers = catalogHeaders(env);
  const wanted = String(colorName || '').trim();
  if (!headers || !productId || !wanted) return null;

  const url = `${env.SUPABASE_URL}/rest/v1/color_variants`
    + `?product_id=eq.${encodeURIComponent(productId)}`
    + `&select=color_name,current_price,member_price,msrp`;
  const r = await fetch(url, { headers, cache: 'no-store' }).catch(() => null);
  if (!r) return null;
  if (!r.ok) {
    /* 400 here is the ordinary state until 0021 is applied, so it is a warning
       rather than an error — but it is logged, because after 0021 it would mean
       colour prices silently not applying. */
    console.warn(`fetchColorVariant: SELECT rejected (${r.status}) — pricing from the product`);
    return null;
  }
  const rows = await r.json().catch(() => []);
  if (!Array.isArray(rows)) return null;

  /* Matched case- and space-insensitively, the same way the cart's colour is
     compared everywhere else. "Bright Crimson" from a swatch and "bright
     crimson" from a stale bag entry are the same colourway. */
  const canon = (s) => String(s || '').trim().toLowerCase();
  return rows.find((row) => canon(row.color_name) === canon(wanted)) || null;
}

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
export async function resolveCatalogItems(items, env, isMember, limitToStock = true, say = shippedMessages, isWholesale = false) {
  if (!Array.isArray(items) || items.length === 0) throw cartError('Missing cart items.', 400);
  if (items.length > 25) throw cartError('Cart has too many line items.', 400);

  /* The pricing system (migration 0022), read ONCE for the whole cart rather
     than once per line — five lines used to mean five round trips before this
     existed, and the live set for a handful of products is one small query.

     Empty on any failure, and empty means "nothing overrides the catalogue".
     That is the only safe direction: the alternative is a store that cannot
     quote a price because a pricing table is briefly unavailable. */
  const pricingContext = await fetchPricingContext(
    env,
    items.map((i) => String(i?.productId || i?.id || '').trim()).filter(Boolean)
  );
  /* Wholesale rides the same resolver as every other group — see shopperFor.
     Defaulted false so every existing caller keeps pricing retail until it
     passes a value it has proved server-side. */
  const shopper = shopperFor({ isMember, isWholesale });

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

    /* What THIS COLOURWAY costs. Price used to be a product-level fact, so
       every colour of a product cost the same and none could be discounted on
       its own. A colour that sets its own price owns the whole set — regular,
       member and compare-at — because falling back field by field would let a
       $250 limited colour inherit the product's $35 member price. See
       _variant-price.js.

       Fetched by name rather than trusting anything the browser sent: the
       colour is the only part of a cart line that selects a PRICE, so it is now
       as load-bearing as the product id. */
    const colorVariant = await fetchColorVariant(env, product.id, raw?.colorName);

    /* One question, one answerer. resolvePrice consults the price lists first
       and falls back to exactly what resolveVariantPrice would have said, so
       the catalogue price remains the answer until somebody deliberately puts a
       row in the pricing system. */
    const priced = resolvePrice({
      product, variant: colorVariant,
      rows: pricingContext.rows, lists: pricingContext.lists,
      shopper, now: Date.now(),
    });
    const priceCents = priced.priceCents;
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
      /* Face value, and the flag, in one number: 0 means an ordinary product,
         anything above means this line IS a gift card worth that much. Read
         from the catalogue like the price is, never from the cart — a browser
         that could name the face value could name a larger one. See 0032.

         ── AND NEVER WORTH MORE THAN WAS PAID FOR IT ──────────────────────────
         Clamped to the line's own price, which is the one rule that closes the
         mint. Without it, anybody who can edit a product can put $500 of face
         value on a $5 item, buy it, and walk away with $495 — which is exactly
         the "theft by giving yourself gift cards" this system is supposed to
         refuse, arriving through the product form instead of the issue button.
         The issue endpoint is behind REFUND_SECRET, a daily cap and a
         no-self-dealing rule; the product form is behind neither, and it does
         not need to be if a card cannot be worth more than its price.

         Enforced HERE rather than as a database check because this is the only
         place that knows what was actually charged. A constraint could compare
         face value to products.current_price and still be wrong: price lists,
         effective dates and per-colourway pricing all mean the charged amount
         is decided at the till, not in the row.

         It clamps rather than refusing the sale. A misconfigured card that
         issues $5 for $5 is an admin mistake somebody notices; a checkout that
         fails is a customer punished for it. The admin form warns at the point
         the number is typed, which is where prevention belongs. */
      giftCardCents: Math.min(
        Math.max(0, Number(product.gift_card_cents) || 0),
        priceCents,
      ),
      /* A gift card is a code in an email. It has no weight, so it must not
         drag half a pound into the parcel estimate the shipping rate is signed
         against — a cart of ten cards would otherwise be quoted for a 5lb box
         that does not exist. */
      shippingWeightLb: Number(product.gift_card_cents) > 0
        ? 0
        : (Number.parseFloat(product.shipping_weight_lb) || Number.parseFloat(raw?.weightLb) || 0.5),
      image: product.image_url || raw?.image || raw?.imageUrl || raw?.img || '',
      /* What this product IS, for tax. Blank falls back to the store-wide
         default, so an all-clothing catalogue needs no per-product setting and
         a store that later adds a water bottle can say so on that one row. */
      taxCategory: String(product.tax_category || '').trim(),
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

/* ── What fulfilment needs to know about an order ─────────────────────────────
 *
 * handleSuccessfulPayment() reads a flat string map: the line items, the
 * inventory to decrement, the shipping rate that was quoted, the tax that was
 * charged and where it goes. Stripe carries it as PaymentIntent metadata, which
 * is where it was built — inline, forty-odd fields, in create-payment-intent.
 *
 * PayPal has to produce the same map, because it hands the same order to the
 * same fulfilment. Copying it would mean two lists of forty fields that agree
 * today: a field added to one and not the other is an order that fulfils with a
 * piece missing, and the failure would land in whichever route is used less —
 * so it would be found late, by a customer.
 *
 * Every value is a string. That is Stripe's constraint rather than ours, but
 * keeping it for both means the webhook and the capture path parse identically
 * and neither has to know which one built the map.
 */
export function buildOrderMetadata({ orderNumber, address = {}, quote, featureFlagsMeta = '', attributionMeta = '', matchKeys = null }) {
  const {
    attributedUser, lineItems, inventoryItems, subtotalCents, shipping, giftCardLines,
    normalizedPromoCode, discountCents, tax, taxStateCode, taxRate, taxCents, totalCents,
  } = quote;

  /* Stripe caps each metadata value at 500 chars, so the line items get trimmed
     to fit. Done here rather than in the quote because the cap is Stripe's —
     but applied for both routes, so the two maps stay byte-identical and a
     PayPal order cannot carry a longer item list than a card one. Drop
     size+colour first, then truncate names; fulfilment only requires
     name/sku/amount/qty. */
  let metaItems = JSON.stringify(lineItems);
  if (metaItems.length > 490) {
    metaItems = JSON.stringify(lineItems.map(({ sku, name, amount, quantity }) => ({ sku, name, amount, quantity })));
  }
  if (metaItems.length > 490) {
    metaItems = JSON.stringify(lineItems.map(({ sku, name, amount, quantity }) => ({ sku, name: name.slice(0, 28), amount, quantity })));
  }

  return {
    order_number: orderNumber,
    customer_email: address.email,
    customer_name: address.name || '',
    /* The buyer, not whoever happens to be signed in on this browser. See the
       note in quoteCart: this used to be the session, so a guest checking out
       on someone else's computer filed their order — name, address, contents —
       into that person's account history. */
    user_id: attributedUser?.id || '',
    items: metaItems,
    inv: JSON.stringify(inventoryItems),
    /* Its own key on purpose. `items` above is trimmed to fit Stripe's 500-char
       cap and the trim drops every field but sku/name/amount/quantity, so a
       gift-card flag riding on a line item disappears exactly when a cart is
       big — which is the cart most likely to contain them. Absent means no
       gift cards, which is the common case and costs one empty string. */
    gift_cards: giftCardLines && giftCardLines.length ? JSON.stringify(giftCardLines) : '',
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
    /* Which engine produced that number — not always the one configured, since
       an external provider that failed falls back to the table. The Tax page
       reads this so a figure at filing time can be attributed. */
    tax_engine: tax.fallbackFrom ? `${tax.fallbackFrom}→builtin` : (tax.engine || 'builtin'),
    /* The provider's handle on the calculation. A tax provider only files sales
       it has been told completed, and it is told by referring back to this — so
       it has to survive from here to fulfilment. Empty for engines with nothing
       to file. */
    tax_ref: tax.ref || '',
    total_amount_cents: String(totalCents),
    feature_flags: featureFlagsMeta,
    /* Which ad, email or post produced this order — compact form, see
       _attribution.js. Carried through payment metadata rather than posted
       separately because this is the one channel guaranteed to reach the
       webhook: the browser may be closed the instant the card is approved, and
       an order saved without attribution can never have it added.

       Empty string when the visitor declined the cookie banner, arrived with no
       campaign parameters, or the value would not fit Stripe's cap. All three
       are recorded the same way — as nothing — because all three mean the same
       thing downstream. */
    attribution: attributionMeta,
    /* Meta's browser match keys, kept OUT of `attribution` and out of the
       orders table. They identify the browser to Meta and are useful to exactly
       one consumer: the server-side Purchase in _fulfil.js, which was sending
       hashed email alone because nothing ever collected these. They travel here
       because that is where the webhook can reach them, and they stop there. */
    fbp: (matchKeys && matchKeys.fbp) || '',
    fbc: (matchKeys && matchKeys.fbc) || '',
    ship_line1: address.line1 || '',
    ship_line2: address.line2 || '',
    ship_city: address.city || '',
    ship_state: address.state || '',
    ship_zip: address.zip || '',
    ship_country: address.country || 'US',
  };
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

  /* ── NOTHING IN THIS CART IS A PARCEL ─────────────────────────────────────
     A cart of gift cards has nothing to ship: no weight, no label, no address
     to rate against. Charging the standard rate for one would be charging
     postage on an email, and asking a carrier to rate a zero-weight shipment
     is a question with no good answer.

     EVERY line, not any — a card bought alongside a shirt still goes in a box,
     and the card simply contributes nothing to its weight. */
  const shipsNothing = Array.isArray(catalogItems) && catalogItems.length > 0
    && catalogItems.every((item) => item && Number(item.giftCardCents) > 0);
  if (shipsNothing) {
    return {
      qualifiesFree: true, handDelivery: false, signedRate: null,
      actualShippingCents: 0, shippingCents: 0,
      provider: '', servicelevel: '', rateObjectId: '', source: '', remoteShipmentId: '',
    };
  }

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
export async function quoteCart({ items, address = {}, shippingRate, promoCode = '', deliveryMethod = '', storedValueCode = '', accessToken = '', env, request, waitUntil }) {
  const verifiedUser = await verifyAccessToken(accessToken, env);
  const isMember = Boolean(verifiedUser?.id);

  /* The wholesale account, read from the PROFILE with the service key, for the
     user this token just proved. Never from the request — this is the till, and
     a client-supplied "I am wholesale" would be a self-service trade discount.

     Unreadable means retail. That is the direction that cannot go wrong: it
     prices exactly as it did before this feature existed, and a buyer who is
     wrongly charged retail complains, where one wrongly charged trade does
     not. */
  let wholesaleProfile = null;
  if (verifiedUser && verifiedUser.id) {
    try {
      const k = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
      if (k) {
        const rows = await fetch(
          env.SUPABASE_URL + '/rest/v1/profiles?select=wholesale&id=eq.'
            + encodeURIComponent(verifiedUser.id) + '&limit=1',
          { headers: { apikey: k, Authorization: 'Bearer ' + k }, cache: 'no-store' }
        ).then((r) => (r.ok ? r.json() : []));
        wholesaleProfile = (rows && rows[0]) || null;
      }
    } catch (_) { wholesaleProfile = null; }
  }
  const isWholesale = isWholesaleBuyer(wholesaleProfile);

  /* ── Whose order is this? ─────────────────────────────────────────────────
     Not "whose browser is this", which is what it used to mean.

     Attribution followed the session token alone, so anyone checking out on a
     computer where somebody else was still signed in had their order filed
     under that account. The account holder then sees a stranger's order —
     their name, their address, what they bought — in their history, and can
     start a return on it. That is somebody else's private information showing
     up in your account, which is worse than any of the alternatives below.

     So attribution follows the EMAIL the buyer typed. Same address as the
     signed-in account means the account holder is buying; a different one
     means somebody else is, whatever the session says.

     The cost, stated plainly: a signed-in customer who deliberately enters a
     different email — sending a gift, using a work address — gets an order
     that is not linked to their account. They can still reach it through the
     guest returns flow with the order number and that email. That is a
     recoverable inconvenience; showing one customer another's order is not.

     Member PRICING still follows the session, because someone signed in and
     paying is entitled to their discount regardless of the delivery email. */
  const buyerEmail = String(address?.email || '').trim().toLowerCase();
  const accountEmail = String(verifiedUser?.email || '').trim().toLowerCase();
  const attributedUser = (verifiedUser?.id && buyerEmail && accountEmail && buyerEmail === accountEmail)
    ? verifiedUser
    : null;

  /* Admin → Commerce may permit ordering beyond stock (backorders). Read here
     rather than in the loop so one setting read covers the whole cart, and
     defaulted ON so an unreadable setting cannot become permission to oversell.
     The storefront reads the same value off /api/stock, so the quantity a
     shopper is allowed to pick and the quantity checkout accepts come from one
     switch — the two disagreeing is what "Only 1 left" then "out of stock" was. */
  /* One settings read covers both the rule and the words it is explained in.
     Two reads would let them arrive out of step, and this is the request that
     takes money. */
  const { limitToStock, say, memberPricingOn } = await (async () => {
    try {
      const cfg = sanitizeCommerceConfig(await getSetting(env, 'commerce_config', {}));
      return {
        limitToStock: cfg?.customerExperience?.limitQtyToStock !== false,
        say: messagesFrom(cfg),
        /* Whether members are charged differently AT ALL. Absent means on:
           every store predates the switch, and reading a missing key as "off"
           would withdraw a discount shoppers are currently being shown. */
        memberPricingOn: cfg?.memberPricing?.enabled !== false,
      };
    } catch (_) {
      // Unreadable settings must not become permission to oversell, nor silence.
      return { limitToStock: true, say: shippedMessages, memberPricingOn: true };
    }
  })();

  /* THE SWITCH, applied where membership is decided rather than where each
     price is worked out.
     Every member rule downstream — the catalogue's member_price, a price list
     row's member_price — hangs off this one boolean, so turning the feature off
     here turns it off everywhere without a second flag threaded through the
     resolver. /api/prices reads the same setting at the same point, which is
     what keeps the figure on the page and the figure on the card identical:
     gating only one of the two is how a page comes to show $25 and a card to be
     charged $40. */
  const chargeAsMember = isMember && memberPricingOn;

  const catalogItems = await resolveCatalogItems(items, env, chargeAsMember, limitToStock, say, isWholesale);
  const subtotalCents = catalogItems.reduce((sum, item) => sum + item.amount * item.quantity, 0);

  /* The account's own minimum, checked on the GOODS before shipping, tax or a
     promo code. All three of those would let a buyer reach a minimum without
     buying more — and the minimum is not about the total, it is about whether
     the order is worth picking, packing and invoicing.
     Checked here rather than in the browser for the reason everything else in
     this file is: the browser can be told, but the till has to refuse. */
  const minOrderCents = wholesaleMinimumCents(wholesaleProfile);
  if (minOrderCents > 0 && subtotalCents < minOrderCents) {
    const short = ((minOrderCents - subtotalCents) / 100).toFixed(2);
    /* cartError, not a bare Error — this is a refusal the buyer caused and can
       fix, so it has to answer 400 rather than joining "Stripe is down" in the
       500 bucket. Same reason out-of-stock does. */
    throw cartError(
      'Your account has a $' + (minOrderCents / 100).toFixed(2) + ' minimum. '
      + 'Add $' + short + ' more to place this order.',
      400
    );
  }

  const shipping = await resolveShipping({ shippingRate, address, subtotalCents, catalogItems, env, deliveryMethod, say });

  /* ── A GIFT CARD IS NOT A DISCOUNTABLE GOOD ───────────────────────────────
     Its value is stated in the catalogue (0032), not derived from what was
     paid, and that is what makes a discount on one an arbitrage rather than a
     saving: 20% off a $100 card would be $100 of spendable balance for $80.
     Run it twice and the store is paying the customer.

     So gift card lines come out of the base a promotion is calculated on, and
     out of the taxable base below. The face-value column and these two
     exclusions are one feature — the column WITHOUT them is the arbitrage. */
  const giftCardSubtotalCents = catalogItems.reduce(
    (sum, item) => sum + (Number(item.giftCardCents) > 0 ? item.amount * item.quantity : 0),
    0
  );
  const discountableItems = catalogItems.filter((item) => !(Number(item.giftCardCents) > 0));
  const discountableSubtotalCents = Math.max(0, subtotalCents - giftCardSubtotalCents);

  /* What has to be ISSUED if this order completes: face value and how many of
     it. Kept as a compact pair per line because it travels in Stripe metadata,
     which caps each value at 500 characters — `[[5000,40]]` is forty cards.

     Deliberately NOT carried on the line items. Those get trimmed to fit that
     same cap, and the trim drops every field except sku/name/amount/quantity —
     so on a large cart the flag saying "this line is a gift card" would vanish
     and the codes would silently never be issued. A customer would be charged
     for a gift card that does not exist. */
  const giftCardLines = catalogItems
    .filter((item) => Number(item.giftCardCents) > 0)
    .map((item) => [Math.round(item.giftCardCents), item.quantity || 1]);

  /* Each card is a separate code, because forty people cannot share one. That
     makes the count a real cost at fulfilment — one write per card — and the
     cart's own limits allow 25 lines of 99, which is 2,475 codes and a Worker
     that times out holding somebody's money.

     Refused HERE, while it is still a quote, rather than discovered after the
     charge. A buyer who needs more than this is a conversation, not an error. */
  const cardCount = giftCardLines.reduce((sum, [, qty]) => sum + qty, 0);
  if (cardCount > 100) {
    throw cartError(
      'Orders are limited to 100 gift cards at a time. Get in touch and we will sort out a larger order.',
      400
    );
  }

  const promotion = await getPromotionForCode(env, promoCode);
  const normalizedPromoCode = promotion ? normalizePromoCode(promotion.code) : normalizePromoCode(promoCode);
  const discountCents = computePromotionDiscount(promotion, discountableSubtotalCents, shipping.shippingCents, discountableItems);
  const discountedSubtotalCents = Math.max(0, subtotalCents - discountCents);


  /* ── AND IT IS NOT TAXED AT PURCHASE ──────────────────────────────────────
     Tax is charged on what a gift card BUYS, when it is spent. Charging it here
     as well charges it twice, and the store cannot un-charge the first half
     without a refund and an apology.

     0032 refuses to let a gift card product exist unless its tax_category is
     'exempt', which is enough for engines that price line by line. It is NOT
     enough for the ones that take a single taxable figure — the built-in table
     is one of those, and it is the DEFAULT, so without this line the ordinary
     store taxes every card it sells. */
  const taxableCents = Math.max(0, discountedSubtotalCents - giftCardSubtotalCents);

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
    /* Gift cards are left out entirely rather than sent as exempt lines. An
       engine reads EITHER these lines or the single taxableCents figure above,
       never both — so the two have to describe the same money. Sending lines
       that sum to the whole cart while telling a table engine a smaller number
       is two answers to one question, and which one applies would depend on
       which engine the store happens to have selected. */
    const taxable = discountableItems;
    if (!taxable.length || discountableSubtotalCents <= 0) return null;
    const lines = taxable.map((item) => ({
      sku: item.sku,
      name: item.name,
      quantity: item.quantity || 1,
      amountTotal: Math.round(item.amount * (item.quantity || 1) * (taxableCents / discountableSubtotalCents)),
      /* What it is, in our vocabulary — each engine maps it to its own code. */
      taxCategory: item.taxCategory || '',
    }));
    const allocated = lines.reduce((sum, l) => sum + l.amountTotal, 0);
    const remainder = taxableCents - allocated;
    if (remainder !== 0 && lines.length) lines[lines.length - 1].amountTotal += remainder;
    return lines.filter((l) => l.amountTotal > 0);
  })();

  const tax = await resolveTax({
    env, request, address, dbOverrides,
    taxableCents,
    shippingCents: shipping.shippingCents,
    lineItems: taxLineItems,
    /* So a held exemption certificate is honoured. Both identifiers, because a
       wholesale buyer usually checks out as a guest the first time. */
    customer: { email: address?.email || '', userId: verifiedUser?.id || '' },
    /* Shadow mode prices a second engine after the response has gone out. Absent
       on a caller with no Worker context, in which case it simply does not run
       rather than making a customer wait for a comparison. */
    waitUntil,
  });

  const totalCents = discountedSubtotalCents + shipping.shippingCents + tax.taxCents;

  /* ── STORED VALUE IS TENDER, NOT A DISCOUNT ────────────────────────────────
     Applied here, AFTER tax and shipping, and deliberately not with the promo
     code above. A gift card pays a bill; it does not reduce one. Folding it in
     as a discount would shrink the taxable amount — which is somebody else's
     money to decide about — and would under-collect tax the store still owes on
     goods it really did sell at full price.

     So `totalCents` stays what the order is worth, and `amountDueCents` is what
     the card is asked for. An order paid entirely with a gift card still has a
     total, still owes tax on it, and still reports revenue.

     NOTHING IS RESERVED HERE. This runs while the customer is still looking at
     the page — every keystroke in the address field re-quotes — and a hold
     taken at quote time would let a shopper who typed a code and wandered off
     leave their own money locked against a checkout that never happened. The
     hold is taken at the moment of payment, by the caller. */
  let storedValue = { code: '', appliedCents: 0, balanceCents: 0, reason: '', kind: '' };

  /* ── STORED VALUE CANNOT BUY STORED VALUE ─────────────────────────────
     Paying for a gift card with a gift card moves no money, and on its own it
     is not theft. What it is, is a laundry: a code with a history — a known
     owner, a known origin, an expiry, a reason it might be about to be voided
     — goes in, and a clean one comes out with none of that attached. It is
     precisely what somebody does with a code they should not be holding.

     It also breaks the one thing that makes the refund guard work. Refunding an
     order voids the cards it minted; if those were bought with another card,
     voiding them destroys value that traces back to a payment nobody is
     refunding, and the arithmetic stops being answerable at all.

     Refused for the WHOLE cart, not just the gift-card line. Splitting the
     tender per line is a second pricing path in the place where a bug means
     money, to serve a cart nobody has ever built on purpose. */
  if (storedValueCode && giftCardSubtotalCents > 0) {
    throw cartError(
      'A gift card cannot be paid for with a gift card or store credit. '
      + 'Take the gift card out of your bag, or pay for this order with a card.',
      400
    );
  }

  if (storedValueCode && await storedValueEnabled(env)) {
    /* verifiedUser, NOT attributedUser. A locked card asks "who is signed in",
       which is a different question from "whose order is this" — attribution
       additionally requires the delivery email to match the account, and a
       customer sending a present to a friend's address is still the owner of
       their own card. Refusing them there would be the lock working against
       the person it belongs to. Member pricing follows the session for exactly
       the same reason; see the note above. */
    const q = await quoteAgainst(env, storedValueCode, totalCents, verifiedUser?.id || null);
    storedValue = {
      code: q.applied > 0 ? String(storedValueCode).trim().toUpperCase().replace(/\s+/g, '') : '',
      appliedCents: q.applied,
      balanceCents: q.info.balanceCents || 0,
      kind: q.info.kind || '',
      /* Why it did nothing, in the shopper's words rather than the ledger's, so
         the page can say "that code has already been used" instead of failing
         silently and looking broken. */
      reason: q.applied > 0 ? '' : (q.info.reason || 'not_found'),
    };
  }
  const amountDueCents = Math.max(0, totalCents - storedValue.appliedCents);

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
    verifiedUser, attributedUser,
    /* Face value and count per line, for the codes fulfilment has to mint. */
    giftCardLines, giftCardSubtotalCents,
    /* `isMember` stays "is this a signed-in customer", because that is what the
       word means and what anything reading it later would expect. Whether they
       were PRICED as one is a separate fact, reported separately — folding the
       two together would leave an order that cannot say why it charged what it
       charged. */
    isMember, chargeAsMember, memberPricingOn,
    catalogItems, lineItems, inventoryItems,
    subtotalCents, shipping, promotion, normalizedPromoCode, discountCents,
    discountedSubtotalCents, tax,
    taxStateCode: tax.stateCode, taxRate: tax.rate, taxCents: tax.taxCents,
    totalCents,
    /* What the order is worth vs what the card is asked for. Both, always, so
       nothing downstream has to subtract for itself — the same reason
       `discountedSubtotalCents` is returned rather than recomputed. When stored
       value is off or unused, amountDueCents === totalCents and every existing
       caller reads the number it always read. */
    storedValue, amountDueCents,
  };
}
