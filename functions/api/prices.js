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
 * Per colourway: the price, the compare-at, and whether it came from a list or
 * from the catalogue. NOT the list's name, NOT the window, NOT the other lists
 * the shopper is not on. A wholesale tier is commercially sensitive, and
 * "members pay $198" is a thing a competitor can read straight out of a
 * response body if it is sent to everybody.
 *
 * Membership is taken from the token, verified — never from a query parameter.
 * Otherwise anybody could ask for member pricing, be shown it, and then be
 * refused at the till by the never-bill-above-the-quote guard, which would look
 * like the store breaking rather than like an attempt not working.
 */

import { verifyAccessToken } from './_cart-pricing.js';
import { fetchPricingContext, resolvePrice, shopperFor } from './_price-resolution.js';

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
    const productId = String(url.searchParams.get('productId') || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(productId)) {
      return json({ ok: false, error: 'A product id is required.' }, 400, headers);
    }

    const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
    if (!env.SUPABASE_URL || !key) return json({ ok: false, error: 'Catalog is not configured.' }, 503, headers);
    const H = { apikey: key, Authorization: 'Bearer ' + key };

    /* Verified, not claimed. A query parameter saying "I am a member" would be
       honoured by nothing downstream, so honouring it here would only produce a
       price the till then refuses. */
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const user = token ? await verifyAccessToken(token, env) : null;
    const isMember = Boolean(user && user.id);

    const [productRows, variantRows] = await Promise.all([
      fetch(`${env.SUPABASE_URL}/rest/v1/products?select=id,current_price,member_price,msrp&id=eq.${productId}&limit=1`,
            { headers: H, cache: 'no-store' }).then((r) => r.ok ? r.json() : []).catch(() => []),
      fetch(`${env.SUPABASE_URL}/rest/v1/color_variants?select=id,color_name,current_price,member_price,msrp&product_id=eq.${productId}`,
            { headers: H, cache: 'no-store' }).then((r) => r.ok ? r.json() : []).catch(() => []),
    ]);

    const product = Array.isArray(productRows) ? productRows[0] : null;
    if (!product) return json({ ok: false, error: 'No such product.' }, 404, headers);

    const ctx = await fetchPricingContext(env, [productId]);
    const shopper = shopperFor({ isMember });
    const now = Date.now();

    const priceOf = (variant) => {
      const r = resolvePrice({ product, variant, rows: ctx.rows, lists: ctx.lists, shopper, now });
      return {
        priceCents: r.priceCents,
        compareAtCents: r.compareAtCents,
        /* 'list' rather than the list's CODE. Which tier a shopper is on is
           theirs to know; which tier exists is not the storefront's to publish. */
        source: r.source === 'price_list' ? 'list' : r.source,
      };
    };

    const colours = (Array.isArray(variantRows) ? variantRows : []).map((v) => ({
      id: v.id,
      colorName: v.color_name || '',
      ...priceOf(v),
    }));

    return json({
      ok: true,
      productId,
      member: isMember,
      /* The price with no colour chosen — what the page shows before a swatch
         is clicked, and what a grid would show. */
      base: priceOf(null),
      colours,
    }, 200, headers);
  } catch (err) {
    console.error('/api/prices failed:', err && err.message);
    /* An error here must not blank the price on a product page. The caller
       falls back to the catalogue figure it already has, which is what the page
       showed before this endpoint existed. */
    return json({ ok: false, error: 'Could not price that product.' }, 500, headers);
  }
}
