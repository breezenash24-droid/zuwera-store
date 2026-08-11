/* One fulfilment, reachable by every processor.
 *
 * "An order happened" — save it, decrement stock, buy a label, email the buyer,
 * award points, credit a referrer, count the promo — lived inside the Stripe
 * webhook. A second processor could either import that route, dragging the
 * Stripe SDK into a worker with no use for it, or write fulfilment again.
 *
 * The second option is the one that costs. Two implementations drift where
 * nobody looks: stock decremented on one path and not the other, points awarded
 * twice, a confirmation email that only card payments get. Same reasoning that
 * split _cart-pricing.js out, and the same class of bug it avoided.
 *
 * This holds the split open, so the next processor cannot quietly grow its own.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..') + '/';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

const fulfil = fs.readFileSync(ROOT + 'functions/api/_fulfil.js', 'utf8');
const hook = fs.readFileSync(ROOT + 'functions/api/stripe-webhook.js', 'utf8');

console.log('\n  fulfilment is somewhere a second processor can reach');
{
  ok('_fulfil.js exports the orchestrator',
    /export async function handleSuccessfulPayment/.test(fulfil));

  /* The whole point. If this file imports Stripe, importing it from the PayPal
     route drags the SDK along and the split has bought nothing. */
  ok('…and carries no Stripe SDK import', !/from 'stripe'/.test(fulfil),
    'importing this would pull the Stripe SDK into every processor');
  ok('…so the route keeps the SDK to itself', /from 'stripe'/.test(hook));

  ok('the webhook calls the shared one rather than its own copy',
    /import \{[^}]*handleSuccessfulPayment[^}]*\} from '\.\/_fulfil\.js'/.test(hook));
  ok('…and no longer defines it', !/function handleSuccessfulPayment/.test(hook));
}

console.log('\n  everything that has to happen on a sale happens in one place');
{
  /* Each of these is a step that, missed on one processor, is silent: stock
     that never comes down, points never awarded, a promo that can be reused
     forever. Naming them here means a future extraction cannot quietly drop
     one. */
  const STEPS = [
    ['saveOrderToSupabase', 'the order is recorded'],
    ['decrementInventory', 'stock comes off the shelf'],
    ['createShippingLabel', 'a label is bought'],
    ['sendConfirmationEmail', 'the buyer is told'],
    ['incrementPromoUsage', 'the promo is counted'],
    ['awardLoyaltyPoints', 'points are credited'],
    ['creditReferrer', 'the referrer is paid'],
    ['sendPurchaseEvent', 'the purchase is reported'],
  ];
  for (const [fn, what] of STEPS) {
    ok(what, new RegExp('function ' + fn + '\\b').test(fulfil), fn + ' is not in _fulfil.js');
  }

  /* decrement_stock is wired into fulfilment and nowhere else. A processor that
     skips fulfilment oversells silently — no error, no log, just stock that
     never comes down. It is the largest risk in adding one. */
  ok('and stock is decremented ONLY from here',
    /decrement_stock/.test(fulfil) && !/decrement_stock/.test(hook),
    'a second decrement path is a second chance to get it wrong');
}

console.log('\n  the one processor-specific step is injected, not assumed');
{
  /* Writing tracking back onto the payment record was the only Stripe-shaped
     thing in fulfilment. A processor with nothing to write back passes nothing;
     it must not be a requirement. */
  ok('fulfilment takes a tracking write-back callback',
    /handleSuccessfulPayment\(pi, meta, env, onTracking\)/.test(fulfil));
  ok('…and treats it as optional',
    /typeof onTracking === 'function'/.test(fulfil),
    'a processor with no PaymentIntent would break here');
  ok('…while the Stripe route still writes tracking onto its PaymentIntent',
    /paymentIntents\.update/.test(hook));
  /* Comments stripped: _fulfil.js's header names the call it used to make, and
     a check that cannot tell prose from code would read the explanation as the
     thing it explains. */
  const code = fulfil.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('…and that call no longer lives in fulfilment',
    !/paymentIntents\.update/.test(code));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
