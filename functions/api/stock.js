/**
 * Cloudflare Pages Function: GET /api/stock   (public)
 *
 * Per-size stock levels, split out from /api/catalog on purpose.
 *
 * The catalogue — titles, prices, photos, colourways — barely changes and can
 * sit on a five-minute edge cache. Stock cannot: product_sizes.stock_quantity
 * decides whether a size can be added to a bag, and serving a five-minute-old
 * copy means offering something that has already gone. So this is its own
 * endpoint with a much shorter cache.
 *
 * 20 seconds at the edge still collapses a burst of traffic into a handful of
 * reads — which is where the egress saving actually comes from — while keeping
 * the window in which the site can be wrong down to something a shopper would
 * never notice. Checkout re-checks stock server-side before taking money
 * regardless (decrement_stock), so this is display accuracy, not the thing
 * standing between you and an oversell.
 */

import { cors, json } from './_commerce.js';

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestGet({ env }) {
  try {
    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return json({ ok: false, sizes: [] }, 200, cors(env));

    // Named columns, not *. Everything that reads stock wants these four; the
    // rest (ids, timestamps) is weight on every shopper's connection for data
    // no renderer touches.
    const sizes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/product_sizes?select=product_id,size,stock_quantity,color_variant_id`,
      { headers: { apikey: key, Authorization: 'Bearer ' + key }, cache: 'no-store' }
    ).then((r) => (r.ok ? r.json() : [])).catch(() => []);

    return json({ ok: true, sizes: Array.isArray(sizes) ? sizes : [] }, 200, {
      ...cors(env),
      'Cache-Control': 'public, max-age=10, s-maxage=20, stale-while-revalidate=30',
    });
  } catch (_) {
    return json({ ok: false, sizes: [] }, 200, cors(env));
  }
}
