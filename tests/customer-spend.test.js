/* Who your customers actually are, on the Users page.
 *
 * The list was name, email and a join date — nothing that separates someone who
 * has bought eleven times from someone who signed up once and never came back,
 * which is most of what the page is for.
 *
 * The arithmetic is easy; the MATCHING is where this goes quietly wrong, and
 * always in the same direction: undercounting your best customers. An order
 * placed before someone made an account carries no user_id. A guest order
 * carries no profile at all. Match on the wrong key and the people who have
 * spent the most are the ones most likely to be missing, because they are the
 * ones who have been around longest.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SRC = fs.readFileSync(ROOT + '/admin-main.js', 'utf8');

/* Lift the function out of the admin bundle rather than exporting it purely to
   be tested — the thing under test should be the thing that runs. */
function extract(name, src) {
  const start = src.indexOf('async function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found');
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(start, i + 1);
}

function load(orders, opts = {}) {
  const win = {};
  const sb = {
    from: () => ({
      select: async () => (opts.fail
        ? { data: null, error: new Error('orders unreadable') }
        : { data: orders, error: null }),
    }),
  };
  const body = extract('loadCustomerSpend', SRC);
  const fn = new Function('window', 'sb', 'console', body + '; return loadCustomerSpend;')(
    win, sb, { error() {}, warn() {}, log() {} },
  );
  return { fn, win };
}

const ORDERS = [
  // Two orders under the account's id.
  { user_id: 'u1', email: 'ada@shop.test',  total: '50.00', created_at: '2026-03-01', status: 'confirmed' },
  { user_id: 'u1', email: 'ada@shop.test',  total: '30.00', created_at: '2026-05-01', status: 'delivered' },
  // Same person, BEFORE the account existed — no user_id, email only.
  { user_id: null, email: 'ada@shop.test',  total: '20.00', created_at: '2025-11-01', status: 'confirmed' },
  // Money that came back. Not spend.
  { user_id: 'u1', email: 'ada@shop.test',  total: '99.00', created_at: '2026-06-01', status: 'refunded' },
  { user_id: 'u2', email: 'bob@shop.test',  total: '75.00', created_at: '2026-04-01', status: 'cancelled' },
  // Never made an account at all.
  { user_id: null, email: 'guest@shop.test', total: '500.00', created_at: '2026-07-01', status: 'confirmed' },
];

(async () => {
  console.log('\n  customer spend\n');

  console.log('  matching');
  {
    const customers = [
      { id: 'u1', email: 'ada@shop.test' },
      { id: 'u2', email: 'bob@shop.test' },
      { id: 'u3', email: 'never@shop.test' },
    ];
    const { fn, win } = load(ORDERS);
    await fn(customers);
    const ada = customers[0];

    /* 50 + 30 + 20. The 20 is the pre-account order, and it is the one a
       user_id-only match would drop — from the customer who has been here
       longest, which is the worst place to lose money. */
    ok('orders placed before the account are still counted',
      ada._orders === 3 && Math.abs(ada._spent - 100) < 0.001,
      ada._orders + ' orders / $' + ada._spent);
    ok('…and the refunded one is not', Math.abs(ada._spent - 100) < 0.001, String(ada._spent));
    ok('the most recent order date is kept', ada._lastOrder === '2026-05-01', String(ada._lastOrder));

    ok('a cancelled order is not spend',
      customers[1]._orders === 0 && customers[1]._spent === 0, JSON.stringify(customers[1]._spent));
    ok('someone who never ordered reads zero, not blank',
      customers[2]._orders === 0 && customers[2]._spent === 0);
  }

  console.log('\n  people with no account');
  {
    const customers = [{ id: 'u1', email: 'ada@shop.test' }];
    const { fn, win } = load(ORDERS);
    await fn(customers);
    /* $500 — the biggest spender in the fixture, and invisible on a page that
       only lists profiles. */
    ok('a guest buyer is surfaced separately', win._zwGuestBuyers.length >= 1,
      JSON.stringify(win._zwGuestBuyers));
    const guest = win._zwGuestBuyers[0];
    ok('…with what they spent', guest.email === 'guest@shop.test' && guest.spent === 500,
      JSON.stringify(guest));
    ok('…and is not double-counted as a customer',
      !win._zwGuestBuyers.some((g) => g.email === 'ada@shop.test'),
      JSON.stringify(win._zwGuestBuyers.map((g) => g.email)));
    ok('…sorted by spend, so the biggest is first',
      win._zwGuestBuyers.every((g, i, a) => !i || a[i - 1].spent >= g.spent));
  }

  console.log('\n  when orders cannot be read');
  {
    const customers = [{ id: 'u1', email: 'ada@shop.test' }];
    const { fn } = load(ORDERS, { fail: true });
    await fn(customers);
    /* NULL, not zero. Zero is a claim about the customer — "they have never
       bought anything" — and drawing it when the query failed is a lie about
       them rather than about us. The table renders a dash for null. */
    ok('a failed query leaves spend unknown rather than zero',
      customers[0]._orders === null && customers[0]._spent === null,
      JSON.stringify(customers[0]));
    ok('…and the table draws that as a dash', /unknown \? '—'/.test(SRC));
  }

  console.log('\n  wiring');
  {
    const html = fs.readFileSync(ROOT + '/admin.html', 'utf8');
    ok('customers and admins stay separate tabs',
      /data-tab="users-customers"/.test(html) && /data-tab="users-admins"/.test(html));
    ok('the list can be sorted by top spender', /id="customerSort"/.test(html));
    ok('…and defaults to it', /value="spent"/.test(html));
    /* The admins table still has four columns; the customers one now has
       seven. A shared empty-state colspan would leave one of them short. */
    ok('the empty row spans the right number of columns for each table',
      /isAdminsTable \? 4 : 7/.test(SRC));
    ok('staff are not given a purchase history', /if \(!isAdminsTable\)/.test(SRC));
    ok('guest buyers are explained, not just listed', /never appear in the list above/.test(html));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
