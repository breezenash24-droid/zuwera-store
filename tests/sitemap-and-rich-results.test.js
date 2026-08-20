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
const EDGE = read('functions/product/[slug].js');
const MAIN = read('product-main.js');
const STORE = read('storefront.js');
const BUILD = read('scripts/cloudflare-pages-build.js');

console.log('\n  the sitemap is generated, and the markup carries its ratings\n');

console.log('  the sitemap comes from the catalogue');
{
  /* IT SHIPPED AS functions/sitemap.xml.js AND THAT ROUTE DOES NOT EXIST.
     Measured on the deployed site: /sitemap.xml returned 404 with the 404
     page's body — the dot in the filename means Pages never registered it, and
     the static file had been deleted in the same change, so the result was no
     sitemap at all. Worse than the stale one it replaced, and invisible from
     here, because every assertion in this file reads the repository rather
     than the response.

     The generator is now a module, and functions/_middleware.js answers the
     path. That is not another guess: the middleware demonstrably runs in
     production, because it is what stamps the header arrangement into the
     HTML of every page. */
  ok('the generator is a module, not a dotted route',
    fs.existsSync(path.join(ROOT, SITEMAP_FILE))
    && !fs.existsSync(path.join(ROOT, 'functions/sitemap.xml.js')),
    'functions/sitemap.xml.js is not a route Cloudflare Pages will serve');
  ok('...and the middleware answers /sitemap.xml with it',
    /url\.pathname === '\/sitemap\.xml'/.test(MW)
    && /await buildSitemap\(env\)/.test(MW)
    && /import \{ buildSitemap \} from '\.\/api\/_sitemap\.js'/.test(MW));
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
