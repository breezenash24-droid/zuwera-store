/* Two things a crawler needs, both of which stopped one step short.
 *
 * ── THE SITEMAP WAS TYPED BY HAND ───────────────────────────────────────────
 *
 * sitemap.xml was a static file with product UUIDs written into it, last
 * touched on 11 June, which cloudflare-pages-build.js copied to the output.
 * Nothing generated it. Measured against the live catalogue on 20 August:
 *
 *     live products                      11
 *     product URLs in the file            4
 *     in the catalogue but not listed     7
 *
 * Seven of eleven products did not exist as far as a crawler was concerned.
 *
 * A build step would have been correct at deploy time and wrong again as soon
 * as somebody published a product — and publishing does not deploy here, by
 * explicit decision. So it is generated per request at the edge, and the static
 * file is DELETED rather than left behind: a static asset would win over the
 * function route, and a file that shadows its own replacement looks fixed for
 * months.
 *
 * ── THE PRODUCT MARKUP HAD NO RATING, AND WAS BEING OVERWRITTEN ─────────────
 *
 * functions/product/[slug].js renders Product + Offer into the head before the
 * browser sees the page, which is genuinely well done and is why social cards
 * work. It carried no aggregateRating — the stars under a search result —
 * although the reviews were already in the database and already on the page.
 *
 * Adding it there alone would have achieved nothing, and finding out why is the
 * more useful half of this file: product-main.js REPLACED that element wholesale
 * on every page load. It was already deleting the server's `sku` field, unnoticed,
 * and would have deleted the rating the same way. It now merges onto what the
 * server wrote instead.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
/* Comments stripped for absence checks — the file explains which pages it
   leaves out BY NAME, so a grep that reads comments finds the explanation and
   calls it the defect. */
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

const SITEMAP_FILE = 'functions/api/_sitemap.js';
const SITEMAP = read(SITEMAP_FILE);
const MW = read('functions/_middleware.js');
const ROUTES = read('_routes.json');
const EDGE = read('functions/product/[slug].js');
const MAIN = read('product-main.js');
const STORE = read('storefront.js');
const BUILD = read('scripts/cloudflare-pages-build.js');

console.log('\n  the sitemap is generated, and the markup carries its ratings\n');

console.log('  the sitemap comes from the catalogue');
{
  /* THREE ATTEMPTS, AND ONLY THE THIRD DIAGNOSIS WAS RIGHT.

       1  shipped as functions/sitemap.xml.js       → 404
       2  blamed the dot; moved to a module answered by the middleware → 404
       3  read _routes.json, which lists the ONLY paths that reach a Function
          at all. Everything else is served straight off the asset store with
          no Worker running — so neither the route nor the middleware had ever
          been invoked, and with the static file deleted the 404 page answered.

     Both of the first two were guesses that looked like reasoning, and each
     cost a deploy. The generalisable check is the routing one below; the
     module-vs-route shape is now just tidiness. */
  ok('the generator is a module rather than a dotted route',
    fs.existsSync(path.join(ROOT, SITEMAP_FILE))
    && !fs.existsSync(path.join(ROOT, 'functions/sitemap.xml.js')),
    'a dotted filename is at best ambiguous; the underscore says plainly it is not a route');
  ok('...and the middleware answers /sitemap.xml with it',
    /url\.pathname === '\/sitemap\.xml'/.test(MW)
    && /await buildSitemap\(env\)/.test(MW)
    && /import \{ buildSitemap \} from '\.\/api\/_sitemap\.js'/.test(MW));
  /* THE ONE THAT ACTUALLY MATTERED. _routes.json lists the only paths that
     reach a Function at all — everything else is served straight off the asset
     store with no Worker running, which is why neither functions/sitemap.xml.js
     nor the middleware was ever invoked. Two deploys were spent guessing at the
     filename before anybody read this file.

     Any path answered by the middleware has to be in here, so this is the
     assertion that generalises: add a middleware-served path without adding it
     to the include list and it silently 404s. */
  ok('/sitemap.xml is routed to Functions at all',
    /"\/sitemap\.xml"/.test(ROUTES),
    '_routes.json is the list of paths a Worker ever sees — omitted means the asset store answers, and there is no asset');
  ok('...and the include list is still valid JSON with the old entries intact',
    (() => { try { const j = JSON.parse(ROUTES); return Array.isArray(j.include) && j.include.includes('/api/*') && j.include.includes('/'); } catch (_) { return false; } })(),
    'a malformed _routes.json takes every Function down, not just this one');

  ok('...falling through rather than 500ing if it throws',
    /try \{ return await buildSitemap\(env\); \} catch \(_\) \{/.test(MW));
  ok('…and the hand-typed file is gone', !fs.existsSync(path.join(ROOT, 'sitemap.xml')),
    'a static asset wins over the function route — leaving it would shadow the fix');
  ok('…and the build no longer copies it', !/'sitemap\.xml'/.test(BUILD));
  ok('robots.txt still points at it', /Sitemap: https:\/\/zuwera\.store\/sitemap\.xml/.test(read('robots.txt')));

  ok('every live product is listed',
    /products\?select=id,title,updated_at,status/.test(SITEMAP)
    && /status=neq\.Legacy&status=neq\.Draft/.test(SITEMAP),
    'the same filter /api/catalog uses — a draft must not be advertised before it is published');
  ok('…at the URL the site actually links to',
    /function productSlug\(title\)/.test(SITEMAP)
    && /`\/product\/\$\{slug\}`/.test(SITEMAP)
    && /`\?id=\$\{p\.id\}`/.test(SITEMAP),
    'a sitemap entry nobody can reach from the site advertises a page that does not exist');

  /* THE SLUG RULE LIVES IN TWO PLACES and cannot be imported into a Worker from
     a browser bundle, so it is held level by comparison — the same device the
     RBAC mirror and the variant-price parity test use. */
  const one = (SITEMAP.match(/replace\(\/\^zuwera\\s\+\/i, ''\)[\s\S]{0,220}?replace\(\/\^-\|-\$\/g, ''\)/) || [])[0];
  const two = (STORE.match(/replace\(\/\^zuwera\\s\+\/i, ''\)[\s\S]{0,220}?replace\(\/\^-\|-\$\/g, ''\)/) || [])[0];
  ok('the slug rule matches storefront.js exactly',
    !!one && !!two && one.replace(/\s+/g, '') === two.replace(/\s+/g, ''),
    'two spellings of one URL is a sitemap full of 404s');

  ok('published journal posts are listed too',
    /journal_posts\?select=slug/.test(SITEMAP) && /status=eq\.published/.test(SITEMAP));
  ok('pages that show YOUR data are not',
    !/account\.html|\/bag\.html|checkout\.html/.test(code(SITEMAP_FILE)),
    'nothing to index, and listing them invites the attempt');
  ok('the template page is not listed either',
    !/'\/product\.html'/.test(code(SITEMAP_FILE)),
    'every real product has its own entry; product.html is the shell');

  ok('a failed query costs entries, not the response',
    /catch \(_\) \{\s*return \[\];/.test(SITEMAP),
    'a sitemap that 500s tells a crawler the site is broken');
  ok('it is cached at the edge but not for long',
    /max-age=3600/.test(SITEMAP),
    'long enough that a crawl is not eleven round trips, short enough to matter');
}

console.log('\n  the product markup carries a rating');
{
  ok('the edge reads the ratings', /function fetchRatingSummary/.test(EDGE));
  ok('…and adds aggregateRating', /'@type': 'AggregateRating'/.test(EDGE)
    && /ratingValue: String\(rating\.value\)/.test(EDGE)
    && /ratingCount: rating\.count/.test(EDGE));
  ok('…only when there is something to aggregate',
    /if \(rating && rating\.count > 0\)/.test(EDGE),
    'ratingValue 0 from 0 ratings is a markup error, not "no reviews yet"');
  ok('…over the same set the page displays',
    /reviews\?product_id=eq\./.test(EDGE) && !/status=eq\./.test(EDGE.split('fetchRatingSummary')[1].slice(0, 800)),
    'reviews.js filters on product_id alone — an aggregate over a smaller set overstates the rating');
  ok('…fetched alongside the product, not after it',
    /await Promise\.all\(\[\s*\n\s*fetchProductSeo/.test(EDGE),
    'a second round trip is not a reason for a second wait');
  ok('…and a failed lookup still serves the rest of the markup',
    /A rating lookup must never cost the page its other markup/.test(EDGE));

  /* The reason adding it at the edge alone would have done nothing. */
  ok('the runtime writer merges rather than replaces',
    /\.\.\._ld,/.test(MAIN) && /JSON\.parse\(_ldEl\.textContent \|\| '\{\}'\)/.test(MAIN),
    'it was deleting the server’s sku on every page load, and would have deleted the rating');
  ok('…including inside offers',
    /\.\.\.\(_ld\.offers && typeof _ld\.offers === 'object' \? _ld\.offers : \{\}\)/.test(MAIN));
  ok('…while still owning what changes as you click',
    /price: _price/.test(MAIN) && /availability: _avail/.test(MAIN) && /image: _pImg/.test(MAIN),
    'the colourway’s price and picture are the browser’s to know, not the server’s');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
