/* The reporting a clothing brand actually buys stock against.
 *
 * The Analytics page already had revenue, AOV, conversion, top products, repeat
 * rate and promos — all generic commerce. None of it said which SIZE sold,
 * which is the decision inventory money is spent on.
 *
 * Two things here are easy to get wrong in the direction that costs money:
 *
 *   - Counting refunded orders as sales. A size that sells and comes straight
 *     back is not a size to buy more of.
 *   - Treating "no recorded label cost" as a cost of zero. That invents a
 *     profit on shipping that was never made, and it would apply to every order
 *     placed before the column existed — i.e. all of them, at first.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SRC = fs.readFileSync(ROOT + '/analytics.html', 'utf8');

/* Lift the helpers out of the page rather than exporting them for the test —
   the thing under test should be the thing that ships. */
/* Scan to the semicolon that ends the declaration, tracking bracket depth.
   A lazy regex to the first ';' cuts these functions in half — several contain
   a semicolon inside their own body (a try/catch, a for loop) — and the result
   is a syntax error thirty lines away from the cause. */
function lift(names) {
  const parts = [];
  for (const n of names) {
    const start = SRC.indexOf('const ' + n + ' = ');
    if (start < 0) throw new Error(n + ' not found in analytics.html');
    let depth = 0;
    let i = start;
    for (; i < SRC.length; i++) {
      const ch = SRC[i];
      if (ch === '{' || ch === '(' || ch === '[') depth++;
      else if (ch === '}' || ch === ')' || ch === ']') depth--;
      else if (ch === ';' && depth === 0) break;
    }
    parts.push(SRC.slice(start, i + 1));
  }
  return parts.join('\n');
}

const helpers = lift(['soldOrders', 'orderItems', 'itemSize', 'itemColour', 'itemQty']);
const ctx = new Function('allOrders', 'window',
  helpers + '; return { soldOrders, orderItems, itemSize, itemColour, itemQty };');

console.log('\n  apparel analytics\n');

console.log('  what counts as a sale');
{
  const orders = [
    { status: 'confirmed', items: [{ size: 'M', quantity: 2 }] },
    { status: 'delivered', items: [{ size: 'S', quantity: 1 }] },
    { status: 'refunded',  items: [{ size: 'M', quantity: 9 }] },
    { status: 'cancelled', items: [{ size: 'L', quantity: 9 }] },
  ];
  const H = ctx(orders, {});
  const sold = H.soldOrders();
  ok('refunded and cancelled orders are not sales', sold.length === 2, sold.length + ' counted');
  /* If they were counted, M would read 11 and look like the size to reorder —
     when 9 of those came straight back. */
  const units = {};
  sold.forEach((o) => H.orderItems(o).forEach((i) => {
    units[H.itemSize(i)] = (units[H.itemSize(i)] || 0) + H.itemQty(i);
  }));
  ok('…so a refunded size does not look like a bestseller',
    units.M === 2 && !units.L, JSON.stringify(units));
}

console.log('\n  reading items written by different code paths');
{
  const H = ctx([], {});
  ok('size reads from either field name',
    H.itemSize({ size: 'XL' }) === 'XL' && H.itemSize({ s: 'XL' }) === 'XL');
  ok('colour reads from all four spellings it has been written as',
    ['color', 'colorName', 'colour', 'c'].every((k) => H.itemColour({ [k]: 'Beige' }) === 'Beige'));
  ok('quantity defaults to 1 rather than 0 when absent',
    H.itemQty({}) === 1 && H.itemQty({ qty: 3 }) === 3 && H.itemQty({ q: 2 }) === 2);
  /* Items stored as a JSON string and as an array both occur in this table. */
  ok('items parse whether stored as JSON or as an array',
    H.orderItems({ items: '[{"size":"M"}]' }).length === 1
    && H.orderItems({ items: [{ size: 'M' }] }).length === 1);
  ok('unparseable items are empty, not an exception',
    H.orderItems({ items: '{oops' }).length === 0);
}

console.log('\n  shipping margin');
{
  /* The distinction the whole metric rests on: NULL means nobody recorded what
     the label cost, which is not the same as the label being free. */
  ok('only orders with a recorded label cost are counted',
    /o\.actual_shipping_cost != null/.test(SRC));
  ok('…and the empty state explains why earlier orders are missing',
    /never stored what the label cost/.test(SRC));
  ok('free-shipping orders are called out separately',
    /free-shipping order\(s\) cost you/.test(SRC));
  /* Losing money on shipping must not read the same as making it. */
  ok('a loss is shown as a loss', /net < 0 \? '−' : ''/.test(SRC));

  const fulfil = fs.readFileSync(ROOT + '/functions/api/_fulfil.js', 'utf8');
  ok('the cost is written onto the order', /actual_shipping_cost:/.test(fulfil));
  ok('…as NULL when there was no label, never as zero',
    /actual_shipping_cost_cents\s*\?[\s\S]{0,120}?: null/.test(fulfil));

  const mig = fs.readFileSync(ROOT + '/migrations/0012_order_actual_shipping_cost.sql', 'utf8');
  ok('the column exists in a migration', /add column if not exists actual_shipping_cost/.test(mig));
  ok('…and old orders are left null rather than backfilled',
    !/update .*orders.*set .*actual_shipping_cost/i.test(mig));
}

console.log('\n  size curve');
{
  ok('sizes are sorted in size order, not alphabetically', /ZWSizeOrder\.sort/.test(SRC));
  ok('…and the comparator is actually loaded on the page', /src="\/size-order\.js"/.test(SRC));
  /* A curve built from half the units is a curve you should not buy against. */
  ok('units with no size recorded are declared, not silently dropped',
    /had no size recorded and are not in this chart/.test(SRC));
}

console.log('\n  returns by size');
{
  /* Returns live in a settings blob, not a table — the first version of this
     queried a return_requests table that does not exist. */
  ok('returns are read from where they are actually stored',
    /'commerce_returns'/.test(SRC) && !/from\('return_requests'\)/.test(SRC));
  ok('denied and cancelled requests are excluded',
    /status !== 'denied' && r\.status !== 'cancelled'/.test(SRC));
  /* A RATE, not a count: the size you sell most of will always have the most
     returns, and that says nothing at all. */
  ok('it reports a rate against units sold, not a raw count',
    /returned\[s\] \|\| 0\) \/ sold\[s\]/.test(SRC));
}

console.log('\n  free shipping threshold');
{
  ok('orders either side of the threshold are compared', /Just under/.test(SRC) && /Just over/.test(SRC));
  ok('…and "no evidence yet" is a stated outcome, not a blank',
    /no evidence it is changing behaviour yet/.test(SRC));
}

console.log('\n  it cannot take the page down');
{
  /* This page carries the whole admin dashboard. A new section throwing must
     not stop the existing ones rendering. */
  ok('each new section is wrapped so a failure is isolated',
    /catch \(e\) \{ console\.warn\('Size\/colour failed/.test(SRC)
    && /catch \(e\) \{ console\.warn\('Shipping margin failed/.test(SRC)
    && /catch \(e\) \{ console\.warn\('Free-ship effect failed/.test(SRC));
  ok('…including the async one', /renderReturnsBySize\(\)\.catch/.test(SRC));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
