/* The header pre-paint, and the one thing about it that is invisible when wrong.
 *
 * storefront-features.js is deferred, so without a pre-paint block the header
 * renders and then changes half a second later — a search magnifier appears,
 * the bag-panel class lands. Small, and exactly the movement that makes a
 * storefront feel unfinished on every navigation.
 *
 * THE INVARIANT THIS FILE IS FOR: the block has to sit AFTER the header markup.
 * It queries `.nav-right` / `.zw-hdr-group` and inserts a button into whichever
 * it finds. Placed above them it finds nothing, inserts nothing, and throws
 * nothing — it silently stops being a feature, and the page looks exactly the
 * same as a page that never had it. Nothing about reading the block tells you
 * whether it is in the right place; only its position in the document does.
 *
 * The rest is the same problem sync-preboot.js already solved for the theme
 * block: one source, mechanically stamped into ten pages, drift fails the
 * build. It used to be inline on two pages, absent from eight, and the copy it
 * had knew only one of the two header dialects — so pasting it into the other
 * eight would have done nothing anyway.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { headerBlock, HDR_PAGES, HDR_OPEN, HDR_CLOSE, HDR_SRC } =
  require(path.join(ROOT, 'scripts', 'sync-preboot.js'));
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

console.log('\n  one header pre-paint, in the right place\n');

console.log('  every page carries the same block');
{
  const want = headerBlock();
  const drifted = [];
  const absent = [];
  for (const page of HDR_PAGES) {
    const html = read(page);
    const a = html.indexOf(HDR_OPEN);
    const b = html.indexOf(HDR_CLOSE);
    if (a < 0 || b < a) { absent.push(page); continue; }
    /* Line endings differ by checkout, and git normalises them in the blob —
       comparing raw bytes would fail on Windows for a reason that has nothing
       to do with the code. */
    const got = html.slice(a, b + HDR_CLOSE.length).replace(/\r\n/g, '\n');
    if (got !== want.replace(/\r\n/g, '\n')) drifted.push(page);
  }
  ok('all ' + HDR_PAGES.length + ' pages have the markers', absent.length === 0, absent.join(', '));
  ok('…and none has drifted from the source', drifted.length === 0,
    drifted.join(', ') + ' — run `node scripts/sync-preboot.js`');
}

console.log('\n  and it runs after the header it reaches into');
{
  /* THE ONE THAT MATTERS. Asserted per page, by position, because there is no
     other way to see it: a block above the nav is syntactically perfect and
     functionally absent. */
  const wrong = [];
  const unanchored = [];
  for (const page of HDR_PAGES) {
    const html = read(page);
    const block = html.indexOf(HDR_OPEN);
    /* The anchor is the one the BLOCK would pick, in the block's own order:
       .nav-right first, .zw-hdr-group only if that is absent. Taking the later
       of the two positions instead flagged index.html and product.html, which
       carry BOTH — a .nav-right header at 2163 and a zw-hdr-group inside the
       mobile drawer at 2191. The block reaches the header it will actually use;
       the drawer further down is irrelevant to it. A test that models the code
       loosely reports the code as broken. */
    const browse = html.indexOf('class="nav-right"');
    const info = html.indexOf('zw-hdr-group');
    const nav = browse >= 0 ? browse : info;
    if (nav < 0) { unanchored.push(page); continue; }
    if (block < nav) wrong.push(page + ' (block at ' + block + ', header at ' + nav + ')');
  }
  ok('no page runs the block before its header', wrong.length === 0, wrong.join(', '));
  ok('…and every page has a header for it to find', unanchored.length === 0, unanchored.join(', '));
}

console.log('\n  it knows both header dialects');
{
  /* Named individually. This codebase has five nav dialects and two button
     systems, and a selector written against one silently does nothing on the
     others — which is exactly how the previous copy could look correct on the
     page it was written for and reach none of the rest. */
  const src = read(path.relative(ROOT, HDR_SRC).replace(/\\/g, '/'));
  ok('the browse header (.nav-right + #cart-btn + .nbtn)',
    /\.nav-right/.test(src) && /#cart-btn/.test(src) && /'nbtn'/.test(src));
  ok('the information header (.zw-hdr-group + .zw-hdr-bag + .zw-hdr-action)',
    /\.zw-hdr-group/.test(src) && /\.zw-hdr-bag/.test(src) && /'zw-hdr-action'/.test(src));
  ok('…and the button takes the class of whichever host was found',
    /className = cls \+ ' zwf-search-btn'/.test(src),
    'a fixed class arrives unstyled on the other dialect');

  /* Both pages of the store that used to carry their own copy. A second
     insertion path would put two magnifiers in one header. */
  for (const page of ['index.html', 'product.html']) {
    const html = read(page);
    const outside = html.slice(0, html.indexOf(HDR_OPEN))
      + html.slice(html.indexOf(HDR_CLOSE));
    ok(page + ' has no second copy outside the markers',
      !/zwf-search-btn/.test(outside),
      'it had one fused into its auth pre-paint block');
  }
}

console.log('\n  the icon is the module\'s icon');
{
  /* Two icons that differ by a stroke width flicker at the moment
     storefront-features.js takes over — the single thing this block exists to
     prevent, arrived at from the other direction. */
  const feat = read('storefront-features.js');
  const m = feat.match(/var SEARCH_SVG\s*=\s*'([^']+)'/);
  ok('storefront-features.js still declares SEARCH_SVG', !!m,
    'the pin has nothing to hold onto');
  if (m) {
    const src = read(path.relative(ROOT, HDR_SRC).replace(/\\/g, '/'));
    ok('…and the pre-paint draws exactly that', src.includes(m[1]));
    for (const page of HDR_PAGES) {
      const html = read(page);
      if (!html.includes(m[1])) { ok(page + ' ships the same icon', false, 'differs from SEARCH_SVG'); break; }
    }
    ok('…on every page', HDR_PAGES.every((p) => read(p).includes(m[1])));
  }
}

console.log('\n  what it does not assume');
{
  const src = read(path.relative(ROOT, HDR_SRC).replace(/\\/g, '/'));
  ok('a header that already has the button is left alone',
    /if \(host\.querySelector\('\.zwf-search-btn'\)\) return;/.test(src),
    'on a warm cache the module may have run first — inserting again gives two');
  ok('a missing bag still lands the button in the actions row',
    /if \(before\) host\.insertBefore\(b, before\); else host\.appendChild\(b\);/.test(src));
  ok('the bag-panel class defaults ON, since only "0" turns it off',
    /getItem\('zw_bp'\) !== '0'/.test(src),
    'a browser that has never heard of the setting must get the shipped behaviour');
  ok('nothing here can throw into the page', /catch \(_\)/.test(src));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
