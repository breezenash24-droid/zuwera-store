#!/usr/bin/env node
/**
 * Did it actually ship, and is it actually doing the thing?
 *
 *     npm run verify:live                 # against zuwera.store
 *     npm run verify:live -- <url>        # against a Pages preview deployment
 *
 * WHY THIS EXISTS AT ALL. Three separate defects on this site were invisible
 * to every test in the repository, because every test read a FILE:
 *
 *     the CSP header    two lines over Cloudflare's 2000-character limit, so
 *                       both were dropped and the live site served no CSP
 *     /sitemap.xml      generated correctly and never routed to the Function
 *     the edge cache    Cache-Control set, comments explaining how well it
 *                       worked, cf-cache-status: DYNAMIC on every request
 *
 * The repository is not the deployment. This asks the deployment.
 *
 * Everything here is a GET of a public URL. It reads nothing private and
 * changes nothing.
 */
const https = require('https');
const { URL } = require('url');

const BASE = (process.argv[2] || 'https://zuwera.store').replace(/\/+$/, '');

let pass = 0, fail = 0, warn = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
};
const note = (name, detail) => { warn++; console.log('  ! ' + name + (detail ? '\n      ' + detail : '')); };

function get(path, headers) {
  const url = path.startsWith('http') ? path : BASE + path;
  return new Promise((resolve) => {
    const u = new URL(url);
    const t0 = Date.now();
    https.get({
      host: u.host, path: u.pathname + u.search,
      headers: Object.assign({ 'User-Agent': 'zuwera-verify-live', 'Accept-Encoding': 'br, gzip' }, headers || {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        ms: Date.now() - t0,
        headers: res.headers,
        bytes: Buffer.concat(chunks).length,
        /* Only decoded for the endpoints below, all of which answer JSON or
           HTML; brotli is left to the caller that needs the text. */
        raw: Buffer.concat(chunks),
      }));
    }).on('error', (e) => resolve({ status: 0, ms: Date.now() - t0, headers: {}, bytes: 0, err: String(e.message) }));
  });
}

/* The API endpoints answer JSON; ask for identity so the body is readable
   without pulling in a decompressor. The size numbers reported for them are
   therefore RAW, and labelled as such. */
const getJson = async (path) => {
  const r = await get(path, { 'Accept-Encoding': 'identity', Accept: 'application/json' });
  try { r.json = JSON.parse(r.raw.toString('utf8')); } catch (_) { r.json = null; }
  return r;
};
const getText = async (path) => {
  const r = await get(path, { 'Accept-Encoding': 'identity' });
  r.text = r.raw.toString('utf8');
  return r;
};

(async () => {
  console.log('\n  verifying ' + BASE + '\n');

  /* ── 1. the edge cache ──────────────────────────────────────────────────
     X-Zw-Cache is set by functions/api/_edge-cache.js. Its ABSENCE means the
     deploy has not landed; 'miss' twice in a row means the Cache API is not
     retaining, which is the failure this was written to make visible. */
  console.log('  the read endpoints are cached at the edge');
  for (const p of ['/api/catalog?view=list&limit=250&offset=0', '/api/storefront-settings', '/api/stock']) {
    const a = await get(p, { 'Accept-Encoding': 'identity' });
    const b = await get(p, { 'Accept-Encoding': 'identity' });
    const tag = (r) => r.headers['x-zw-cache'] || '(absent)';
    const label = p.split('?')[0];

    if (!a.headers['x-zw-cache']) {
      ok(label + ' reports its cache state', false,
        'X-Zw-Cache absent — this deploy predates _edge-cache.js');
      continue;
    }
    ok(label + ' reports its cache state', true);
    ok('  …and the second request is served from it', tag(b) === 'hit',
      'first ' + tag(a) + ' ' + a.ms + 'ms, second ' + tag(b) + ' ' + b.ms + 'ms'
      + ' — two misses means the Cache API is not retaining');
    if (tag(b) === 'hit' && b.ms < a.ms) {
      console.log('      ' + a.ms + 'ms cold → ' + b.ms + 'ms warm');
    }
    if ((a.headers['cf-cache-status'] || '') === 'DYNAMIC' && tag(b) === 'hit') {
      note(label + ': Cloudflare still reports DYNAMIC',
        'expected — the Worker cache is ours, not the zone cache. X-Zw-Cache is the one that matters.');
    }
  }

  /* ── 2. the catalogue is bounded ───────────────────────────────────────── */
  console.log('\n  the catalogue is bounded and paginated');
  const page1 = await getJson('/api/catalog?view=list&limit=2&offset=0');
  ok('a limit is honoured', page1.json && Array.isArray(page1.json.products)
    && page1.json.products.length <= 2,
    page1.json ? (page1.json.products || []).length + ' products for limit=2' : 'no JSON');
  ok('…and the response says how many exist', page1.json && typeof page1.json.total === 'number',
    'total=' + (page1.json && page1.json.total));
  ok('…and admits it is not the whole catalogue',
    page1.json && page1.json.complete === false,
    'complete=' + (page1.json && page1.json.complete)
    + ' — the admin delete-scan trusts this flag');

  const full = await getJson('/api/catalog?view=full&limit=500&offset=0');
  const total = full.json && full.json.total;
  ok('a request that covers everything says so',
    full.json && full.json.complete === true && (full.json.products || []).length === total,
    (full.json ? (full.json.products || []).length + ' of ' + total : 'no JSON'));

  /* offset must not repeat or skip a product */
  if (total && total > 2) {
    const a = await getJson('/api/catalog?view=list&limit=2&offset=0');
    const b = await getJson('/api/catalog?view=list&limit=2&offset=2');
    const ids = [...(a.json.products || []), ...(b.json.products || [])].map((p) => p.id);
    ok('paging does not repeat or skip', new Set(ids).size === ids.length,
      ids.length + ' rows, ' + new Set(ids).size + ' distinct — a tie in sort_order without an id tie-break causes this');
  }

  /* ── 3. the projection actually drops the detail columns ───────────────── */
  console.log('\n  view=list ships only what a card draws');
  const listOne = await getJson('/api/catalog?view=list&limit=1&offset=0');
  const fullOne = await getJson('/api/catalog?view=full&limit=1&offset=0');
  const lp = listOne.json && listOne.json.products && listOne.json.products[0];
  const fp = fullOne.json && fullOne.json.products && fullOne.json.products[0];
  if (lp && fp) {
    for (const c of ['care_instructions', 'pom_chest', 'upf_rating', 'certifications'])
      ok('list view omits ' + c, !(c in lp));
    /* Two that read like product-page fields and are not: they feed the
       collection page's Material facet and "only N left". */
    for (const c of ['material_composition', 'low_stock_threshold', 'title', 'image_url'])
      ok('…but keeps ' + c, c in lp, 'a card or a facet reads this');
    const img = (lp.product_images || [])[0];
    if (img) {
      ok('image rows drop the fields nothing reads',
        !('id' in img) && !('created_at' in img) && !('product_id' in img),
        Object.keys(img).join(','));
      ok('…and keep the ones the swatches match on',
        'color_variant_id' in img && 'image_url' in img);
    }
    const lb = JSON.stringify(listOne.json.products).length;
    const fb = JSON.stringify(fullOne.json.products).length;
    console.log('      one product: ' + lb + ' b list vs ' + fb + ' b full  ('
      + (100 - Math.round(100 * lb / fb)) + '% smaller, raw)');
  } else {
    ok('the catalogue answered with a product to compare', false, 'no products returned');
  }

  /* ── 4. one settings read, and it carries everything ───────────────────── */
  console.log('\n  settings arrive in one response');
  const st = await getJson('/api/storefront-settings');
  const S = (st.json && st.json.settings) || {};
  ok('the endpoint answers ok', st.json && st.json.ok === true,
    'ok:false means it could not read — and it is no longer cached when that happens');
  /* The four that made twelve modules call Supabase directly. */
  for (const k of ['icons', 'theme_modes', 'text_overrides', 'header_layout'])
    ok('it publishes ' + k, k in S, 'without this, that module has to call Supabase itself');
  ok('…and carries updated_at with the values',
    st.json && st.json.updatedAt && typeof st.json.updatedAt === 'object',
    'header-layouts.js compares it against the stamp on the document');

  /* ── 5. the page itself ────────────────────────────────────────────────── */
  console.log('\n  the homepage');
  const home = await getText('/');
  ok('serves 200', home.status === 200, 'HTTP ' + home.status);
  ok('loads zw-data.js', /<script src="\/zw-data\.js/.test(home.text));
  ok('…after preview-mode.js, which has to be first',
    home.text.indexOf('preview-mode.js') > -1
    && home.text.indexOf('preview-mode.js') < home.text.indexOf('zw-data.js'));
  ok('asks the catalogue for a bounded page',
    /__zwProductsEarlyFetch=fetch\('\/api\/catalog\?view=list&limit=\d+/.test(home.text));
  ok('reads the hero out of the settings already in flight',
    /THE HERO, FOR SOMEONE WHO HAS NEVER BEEN HERE BEFORE/.test(home.text)
    || /zwPosterOf/.test(home.text));
  for (const f of ['email-popup.js', 'lang.js', 'customer-hub.js']) {
    const m = home.text.match(new RegExp('<script[^>]*src="[^"]*' + f.replace('.', '\\.') + '[^"]*"[^>]*>'));
    ok(f + ' is out of the ordered defer queue', !!m && / async[ >]/.test(m[0]),
      m ? m[0] : 'tag not found');
  }

  /* ── 6. the hero preload resolves to a real image ──────────────────────── */
  console.log('\n  the hero the head will preload');
  let pb = S.page_builder_published;
  if (typeof pb === 'string') { try { pb = JSON.parse(pb); } catch (_) { pb = null; } }
  const secs = (pb && pb.sections) || [];
  const top = secs.slice().sort((a, b) => (a.order || 0) - (b.order || 0))
    .filter((s) => s && s.visible !== false)[0];
  if (top && (top.type === 'hero' || top.type === 'hero_carousel')) {
    const s = top.settings || top;
    const sl = (Array.isArray(s.slides) && s.slides[0]) || s;
    const src = sl.media_url || s.image || '';
    const isVideo = sl.media_type === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(src);
    const href = isVideo
      ? (sl.video_poster
        || 'https://res.cloudinary.com/dubg4loah/video/fetch/so_0,f_jpg,q_auto,w_1400/' + encodeURI(src))
      : 'https://res.cloudinary.com/dubg4loah/image/fetch/f_auto,q_auto:eco,w_1400/' + encodeURI(src);
    const r = await get(href);
    ok('the top section is a hero (' + top.type + ')', true);
    ok('…and what would be preloaded is a real image',
      r.status === 200 && /^image\//.test(r.headers['content-type'] || ''),
      'HTTP ' + r.status + ' ' + (r.headers['content-type'] || '') + ' ' + r.bytes + ' b');
    if (isVideo) {
      const vid = await get('https://res.cloudinary.com/dubg4loah/video/fetch/f_auto,q_auto,w_1400/' + encodeURI(src));
      const rawv = await get(src);
      console.log('      poster ' + r.bytes + ' b, optimised video ' + vid.bytes
        + ' b, original ' + rawv.bytes + ' b');
      /* If Cloudinary ever stops answering, the fallback is that original.
         A fallback target that does not resolve is not a fallback. */
      ok('…and the raw original still resolves, since that is video\'s only fallback',
        rawv.status === 200, 'HTTP ' + rawv.status);
    }
  } else {
    note('the top section is not a hero', 'nothing to preload; not a failure');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed'
    + (warn ? ', ' + warn + ' note(s)' : '') + '\n');
  process.exit(fail ? 1 : 0);
})();
