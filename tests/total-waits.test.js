/* The total moved while the shopper was looking at it.
 *
 * Three different places wrote it, and each read the others' answers back out
 * of the DOM as rendered text:
 *
 *   refreshTaxDisplay()          subtotal + tax. Shipping was not in the
 *                                expression at all.
 *   updateCartSummaryShipping()  subtotal + parse(taxEl) + shipping.
 *   zwPromoUpdateSummaryTotals() sub - discount + parse(tax) + parse(shipping),
 *                                and it ran at the end of both of the above.
 *
 * So whichever landed last decided the number. When tax landed second it
 * silently dropped shipping back out, because its expression never had it:
 * the total went up, down, then up again. And the promo pass would then
 * reassemble a confident dollar figure by parsing '—' as 0, writing over
 * whatever had just been marked as pending.
 *
 * Underneath all three: a total was on screen from the first paint, looking
 * exactly as definite as the final one. Tax had already solved this for itself
 * — unknown renders a dash and stays out of the sum, so "Oregon charges none"
 * and "we have not been told yet" cannot be confused — but the TOTAL never
 * inherited it, and the total is the line people actually read.
 *
 * One assembler now, and a total is only a total once every part of it is
 * known.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const JS   = fs.readFileSync(path.join(ROOT, 'checkout.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'checkout.html'), 'utf8');

/* A DOM just big enough to run the real assembler and read back what a shopper
   would see. */
function harness({ taxKnown, taxRate = 0.078, subtotal = 100 }) {
  const els = {};
  const mk = (id, text) => {
    const classes = new Set();
    return {
      id, textContent: text === undefined ? '—' : text,
      classList: {
        toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
        contains: (c) => classes.has(c),
      },
      _classes: classes,
    };
  };
  for (const id of ['pm-subtotal', 'pm-tax', 'pm-shipping', 'pm-total', 'pm-toggle-total', 'pm-tax-label']) {
    els[id] = mk(id);
  }
  els['pm-subtotal'].textContent = '$' + subtotal.toFixed(2);

  const _pay = { taxEl: mk('tax'), shippingEl: mk('ship'), totalEl: mk('total'),
                 stateInput: { value: 'OH' }, zipInput: { value: '45202' } };
  const window_ = {
    ZWCheckoutTax: {
      isKnown: () => taxKnown,
      taxDollars: (sub) => sub * taxRate,
      stateFor: () => 'OH',
      ensure: () => {},
    },
  };
  const document_ = { getElementById: (id) => els[id] || null };

  /* Anchored on the functions, not on the `_shipDollars` initializer — the
     harness declares that itself so that changing it in the source cannot turn
     a clean assertion failure into a crashed suite. The source's own initial
     value is asserted separately, by regex, further down. */
  const rStart = JS.indexOf('function renderSummaryTotals()');
  const uStart = JS.indexOf('function updateCartSummaryShipping(amount)');
  const src = 'let _shipDollars = null;\n'
    + JS.slice(rStart, uStart)
    + JS.slice(uStart, JS.indexOf('\n}', uStart) + 2);

  const api = new Function('document', 'window', '_pay', src +
    ';return { render: renderSummaryTotals, ship: updateCartSummaryShipping };')(document_, window_, _pay);

  return { api, els, txt: (id) => els[id].textContent, dashed: (id) => els[id]._classes.has('dash') };
}

console.log('\n  a total is only a total once every part is known\n');

console.log('  before anything has resolved');
{
  const h = harness({ taxKnown: false });
  h.api.render();
  ok('tax is a dash', h.txt('pm-tax') === '—');
  ok('shipping is a dash', h.txt('pm-shipping') === '—');
  /* THE BUG. This used to be a confident dollar figure from the first paint. */
  ok('and so is the total', h.txt('pm-total') === '—',
    'a total missing two of its parts must not look exactly like the final one');
  ok('…marked as pending, not as a value', h.dashed('pm-total'));
  ok('the toggle total agrees', h.txt('pm-toggle-total') === '—');
}

console.log('\n  tax lands first, shipping second');
{
  const h = harness({ taxKnown: true });
  h.api.render();
  ok('tax shows', h.txt('pm-tax') === '$7.80');
  ok('the total still waits on shipping', h.txt('pm-total') === '—',
    'subtotal + tax is not the total — that expression is the original bug');
  h.api.ship(9.5);
  ok('once shipping lands the total appears', h.txt('pm-total') === '$117.30');
  ok('…and stops being marked pending', !h.dashed('pm-total'));
}

console.log('\n  shipping lands first, tax second');
{
  /* The order that broke it. updateCartSummaryShipping wrote a total including
     shipping; refreshTaxDisplay then wrote one that did not, so the number
     went DOWN when the tax quote arrived. */
  const h = harness({ taxKnown: false });
  h.api.ship(9.5);
  ok('shipping shows immediately', h.txt('pm-shipping') === '$9.50');
  ok('the total still waits on tax', h.txt('pm-total') === '—');

  const h2 = harness({ taxKnown: true });
  h2.api.ship(9.5);
  const afterShip = h2.txt('pm-total');
  h2.api.render();
  ok('a later tax render does not drop shipping back out',
    h2.txt('pm-total') === afterShip && h2.txt('pm-total') === '$117.30',
    'was $117.30 then $107.80 — the total fell while the shopper watched');
}

console.log('\n  free shipping is an answer, not a missing one');
{
  const h = harness({ taxKnown: true });
  h.api.ship(0);
  ok('it reads Free', h.txt('pm-shipping') === 'Free');
  ok('…and is not dashed', !h.dashed('pm-shipping'),
    'null means not resolved; 0 means resolved and free — only one is unknown');
  ok('the total completes', h.txt('pm-total') === '$107.80');
}

console.log('\n  the promo pass respects the same rule');
{
  /* It reruns at the end of every render, parses the rendered text, and reads
     '—' as 0 — so it would write a confident dollar total over a pending one. */
  const fn = HTML.slice(HTML.indexOf('window.zwPromoUpdateSummaryTotals = function()'),
                        HTML.indexOf('window.zwClearPromo'));
  ok('it checks for the pending marker', /classList\.contains\('dash'\)/.test(fn));
  ok('…on both components', /dashed\('pm-tax'\) \|\| dashed\('pm-shipping'\)/.test(fn));
  ok('…and writes a dash rather than a number', /incomplete \? '—' :/.test(fn));
  ok('…keeping the marker in step', /classList\.toggle\('dash', incomplete\)/.test(fn));
}

console.log('\n  one assembler, not three');
{
  ok('the tax path no longer writes the total itself',
    !/const total = subtotal \+ tax;/.test(JS),
    'that expression had no shipping in it, which is what made the total fall');
  ok('…it asks, then delegates', /ZWCheckoutTax\.ensure\(state, zip[\s\S]{0,120}?renderSummaryTotals\(\);/.test(JS));
  ok('the shipping path delegates too',
    /_shipDollars = Number\(amount\) \|\| 0;\s*\n\s*renderSummaryTotals\(\);/.test(JS));
  ok('shipping starts unresolved rather than zero', /let _shipDollars = null;/.test(JS));

  /* A dash that looks like a value is barely better than a wrong number. */
  ok('pending figures are visibly pending', /\.dash \{ opacity/.test(HTML));
}

console.log('\n  a known zero is written down like any other number');
{
  const co = fs.readFileSync(path.join(ROOT, 'checkout.js'), 'utf8').replace(/\r\n/g, '\n');

  /* THE BRANCH THAT WAS NOT THERE. The rate handler read:

         if (data.rates?.length) { … }
         else if (!qualifiesFree) { updateCartSummaryShipping(standard) }

     — so an order that ships FREE, on a store whose rate provider answered
     with nothing, set no shipping figure at all. _shipDollars stayed null,
     shipping rendered as an em dash, and a total is only a total once every
     part of it is known: the total dashed too, and so did the gift card and
     the amount due hanging off it.

     'Free shipping needs no rate' is true. It just never said so, and an unset
     zero is indistinguishable from never having asked. Reported live — a $234
     basket that would not show a total no matter what address was typed. */
  ok('no rates on a free-shipping order still writes zero',
    /updateCartSummaryShipping\(qualifiesFree \? 0 : \(policy\.standardRate \|\| 8\)\);/.test(co),
    'the customer this stranded is always the one with the biggest basket');

  ok('…and it is an unconditional else, not another condition to forget an arm of',
    !/\} else if \(!qualifiesFree\) \{/.test(co));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
