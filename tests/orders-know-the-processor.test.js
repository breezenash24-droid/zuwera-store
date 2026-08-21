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
  /* This started as a refusal — "paid through PayPal, issue it there" — then
     became a real PayPal refund, then stopped being a branch at all. The route
     now looks the processor up in _processors.js and calls one interface, so a
     third processor is a file and a registry line rather than another arm on
     every `if`. What matters here is only that the id is no longer assumed to
     be a Stripe one; the behaviour lives in tests/paypal-refund.test.js. */
  ok('the route asks which processor took it', /processorFor\(order\)/.test(REFUND));
  ok('…and no longer names one in the flow', !/isPayPal/.test(REFUND),
    'a name in the branch is what has to be edited for every processor added');
  ok('…refunding through the interface', /proc\.refund\(/.test(REFUND));
  ok('…and asking it what has already gone back', /proc\.refundedSoFar\(/.test(REFUND));

  /* Ordering still matters: the guards have to run before anything moves. */
  const code = REFUND.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  ok('…with the guards above the call',
    code.indexOf('if (already.known)') < code.indexOf('proc.refund('),
    'a check after the call is not a check');

  ok('the response says which processor handled it', /check: true, orderId, processor/.test(REFUND));
  /* Was pinned to the words "blocked: already fully refunded". It is now
     "settled in full", because a refund and a store credit both consume the
     same ceiling and only one of them is a refund — and an assertion on the
     wording would have failed for a change that made the message MORE true.
     What has to hold is the guard and its position. */
  ok('an already-refunded order is refused before PayPal is called',
    /if \(remaining <= 0\) \{[\s\S]{0,200}?success: false/.test(REFUND)
    && code.indexOf('if (remaining <= 0)') < code.indexOf('proc.refund('));

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
