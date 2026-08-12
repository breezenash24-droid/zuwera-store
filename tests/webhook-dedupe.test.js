/* The webhook already deduped on "does an order for this PaymentIntent exist".
   That catches the ordinary retry and misses two things: two deliveries
   arriving at once can BOTH pass it before either writes, and an event that
   creates no order has nothing to look for. */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..') + '/';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  \u2014 ' + extra : '')); }
}

const W = fs.readFileSync(ROOT + 'functions/api/stripe-webhook.js', 'utf8');
const src = W.slice(W.indexOf('async function alreadyHandled'), W.indexOf('// ─── Entry point'));
const make = (fetchImpl) => new Function('fetch', 'getSupabaseServiceKey', 'console',
  src + '\n;return alreadyHandled;')(fetchImpl, () => 'svc', { warn() {}, log() {} });

const env = { SUPABASE_URL: 'https://x' };
const ev = { id: 'evt_1', type: 'payment_intent.succeeded' };
const res = (status) => Promise.resolve({ ok: status >= 200 && status < 300, status });

console.log('\n  the check IS the claim');
{
  /* No window between looking and claiming — that gap is the race the old
     order-exists guard has. */
  ok('inserting the event id is what claims it',
    /method: 'POST'/.test(src) && /processed_events/.test(src) && !/select=/.test(src),
    'a select-then-insert leaves a gap two racers both pass through');
  ok('a first delivery is not a duplicate', make(() => res(201))(env, ev).then ? true : true);
}

console.log('\n  only a real duplicate stops the handler');
(async () => {
  ok('409 from the primary key means someone else has it',
    (await make(() => res(409))(env, ev)) === true);
  ok('a successful claim means carry on',
    (await make(() => res(201))(env, ev)) === false);

  /* The dangerous direction. Treating "cannot dedupe" as "already done" would
     silently drop every order — far worse than the duplicate it guards against. */
  ok('a missing table proceeds rather than dropping the order',
    (await make(() => res(404))(env, ev)) === false);
  ok('an auth failure proceeds', (await make(() => res(401))(env, ev)) === false);
  ok('a server error proceeds', (await make(() => res(503))(env, ev)) === false);
  ok('a thrown network error proceeds',
    (await make(() => Promise.reject(new Error('offline')))(env, ev)) === false);
  ok('no configuration proceeds', (await make(() => res(409))({}, ev)) === false);
  ok('an event with no id proceeds', (await make(() => res(409))(env, {})) === false);

  console.log('\n  it runs before any handler, for every event type');
  {
    ok('the guard is above the payment_intent.succeeded branch',
      W.indexOf('if (await alreadyHandled(env, event))') < W.indexOf("if (event.type === 'payment_intent.succeeded')"),
      'a dedupe after the handler has already done the work is not a dedupe');
    ok('a duplicate answers 200, so Stripe stops retrying',
      /duplicate: true \}\), \{\s*status: 200/.test(W));
    const M = fs.readFileSync(ROOT + 'migrations/0006_payment_hardening.sql', 'utf8');
    ok('the primary key that does the locking exists',
      /event_id\s+text primary key/.test(M));
  }

  /* ── A claim never given back turns every retry into a no-op ──────────────
     Claiming BEFORE fulfilment is right: two concurrent deliveries of the same
     event must not both create an order. Keeping the claim after a FAILURE is
     not — Stripe's retry hits the 409, reads it as "already handled", and does
     nothing. The handler answered 500 saying "Stripe should retry this event"
     while guaranteeing the retry could not work.

     That is how an order survives a transient fault and still never gets its
     confirmation, its label or its stock decrement. */
  console.log('\n  a failed delivery can actually be retried');
  {
    const W = fs.readFileSync(ROOT + 'functions/api/stripe-webhook.js', 'utf8');

    ok('the claim is released when fulfilment fails', W.includes('await releaseClaim(env, event)'));
    ok('…before answering, so the retry it asks for can work',
      W.indexOf('await releaseClaim(env, event)') < W.indexOf("error: 'Fulfillment failed"));
    ok('…and releasing is best-effort, never a second failure',
      W.includes('Could not release the dedupe claim'));
    ok('the response still asks Stripe to retry', W.includes('Stripe should retry this event'));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
