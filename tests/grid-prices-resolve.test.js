/* The two grids ask the same resolver as everything else.
 *
 * Every surface a shopper reaches AFTER a product card — the product page, the
 * bag, the checkout, the till — was moved onto /api/prices when price lists
 * were built. The two grids were not. They printed the CATALOGUE price straight
 * off the products row:
 *
 *     const productPrice = p.current_price || p.msrp || p.price;
 *
 * So on any store with a price list they disagree with the page they link to.
 * Measured on the live store when this was found: the grids said $40.00 and
 * /api/prices said $32.00 (source "list"), with the member figure $35 against
 * $22. A shopper saw one number on the card and a different one after clicking
 * it.
 *
 * There are already TWO card renderers to keep in step — the homepage's in
 * storefront.js and the collection's in drop001.html — which is why the fix is
 * one painter both of them call rather than the price rule written a third and
 * fourth time.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const vp = read('variant-price.js');
const home = read('storefront.js');
const coll = read('drop001.html');

console.log('\n  the grids ask the same resolver as everything else\n');

ok('both card templates mark their price element',
  /class="pcard-price" data-zw-price-for=/.test(home)
  && /class="product-price" data-zw-price-for=/.test(coll));

ok('both call the painter once the cards exist',
  /ZWVariantPrice\.paintCards\(grid\)/.test(home)
  && /ZWVariantPrice\.paintCards\(grid\)/.test(coll));

/* The collection page re-renders on every filter and sort, so the call has to
   live inside renderProducts rather than at the one initial call site. */
const render = coll.slice(coll.indexOf('function renderProducts'));
ok('…and the collection calls it from inside renderProducts, so filters and sort get it too',
  render.indexOf('paintCards') > 0 && render.indexOf('paintCards') < render.indexOf('})();'),
  'hooking only the first paint leaves every filtered view on the catalogue price');

ok('there is one painter, not one per grid',
  (vp.match(/function paintCards/g) || []).length === 1,
  'a third copy of the price rule is the one that would drift');

ok('a price the server has not answered for is left as rendered',
  /if \(!known\(pid\)\) continue;/.test(vp),
  'a slow or failed request must show the catalogue figure, not a blank or a spinner');

ok('the member figure needs the member-pricing switch',
  /memberPricingOn\(\)/.test(vp),
  'a store with member pricing off must never show a member number on a card');

ok('both pages actually load the resolver',
  /variant-price\.js/.test(read('index.html')) && /variant-price\.js/.test(coll));

console.log('\n  nothing in the suite knows where this repo lives');
{
  /* THIS FILE SHIPPED WITH `const ROOT = 'c:/Users/Breez/Zuwera-Repository'`.
     It passed locally, because on that machine the path is right, and failed
     the moment CI ran it on Linux. Every other test resolves ROOT from
     __dirname; a test that hardcodes a path is green for exactly one person. */
  const offenders = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'tests')).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ');
    if (/['"][a-zA-Z]:[\\/]|['"]\/(?:home|Users)\//.test(src)) offenders.push(f);
  }
  ok('no test hardcodes an absolute path', offenders.length === 0,
    offenders.join(', ') + ' — resolve from __dirname instead');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
