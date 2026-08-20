/* Three things the storefront was doing on every page load, and none of them
   were what the code said they were.
   ═══════════════════════════════════════════════════════════════════════════

   1. THE EDGE CACHE THAT WAS NEVER ON

   /api/catalog, /api/storefront-settings and /api/stock all set

       Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=600

   and both files stated in their own comments that Cloudflare therefore answers
   almost every request from its edge, with Supabase seeing one read per cache
   window however many people are browsing. Read off the live site:

       GET /api/storefront-settings   cf-cache-status: DYNAMIC   1.02 s
       GET /api/storefront-settings   cf-cache-status: DYNAMIC   1.06 s
       GET /api/storefront-settings   cf-cache-status: DYNAMIC   1.01 s
       GET /api/storefront-settings   cf-cache-status: DYNAMIC   1.60 s
       GET /api/storefront-settings   cf-cache-status: DYNAMIC   0.98 s
       GET /api/catalog               cf-cache-status: DYNAMIC
       GET /api/stock                 cf-cache-status: DYNAMIC
       GET /image-utils.js            cf-cache-status: MISS      (a real asset,
                                                                  so the header
                                                                  means something)

   DYNAMIC is not a miss. It means the response was never a candidate:
   Cloudflare's default cache covers a list of file extensions, and a Function
   response at an extensionless path is not on it whatever Cache-Control says.
   Every visitor was paying a full round trip to Supabase for the three things
   the homepage asks for first.

   2. TWELVE MODULES ASKING ONE QUESTION

   Twelve storefront files each opened their own connection to Supabase for one
   site_settings row. Measured on the live homepage they started between 2,107 ms
   and 3,021 ms and the last settled around 3,520 ms — while /api/storefront-
   settings, already in flight from the <head>, was carrying eight of the same
   twelve values.

   3. A CATALOGUE WITH NO CEILING

   /api/catalog returned every product with every image, select=*, unbounded:

       11 products    92,313 bytes raw    8,392 bytes per product
       at 1,000 products                  ~8.0 MB raw

   fired from index.html before anything else on the page. */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

/* Comments explain WHY a file avoids something, so they necessarily name it.
   Assertions about behaviour have to read the code, not the prose. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CACHE = read('functions/api/_edge-cache.js');
const CAT = read('functions/api/catalog.js');
const SETS = read('functions/api/storefront-settings.js');
const STOCK = read('functions/api/stock.js');
const DATA = read('zw-data.js');
const INDEX = read('index.html');
const HOME = read('storefront.js');
const COLL = read('drop001.html');
const ADMIN = read('admin-main.js');
const UTIL = read('image-utils.js');

console.log('\n  the reads are bounded, cached and shared\n');

console.log('  the edge cache is actually asked for');
{
  ok('there is one helper, not a per-endpoint copy',
    /export async function withEdgeCache\(request, waitUntil, build/.test(CACHE));
  ok('it uses the Cache API rather than trusting Cache-Control alone',
    /caches\.default/.test(code(CACHE)) && /cache\.match\(request\)/.test(code(CACHE))
    && /cache\.put\(request/.test(code(CACHE)),
    'a header Cloudflare never applies to a Function is not a cache');
  ok('…and the write does not delay the answer',
    /if \(typeof waitUntil === 'function'\) waitUntil\(put\);/.test(code(CACHE)));
  ok('only GET is ever cached',
    /request\.method === 'GET'/.test(code(CACHE)));
  ok('a response carrying a cookie is never shared',
    /!response\.headers\.has\('Set-Cookie'\)/.test(code(CACHE)));

  /* These endpoints answer 200 with an empty payload when Supabase is
     unreachable, because a quiet shop beats an error page. That makes the
     status code useless for deciding what to cache — caching THAT for five
     minutes turns a one-second blip into a five-minute outage. */
  ok('a failed upstream read is not cached as if it were the answer',
    /export async function okBody/.test(CACHE)
    && /return !!\(body && body\.ok\)/.test(code(CACHE)));
  ok('…and the predicate is awaited, not merely truthy',
    /await shouldCache\(response\)/.test(code(CACHE)),
    'an un-awaited promise is truthy however it resolves — that would cache every failure');
  ok('a missing or broken cache leaves the endpoint working',
    /if \(typeof caches === 'undefined'/.test(code(CACHE))
    && /catch \(_\) \{ \/\* a broken cache must not break the endpoint \*\/ \}/.test(CACHE));
  ok('whether it hit is visible from outside',
    /headers\.set\('X-Zw-Cache', 'hit'\)/.test(code(CACHE))
    && /'X-Zw-Cache', cacheable \? 'miss' : 'bypass'/.test(code(CACHE)),
    'without this there is no way to tell a working cache from a silently DYNAMIC one');

  for (const [name, src] of [['catalogue', CAT], ['settings', SETS], ['stock', STOCK]]) {
    ok('the ' + name + ' endpoint goes through it',
      /withEdgeCache\(request, waitUntil,/.test(code(src))
      && /shouldCache: okBody/.test(code(src)));
    ok('…and takes waitUntil from the handler to do it',
      /onRequestGet\(\{ env, request, waitUntil \}\)/.test(code(src)));
  }
}

console.log('\n  the catalogue can no longer be unbounded');
{
  ok('limit and offset are read from the query',
    /const limit = clampInt\(params\.get\('limit'\)/.test(code(CAT))
    && /const offset = clampInt\(params\.get\('offset'\)/.test(code(CAT)));
  ok('…and clamped, so no caller can talk past the ceiling',
    /const MAX_LIMIT = \d+;/.test(code(CAT))
    && /clampInt\(params\.get\('limit'\), 1, MAX_LIMIT, DEFAULT_LIMIT\)/.test(code(CAT)));
  ok('a caller that says nothing still gets a bounded page',
    /const DEFAULT_LIMIT = \d+;/.test(code(CAT)),
    'including a page cached from before pagination existed');
  ok('the query carries the limit and offset it computed',
    /&limit=\$\{limit\}&offset=\$\{offset\}/.test(CAT));

  /* Without a tie-break, two products sharing a sort_order can swap places
     between requests: a paging caller then sees one twice and never sees the
     other. PostgREST reads only the LAST order= it is given, so the tie-break
     has to be in the same parameter. */
  ok('paging order is total, so no product is served twice or skipped',
    /order=sort_order\.asc,id\.asc/.test(CAT));
  ok('…in one order parameter, because a second would replace the first',
    !/&order=[^&'`]*'\s*\n?\s*\+\s*'&order=/.test(CAT));

  ok('the row count comes back with the rows',
    /Prefer: 'count=exact'/.test(code(CAT))
    && /function totalFromContentRange/.test(CAT));
  ok('…and an unreadable Content-Range degrades rather than lying',
    /if \(!tail \|\| tail === '\*'\) return null;/.test(code(CAT)));
  ok('every response says whether it holds the whole catalogue',
    /complete = total !== null/.test(code(CAT))
    && /\(offset === 0 && products\.length >= total\)/.test(code(CAT))
    && /\(offset === 0 && products\.length < limit\)/.test(code(CAT)),
    'two independent ways to know, because either alone has a hole');
  ok('a failure says complete:false rather than leaving it undefined',
    /ok: false, products: \[\], total: null, limit, offset, view, complete: false/.test(code(CAT)),
    'a caller checking complete must not read undefined as truthy');
}

console.log('\n  …and stops shipping columns no grid draws');
{
  ok('there is a named list for grids instead of a star',
    /const LIST_COLUMNS = \[/.test(CAT));
  ok('…chosen as an allowlist, so a new column stays out by default',
    /An allowlist, not a denylist/.test(CAT));

  const list = ((CAT.match(/const LIST_COLUMNS = \[([\s\S]*?)\]\.join/) || [])[1] || '');
  /* Two that read like product-page fields and are not. material_composition
     feeds the collection page's Material facet and low_stock_threshold feeds
     "only N left" — drop either and a filter quietly offers half its options. */
  ok('material_composition survived the trim (the Material facet reads it)',
    /'material_composition'/.test(list));
  ok('low_stock_threshold survived it too ("only N left" reads it)',
    /'low_stock_threshold'/.test(list));
  for (const c of ['id', 'title', 'sku', 'status', 'gender', 'category', 'image_url', 'msrp', 'sports', 'best_for', 'tags'])
    ok('…and so did ' + c, new RegExp("'" + c + "'").test(list));
  /* The product page is server-rendered and does not read this endpoint, so
     these belong to it alone. */
  for (const c of ['care_instructions', 'pom_chest', 'upf_rating', 'certifications', 'model_height'])
    ok('but ' + c + ' does not travel to a card', !new RegExp("'" + c + "'").test(list));

  /* Exactly the select the per-product image fetches already use, so there is
     one answer to "what is an image row" rather than two that can drift. */
  ok('image rows carry only what the storefront reads',
    /const IMAGE_COLUMNS = 'image_url,alt_text,sort_order,color_variant_id,media_type';/.test(CAT));
  ok('…matching the per-product fetch the product pages already use',
    read('quick-add-modal.js').includes('select=image_url,alt_text,sort_order,color_variant_id,media_type'));
  ok('colourway rows drop the column nothing reads',
    /const VARIANT_COLUMNS = 'id,color_name/.test(CAT) && !/rgb_color/.test(code(CAT)));
  ok('…but keep the id the card swatches match images by',
    /VARIANT_COLUMNS = 'id,/.test(CAT));
}

console.log('\n  and every caller knows page one is not the shop');
{
  ok('there is one paging loop, not one per caller',
    /function fetchCatalog\(opts\)/.test(DATA) && /window\.zwFetchCatalog = fetchCatalog;/.test(DATA));
  ok('it stops on any of the three ends, and cannot spin',
    /var atEnd = serverComplete \|\| haveAll \|\| shortPage;/.test(code(DATA))
    && /var MAX_PAGES = \d+;/.test(code(DATA)));
  ok('…and "stop looping" is kept separate from "we saw all of it"',
    /var done = atEnd \|\| reachedMax \|\| pages >= MAX_PAGES;/.test(code(DATA))
    && /complete: atEnd/.test(code(DATA)),
    'a caller that asked for the first N must not be told it has the catalogue');
  ok('hitting the ceiling is reported, not swallowed',
    /the result is NOT the whole catalogue/.test(DATA));
  ok('a bare array still reads, so a page cached mid-deploy renders',
    /Array\.isArray\(body\) \? body : \(\(body && body\.products\) \|\| \[\]\)/.test(code(DATA)));

  ok('the homepage asks for a bounded page of the grid projection',
    /__zwProductsEarlyFetch=fetch\('\/api\/catalog\?view=list&limit=\d+&offset=0'\)/.test(INDEX));
  ok('…and hands that in-flight response to the pager rather than re-asking',
    /window\.zwFetchCatalog\(\{ view: 'list', pageSize: 250, first: earlyFetch \}\)/.test(code(HOME)));

  /* view=full here on purpose: this page's card carousel renders every photo
     of a colourway as a slide, so the trimmed grid projection would quietly
     shorten the carousels. */
  ok('the collection page keeps the full projection its carousels need',
    /window\.zwFetchCatalog\(\{ view: 'full', pageSize: 250 \}\)/.test(code(COLL)));
  ok('…and waits for every page before drawing its filters',
    /A sidebar built from\s*\n\s*page one would offer a subset of the real options/.test(COLL),
    'facets computed from a partial catalogue look exactly like complete ones');

  /* The admin decides which files in storage nothing references and then offers
     to delete them. Its own comment: "A reference report that misses a source
     does not under-report slightly; it invites a deletion." */
  ok('both admin media scans page to the end of the catalogue',
    (ADMIN.match(/window\.zwFetchCatalog\(\{ view: 'full', pageSize: 500 \}\)/g) || []).length === 2);
  ok('…and refuse to call anything unused when they could not read it all',
    /if \(!cat\.complete\) \{ checkedAll = false;/.test(code(ADMIN))
    && /if \(!cat\.complete\) complete = false;/.test(code(ADMIN)));
}

console.log('\n  twelve settings reads became one');
{
  ok('there is a shared read, and it is not a second request',
    /window\.__zwSettingsEarlyFetch \|\| null/.test(code(DATA)),
    'index.html already fires this in <head>; taking it costs nothing');
  ok('…taken once and cleared, so a later caller starts a fresh one',
    /window\.__zwSettingsEarlyFetch = null;/.test(code(DATA)));
  ok('a missing key resolves null; a FAILED read rejects',
    /if \(!body \|\| body\.ok !== true\) throw new Error\('settings not ok'\);/.test(code(DATA))
    && /return v === undefined \? null : v;/.test(code(DATA)),
    'collapsing the two would let a blip reset a store to the shipped defaults');
  ok('…and a failure is not remembered as the answer',
    /settingsPromise\.catch\(function \(\) \{ settingsPromise = null; \}\);/.test(code(DATA)));

  /* Four keys the storefront reads were not on the endpoint's allow-list, so
     those four modules had no choice but to call Supabase. Each is already
     visible to anyone who reads the rendered page, which is this file's own
     test for belonging. */
  for (const k of ['icons', 'theme_modes', 'text_overrides', 'header_layout'])
    ok('the endpoint now publishes ' + k, new RegExp("'" + k + "'").test(SETS));
  ok('…and none of the secret keys joined them',
    !/'commerce_config'|'email_settings'|'_draft'/.test(SETS));
  ok('updated_at travels with the values',
    /select=key,value,updated_at/.test(SETS) && /updatedAt\[row\.key\] = row\.updated_at/.test(code(SETS)),
    'header-layouts.js compares it against the stamp on the document');
  ok('a rejected query is no longer reported as a shop with no settings',
    /if \(!resp \|\| !resp\.ok\) return failed\(\);/.test(code(SETS))
    && /if \(!Array\.isArray\(rows\)\) return failed\(\);/.test(code(SETS)));

  const MODULES = [
    ['header-scroll.js', 'header_behavior'], ['announcement-bar.js', 'announcement_bar'],
    ['icon-sets.js', 'icons'], ['image-effects.js', 'image_effects'],
    ['theme-engine.js', 'theme_modes'], ['zw-copy.js', 'text_overrides'],
    ['integrations.js', 'integrations'], ['storefront-features.js', 'bag_panel'],
    ['fit-finder.js', 'fit_finder'], ['nav-menu.js', 'nav_menu'],
    ['flags.js', 'feature_flags'], ['express-wallet.js', 'integrations'],
    ['header-layouts.js', 'header_layout'],
  ];
  for (const [file, key] of MODULES) {
    const src = read(file);
    ok(file + ' reads ' + key + ' through the shared read',
      new RegExp("window\\.zwSettings\\s*\\n?\\s*[.?]|window\\.zwSettings").test(src)
      && new RegExp("'" + key + "'").test(src));
    /* Never a hard dependency on another file having loaded first. */
    ok('…and still works if zw-data.js is not on the page',
      /if \(window\.zwSettings\)/.test(src) || /window\.zwSettings\s*\n?\s*\?/.test(src));
  }

  ok('express-wallet and integrations share one read of the same row',
    /window\.zwSettings\s*\n?\s*\? window\.zwSettings\.get\('integrations'\)/.test(read('express-wallet.js')));
  ok('header-layouts asks for the timestamp it needs',
    /window\.zwSettings\.getWithMeta\('header_layout'\)/.test(read('header-layouts.js')));
}

console.log('\n  zw-data.js is in front of everything that reads through it');
{
  const PAGES = ['404.html', 'about.html', 'account.html', 'bag.html', 'checkout.html',
    'confirm.html', 'drop001.html', 'index.html', 'journal.html', 'landing.html',
    'policies.html', 'product.html', 'returns.html', 'sizeguide.html'];
  /* Deferred scripts run in document order, so the requirement is that
     zw-data.js comes before every module that reads window.zwSettings.

     NOT "first", though — that was the first attempt and it broke a different
     invariant. preview-mode.js has its own, held by tests/preview-mode.test.js:
     it takes the ?zwpreview= token out of the address bar and must have done so
     before any renderer looks for it. It goes first; zw-data.js goes directly
     after. preview-mode.js reads no settings, so nothing is lost.

     (That collision passed locally by three characters and only failed once the
     cache-bust hash lengthened the tag. Hence `npm run ci`, not `node
     tests/run.js`.) */
  const READERS = ['header-scroll.js', 'announcement-bar.js', 'icon-sets.js',
    'image-effects.js', 'theme-engine.js', 'zw-copy.js', 'integrations.js',
    'storefront-features.js', 'fit-finder.js', 'nav-menu.js', 'flags.js',
    'express-wallet.js', 'header-layouts.js'];
  for (const page of PAGES) {
    const html = read(page);
    const mine = html.search(/<script[^>]*\ssrc="[^"]*zw-data\.js/);
    ok(page + ' loads zw-data.js at all', mine > -1);
    if (mine < 0) continue;
    const late = READERS.filter((f) => {
      const at = html.search(new RegExp('<script[^>]*\\ssrc="[^"]*' + f.replace('.', '\\.')));
      return at > -1 && at < mine;
    });
    ok('…before every module that reads through it', late.length === 0, late.join(', '));
  }
  /* And the other invariant it must not displace. */
  for (const page of PAGES) {
    const html = read(page);
    const pv = html.search(/<script[^>]*\ssrc="[^"]*preview-mode\.js/);
    if (pv < 0) continue;
    const mine = html.search(/<script[^>]*\ssrc="[^"]*zw-data\.js/);
    ok(page + ': preview-mode.js still runs before it', pv < mine,
      'preview-mode reads the ?zwpreview= token before any renderer looks for it');
  }
  ok('the admin gets it too, for the paging loop its media scans need',
    /zw-data\.js/.test(read('admin.html')));
}

console.log('\n  and video has somewhere to fall when Cloudinary stops answering');
{
  /* Routing video through Cloudinary is what made this necessary. Before that
     the hero came straight off R2 and a Cloudinary outage could not touch it;
     afterwards the fallback listener returned immediately for anything that
     was not an <img>, so an over-quota account meant a black rectangle.

     Checked against the live hero:
         Cloudinary video/fetch          1,239,381 b   HTTP 200
         raw from R2 (the fallback)      5,755,657 b   HTTP 200
         images.weserv.nl asked for it          99 b   HTTP 404  (image service)

     So video is a ONE-step fallback and images stay a two-step one — the cost
     is bytes, not the video. */
  ok('the fallback covers <video>, not only <img>',
    /if \(img\.tagName === 'VIDEO'\) \{ videoFallback\(img\); return; \}/.test(code(UTIL)));
  ok('…and a <source> inside one, which reports on itself',
    /if \(img\.tagName === 'SOURCE' && img\.parentElement/.test(code(UTIL)));
  ok('it falls to the raw original, since no second optimiser takes video',
    /const orig = originalFromFetchUrl\(src, 'video'\);/.test(code(UTIL))
    && /el\.src = orig;/.test(code(UTIL)));
  ok('…once only, because there is nowhere further to fall',
    /if \(el\.dataset\.zwVfb === '1'\) return;/.test(code(UTIL)));
  ok('the poster goes with it — same account, same outage',
    /if \(poster\.indexOf\('res\.cloudinary\.com'\) !== -1\) el\.removeAttribute\('poster'\);/.test(code(UTIL)),
    'left in place it would sit over the video that is now working');
  ok('one URL-recovery helper serves both media types',
    /function originalFromFetchUrl\(src, kind\)/.test(UTIL)
    && /originalFromFetchUrl\(src, 'image'\)/.test(code(UTIL)));
  ok('…and it only ever touches our own fetch URLs',
    /if \(url\.indexOf\('res\.cloudinary\.com'\) === -1\) return '';/.test(code(UTIL))
    && /const marker = '\/' \+ kind \+ '\/fetch\/';/.test(code(UTIL)),
    'a Cloudinary URL somebody stored directly must be left alone');
}

console.log('\n  the hero starts loading on the FIRST visit, not the second');
{
  /* The existing preload block reads localStorage, so it does nothing at all
     for someone who has never been here. Their largest element could not begin
     downloading until storefront.js — 39,953 bytes on the wire, deferred, and
     24% of the homepage's whole script payload — had been fetched, parsed, run,
     and had waited for its settings. Measured live: LCP 5,716 ms, and the LCP
     element was the hero VIDEO.

     The answer was already in flight: /api/storefront-settings is fired in the
     <head>. So the hero is read out of THAT. Verified against the live payload
     before shipping — the block picks the first visible section, resolves the
     video to its poster frame, and both viewports return a real image:

         desktop  …/video/fetch/so_0,f_jpg,q_auto,w_1400/…   200   58,439 b
         mobile   …/video/fetch/so_0,f_jpg,q_auto,w_760/…    200   27,687 b  */
  ok('the head reads the hero out of the settings already in flight',
    /window\.__zwSettingsEarlyFetch\s*\n\s*\.then\(function\(r\)\{ return r\.ok \? r\.clone\(\)\.json\(\) : null; \}\)/.test(INDEX));
  ok('…by cloning, so it does not consume the body zw-data.js needs',
    /r\.clone\(\)\.json\(\)/.test(INDEX),
    'this handler is registered first, so the clone is taken before anything reads it');
  ok('it preloads the FIRST VISIBLE section, not the first hero anywhere',
    /\.filter\(function\(s\)\{ return s && s\.visible !== false; \}\)\[0\]/.test(INDEX)
    && /if \(!top \|\| \(top\.type !== 'hero' && top\.type !== 'hero_carousel'\)\) return;/.test(INDEX),
    'a hero three sections down is not the largest paint, and would compete with whatever is');
  ok('…respecting the per-device hide switches',
    /if \(narrow \? s\.hide_mobile : s\.hide_desktop\) return;/.test(INDEX));
  ok('…and the mobile media override',
    /\(narrow && sl\.media_url_mobile\) \|\| sl\.media_url/.test(INDEX));
  ok('a video preloads its POSTER, which is what actually paints',
    /if \(isVideo\) url = sl\.video_poster \|\| zwPosterOf\(url\);/.test(INDEX),
    '58 KB against 1.2 MB — the video arrives behind it');
  ok('…preferring the poster the admin set over the derived one',
    /sl\.video_poster \|\| zwPosterOf/.test(INDEX));
  ok('the preload is high priority',
    /pre\.fetchPriority = 'high';/.test(INDEX));
  ok('…and is remembered for the synchronous path on the next visit',
    /localStorage\.setItem\('zw-hero-media', href\)/.test(INDEX));
  ok('it renders nothing — a wrong guess costs one wasted request, never a wrong hero',
    !/innerHTML/.test(INDEX.slice(INDEX.indexOf('THE HERO, FOR SOMEONE WHO HAS NEVER'),
      INDEX.indexOf('function zwOptHead'))));

  /* These two duplicate image-utils.js because they run in <head>, before it.
     Duplication is the price of being early; drift is what makes it a bug. */
  ok('the head transform agrees with the real optimizeImage',
    /f_auto,q_auto:eco,w_/.test(INDEX) && /f_auto,q_auto:eco,w_\$\{safeWidth\}/.test(UTIL));
  ok('the head poster agrees with the real videoPosterUrl',
    /video\/fetch\/so_0,f_jpg,q_auto,w_/.test(INDEX)
    && /so_0,f_jpg,q_auto,w_\$\{safeWidth\}/.test(UTIL));
  ok('…and both use the same cloud name',
    (INDEX.match(/res\.cloudinary\.com\/dubg4loah/g) || []).length >= 2
    && /DEFAULT_CLOUDINARY_CLOUD_NAME = 'dubg4loah'/.test(UTIL));
  ok('…and the same viewport caps',
    (INDEX.match(/cap = 760; else if\(vw && vw <= 900\) cap = 1000;/g) || []).length >= 2
    && /MAX_MOBILE_WIDTH = 760/.test(UTIL) && /MAX_TABLET_WIDTH = 1000/.test(UTIL));
}

console.log('\n  four modules left the ordered queue, and only the four that could');
{
  /* Deferred scripts execute in DOCUMENT ORDER, so a slow one holds up every
     script after it — including the ones that paint the nav, the copy and the
     header arrangement. That ordering cost more than the bytes did. */
  const PAGES = ['404.html', 'about.html', 'account.html', 'bag.html', 'checkout.html',
    'confirm.html', 'drop001.html', 'index.html', 'journal.html', 'landing.html',
    'policies.html', 'product.html', 'returns.html', 'sizeguide.html'];
  const tag = (html, file) => {
    const m = html.match(new RegExp('<script[^>]*\\ssrc="[^"]*' + file.replace('.', '\\.') + '[^"]*"[^>]*>'));
    return m ? m[0] : '';
  };
  for (const page of PAGES) {
    const html = read(page);
    for (const f of ['email-popup.js', 'lang.js', 'customer-hub.js']) {
      const t = tag(html, f);
      if (!t) continue;
      ok(page + ' loads ' + f + ' out of the ordered queue',
        / async[ >]/.test(t) && !/ defer[ >]/.test(t), t.slice(0, 60));
    }
  }
  ok('reviews.js is async on the homepage, where nothing inline calls it',
    / async[ >]/.test(tag(INDEX, 'reviews.js')));
  /* product.html has onclick="openReviewForm(...)" written into its markup, and
     an inline handler naming a function that has not loaded yet throws rather
     than waiting. defer is what guarantees it has run before anything is
     clickable. */
  ok('…but stays deferred on the product page, which has an inline handler for it',
    / defer[ >]/.test(tag(read('product.html'), 'reviews.js'))
    && /onclick="openReviewForm\(/.test(read('product.html')));

  /* Leaving the deferred queue means a script can run AFTER DOMContentLoaded,
     and a listener registered for an event that already fired never runs. Both
     files that had an unguarded one were guarded first. */
  ok('customer-hub.js no longer depends on being early to initialise',
    /if \(document\.readyState === 'loading'\)/.test(read('customer-hub.js'))
    && /document\.addEventListener\('DOMContentLoaded', boot, \{ once: true \}\)/.test(read('customer-hub.js')));
  ok('reviews.js does not either',
    /function zwOnReady\(fn\)/.test(read('reviews.js'))
    && !/^document\.addEventListener\('DOMContentLoaded'/m.test(code(read('reviews.js'))));

  /* These two look like the same kind of module and are not: between them they
     define showToast, renderCart, loadCartCount, animateAddToBag,
     closeMobileMenu and openAuth, called from more than ten other files.
     Loading either late leaves a window with showToast undefined site-wide. */
  for (const f of ['quick-add-modal.js', 'zw-login.js'])
    ok(f + ' stayed in the queue — other files call its globals',
      / defer[ >]/.test(tag(INDEX, f)), tag(INDEX, f).slice(0, 60));
  ok('…and that is true of showToast specifically',
    /window\.showToast\s*=/.test(read('quick-add-modal.js')));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
