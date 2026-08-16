/* 229KB that every product view downloaded again.
 *
 * product.html was 351KB, and 240KB of it was inline <script>. Inline script
 * cannot carry an ETag and cannot be cached separately from the document, and
 * the document is deliberately `no-cache, must-revalidate` because it has to
 * show current stock and prices. So the same 240KB — a quarter of a megabyte,
 * about 60KB over the wire compressed — was fetched again for every product a
 * shopper looked at, on every visit, forever. Three products is three copies.
 *
 * The two big blocks are now product-main.js and product-cart.js, which `/*.js`
 * in _headers caches for a year as immutable, with the content hash in ?v=
 * doing the busting. The page itself is 144KB and still revalidates.
 *
 * WHAT MAKES THIS SAFE, and what this file exists to keep true: they are
 * CLASSIC scripts at the same position in the document. Classic scripts share
 * global scope, execute in document order, and block the parser exactly as an
 * inline block does — so top-level declarations, hoisting inside each block,
 * and the order everything runs in are all unchanged. The moment one of them
 * grows a `defer` or `async`, or the tags are reordered, that stops being true
 * and the page breaks in ways a grep for "does it still say X" cannot see.
 *
 * The extraction was verbatim. Nothing was split, renamed, or "tidied on the
 * way" — see the admin's giant script in enterprise-admin-roadmap for why
 * splitting one of these is a different and much worse job than moving it.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const P = require('./_product-source');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const html = P.html();
const kb = (n) => (n / 1024).toFixed(0) + 'KB';

console.log('\n  the product page stopped re-sending its own code\n');

console.log('  what is left inline is only what has to be');
{
  const inline = [...html.matchAll(/<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const total = inline.reduce((s, b) => s + b.length, 0);
  const biggest = inline.slice().sort((a, b) => b.length - a.length)[0] || '';

  /* A budget, not a ban. The pre-paint theme block and the first-paint auth
     block MUST stay inline — they exist to run before the first frame, and a
     separate request is the one thing that would defeat them. Everything else
     belongs in a file. */
  ok('inline script is under 20KB in total', total < 20 * 1024, kb(total) + ' across ' + inline.length + ' blocks');
  ok('…and no single inline block is over 8KB', biggest.length < 8 * 1024, kb(biggest.length),
    'a block this size is a file that has not been moved yet');
  ok('the page itself is under 200KB', html.length < 200 * 1024, kb(html.length));
}

console.log('\n  the extracted files are real, and they are classic scripts');
{
  for (const f of P.EXTRACTED) {
    const p = path.join(ROOT, f);
    ok(f + ' exists', fs.existsSync(p));
    let src = '';
    try { src = fs.readFileSync(p, 'utf8'); } catch (_) {}
    /* Parsed, not pattern-matched. An extraction that lost a brace produces a
       file that greps fine and throws on load — and the page it breaks is the
       one every shopper reaches. */
    let parses = false;
    try { new Function(src); parses = true; } catch (e) { parses = e.message; }
    ok('…and parses standalone as a classic script', parses === true, String(parses));
    ok('…and is not empty', src.length > 1024, kb(src.length));
  }
}

console.log('\n  loaded the way inline script behaved');
{
  const tags = [...html.matchAll(/<script\b([^>]*\ssrc="(product-(?:main|cart)\.js)[^"]*")([^>]*)>/g)];
  ok('both are referenced from the page', tags.length === 2, tags.length + ' found');

  for (const t of tags) {
    const attrs = t[1] + t[3];
    /* THE ONE THAT SILENTLY BREAKS IT. defer moves execution to after parsing;
       async moves it to whenever. Either turns a guaranteed order into a race
       between two files that share globals and a page that calls into them. */
    ok(t[2] + ' is not deferred or async', !/\b(defer|async)\b/.test(attrs), attrs.trim());
    ok('…and is cache-busted by content hash', /\?v=[0-9a-f]{6,}/.test(t[1]),
      'without ?v= a year of immutable caching serves the old file forever');
  }

  const main = html.indexOf('src="product-main.js');
  const cart = html.indexOf('src="product-cart.js');
  ok('main comes before cart, as the blocks did', main > 0 && cart > main);

  /* Both sat at the bottom of the body, after the markup they operate on.
     Moving one into <head> would run it against a document that is not there
     yet — the same failure as adding defer, arrived at from the other side. */
  const bodyEnd = html.lastIndexOf('</body>');
  const headEnd = html.indexOf('</head>');
  ok('…and both load after the markup they touch', main > headEnd && cart < bodyEnd);
}

console.log('\n  the build ships them');
{
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'cloudflare-pages-build.js'), 'utf8');
  for (const f of P.EXTRACTED) {
    ok(f + ' is in the Pages file list', new RegExp("'" + f.replace('.', '\\.') + "'").test(build),
      'a file the build does not copy is a 404 on the busiest page of the store');
  }

  const headers = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8');
  const jsBlock = headers.slice(headers.indexOf('/*.js'), headers.indexOf('/*.js') + 120);
  ok('js is cached hard, which is the entire point',
    /max-age=31536000/.test(jsBlock) && /immutable/.test(jsBlock), jsBlock.split('\n')[1]);

  /* And the document must NOT be, or the page would serve stale prices to hold
     on to a saving that the extracted files already deliver. */
  ok('…while the document still revalidates',
    /no-cache/.test(headers.slice(0, headers.indexOf('/*.js'))),
    'stock and price are on this page; it cannot be cached hard');
}

console.log('\n  and nothing was left behind');
{
  /* Spot checks that the code actually moved rather than being duplicated or
     dropped. Each names something the page cannot work without. */
  const all = P.all();
  for (const [what, re] of [
    ['the product loader', /async function loadProduct/],
    ['add to cart', /function addToCart|addToCart\s*=/],
    ['the size renderer', /function renderSizes\(/],
    ['the cart modal', /CART MODAL LOGIC/],
  ]) {
    ok(what + ' is still there', re.test(all));
    /* Present ONCE. A copy-instead-of-move leaves the page working and doubles
       the bytes, which is the failure this whole change was about. */
    const inPage = (P.html().match(re) || []).length;
    ok('…and not left in the page as well', inPage === 0,
      'the extraction moves code; a duplicate would ship both copies');
  }
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
