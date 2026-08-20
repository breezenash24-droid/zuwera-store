/**
 * Edge caching for the public read endpoints — the part that was never true.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * /api/catalog, /api/storefront-settings and /api/stock all set
 *
 *     Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=600
 *
 * and both files say in their own comments that Cloudflare answers almost every
 * request from its edge, so Supabase sees one read per cache window however
 * many people are browsing. Checked against the live site:
 *
 *     GET /api/storefront-settings   cf-cache-status: DYNAMIC   1.02 s
 *     GET /api/storefront-settings   cf-cache-status: DYNAMIC   1.06 s
 *     GET /api/storefront-settings   cf-cache-status: DYNAMIC   1.01 s
 *     GET /api/storefront-settings   cf-cache-status: DYNAMIC   1.60 s
 *     GET /api/storefront-settings   cf-cache-status: DYNAMIC   0.98 s
 *     GET /api/catalog               cf-cache-status: DYNAMIC
 *     GET /api/stock                 cf-cache-status: DYNAMIC
 *
 * DYNAMIC does not mean "missed". It means the response was never a candidate:
 * Cloudflare's default cache covers a list of static file extensions, and a
 * Function response at a path with no extension is not on it, whatever
 * Cache-Control says. So every visitor was paying a full round trip to Supabase
 * for settings, for the catalogue and for stock — the three things the homepage
 * asks for first — and a header nobody had checked said otherwise.
 *
 * Same shape as the two live regressions found in the last audit: the file was
 * right, the response was not, and every test read the file.
 *
 * ── WHY THE CACHE API RATHER THAN A DASHBOARD RULE ──────────────────────────
 *
 * A "Cache Everything" rule for /api/* would also work, and would also live
 * somewhere nobody can see from the repository, apply to endpoints added later
 * that must NOT be cached, and vanish if the zone is ever rebuilt. This ships
 * with the code that depends on it, names the endpoints one at a time, and can
 * be tested.
 *
 * ── THE RULES THIS FOLLOWS ──────────────────────────────────────────────────
 *
 * Only GET. Only 200-family responses. Never a response carrying Set-Cookie or
 * an Authorization-varying body — everything cached here is public data that is
 * identical for every visitor, which is the whole reason it can be shared.
 *
 * The cache key is the full request URL, so ?view=list&limit=250&offset=0 and
 * ?view=full are separate entries and no caller can be served another caller's
 * projection.
 */

/* `caches.default` exists in the Workers runtime. It does not exist in Node,
   and `wrangler dev` gives a no-op that stores nothing — so every path here
   has to work when the cache is absent, not just when it misses. */
function edgeCache() {
  try {
    if (typeof caches === 'undefined' || !caches || !caches.default) return null;
    return caches.default;
  } catch (_) {
    return null;
  }
}

/**
 * Serve `build()` through the edge cache.
 *
 * @param {Request}  request   the incoming request; its URL is the cache key
 * @param {Function} waitUntil the Worker's waitUntil, or undefined
 * @param {Function} build     async () => Response — called only on a miss
 * @param {Object}  [opts]
 * @param {Function} [opts.shouldCache] (Response) => boolean, defaults to "ok"
 */
export async function withEdgeCache(request, waitUntil, build, opts = {}) {
  const cache = edgeCache();
  const cacheable = request && request.method === 'GET' && cache;

  if (cacheable) {
    try {
      const hit = await cache.match(request);
      if (hit) {
        /* Say so out loud. Without this there is no way to tell a cache that is
           working from one that is silently DYNAMIC again — which is exactly
           how this went unnoticed for as long as it did. */
        const headers = new Headers(hit.headers);
        headers.set('X-Zw-Cache', 'hit');
        return new Response(hit.body, { status: hit.status, headers });
      }
    } catch (_) { /* a broken cache must not break the endpoint */ }
  }

  const response = await build();

  if (cacheable) {
    const shouldCache = opts.shouldCache || ((r) => r && r.ok);
    let ok = false;
    /* Awaited: the default predicate is synchronous but okBody has to read the
       body to decide, and an un-awaited promise is truthy no matter what it
       resolves to — which would cache every failure. */
    try { ok = !!(await shouldCache(response)); } catch (_) { ok = false; }
    /* A response that failed upstream still answers 200 here (every one of
       these endpoints degrades to an empty body rather than an error, so a
       shopper sees a quiet shop instead of a broken one). Caching THAT for five
       minutes would turn a one-second Supabase blip into a five-minute outage,
       so shouldCache reads the body's own ok flag, not the status code. */
    if (ok && !response.headers.has('Set-Cookie')) {
      try {
        const copy = response.clone();
        const put = cache.put(request, copy);
        if (typeof waitUntil === 'function') waitUntil(put);
        else await put.catch(() => {});
      } catch (_) { /* over quota, unsupported, whatever — just do not cache */ }
    }
  }

  const headers = new Headers(response.headers);
  headers.set('X-Zw-Cache', cacheable ? 'miss' : 'bypass');
  return new Response(response.body, { status: response.status, headers });
}

/**
 * These endpoints answer 200 with an empty payload when Supabase is unreachable,
 * because a shopper is better served by a quiet shop than by an error page. That
 * makes the HTTP status useless for deciding what to cache, so the body says.
 */
export async function okBody(response) {
  try {
    const body = await response.clone().json();
    return !!(body && body.ok);
  } catch (_) {
    return false;
  }
}
