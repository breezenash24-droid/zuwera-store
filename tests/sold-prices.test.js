/* What things actually sold for.
 *
 * Every other figure on the Pricing screen is what the store INTENDS to charge.
 * This one is a fact: the amount frozen on an order line when the card went
 * through. It is the only way to answer "we list this at $32 — what has it
 * actually been going out at?"
 *
 * ── THE THINGS AN AVERAGE CAN QUIETLY GET WRONG ─────────────────────────────
 *
 * 1. AVERAGING OVER LINES INSTEAD OF UNITS. Two shirts on one line are two
 *    sales at that price. A mean over lines calls "two at $30 and one at $35"
 *    an average of $32.50, which is not a price anybody paid.
 *
 * 2. COUNTING REFUNDS AS SALES. A refunded order is not a sale, and leaving it
 *    in makes the average of what customers paid include money given back.
 *
 * 3. DROPPING WHAT IT CANNOT CLASSIFY. A product with no category still sold.
 *    A total that silently omits it is worse than a bucket labelled
 *    "Uncategorised", because the revenue no longer adds up and nothing says
 *    why.
 *
 * A persisted order line is { sku, name, size, color, amount, quantity } and
 * `amount` is in CENTS — there is no productId on it, so sku is the only
 * identity and the join back to the catalogue is by sku.
 */
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const PRODUCTS = [
  { id: 'p1', sku: 'ZW-MTP-002', title: 'Zuwera Aero Pro', category: 'T-Shirts', current_price: 32 },
  { id: 'p2', sku: 'ZW-MTP-003', title: 'Zuwera Fleece',   category: 'Hoodies',  current_price: 65 },
  { id: 'p3', sku: 'ZW-NOCAT',   title: 'Unfiled Thing',   category: '',         current_price: 20 },
];

const line = (sku, name, colour, cents, qty, size) =>
  ({ sku, name, size: size || 'M', color: colour, amount: cents, quantity: qty });

const order = (id, num, at, status, items) => ({ id, order_number: num, created_at: at, status, items });

(async () => {
  const { summariseSold } = await import(pathToFileURL(path.join(ROOT, 'functions/api/admin-prices.js')).href);

  console.log('\n  what things actually sold for\n');

  console.log('  the average is over UNITS, not over lines');
  {
    const r = summariseSold([
      order('o1', '1001', '2026-08-14T10:00:00Z', 'paid', [line('ZW-MTP-002', 'Zuwera Aero Pro', 'Yellow', 3000, 2)]),
      order('o2', '1002', '2026-08-15T10:00:00Z', 'paid', [line('ZW-MTP-002', 'Zuwera Aero Pro', 'Tennesee', 3500, 1)]),
    ], PRODUCTS);
    const p = r.products[0];

    ok('three units, not two lines', p.units === 3, 'got ' + p.units);
    ok('the mean is weighted by quantity', p.avgCents === 3167,
      'got ' + p.avgCents + ' — an unweighted mean of 3000 and 3500 is 3250, a price nobody paid');
    ok('the median is too', p.medianCents === 3000,
      'got ' + p.medianCents + ' — two units at $30 and one at $35 puts the middle unit at $30');
    ok('revenue multiplies by quantity', p.revenueCents === 9500);
    ok('the range is the range', p.lowCents === 3000 && p.highCents === 3500);
    ok('and the order count is distinct orders', p.orders === 2);
  }

  console.log('\n  a refunded order is not a sale');
  {
    const rows = [
      order('o1', '1001', '2026-08-14T10:00:00Z', 'paid', [line('ZW-MTP-002', 'Aero', 'Yellow', 3000, 1)]),
      order('o2', '1002', '2026-08-15T10:00:00Z', 'refunded', [line('ZW-MTP-002', 'Aero', 'Yellow', 9900, 1)]),
      order('o3', '1003', '2026-08-15T11:00:00Z', 'cancelled', [line('ZW-MTP-002', 'Aero', 'Yellow', 9900, 1)]),
    ];
    const r = summariseSold(rows, PRODUCTS);
    ok('the refund is left out', r.products[0].units === 1);
    ok('…so it cannot drag the average', r.products[0].avgCents === 3000,
      'got ' + r.products[0].avgCents + ' — money that was given back is not money customers paid');
    ok('…and the cancellation too', r.ordersExcluded === 2);
    ok('the exclusions are reported rather than silent', r.ordersCounted === 1,
      'a total that quietly drops rows is one nobody can reconcile');
    ok('…and no excluded line reaches the drill-down', r.sales.length === 1);
  }

  console.log('\n  three groupings of the same sales');
  {
    const r = summariseSold([
      order('o1', '1001', '2026-08-14T10:00:00Z', 'paid', [
        line('ZW-MTP-002', 'Aero', 'Yellow', 3000, 2),
        line('ZW-MTP-002', 'Aero', 'Tennesee', 3500, 1),
        line('ZW-MTP-003', 'Fleece', 'Black', 6500, 1),
      ]),
    ], PRODUCTS);

    ok('by product', r.products.length === 2);
    ok('…with the colours folded together', r.products.find((p) => p.sku === 'ZW-MTP-002').units === 3);

    const yellow = r.colours.find((c) => c.colour === 'Yellow');
    const tenn = r.colours.find((c) => c.colour === 'Tennesee');
    ok('by colourway', yellow.units === 2 && tenn.units === 1);
    ok('…each averaging its own price', yellow.avgCents === 3000 && tenn.avgCents === 3500,
      'this is the check that says whether pricing a colour apart is doing anything');

    const tees = r.categories.find((c) => c.label === 'T-Shirts');
    const hood = r.categories.find((c) => c.label === 'Hoodies');
    ok('by category', tees.units === 3 && hood.units === 1);
    ok('…answering "what does a hoodie sell for"', hood.avgCents === 6500);

    /* The three groupings are three views of ONE set of sales, so they must
       agree on the money. Disagreeing totals is how a report loses trust. */
    const sum = (list) => list.reduce((n, x) => n + x.revenueCents, 0);
    ok('and all three add up to the same revenue',
      sum(r.products) === sum(r.colours) && sum(r.colours) === sum(r.categories),
      [sum(r.products), sum(r.colours), sum(r.categories)].join(' / '));
  }

  console.log('\n  the gap against what it is listed at now');
  {
    const r = summariseSold([
      order('o1', '1001', '2026-08-14T10:00:00Z', 'paid', [line('ZW-MTP-002', 'Aero', 'Yellow', 3000, 1)]),
    ], PRODUCTS);
    ok('the listed price comes along', r.products[0].listedCents === 3200,
      'without it there is nothing to compare the average against');
    ok('…and it is the CURRENT one, in cents', r.products[0].listedCents !== 32,
      'current_price is in dollars on the product row and cents everywhere here — mixing them is a 100x error');
  }

  console.log('\n  it does not drop what it cannot classify');
  {
    const r = summariseSold([
      order('o1', '1001', '2026-08-14T10:00:00Z', 'paid', [line('ZW-NOCAT', 'Unfiled Thing', '', 2000, 1)]),
      order('o2', '1002', '2026-08-14T11:00:00Z', 'paid', [line('ZW-GONE', 'Deleted Product', 'Red', 4500, 1)]),
    ], PRODUCTS);

    ok('a product with no category is bucketed, not dropped',
      r.categories.some((c) => c.label === 'Uncategorised'),
      'revenue that vanishes from a total with nothing to explain it is worse than an ugly label');
    ok('a product deleted since the sale still counts',
      r.products.some((p) => p.label === 'Deleted Product'),
      'the sale happened; the catalogue row going away does not unhappen it');
    ok('…under its own name from the order line', r.products.find((p) => p.label === 'Deleted Product').units === 1);
    ok('…and with no listed price to compare against',
      r.products.find((p) => p.label === 'Deleted Product').listedCents === 0);
  }

  console.log('\n  every sale is readable behind the average');
  {
    const r = summariseSold([
      order('o1', '1001', '2026-08-14T10:00:00Z', 'paid', [line('ZW-MTP-002', 'Aero', 'Yellow', 3000, 2, 'S')]),
      order('o2', '1002', '2026-08-16T10:00:00Z', 'paid', [line('ZW-MTP-002', 'Aero', 'Tennesee', 3500, 1, 'L')]),
    ], PRODUCTS);

    ok('one row per line', r.sales.length === 2);
    ok('newest first', r.sales[0].orderNumber === '1002');
    ok('carrying what it sold at, and the line total', r.sales[1].soldCents === 3000 && r.sales[1].lineCents === 6000,
      'an average with nothing behind it is a number you cannot check');
    ok('…and enough to find the order', r.sales[0].orderNumber === '1002' && !!r.sales[0].at);
    ok('…and the size and colour', r.sales[0].size === 'L' && r.sales[0].colour === 'Tennesee');
  }

  console.log('\n  nothing to report is not an error');
  {
    const empty = summariseSold([], PRODUCTS);
    ok('no orders', empty.products.length === 0 && empty.sales.length === 0);
    const junk = summariseSold([
      order('o1', '1', '2026-08-14T10:00:00Z', 'paid', null),
      order('o2', '2', '2026-08-14T10:00:00Z', 'paid', 'not json'),
      order('o3', '3', '2026-08-14T10:00:00Z', 'paid', []),
    ], PRODUCTS);
    ok('unreadable items are skipped rather than thrown', junk.products.length === 0);
    ok('…and a JSON STRING of items is parsed', summariseSold([
      order('o1', '1', '2026-08-14T10:00:00Z', 'paid', JSON.stringify([line('ZW-MTP-002', 'Aero', 'Yellow', 3000, 1)])),
    ], PRODUCTS).products[0].units === 1,
      'the column is jsonb, but a row written as text would otherwise report zero sales');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
