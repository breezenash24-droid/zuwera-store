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
import { fetchSiteSettings } from './_settings.js';

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

    // Named columns, not *. Everything that reads stock wants these; the rest
    // (ids, timestamps) is weight on every shopper's connection for data no
    // renderer touches.
    //
    // color_name is here because stock is per-colour and the storefront has to
    // match colour the way the server does. Without it the browser could only
    // match on color_variant_id, which bag lines do not carry — so it fell back
    // to per-size totals and offered stock belonging to a different colourway.
    const sizesP = fetch(
      `${env.SUPABASE_URL}/rest/v1/product_sizes?select=product_id,size,stock_quantity,color_name,color_variant_id`,
      { headers: { apikey: key, Authorization: 'Bearer ' + key }, cache: 'no-store' }
    ).then((r) => (r.ok ? r.json() : [])).catch(() => []);

    /* Whether the storefront should stop a shopper ordering more than exists.
       It rides along on this response instead of getting its own endpoint: it
       is read at exactly the moment stock is, and two round trips would let the
       rule and the numbers it governs arrive out of step.

       Absent or unreadable means ON. A store that has never opened the setting
       should not be able to accept orders it cannot fill, and a failed settings
       read must not silently become permission to oversell. */
    const settingsP = fetchSiteSettings(['commerce_config'], env)
      .then((s) => {
        const raw = s && s.commerce_config;
        const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return cfg?.customerExperience?.limitQtyToStock !== false;
      })
      .catch(() => true);

    const [sizes, limitToStock] = await Promise.all([sizesP, settingsP]);

    return json({ ok: true, sizes: Array.isArray(sizes) ? sizes : [], limitToStock }, 200, {
      ...cors(env),
      'Cache-Control': 'public, max-age=10, s-maxage=20, stale-while-revalidate=30',
    });
  } catch (_) {
    return json({ ok: false, sizes: [], limitToStock: true }, 200, cors(env));
  }
}
