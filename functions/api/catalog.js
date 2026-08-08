/**
 * Cloudflare Pages Function: GET /api/catalog   (public)
 *
 * The product catalogue — products with their images and colourways — in one
 * edge-cached response.
 *
 * WHY. The homepage was fetching
 * `products?select=*,product_images(*),color_variants(*)` (92 KB) and the
 * collection page four separate queries (~110 KB), both with `cache:'no-store'`,
 * on every page load. That is what put 5.68 GB through a 5 GB Supabase free
 * tier with two monthly active users. Behind Cloudflare, Supabase serves this
 * once per cache window however many people are browsing.
 *
 * STOCK IS DELIBERATELY NOT HERE. product_sizes.stock_quantity decides whether
 * a size can be added to a bag, and a five-minute-old copy of that can sell
 * something that is gone. It has its own endpoint (/api/stock) on a much
 * shorter cache, so the 89 KB of catalogue that barely changes can be cached
 * hard without the 19 KB that must not be. An oversell costs more than the
 * bandwidth ever would.
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
    if (!env.SUPABASE_URL || !key) return json({ ok: false, products: [] }, 200, cors(env));

    // Same shape the storefront already builds its grids from, so the client
    // change is a swapped URL rather than a rewritten renderer.
    const url = `${env.SUPABASE_URL}/rest/v1/products`
      + '?select=*,product_images(*),color_variants(*)'
      + '&status=neq.Legacy&status=neq.Draft&order=sort_order.asc';

    const products = await fetch(url, {
      headers: { apikey: key, Authorization: 'Bearer ' + key },
    }).then((r) => (r.ok ? r.json() : [])).catch(() => []);

    return json({ ok: true, products: Array.isArray(products) ? products : [] }, 200, {
      ...cors(env),
      'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
    });
  } catch (_) {
    return json({ ok: false, products: [] }, 200, cors(env));
  }
}
