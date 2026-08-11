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

    /* Named columns, not *. Everything that reads stock wants these; the rest
       (ids, timestamps) is weight on every shopper's connection.

       color_name is here because stock is per-colour and the storefront has to
       match colour the way the server does. Without it the browser can only
       match on color_variant_id, which bag lines do not carry.

       BUT it is requested defensively, because it went wrong exactly once and
       silently: this endpoint answered `ok: true` with ZERO rows, which every
       caller reads as "nothing is in stock anywhere" rather than "the query
       failed". A shop with no stock data looks like a working shop that has
       sold out. The old `r.ok ? r.json() : []` is what turned a rejected
       SELECT into a plausible empty answer.

       So: ask for the column, and if the database rejects the request, say why
       in the log and ask again without it. A missing column then costs colour
       precision — the pre-existing behaviour — instead of costing every
       shopper the ability to see stock at all. */
    const BASE = `${env.SUPABASE_URL}/rest/v1/product_sizes?select=product_id,size,stock_quantity`;
    const headers = { apikey: key, Authorization: 'Bearer ' + key };

    /* The fetch is wrapped because a THROWN fetch and a REJECTED query are
       different faults with different owners, and the first version of this
       reported them identically — the outer catch and the query-failed branch
       returned the same body, so the answer to "why is stock empty?" was still
       a guess. A runtime that refuses a request option throws; a database that
       refuses a SELECT answers. Say which. */
    const query = async (cols) => {
      let resp;
      try {
        resp = await fetch(BASE + cols, { headers, cache: 'no-store' });
      } catch (e) {
        return { ok: false, threw: true, reason: String((e && e.message) || e).slice(0, 120) };
      }
      if (resp.ok) return { ok: true, rows: await resp.json().catch(() => []) };
      return { ok: false, status: resp.status, detail: (await resp.text().catch(() => '')).slice(0, 300) };
    };

    let degraded = '';
    let res = await query(',color_name,color_variant_id');
    if (!res.ok) {
      console.error(`stock: SELECT with color_name failed (${res.status}): ${res.detail} — retrying without it`);
      degraded = 'no_color_name';
      res = await query(',color_variant_id');
    }
    if (!res.ok) {
      /* Both attempts rejected. This is a real outage of the stock read, and it
         must NOT be dressed up as an empty catalogue — ok:false lets callers
         treat availability as UNKNOWN, which is what it is. */
      /* The STATUS is reported, the detail is not. Which of these it is
         determines who fixes it and how, and without it the failure is only
         visible to whoever can read Worker logs — which is why this endpoint
         sat broken while looking like an empty catalogue:

           401 / 403  the key cannot read product_sizes. Either
                      SUPABASE_SERVICE_ROLE_KEY is unset (so this fell back to
                      the anon key) or the table has no policy granting it.
           404        no such table under that name.
           400        the query is malformed — ours to fix.

         The body is deliberately withheld: PostgREST error text names columns
         and constraints, and this endpoint is public. */
      console.error(`stock: SELECT failed outright (${res.status || 'threw'}): ${res.detail || res.reason}`);
      return json({
        ok: false, sizes: [], limitToStock: true,
        error: res.threw ? 'stock_fetch_threw' : 'stock_query_rejected',
        ...(res.threw ? { reason: res.reason } : { status: res.status }),
      }, 200, cors(env));
    }
    const sizesP = Promise.resolve(res.rows);

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

    return json({
      ok: true,
      sizes: Array.isArray(sizes) ? sizes : [],
      limitToStock,
      // Present only when colour precision was lost, so the cause is visible in
      // the payload and not just in a log nobody is reading at 2am.
      ...(degraded ? { degraded } : {}),
    }, 200, {
      ...cors(env),
      'Cache-Control': 'public, max-age=10, s-maxage=20, stale-while-revalidate=30',
    });
  } catch (e) {
    // Distinct from the query failures above, so "which one was it?" is never
    // a guess again.
    console.error('stock: unhandled', e && e.message);
    return json({
      ok: false, sizes: [], limitToStock: true,
      error: 'stock_handler_threw', reason: String((e && e.message) || e).slice(0, 120),
    }, 200, cors(env));
  }
}
