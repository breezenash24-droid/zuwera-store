/**
 * Cloudflare Pages Function: GET /api/catalog   (public)
 *
 * The product catalogue — products with their images and colourways — in one
 * edge-cached response.
 *
 * WHY IT EXISTS. The homepage was fetching
 * `products?select=*,product_images(*),color_variants(*)` (92 KB) and the
 * collection page four separate queries (~110 KB), both with `cache:'no-store'`,
 * on every page load. That is what put 5.68 GB through a 5 GB Supabase free
 * tier with two monthly active users. Behind Cloudflare, Supabase serves this
 * once per cache window however many people are browsing.
 *
 * ── WHY IT IS NOW BOUNDED ───────────────────────────────────────────────────
 *
 * It used to answer with the WHOLE catalogue, always, and `select=*` at that.
 * Measured against the live shop:
 *
 *     11 products          92,313 bytes raw     8,392 bytes per product
 *     …so at 1,000 products               ~8.0 MB raw, ~1.1 MB brotli
 *
 * The homepage fires this before anything else (`__zwProductsEarlyFetch`), so
 * that is a megabyte standing between a visitor and the first product. It is a
 * wall rather than a slope: nothing degrades gracefully, the shop simply stops
 * being usable somewhere north of a few hundred products.
 *
 * Two things fix it, and both are here.
 *
 * PAGINATION. `limit` and `offset`, and a hard cap no caller can talk past. The
 * response can never again be unbounded, whatever the catalogue grows to.
 *
 * PROJECTION. Named columns instead of a star, and the nested selects trimmed
 * to the fields the storefront actually reads. 78% of the payload was
 * product_images, and a third of every image row was an id, a created_at and a
 * product_id that nothing on the storefront looks at. Measured:
 *
 *     star select, nested star            92,313 b    8,392 b/product
 *     nested projection only              67,099 b    6,100 b/product   −27%
 *     view=list (detail columns dropped)  60,169 b    5,470 b/product   −35%
 *
 * ── WHAT `complete` IS FOR, AND WHY IT IS NOT DECORATION ────────────────────
 *
 * The admin's unused-media report reads this endpoint to decide which files in
 * storage nothing references, and then offers to delete them. A paginated
 * answer that a caller mistakes for the whole catalogue would report every
 * image belonging to page two as unused. So every response says whether it
 * contains the entire catalogue, and the callers that need everything page
 * until it does — or say they could not check, rather than under-report.
 *
 * STOCK IS DELIBERATELY NOT HERE. product_sizes.stock_quantity decides whether
 * a size can be added to a bag, and a five-minute-old copy of that can sell
 * something that is gone. It has its own endpoint (/api/stock) on a much
 * shorter cache, so the catalogue that barely changes can be cached hard
 * without the part that must not be. An oversell costs more than the bandwidth
 * ever would.
 */

import { cors, json } from './_commerce.js';
import { withEdgeCache, okBody } from './_edge-cache.js';

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}

/* The columns a GRID needs. An allowlist, not a denylist, and that direction is
   deliberate: a column added to `products` next year is a product-page detail
   until someone decides otherwise, so the default for anything new is to stay
   out of every card on the site rather than silently join the payload.

   Each of these was checked against what the list renderers actually read —
   storefront.js, drop001.html, landing.js, storefront-features.js,
   quick-add-modal.js — not against what looked plausible. Two that read like
   product-page fields and are not: `material_composition` feeds the collection
   page's Material facet, and `low_stock_threshold` feeds "only N left". Drop
   either and a filter quietly stops offering half its options. */
const LIST_COLUMNS = [
  'id', 'sku', 'title', 'subtitle', 'category', 'gender', 'status', 'colorway',
  'sort_order', 'created_at', 'msrp', 'current_price', 'member_price',
  'image_url', 'image_focal_y', 'low_stock_threshold', 'shipping_weight_lb',
  'material_composition', 'sports', 'best_for', 'tags',
].join(',');

/* Exactly the select the per-product image fetches already use
   (drop001.html and quick-add-modal.js), so there is one answer to "what is an
   image row" rather than two that can drift. `id` and `created_at` are read by
   nothing; `product_id` is read only with a `|| p.id` fallback, which is what
   nesting already guarantees. */
const IMAGE_COLUMNS = 'image_url,alt_text,sort_order,color_variant_id,media_type';

/* `id` stays — the card swatches match images to colourways by it. `rgb_color`
   goes: no storefront file reads it. */
const VARIANT_COLUMNS = 'id,color_name,hex_color,variant_sku,msrp,current_price,member_price,sort_order';

/* A page nobody asked to bound still has to be bounded, so DEFAULT_LIMIT is the
   number that applies when a caller says nothing — including a page cached from
   before pagination existed, which is why it is far above any real catalogue
   today rather than a tidy 24. MAX_LIMIT is the number no caller can exceed. */
const DEFAULT_LIMIT = 250;
const MAX_LIMIT = 500;

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* PostgREST reports the row count in Content-Range as "0-9/57", or with a star
   before the slash for an empty page. Returns null when the header is missing
   or unparseable — the caller then falls back to inferring completeness from
   the page size, which needs no count at all. */
function totalFromContentRange(header) {
  const raw = String(header || '');
  const slash = raw.lastIndexOf('/');
  if (slash === -1) return null;
  const tail = raw.slice(slash + 1).trim();
  if (!tail || tail === '*') return null;
  const n = Number.parseInt(tail, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestGet({ env, request, waitUntil }) {
  return withEdgeCache(request, waitUntil, () => buildCatalog(env, request), { shouldCache: okBody });
}

async function buildCatalog(env, request) {
  const params = new URL(request.url).searchParams;
  const view = params.get('view') === 'list' ? 'list' : 'full';
  const limit = clampInt(params.get('limit'), 1, MAX_LIMIT, DEFAULT_LIMIT);
  const offset = clampInt(params.get('offset'), 0, Number.MAX_SAFE_INTEGER, 0);

  /* The failure body carries the same envelope as a success, minus `ok`. A
     caller checking `complete` must not read `undefined` as truthy and go on to
     decide that nothing is referenced. */
  const failed = () => json(
    { ok: false, products: [], total: null, limit, offset, view, complete: false },
    200,
    cors(env),
  );

  try {
    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return failed();

    const columns = view === 'list' ? LIST_COLUMNS : '*';
    const url = `${env.SUPABASE_URL}/rest/v1/products`
      + `?select=${columns},product_images(${IMAGE_COLUMNS}),color_variants(${VARIANT_COLUMNS})`
      + '&status=neq.Legacy&status=neq.Draft'
      /* id breaks ties, in the SAME order param — PostgREST reads only the last
         `order=` it is given, so a second one would silently replace the first
         rather than add to it. Without a tie-break, two products sharing a
         sort_order can swap places between requests, and a paging caller then
         sees one of them twice and never sees the other. */
      + '&order=sort_order.asc,id.asc'
      + `&limit=${limit}&offset=${offset}`;

    const resp = await fetch(url, {
      headers: {
        apikey: key,
        Authorization: 'Bearer ' + key,
        /* One COUNT per cache window, not per visitor — and it is what lets a
           caller know when it has the whole catalogue. */
        Prefer: 'count=exact',
      },
    });
    if (!resp.ok) return failed();

    const products = await resp.json().catch(() => null);
    if (!Array.isArray(products)) return failed();

    const total = totalFromContentRange(resp.headers.get('Content-Range'));
    /* Two independent ways to know this response holds everything, because
       either one alone has a hole. The count is authoritative when present. A
       short page proves the end was reached when it is not. */
    const complete = total !== null
      ? (offset === 0 && products.length >= total)
      : (offset === 0 && products.length < limit);

    return json({ ok: true, products, total, limit, offset, view, complete }, 200, {
      ...cors(env),
      'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
      /* Same URL, different answer per view/limit/offset — those are already in
         the query string, so the edge keys on them. Vary is here for any proxy
         in between that normalises query strings away. */
      Vary: 'Accept-Encoding',
    });
  } catch (_) {
    return failed();
  }
}
