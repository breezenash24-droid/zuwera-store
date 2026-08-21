/* One order, one number, and the customer's copy is the real one.
 *
 * There were two generators and they never met.
 *
 *   AT PAYMENT     create-payment-intent and paypal-create-order call
 *                  generateOrderNumber(), put it in the metadata, and it is
 *                  what the confirmation email prints.
 *   AT FULFILMENT  _fulfil.js built a SECOND one — `ZW-<category>-00001` from a
 *                  row count — wrote that to orders.order_number, and threw
 *                  away the number the customer had just been given.
 *
 * And the second one usually produced neither, because it needed the first
 * item's product to have a `category` and did nothing when that was empty:
 *
 *     const categoryCode = catRows[0]?.category || '';
 *     if (categoryCode) { … }      // no else, no log
 *
 * Which is why order_number is NULL on every real order in production, why the
 * panel falls back to `#0MWBS6VZ` derived from the payment reference, and why
 * — the part that actually cost something — guest-return.js matches on what
 * the panel shows, so a guest typing the number from their own confirmation
 * email was told it was not their order.
 *
 * This file holds the three things that make that stay fixed: one generator,
 * the customer's number reaching the column, and no two orders sharing one.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const pricing = read('functions/api/_cart-pricing.js');
const fulfil = read('functions/api/_fulfil.js');
const migration = read('migrations/0031_an_order_has_one_number.sql');

console.log('\n  there is one generator\n');

ok('generateOrderNumber is the only thing that mints one',
  (pricing.match(/export function generateOrderNumber/g) || []).length === 1);

/* The tell-tale of the old scheme. If any of these come back, so does the
   second number — and the count-based part brings the race with it. */
ok('…and fulfilment does not build a second',
  !/ZW-\$\{categoryCode\}/.test(fulfil)
  && !/select=category/.test(fulfil)
  && !/order_number=like\./.test(fulfil),
  'counting rows to find the next number is a lost update with money attached');

ok('fulfilment writes the number the customer was already given',
  /const orderNumber = String\(meta\.order_number \|\| ''\)\.trim\(\) \|\| null;/.test(fulfil)
  && /order_number:      orderNumber,/.test(fulfil));

/* Both processors have to put it in the metadata, or the column goes back to
   null for whichever one was forgotten. PayPal carries it through the approval
   round-trip as custom_id and reads it back at capture. */
ok('both payment routes generate it and carry it',
  /generateOrderNumber\(\)/.test(read('functions/api/create-payment-intent.js'))
  && /generateOrderNumber\(\)/.test(read('functions/api/paypal-create-order.js'))
  && /order_number: orderNumber/.test(pricing));

console.log('\n  the email and the database say the same thing');

/* This is the whole point. The email prints meta.order_number; the column now
   holds meta.order_number; orderNo() reads the column first. Three readers,
   one string. */
ok('the confirmation email prints the metadata number',
  /const orderId      = meta\.order_number \|\| pi\.id\.slice\(-8\)\.toUpperCase\(\);/.test(fulfil));

ok('…and the panel reads the column before falling back',
  /const n = String\(o\.order_number == null \? '' : o\.order_number\)\.trim\(\);\s*\n\s*if \(n\) return/.test(read('functions/api/_order-no.js')));

/* The fallback stays. Every order placed before this has a null column and has
   been showing a payment-reference label for months — in the panel, in stored
   return labels, in emails already sent. Removing it would rename them. */
ok('…and old orders keep the name they have always had',
  /fallback\.slice\(-8\)\.toUpperCase\(\)/.test(read('functions/api/_order-no.js')));

ok('a guest can be found by the number they were emailed',
  /sameOrderNo\(orderNo\(o\), wanted\)/.test(read('functions/api/guest-return.js')),
  'it matches on orderNo(), which is why the column being null rejected real customers');

console.log('\n  no two orders share one');

ok('the column is unique',
  /create unique index if not exists orders_order_number_key/.test(migration));

ok('…and the nulls history left behind are allowed, deliberately',
  /where order_number is not null/.test(migration));

/* Ten characters of a 28-symbol alphabet. The alphabet matters as much as the
   length: this gets read down a phone line, so no 0/1/O/I, and no vowels so it
   cannot spell anything. Same reasoning _stored-value.js already applies to
   gift card codes, which is the same act. */
ok('the number has enough entropy for a unique index to cost nothing',
  /const ORDER_NO_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ';/.test(pricing)
  && /new Uint8Array\(10\)/.test(pricing));

ok('…with no character anybody has to disambiguate out loud',
  !/[01OI]/.test((pricing.match(/const ORDER_NO_ALPHABET = '([^']+)'/) || [])[1] || 'O')
  && !/[AEIU]/.test((pricing.match(/const ORDER_NO_ALPHABET = '([^']+)'/) || [])[1] || 'A'));

/* A unique index that can reject rejects AFTER the customer has been charged.
   The throw would fail the webhook, Stripe would redeliver identical metadata,
   it would collide again — an infinite retry over a paid order that never
   saves. */
ok('a collision does not lose an order that has already been paid for',
  /if \(resp\.status === 409 && orderNumber\)/.test(fulfil)
  && /const suffixed = orderNumber \+ '-'/.test(fulfil));

ok('…and says so, because at these odds it means the generator is wrong',
  /console\.error\('order number collision on'/.test(fulfil));

console.log('\n  the generator actually behaves');
{
  /* Run it. Everything above reads source; this runs the thing. */
  const src = (pricing.match(/const ORDER_NO_ALPHABET[\s\S]*?^}/m) || [])[0] || '';
  const gen = new Function('crypto',
    src.replace(/^export\s+/gm, '') + '\nreturn generateOrderNumber;')(require('crypto').webcrypto);
  const seen = new Set();
  let shapeOk = true;
  for (let i = 0; i < 20000; i += 1) {
    const n = gen();
    if (!/^[23456789BCDFGHJKMNPQRSTVWXYZ]{10}$/.test(n)) { shapeOk = false; break; }
    seen.add(n);
  }
  ok('every number is ten characters of the stated alphabet', shapeOk);
  ok('…and twenty thousand of them collide zero times', seen.size === 20000,
    (20000 - seen.size) + ' collisions — the unique index would have rejected paid orders');

  /* The one comparison a customer's typing has to survive. Evaluated the way
     order-number.test.js does it — the module is ESM and the suite is not. */
  const { orderNo, sameOrderNo } = new Function(
    read('functions/api/_order-no.js').replace(/^export\s+/gm, '')
    + '\n;return { orderNo, sameOrderNo };')();

  ok('“#K3M9QXBCDF”, “k3m9qxbcdf” and “K3M9 QXBCDF” are one order',
    sameOrderNo('#K3M9QXBCDF', 'k3m9qxbcdf') && sameOrderNo('#K3M9QXBCDF', 'K3M9 QXBCDF'));
  ok('…and two different numbers are not',
    !sameOrderNo('#K3M9QXBCDF', '#K3M9QXBCDG'));

  /* End to end on the shape that was broken: a real generated number, written
     to the column, read back by the panel, and matched against what the
     customer typed off their email. */
  const issued = gen();
  ok('a number this generates survives the whole round trip',
    orderNo({ order_number: issued, stripe_payment_intent_id: 'pi_3U5GvY0oFp4PJGit0mwbS6vz' }) === '#' + issued
    && sameOrderNo(orderNo({ order_number: issued }), issued),
    'the panel must show the number the customer was emailed, not the payment reference');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
