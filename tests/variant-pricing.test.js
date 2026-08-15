/* A colourway that costs something different.
 *
 * Price lived on `products` and colour lived in `color_variants`, so every
 * colour of a product cost the same and none could be discounted alone. The
 * only workaround was splitting one product into several, which scatters the
 * reviews, breaks the swatch row, and leaves per-colour stock in product_sizes
 * pointing at the wrong product.
 *
 * ── THE BUG THIS DESIGN EXISTS TO PREVENT ───────────────────────────────────
 *
 * Inheritance is ALL-OR-NOTHING: set a colour's current_price and that row's
 * member_price and msrp apply too, including when they are null.
 *
 * The obvious alternative — fall back field by field — is worse in one specific
 * and expensive way. A $250 limited colourway would inherit the product's $35
 * member price, so members would buy the EXPENSIVE colour for less than the
 * cheap one, on a page that shows both. It reads as the more helpful design,
 * which is exactly why it would ship. Several assertions below exist only to
 * make that regression fail.
 *
 * ── AND THE OTHER RECURRING FAULT ───────────────────────────────────────────
 *
 * This rule exists twice — once for the Worker that decides the charge, once
 * for the browser that renders a swatch change — because a Worker cannot load
 * an IIFE. Two answerers to one money question is how the bag came to say $35
 * while checkout charged $40. So the two are run here over ONE table of cases
 * and any disagreement fails, on the commit that causes it.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const MIG    = fs.readFileSync(path.join(ROOT, 'migrations/0021_colours_carry_their_own_price.sql'), 'utf8');
const BUNDLE = fs.readFileSync(path.join(ROOT, 'functions/api/_migrations.js'), 'utf8');
const CART   = fs.readFileSync(path.join(ROOT, 'functions/api/_cart-pricing.js'), 'utf8');
const BROWSER_SRC = fs.readFileSync(path.join(ROOT, 'variant-price.js'), 'utf8');

/* ── the cases both implementations must agree on ──────────────────────────
   Shared, so neither side can be "fixed" by quietly testing it on easier
   input. The Nike page that prompted this is the last two rows: one product,
   one colour at $176.97 and another at $220. */
const PRODUCT = { current_price: 220, member_price: 198, msrp: 260, price: null };

const CASES = [
  ['no colour at all',                     PRODUCT, null,                                              false],
  ['no colour, member',                    PRODUCT, null,                                              true],
  ['a colour that sets nothing',           PRODUCT, { color_name: 'Black' },                           false],
  ['…as a member',                         PRODUCT, { color_name: 'Black' },                           true],
  ['a cheaper colourway',                  PRODUCT, { current_price: 176.97 },                         false],
  ['…as a member, with no member price',   PRODUCT, { current_price: 176.97 },                         true],
  ['a cheaper colourway with its own member price', PRODUCT, { current_price: 176.97, member_price: 160 }, true],
  ['a DEARER colourway',                   PRODUCT, { current_price: 250 },                            false],
  ['…as a member — must NOT inherit $198', PRODUCT, { current_price: 250 },                            true],
  ['a colourway with its own compare-at',  PRODUCT, { current_price: 176.97, msrp: 220 },              false],
  ['member price above regular is ignored', PRODUCT, { current_price: 100, member_price: 150 },        true],
  ['a colour with a member price but no regular price', PRODUCT, { member_price: 9 },                  true],
  ['zero is not a price',                  PRODUCT, { current_price: 0 },                              false],
  ['a blank string is not a price',        PRODUCT, { current_price: '' },                             false],
  ['a string price still works',           PRODUCT, { current_price: '176.97' },                       false],
  ['negative is not a price',              PRODUCT, { current_price: -50 },                            false],
  ['product with only the legacy price field', { price: 80 }, null,                                    false],
  ['…overridden by a colour',              { price: 80 }, { current_price: 95 },                       false],
];

(async () => {
  const S = await import(pathToFileURL(path.join(ROOT, 'functions/api/_variant-price.js')).href);

  /* The browser file, run as the browser runs it. */
  const win = {};
  new Function('window', BROWSER_SRC)(win);
  const B = win.ZWVariantPrice;

  console.log('\n  a colourway can cost something different\n');

  console.log('  the browser and the server never disagree');
  {
    ok('the browser file publishes the rule', !!B && typeof B.resolve === 'function');
    let mismatches = 0;
    for (const [name, product, variant, isMember] of CASES) {
      const s = S.resolveVariantPrice(product, variant, isMember);
      const b = B.resolve(product, variant, isMember);
      const same = s.priceCents === b.priceCents && s.regularCents === b.regularCents
        && s.memberCents === b.memberCents && s.msrpCents === b.msrpCents
        && s.usingMember === b.usingMember && s.source === b.source;
      if (!same) mismatches++;
      ok(name + ' → ' + (s.priceCents / 100).toFixed(2) + ' (' + s.source + ')', same,
        'server ' + JSON.stringify(s) + ' vs browser ' + JSON.stringify(b));
    }
    ok('every case agrees', mismatches === 0,
      mismatches + ' of ' + CASES.length + ' disagree — one side was edited without the other');
  }

  console.log('\n  inheritance is all-or-nothing');
  {
    /* THE assertion. Field-by-field fallback makes this $198 and sells the
       $250 colour to members cheaper than the $220 one. */
    const dear = S.resolveVariantPrice(PRODUCT, { current_price: 250 }, true);
    ok('a dearer colourway does not inherit the product member price',
      dear.priceCents === 25000,
      'got ' + dear.priceCents + 'c — field-by-field inheritance sells the premium colour to members for less than the standard one');
    ok('…and says so has no member discount', dear.usingMember === false);

    const cheap = S.resolveVariantPrice(PRODUCT, { current_price: 176.97, member_price: 160 }, true);
    ok('a colourway that states its own member price gets it', cheap.priceCents === 16000);

    const plain = S.resolveVariantPrice(PRODUCT, { color_name: 'Black' }, true);
    ok('a colour that sets no price inherits everything', plain.priceCents === 19800 && plain.source === 'product');

    /* msrp must follow the same switch, or a discounted colour shows the
       product's compare-at and claims a saving that is not being offered. */
    const noMsrp = S.resolveVariantPrice(PRODUCT, { current_price: 176.97 }, false);
    ok('a priced colour with no compare-at shows none', noMsrp.msrpCents === 0,
      'inheriting msrp would advertise a discount off a price this colour never had');
  }

  console.log('\n  "from $X" on a grid');
  {
    const variants = [
      { color_name: 'Black' },
      { color_name: 'Crimson', current_price: 176.97 },
      { color_name: 'Limited', current_price: 250 },
    ];
    const low = S.lowestPriceCents(PRODUCT, variants, false);
    ok('the lowest sellable colour wins', low.lowestCents === 17697);
    ok('…and it knows the price varies', low.varies === true);

    const uniform = S.lowestPriceCents(PRODUCT, [{ color_name: 'Black' }, { color_name: 'White' }], false);
    ok('all-inheriting colours do not "vary"', uniform.varies === false && uniform.lowestCents === 22000,
      'showing "from $220" when every colour is $220 is noise');

    /* A misconfigured colour must not advertise the product at $0. */
    const broken = S.lowestPriceCents(PRODUCT, [{ color_name: 'Oops', current_price: 0 }], false);
    ok('an unsellable colour is not advertised as the cheapest', broken.lowestCents === 22000);

    const bLow = B.lowest(PRODUCT, variants, false);
    ok('the browser agrees about the lowest', bLow.lowestCents === low.lowestCents && bLow.varies === low.varies);
  }

  console.log('\n  the charge is priced by colour');
  {
    const code = CART.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
    ok('the cart resolves the colour before pricing', /await fetchColorVariant\(env, product\.id, raw\?\.colorName\)/.test(code));
    ok('…and uses the shared rule rather than its own', /resolveVariantPrice\(product, colorVariant, isMember\)/.test(code));
    ok('…with the old product-only expression gone',
      !/toCents\(product\.member_price\)/.test(code),
      'a second price derivation left behind is one that will be reached by some path');

    /* Order matters: pricing has to happen before the never-bill-above-shown
       guard, or the guard compares the wrong number. */
    ok('the colour price is settled before the shown-price guard',
      code.indexOf('resolveVariantPrice(product, colorVariant') < code.indexOf('const shownCents'),
      'a check on a figure computed afterwards is not a check');

    /* The lookup failing must not become a silent overcharge. */
    ok('a rejected lookup falls back to the product price', /pricing from the product/.test(CART));
    ok('…matched case-insensitively, as colour is everywhere else',
      /canon\(row\.color_name\) === canon\(wanted\)/.test(CART));
  }

  console.log('\n  the columns');
  {
    ok('0021 adds all three', /add column if not exists current_price/.test(MIG)
      && /add column if not exists member_price/.test(MIG) && /add column if not exists msrp/.test(MIG));
    ok('…nullable, so nothing changes price the day it is applied',
      !/current_price numeric\(10,2\) not null/.test(MIG) && !/default/.test(MIG.split('comment on')[0]));
    ok('…and documented in the database', /comment on column public\.color_variants\.current_price/.test(MIG));
    ok('…including WHY inheritance is all-or-nothing',
      /all-or-nothing/.test(MIG) && /_variant-price\.js/.test(MIG));
    ok('the bundle picked it up', /0021/.test(BUNDLE),
      'Workers have no filesystem — an unbundled migration cannot be applied');

    /* Size is deliberately NOT priced here. */
    ok('it does not quietly add price columns to product_sizes',
      !/alter table[\s\S]{0,80}product_sizes/.test(MIG),
      'columns added "while we are here" are how tables acquire fields nothing writes');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
