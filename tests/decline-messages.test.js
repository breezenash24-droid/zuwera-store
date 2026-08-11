/* Stripe returns one generic message for most declines — insufficient_funds,
   incorrect_cvc and lost_card all say "Your card was declined." True, and
   useless: each needs a different next step, and surfacing error.message alone
   dead-ends all three identically. Test mode hides this, because test cards
   return clean documented codes while real issuers decline for messy reasons. */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..') + '/';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  \u2014 ' + extra : '')); }
}

const SRC = fs.readFileSync(ROOT + 'checkout.js', 'utf8');

/* The copy moved to customer-messages.js so a store can edit it (Admin →
   Loyalty → Customer messages), keyed by Stripe's own decline code. The
   BEHAVIOUR asserted below did not change, so declineMessage is still exercised
   for real — it is just handed the module it now reads from. */
const win = {};
new Function('window', fs.readFileSync(ROOT + 'customer-messages.js', 'utf8'))(win);
const M = win.ZWMessages;

const start = SRC.indexOf('/* The copy lives in customer-messages.js');
const end = SRC.indexOf('if (typeof window !== ');
if (start === -1 || end === -1) {
  console.log('  ✗ cannot find declineMessage in checkout.js');
  process.exit(1);
}
const { declineMessage } = new Function('window',
  SRC.slice(start, end) + '\n;return { declineMessage };')(win);

/** Every message we ship for a card decline. */
const declineCopy = () => M.keys()
  .filter((k) => k.indexOf('decline:') === 0)
  .map((k) => M.DEFAULTS[k].text);

const err = (o) => Object.assign({ message: 'Your card was declined.' }, o);

console.log('\n  a decline says what to do about it');
{
  ok('insufficient funds does not read like a typo',
    /enough available/i.test(declineMessage(err({ code: 'card_declined', decline_code: 'insufficient_funds' }))));
  ok('a bad CVC points at the back of the card',
    /3 digits/i.test(declineMessage(err({ decline_code: 'incorrect_cvc' }))));
  ok('an expired card says so', /expired/i.test(declineMessage(err({ code: 'expired_card' }))));
  ok('a postcode mismatch names the billing address',
    /postcode|billing address/i.test(declineMessage(err({ decline_code: 'incorrect_zip' }))));
  /* Three codes that share one Stripe message must NOT share one of ours —
     that identical dead end is the whole bug. */
  const three = ['insufficient_funds', 'incorrect_cvc', 'expired_card']
    .map((c) => declineMessage(err({ decline_code: c })));
  ok('codes Stripe words identically get different advice from us',
    new Set(three).size === 3, three.join(' | '));
}

console.log('\n  it does not invent reasons');
{
  /* A decline the shopper cannot act on should not be dressed up as advice.
     Inventing one costs them five minutes fixing what was never wrong. */
  ok('do_not_honor admits the bank gave no reason',
    /without giving a reason/i.test(declineMessage(err({ decline_code: 'do_not_honor' }))));
  /* Fraud holds and lost/stolen share neutral copy on purpose: "your card is
     reported stolen" is a message for the cardholder, and the person at the
     checkout may not be them. */
  ok('lost and stolen cards get neutral copy, not an accusation',
    declineMessage(err({ decline_code: 'lost_card' })) === declineMessage(err({ decline_code: 'stolen_card' })) &&
    !/stolen|lost|report/i.test(declineMessage(err({ decline_code: 'stolen_card' }))));
}

console.log('\n  it never leaves a failure unexplained');
{
  /* An unmapped code must fall through to Stripe rather than to silence — a
     failed payment with no message is worse than a generic one. */
  ok('an unknown decline_code falls back to Stripe\u2019s message',
    declineMessage(err({ decline_code: 'brand_new_code_2027' })) === 'Your card was declined.');
  ok('no error object still yields a sentence', declineMessage(null).length > 10);
  ok('an error with no message or code still yields a sentence',
    declineMessage({}).length > 10);
  ok('every mapped message is non-empty and ends in a full stop',
    declineCopy().every((m) => m.length > 15 && m.trim().endsWith('.')));
  /* Editable must not mean erasable: an empty override is refused and the
     shipped sentence stands, so a store cannot accidentally turn a decline into
     silence from the admin panel. */
  M.setOverrides({ 'decline:expired_card': '   ' });
  ok('a decline message cannot be blanked from settings',
    /expired/i.test(declineMessage(err({ code: 'expired_card' }))));
  M.setOverrides({});
  /* decline_code is the specific one; code is the general one. When both are
     present the specific must win. */
  ok('decline_code beats code when both are present',
    /enough available/i.test(declineMessage(err({ code: 'expired_card', decline_code: 'insufficient_funds' }))));
}

console.log('\n  both checkout paths use it');
{
  ok('the card path reads decline_code, not just message',
    (SRC.match(/declineMessage\(/g) || []).length >= 4 &&
    !/errEl\.textContent = \w+\.error\.message/.test(SRC));
  /* A second copy of this table is a second thing to forget when a code is
     added, so the express path on the homepage shares it. */
  const SF = fs.readFileSync(ROOT + 'storefront.js', 'utf8');
  ok('the express path shares the helper rather than copying it',
    /window\.zwDeclineMessage \|\|/.test(SF) && !/DECLINE_COPY/.test(SF));
  ok('…and checkout.js no longer keeps a private table either',
    !/DECLINE_COPY/.test(SRC), 'the copy belongs in customer-messages.js now');
  ok('…and falls back to Stripe\u2019s message where checkout.js is not loaded',
    /\(e\) => \(e && e\.message\)/.test(SF),
    'no page should get worse than it is today');
  ok('the helper is exported for it', /window\.zwDeclineMessage = declineMessage/.test(SRC));
}


console.log('\n  a thrown decline is still a decline');
{
  /* The outer catch swallowed everything into "Something went wrong", identical
     for every cause — the exact bug the copy above exists to fix, reappearing
     one level out. A Stripe error must carry its reason whichever way it
     reaches us. */
  const CO = fs.readFileSync(ROOT + 'checkout.js', 'utf8');
  ok('the catch maps Stripe errors instead of flattening them',
    /err\.decline_code \|\| err\.code \|\| err\.type/.test(CO) && /\? declineMessage\(err\)/.test(CO));
  ok('...and only a genuinely non-Stripe failure gets the generic line',
    CO.includes(": 'Something went wrong. Please try again.'"));
  /* If the generic DOES show, the console is the only place the cause exists. */
  ok('the raw error is still logged, so the generic case is diagnosable',
    /console\.error\('Checkout error:', err\)/.test(CO));
}


console.log('\n  Stripe talks to integrators, not to shoppers');
{
  /* "Keys for idempotent requests can only be used with the same parameters
     they were first used with. Try using a key other than 'pi_Fgs3…'" reached
     the checkout screen. It names an internal identifier, describes a mechanism
     the shopper cannot reach, and suggests an action only we can take. */
  const CO = fs.readFileSync(ROOT + 'checkout.js', 'utf8');
  ok('API-shaped failures are replaced before display',
    /const INTERNAL_ERROR = \/idempoten\|/.test(CO) && /data\.error = 'We could not start that payment/.test(CO));
  ok('...and the original is kept for the console, not thrown away',
    /data\.detail = data\.error;/.test(CO));

  const CPI = fs.readFileSync(ROOT + 'functions/api/create-payment-intent.js', 'utf8');
  /* The key hashes a SUBSET of the request, so metadata that differs between
     attempts collides under an identical key. A conflict therefore proves the
     two requests differ — which is exactly when a retry is correct. */
  ok('an idempotency conflict retries once with a fresh key',
    /StripeIdempotencyError/.test(CPI) && /idempotencyKey: retryKey/.test(CPI));
  ok('...resending the same body, so the retry is the same order',
    /const intentParams = \{/.test(CPI) && /create\(intentParams, \{ idempotencyKey \}/.test(CPI));
  /* Identical resubmissions must still collide, or the double-charge guard is
     gone. Only a genuine conflict earns a new key. */
  ok('...and anything that is not a conflict still throws',
    /if \(!conflict\) throw e;/.test(CPI));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
