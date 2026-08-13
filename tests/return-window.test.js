/* You promise 30 days in writing, and nothing held you to it.
 *
 * Every order confirmation, the returns page and the policy all say "30-day
 * free returns". returnEligibility() checked the order status and what had
 * already been sent back, and had no date check at all — so an order from three
 * years ago was returnable today.
 *
 * THE HARD PART IS THE DATE, NOT THE RULE. `orders` had created_at (when it was
 * PAID) and nothing else. Counting thirty days from payment is not the promise:
 * an order paid on the 1st, shipped on the 7th and delivered on the 10th gives
 * that customer twenty days while the email told them thirty, and they get
 * refused inside the window they were told about. So 0015 records delivery, and
 * the rule counts from there.
 *
 * IT FAILS OPEN, which is the opposite of the rest of this file and deliberate.
 * Everywhere else in returns, an unanswerable question REFUSES — because the
 * cost of wrongly allowing is paying twice for one item. Here the costs invert:
 * a wrongly refused return is a support email and a customer who does not come
 * back, and a wrongly allowed one costs a single item. No usable date, an
 * unparseable one, a nonsense window: allow it.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const days = (n) => new Date(Date.now() - n * 86400000).toISOString();

(async () => {
  const { returnEligibility, returnWindowFrom } = await import(pathToFileURL(ROOT + '/functions/api/_returns.js').href);

  const order = (extra) => Object.assign({
    id: 'o1', status: 'delivered',
    items: JSON.stringify([{ name: 'Aero Pro', size: 'M', quantity: 1 }]),
  }, extra);
  const check = (o, opts) => returnEligibility(o, [], null, opts);

  console.log('\n  return window\n');

  console.log('  the setting');
  {
    ok('unset means no window — nothing changes for an existing store',
      returnWindowFrom({}).windowDays === 0);
    ok('…and that is what a missing config gives too', returnWindowFrom(null).windowDays === 0);
    ok('a number is taken', returnWindowFrom({ returns: { windowDays: 30 } }).windowDays === 30);
    ok('a string number is taken', returnWindowFrom({ returns: { windowDays: '45' } }).windowDays === 45);
    ok('nonsense is treated as off, not as zero days',
      returnWindowFrom({ returns: { windowDays: 'soon' } }).windowDays === 0);
    ok('negative is off, not a window that refuses everything',
      returnWindowFrom({ returns: { windowDays: -5 } }).windowDays === 0);
    ok('absurd is capped rather than trusted', returnWindowFrom({ returns: { windowDays: 999999 } }).windowDays === 3650);
    ok('the transit allowance defaults to a week', returnWindowFrom({}).transitDays === 7);
    ok('…and can be set', returnWindowFrom({ returns: { transitAllowanceDays: 3 } }).transitDays === 3);
    ok('…including zero, for a store that hand-delivers',
      returnWindowFrom({ returns: { transitAllowanceDays: 0 } }).transitDays === 0);
  }

  console.log('\n  counted from DELIVERY, which is what was promised');
  {
    const inside = check(order({ delivered_at: days(10), created_at: days(40) }), { windowDays: 30 });
    ok('delivered 10 days ago, 30-day window → allowed', inside.ok === true, inside.code);

    const outside = check(order({ delivered_at: days(40), created_at: days(60) }), { windowDays: 30 });
    ok('delivered 40 days ago → refused', outside.ok === false && outside.code === 'window_closed', outside.code);

    /* The whole reason delivered_at exists. Paid 40 days ago but only delivered
       10 days ago is INSIDE a 30-day-from-delivery window — and would be
       refused by anything counting from payment. */
    ok('…and payment date does not shorten it', inside.ok === true);

    ok('a refusal says how long the window is and how long ago it arrived',
      /30/.test(outside.reason) && /\d+/.test(outside.reason), outside.reason);
    ok('…and reports when it closed, for an admin overriding it',
      typeof outside.windowClosedAt === 'string' && outside.windowClosedAt.includes('T'));
  }

  console.log('\n  with no delivery recorded, it is generous');
  {
    /* 61 existing orders have no delivered_at and never will. */
    const noDelivery = check(order({ created_at: days(34) }), { windowDays: 30, transitDays: 7 });
    ok('paid 34 days ago, no delivery date, 30+7 → still allowed', noDelivery.ok === true, noDelivery.code);

    const wayOld = check(order({ created_at: days(200) }), { windowDays: 30, transitDays: 7 });
    ok('paid 200 days ago → refused', wayOld.ok === false && wayOld.code === 'window_closed');

    ok('the allowance is applied to the ORDER date, not ignored',
      check(order({ created_at: days(36) }), { windowDays: 30, transitDays: 7 }).ok === true
      && check(order({ created_at: days(36) }), { windowDays: 30, transitDays: 0 }).ok === false,
      'transitDays must move the boundary');
  }

  console.log('\n  it fails OPEN — the opposite of every other rule here');
  {
    ok('no window configured → allowed', check(order({ created_at: days(9999) }), { windowDays: 0 }).ok === true);
    ok('no options at all → allowed', check(order({ created_at: days(9999) })).ok === true);
    ok('no dates on the order → allowed',
      check(order({ created_at: null, delivered_at: null }), { windowDays: 30 }).ok === true);
    ok('an unparseable date → allowed',
      check(order({ created_at: 'last Tuesday' }), { windowDays: 30 }).ok === true);
    ok('an unparseable delivery date falls back to the order date rather than refusing',
      check(order({ delivered_at: 'nope', created_at: days(2) }), { windowDays: 30 }).ok === true);
  }

  console.log('\n  it does not override the checks that matter more');
  {
    /* A refunded order is refused for being refunded, whatever the dates say —
       the window must not become a way past the money checks. */
    const refunded = check(order({ status: 'refunded', delivered_at: days(1) }), { windowDays: 30 });
    ok('a refunded order is still refused', refunded.ok === false && refunded.code === 'already_refunded');
    const cancelled = check(order({ status: 'cancelled', delivered_at: days(1) }), { windowDays: 30 });
    ok('…and a cancelled one', cancelled.ok === false && cancelled.code === 'cancelled');
  }

  console.log('\n  the delivery date is actually being recorded');
  {
    const hook = fs.readFileSync(path.join(ROOT, 'functions/api/shippo-webhook.js'), 'utf8');
    ok('the webhook stamps it on delivery',
      /if \(fulfillmentStatus === 'delivered'\) patch\.delivered_at/.test(hook));
    /* PostgREST rejects the WHOLE row for one unknown column, so before 0015 is
       applied this would have silently stopped recording fulfilment_status too
       — a new field quietly breaking an old one, which has happened here. */
    ok('…and retries without it if the column is not there yet',
      /if \(!resp\.ok && patch\.delivered_at\)/.test(hook));

    const sql = fs.readFileSync(path.join(ROOT, 'migrations/0015_orders_delivered_at.sql'), 'utf8');
    ok('0015 adds the column', /add column if not exists delivered_at timestamptz/.test(sql));
    ok('…and says why it cannot be backfilled', /CANNOT BE BACKFILLED/.test(sql));
  }

  console.log('\n  the refusal wording exists in both copies');
  {
    /* The parity test compares these character for character; a message the
       server can emit and the browser cannot name renders as blank. */
    const srv = fs.readFileSync(path.join(ROOT, 'functions/api/_messages.js'), 'utf8');
    const cli = fs.readFileSync(path.join(ROOT, 'customer-messages.js'), 'utf8');
    ok('the server has it', /returnWindowClosed:/.test(srv));
    ok('the browser has it', /returnWindowClosed:/.test(cli));
    ok('…and it is admin-editable like the other refusals',
      /'returnWindowClosed'/.test(cli), 'must appear in the editable key list');
  }

  console.log('\n  every caller passes it, or the rule is decorative');
  {
    for (const f of ['guest-return.js', 'customer-hub.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'functions/api/' + f), 'utf8');
      const calls = (src.match(/returnEligibility\(/g) || []).length;
      const withWindow = (src.match(/returnEligibility\([^;]*returnWindowFrom\(/g) || []).length;
      ok(f + ' passes the window at all ' + calls + ' call site(s)',
        calls > 0 && calls === withWindow, withWindow + ' of ' + calls);
    }
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✗ suite crashed: ' + e.stack); process.exit(1); });
