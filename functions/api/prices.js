/**
 * /api/prices — what a product's colourways cost, for THIS shopper, right now.
 *
 * The browser does not resolve prices. It asks.
 *
 * That is the same call checkout-tax.js makes to /api/tax-quote, and it is the
 * same reason: the browser used to hold its own tax table, the table went stale,
 * and the figure on screen stopped matching the figure on the card. Prices are
 * that problem with a larger blast radius — a price list has effective dates and
 * customer groups in it, so a browser copy would have to reimplement the
 * calendar and the group membership as well, and get both right forever.
 *
 * ── WHAT IT RETURNS AND WHAT IT WITHHOLDS ───────────────────────────────────
 *
 * Per colourway: the price, the price before any member discount, the
 * compare-at, what a member pays, and whether it came from a list or from the
 * catalogue. NOT the list's name, NOT the window, NOT the other lists the
 * shopper is not on. A wholesale tier is commercially sensitive, and the code of
 * the list somebody is on is not the storefront's to publish.
 *
 * The member figure IS sent, to everybody, and that is deliberate: the product
 * page has always printed "Members pay $35.00" from the public products table,
 * so it is a price the store advertises rather than one it keeps. What changed
 * is only where the page reads it — it used to patch that line in from the
 * catalogue, which is how a member being charged $30 by a price list came to be
 * shown "Members pay $35.00" next to it.
 *
 * Membership is taken from the token, verified — never from a query parameter.
 * Otherwise anybody could ask for member pricing, be shown it, and then be
 * refused at the till by the never-bill-above-the-quote guard, which would look
 * like the store breaking rather than like an attempt not working.
 */

import { verifyAccessToken } from './_cart-pricing.js';
import { fetchPricingContext, resolvePrice, shopperFor } from './_price-resolution.js';
import { getSetting, sanitizeCommerceConfig } from './_commerce.js';

const CORS = (env) => ({
  'Access-Control-Allow-Origin': env.SITE_URL || 'https://zuwera.store',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  /* Per-shopper and time-dependent: a scheduled price starts partway through
     any cache window, and a cached member price served to a guest is the same
     bug as the browser computing it. */
  'Cache-Control': 'no-store',
});

const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers });

export const onRequestOptions = ({ env }) => new Response(null, { status: 204, headers: CORS(env) });

export async function onRequestGet({ request, env }) {
  const headers = CORS(env);
  try {
    const url = new URL(request.url);
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    /* `productIds` (comma-separated) as well as `productId`, because a cart is
       several products and asking once per line would be a round trip per row —
       the same reason the cart reads its pricing context in one query. Capped
       so a crafted URL cannot turn one request into an unbounded scan. */
    const many = String(url.searchParams.get('productIds') || '')
      .split(',').map((s) => s.trim()).filter((s) => UUID.test(s)).slice(0, 25);
    const single = String(url.searchParams.get('productId') || '').trim();
    const ids = many.length ? [...new Set(many)] : (UUID.test(single) ? [single] : []);
    if (!ids.length) {
      return json({ ok: false, error: 'A product id is required.' }, 400, headers);
    }
    const productId = ids[0];

    const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
    if (!env.SUPABASE_URL || !key) return json({ ok: false, error: 'Catalog is not configured.' }, 503, headers);
    const H = { apikey: key, Authorization: 'Bearer ' + key };

    /* Verified, not claimed. A query parameter saying "I am a member" would be
       honoured by nothing downstream, so honouring it here would only produce a
       price the till then refuses. */
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const user = token ? await verifyAccessToken(token, env) : null;

    /* Does this store price members differently at all?
       Read HERE, at the point membership is decided, exactly as quoteCart reads
       it — that is what keeps the figure on the page and the figure on the card
       the same one. Absent, or unreadable, means on: every store predates the
       switch, and treating a missing key as "off" would withdraw a discount
       shoppers are being shown. */
    let memberPricingOn = true;
    try {
      const cfg = sanitizeCommerceConfig(await getSetting(env, 'commerce_config', {}));
      memberPricingOn = cfg?.memberPricing?.enabled !== false;
    } catch (_) { memberPricingOn = true; }

    const isMember = Boolean(user && user.id) && memberPricingOn;

    const inList = `in.(${ids.join(',')})`;
    const [productRows, variantRows] = await Promise.all([
      fetch(`${env.SUPABASE_URL}/rest/v1/products?select=id,current_price,member_price,msrp&id=${inList}`,
            { headers: H, cache: 'no-store' }).then((r) => r.ok ? r.json() : []).catch(() => []),
      fetch(`${env.SUPABASE_URL}/rest/v1/color_variants?select=id,product_id,color_name,current_price,member_price,msrp&product_id=${inList}`,
            { headers: H, cache: 'no-store' }).then((r) => r.ok ? r.json() : []).catch(() => []),
    ]);

    const products = Array.isArray(productRows) ? productRows : [];
    if (!products.length) return json({ ok: false, error: 'No such product.' }, 404, headers);

    const ctx = await fetchPricingContext(env, ids);
    const shopper = shopperFor({ isMember });
    const now = Date.now();

    /* Resolved TWICE: once as this shopper, once as a member.
       The member figure is what the page's "Members pay $X" line says, and it
       has to be the server's answer for the same reason the charged figure is.
       It used to be patched in from the catalogue by product.html, which meant a
       member already being charged $30 by a price list was shown "Members pay
       $35.00" beside it — the page advertising a WORSE price than the one it was
       about to charge. Membership can also select a different ROW entirely, so
       it cannot be derived from the guest answer by arithmetic.

       This publishes one figure the store already advertises from the public
       products table, and nothing else: no list names, no windows, no tier a
       shopper is not being offered. */
    const priceOf = (product, variant) => {
      const r = resolvePrice({ product, variant, rows: ctx.rows, lists: ctx.lists, shopper, now });
      /* Not asked at all when the store has member pricing switched off, so a
         guest is never offered "Members pay $25" for a tier that no longer
         charges anything different. */
      const m = (isMember || !memberPricingOn) ? r : resolvePrice({
        product, variant, rows: ctx.rows, lists: ctx.lists,
        shopper: shopperFor({ isMember: true }), now,
      });
      return {
        priceCents: r.priceCents,
        /* The price before any member discount — what gets struck through when
           a member is signed in. Sent rather than inferred from compare-at,
           which is a different figure with a different meaning. */
        regularCents: r.regularCents,
        compareAtCents: r.compareAtCents,
        /* What a member pays, and whether that is what THIS shopper is getting.
           Zero when a member pays no less than anyone else — an absent discount
           is never spelled as a number, so the page cannot round it into one. */
        memberPriceCents: m.priceCents < r.priceCents ? m.priceCents
          : (r.usingMember ? r.priceCents : 0),
        usingMember: Boolean(r.usingMember),
        /* 'list' rather than the list's CODE. Which tier a shopper is on is
           theirs to know; which tier exists is not the storefront's to publish. */
        source: r.source === 'price_list' ? 'list' : r.source,
      };
    };

    const forProduct = (product) => ({
      productId: product.id,
      /* The price with no colour chosen — what the page shows before a swatch
         is clicked, and what a grid would show. */
      base: priceOf(product, null),
      colours: (Array.isArray(variantRows) ? variantRows : [])
        .filter((v) => String(v.product_id) === String(product.id))
        .map((v) => ({ id: v.id, colorName: v.color_name || '', ...priceOf(product, v) })),
    });

    const byProduct = products.map(forProduct);
    const first = byProduct.find((p) => String(p.productId) === String(productId)) || byProduct[0];

    return json({
      ok: true,
      member: isMember,
      /* So the browser's OWN fallback — the catalogue rule it uses when this
         request fails — does not go on advertising a member price the store has
         switched off. */
      memberPricing: memberPricingOn,
      /* `products` for a cart; the single-product shape is kept alongside it so
         a caller asking for one thing does not have to unwrap an array it did
         not ask for. */
      products: byProduct,
      productId: first.productId,
      base: first.base,
      colours: first.colours,
    }, 200, headers);
  } catch (err) {
    console.error('/api/prices failed:', err && err.message);
    /* An error here must not blank the price on a product page. The caller
       falls back to the catalogue figure it already has, which is what the page
       showed before this endpoint existed. */
    return json({ ok: false, error: 'Could not price that product.' }, 500, headers);
  }
}
