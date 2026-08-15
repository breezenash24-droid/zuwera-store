/* Every surface that shows a bag line shows the SAME price the till charges.
 *
 * One product, one shopper, one instant — and four different numbers on screen:
 *
 *   bag panel (header)   $30      item.price, frozen at add-to-bag time
 *   bag.html             $40      regularPrice, which is the COMPARE-AT
 *   checkout header      $40      the same
 *   checkout line        $32      the product-wide row, not the colour's
 *   the card             $30      correct — the till resolves the colour by name
 *
 * The till was the only one that was right. It fetches the colourway by NAME and
 * runs resolvePrice, so it charged Yellow's $30 while three screens said
 * something else. Safe in direction — never-bill-above-the-quote lets a lower
 * charge through — and wrong in every other way: a shopper cannot see what they
 * are paying, and a member never sees the discount they are being given.
 *
 * ── THE THREE CAUSES, ALL DIFFERENT ─────────────────────────────────────────
 *
 * 1. THE BAG PANEL NEVER ASKED. It printed localStorage's `price`, the figure
 *    written when the item was added — so it showed yesterday's price after any
 *    change, and the catalogue price to a member.
 *
 * 2. CHECKOUT ASKED WITHOUT THE COLOUR'S ID. It fetched color_variants without
 *    selecting `id`, so `variant.id` was undefined on every row and
 *    resolvedFor() fell through to the product-wide figure. A $30 colourway
 *    displayed as the $32 product price.
 *
 * 3. THE BAG PAGE PREFERRED THE WAS-PRICE. normalizeCartPricing read
 *    `regularPrice || item.price`, and checkout.js fills regularPrice from
 *    compare-at — so a line correctly repriced to $30 rendered at $40.
 *
 * The fix is the one this whole area keeps arriving at: one answerer. Every
 * display reads /api/prices through ZWVariantPrice, keyed by the colour NAME,
 * because that is the only colour identity a cart line has ever carried — and
 * it is the same key the till uses.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SRC      = fs.readFileSync(path.join(ROOT, 'variant-price.js'), 'utf8');
const CHECKOUT = fs.readFileSync(path.join(ROOT, 'checkout.js'), 'utf8');
const BAG      = fs.readFileSync(path.join(ROOT, 'bag.html'), 'utf8');
const PANEL    = fs.readFileSync(path.join(ROOT, 'storefront-features.js'), 'utf8');
const ENGINE   = fs.readFileSync(path.join(ROOT, 'theme-engine.js'), 'utf8');

/* The live answer for the product in the report: a product-wide row at $32 and
   a Yellow colourway at $30. The cart line is Yellow. */
const PAYLOAD = {
  ok: true, memberPricing: false,
  products: [{
    productId: 'p-1',
    base: { priceCents: 3200, regularCents: 3200, compareAtCents: 4000, memberPriceCents: 0, usingMember: false, source: 'list' },
    colours: [
      { id: 'v-yellow', colorName: 'Yellow',   priceCents: 3000, regularCents: 3000, compareAtCents: 4000, memberPriceCents: 0, usingMember: false, source: 'list' },
      { id: 'v-tenn',   colorName: 'Tennesee', priceCents: 3500, regularCents: 3500, compareAtCents: 4000, memberPriceCents: 0, usingMember: false, source: 'list' },
    ],
  }],
};

function loadModule(payload) {
  const store = {};
  const listeners = [];
  const win = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    ZWStock: { storedAccessToken: () => '' },
    addEventListener: (n, f) => listeners.push({ n, f }),
    dispatchEvent: (e) => listeners.filter((l) => l.n === e.type).forEach((l) => l.f(e)),
  };
  const doc = { readyState: 'complete', addEventListener: () => {} };
  const CustomEventShim = function (t, i) { this.type = t; this.detail = i && i.detail; };
  new Function('window', 'localStorage', 'fetch', 'CustomEvent', 'document', 'location', 'URLSearchParams', 'setTimeout', 'clearTimeout', SRC)(
    win, win.localStorage,
    async () => ({ ok: true, json: async () => payload }),
    CustomEventShim, doc, { search: '' }, URLSearchParams, setTimeout, clearTimeout);
  return win.ZWVariantPrice;
}

(async () => {
  console.log('\n  one price, every surface\n');

  console.log('  the colour is found by NAME, which is all a cart line carries');
  {
    const api = loadModule(PAYLOAD);
    await api.ask('p-1');

    ok('the cart line prices as its colourway', api.resolvedForColor('p-1', 'Yellow').priceCents === 3000,
      'this is the whole bug: the line is Yellow, and Yellow is $30');
    ok('…not as the product', api.resolvedForColor('p-1', 'Yellow').priceCents !== 3200,
      'the product-wide row is $32 and is what checkout was showing');
    ok('the other colour prices as itself', api.resolvedForColor('p-1', 'Tennesee').priceCents === 3500);

    /* A swatch writes "Bright Crimson"; a stale bag entry may hold
       "bright crimson". Folded the same way colour is compared everywhere. */
    ok('case does not matter', api.resolvedForColor('p-1', 'yellow').priceCents === 3000);
    ok('…nor does stray whitespace', api.resolvedForColor('p-1', '  Yellow ').priceCents === 3000);

    ok('a line with no colour gets the product price', api.resolvedForColor('p-1', '').priceCents === 3200,
      'a product without colourway pricing costs exactly that');
    ok('…and so does a colour that no longer exists', api.resolvedForColor('p-1', 'Vermilion').priceCents === 3200,
      'falling back is right; inventing a price for a retired colour is not');
    ok('an unknown product answers nothing at all', api.resolvedForColor('p-nope', 'Yellow') === null,
      'null lets the caller keep what it had rather than print a figure from another product');
  }

  console.log('\n  the bag panel asks instead of remembering');
  {
    ok('it resolves the line rather than reading localStorage',
      /function bagLineCents\(item\)/.test(PANEL)
      && /VP\.resolvedForColor\(item && item\.productId, item && item\.colorName\)/.test(PANEL));
    ok('…for the line', !/bagMoney\(\(Number\(i\.price\) \|\| 0\)/.test(PANEL),
      'item.price is the figure frozen when the thing was added');
    ok('…and for the header total', /cart\.reduce\(function \(n, i\) \{ return n \+ \(bagLineCents\(i\) \/ 100\)/.test(PANEL),
      'a header totalled from a different figure than the lines under it is its own bug');
    ok('it makes the request', /bagAskPrices\(cart\);/.test(PANEL));
    ok('…and redraws when the answer lands', /addEventListener\('zw:prices', function \(\) \{ if \(_bagPanel\) renderBagPanel\(\); \}\)/.test(PANEL),
      'otherwise the correction only shows the next time somebody reopens the bag');
    ok('and it still falls back to the stored figure',
      /var stored = Math\.round\(\(Number\(item && item\.price\) \|\| 0\) \* 100\);/.test(PANEL)
      && /\(hit && hit\.priceCents > 0\) \? hit\.priceCents : stored/.test(PANEL),
      'a failed read must not blank a price or invent one');
  }

  console.log('\n  checkout asks WITH the colour\'s id');
  {
    ok('the id is selected', /color_variants\?select=id,product_id,color_name/.test(CHECKOUT),
      'without it variant.id is undefined and resolvedFor falls through to the product-wide price');
    ok('the member figure comes from the server', /memberCents: Number\(fromServer\.memberPriceCents\) \|\| 0/.test(CHECKOUT),
      'hardcoded to 0, a member was repriced to the guest figure on every render');
    ok('…and the regular figure is the regular figure',
      /regularCents: Number\(fromServer\.regularCents\) \|\| fromServer\.priceCents/.test(CHECKOUT),
      'filled from compare-at, it made a $30 line render as its $40 was-price');
    ok('compare-at is no longer read as the price', !/fromServer\.compareAtCents > fromServer\.priceCents/.test(CHECKOUT),
      'they are different numbers with different meanings');
  }

  console.log('\n  the bag page shows the price, not the was-price');
  {
    ok('the stored price wins', /const stored = parseFloat\(item\.price\) \|\| 0;/.test(BAG)
      && /const effectivePrice = stored > 0/.test(BAG));
    ok('…rather than regularPrice', !/: \(regularPrice \|\| parseFloat\(item\.price\) \|\| 0\);/.test(BAG),
      'regularPrice is the compare-at, and preferring it rendered $40 on a $30 line');
    ok('the member rule survives only as the fallback', /memberPrice < regularPrice/.test(BAG),
      'a cart that predates the repricing, or a page where checkout.js never loaded');
  }

  console.log('\n  the bag panel follows the theme');
  {
    /* THE FIRST ATTEMPT AT THIS BROKE TEXT ACROSS THE WHOLE SITE, and this test
       asserted the broken thing.

       The panel read --zw-page / --zw-ink, which are static literals in
       storefront-cohesion.css, so in dark mode it opened as a cream card with
       dark text under a dark header. I made theme-engine.js set them from the
       theme's fg/bg. But --zw-ink is not a semantic "foreground": it is a
       LITERAL near-black, read as `color:` in 21 rules and as `background:` in
       8. Pointing it at the theme's foreground turned every one of those 21
       into near-white text in dark mode, on surfaces that had stayed light —
       invisible copy on the homepage, the product page and the collection.

       A token used in BOTH roles has no single theme-aware value. The fix is
       not to make that token cleverer; it is for the panel to read the two
       tokens that mean exactly one thing each. */
    ok('the panel reads the unambiguous triplets',
      /\.zwf-bag-panel\{background:rgb\(var\(--bg-rgb/.test(PANEL)
      && /color:rgb\(var\(--fg-rgb/.test(PANEL),
      'the ground is the page ground and the text is the page text — one meaning each');
    ok('…and so does the search panel beside it',
      /\.zwf-search-panel\{background:rgb\(var\(--bg-rgb/.test(PANEL),
      'they are the same drawer in two costumes; fixing one and not the other is how they drift');
    ok('…with a fallback for a page that never loaded the theme',
      /--bg-rgb, 9 9 11/.test(PANEL) && /--fg-rgb, 244 241 235/.test(PANEL));
    ok('the engine does NOT drive --zw-ink or --zw-page',
      !/set\('--zw-ink'/.test(ENGINE) && !/set\('--zw-page'/.test(ENGINE),
      'this is the change that broke the site; the comment where it was says why');
    ok('…and the reason is written where the next person will look',
      /--zw-ink AND --zw-page ARE NOT SET HERE/.test(ENGINE),
      'a removed line leaves no trace, and the next person makes the same change');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
