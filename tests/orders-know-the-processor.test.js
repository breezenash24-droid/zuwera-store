/* Which processor took the order, and why the id no longer answers that.
 *
 * Every order records `stripe_payment_intent_id`, and while there was one
 * processor the name was also the answer. PayPal breaks it: its capture id goes
 * into the same column, deliberately — saveOrderToSupabase dedupes on that
 * column, so reusing it keeps idempotency working across both processors with
 * no second code path. The cost is a column doing two jobs and telling the
 * truth about one.
 *
 * The bill for that arrives at the worst possible moment. admin-refund.js calls
 * Stripe on that id unconditionally, so a PayPal order would reach
 * stripe.refunds.create() with an id Stripe has never seen and fail with
 * Stripe's own wording about a missing resource — while a customer is owed
 * money and the button looks broken for no legible reason.
 *
 * So 0018 adds `processor`, fulfilment writes it, and the refund route refuses
 * with a sentence that says where to go instead. Refusing is not the finished
 * feature — refunding PayPal from the panel still has to be built — but it is
 * the difference between an instruction and a mystery.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const MIG    = fs.readFileSync(path.join(ROOT, 'migrations/0018_orders_know_who_took_the_money.sql'), 'utf8');
const FULFIL = fs.readFileSync(path.join(ROOT, 'functions/api/_fulfil.js'), 'utf8');
const REFUND = fs.readFileSync(path.join(ROOT, 'functions/api/admin-refund.js'), 'utf8');
const PAYPAL = fs.readFileSync(path.join(ROOT, 'functions/api/paypal-capture.js'), 'utf8');
const BUNDLE = fs.readFileSync(path.join(ROOT, 'functions/api/_migrations.js'), 'utf8');

console.log('\n  an order says who took the money\n');

console.log('  the column');
{
  ok('0018 adds it', /add column if not exists processor/.test(MIG));
  /* NOT NULL with a default, so no row can be silent about it — an order that
     does not say who took it is exactly the row a refund cannot act on. */
  ok('…not null', /processor text not null/.test(MIG));
  /* Every existing row really was Stripe: nothing else could take an order
     before this. The default is accurate rather than merely convenient. */
  ok('…defaulting existing rows to stripe', /default 'stripe'/.test(MIG));
  ok('…as text rather than an enum', !/create type[\s\S]*processor/i.test(MIG),
    'a new processor should be a setting and a route, not an ALTER TYPE on a live table');
  ok('…and it is documented in the database', /comment on column public\.orders\.processor/.test(MIG));
  ok('the bundle picked it up', /0018/.test(BUNDLE),
    'Workers have no filesystem — an unbundled migration cannot be applied');
}

console.log('\n  fulfilment writes it');
{
  ok('the order row carries the processor', /processor:\s*meta\.payment_provider \|\| 'stripe'/.test(FULFIL));
  /* The PayPal route is the only thing that sets it, and if that ever stops
     the orders silently become "stripe" — which is the wrong answer in the
     one direction that breaks a refund. */
  ok('the PayPal route sets what fulfilment reads', /meta\.payment_provider = 'paypal'/.test(PAYPAL));

  /* Defaulting rather than throwing. An absent field means the Stripe path,
     which does not set it; refusing to save an order over a missing label
     would be losing the order to protect a report. */
  ok('an absent value defaults instead of failing the save', /\|\| 'stripe'/.test(FULFIL));
}

console.log('\n  the refund goes where the money went');
{
  /* This started as a refusal — "paid through PayPal, issue it there" — which
     was the right thing to have in place before the first PayPal order and the
     wrong thing to leave. It now refunds through PayPal for real; see
     tests/paypal-refund.test.js. What matters here is only that the two paths
     are separated at all. */
  ok('a PayPal order takes the PayPal path', /isPayPal && \(action === 'refund'/.test(REFUND),
    'otherwise Stripe is handed a capture id it has never seen');
  ok('…and the Stripe path is no longer unconditional', /!isPayPal && \(action === 'refund'/.test(REFUND));

  /* The guard has to sit ABOVE the Stripe calls or it guards nothing.
     Comments stripped first: the guard's own comment NAMES stripe.refunds.create
     while explaining what it prevents, and an unstripped search finds that
     mention several lines above the guard and reports the guard as too late.
     Second time tonight that prose describing code was read as code. */
  const code = REFUND.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  const guardAt = code.indexOf("!isPayPal && (action === 'refund'");
  const callAt = code.indexOf('stripe.refunds.create');
  ok('…and the Stripe call sits inside that guard',
    guardAt > 0 && callAt > 0 && guardAt < callAt,
    'a check after the call is not a check');

  ok('the response says which processor handled it', /check: true, orderId, processor/.test(REFUND));
  ok('a full PayPal refund is refused before it is attempted',
    /blocked: PayPal reports fully refunded/.test(REFUND));

  /* Cancel is deliberately still processor-agnostic: cancelling an unpaid
     order moves no money and touches nobody's API. */
  ok('cancel needs no processor at all', /action !== 'cancel'/.test(REFUND));
}

console.log('\n  the case that made this necessary');
{
  /* The PayPal capture id is written into the Stripe column on purpose. If that
     ever changes, the dedupe in saveOrderToSupabase needs a second path and
     this whole file is describing a problem that no longer exists. */
  ok('PayPal really does reuse the Stripe id column',
    /id: 'paypal_' \+ captureId/.test(PAYPAL),
    'if this changes, revisit the refund guard and the dedupe together');
  ok('…and the order dedupe still keys on that one column',
    /orders\?stripe_payment_intent_id=eq\./.test(FULFIL));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
