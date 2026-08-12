/* Radar scores every live charge and does essentially nothing in test mode, so
   this is the one field that only gets a real value in production — and it is
   NOT recoverable. A charge scored last week cannot be re-scored, so a day
   without it is a day of evidence gone about whether real customers are being
   wrongly flagged. */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..') + '/';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  \u2014 ' + extra : '')); }
}

/* The Stripe payment path is two files now: the route that verifies the
   signature, and _fulfil.js which does everything after a payment
   succeeds (split out so PayPal can reach fulfilment without importing
   the Stripe SDK). Read as one, because that is what it is. */
const W = fs.readFileSync(ROOT + 'functions/api/stripe-webhook.js', 'utf8')
  + fs.readFileSync(ROOT + 'functions/api/_fulfil.js', 'utf8');
/* riskOf lives in _fulfil.js, so it is sliced out of THAT file rather than out
   of the concatenation — the old end marker ("Entry point") is in the route,
   which now comes first, so slicing across both would run backwards. */
const F = fs.readFileSync(ROOT + 'functions/api/_fulfil.js', 'utf8');
const riskOf = new Function(
  F.slice(F.indexOf('function riskOf(pi)'), F.indexOf('// ─── Orchestrator')) + '\n;return riskOf;')();

console.log('\n  the score is read where Stripe actually puts it');
{
  /* Radar's verdict lives on the CHARGE, not the PaymentIntent. */
  ok('reads it from an expanded charges array',
    riskOf({ charges: { data: [{ outcome: { risk_level: 'normal', risk_score: 12 } }] } }).level === 'normal');
  ok('…and from latest_charge when that is the expanded shape',
    riskOf({ latest_charge: { outcome: { risk_level: 'elevated', risk_score: 60 } } }).score === 60);
}

console.log('\n  absent means not measured, never measured-and-fine');
{
  /* A fabricated 'normal' is indistinguishable from a real one the moment
     anyone looks at the numbers, which is the only reason to collect this. */
  ok('an unexpanded intent yields null, not a default', riskOf({}).level === null && riskOf({}).score === null);
  ok('a charge with no outcome yields null',
    riskOf({ charges: { data: [{}] } }).level === null);
  ok('junk yields null rather than throwing',
    riskOf(null).level === null && riskOf({ charges: { data: 'no' } }).level === null);
  ok('a non-string level is refused rather than coerced',
    riskOf({ latest_charge: { outcome: { risk_level: 7 } } }).level === null);
  ok('a non-integer score is refused rather than rounded',
    riskOf({ latest_charge: { outcome: { risk_score: 'high' } } }).score === null);
  /* score 0 is a real measurement and must survive a falsy check. */
  ok('a score of zero is kept, because zero is a measurement',
    riskOf({ latest_charge: { outcome: { risk_score: 0 } } }).score === 0);
}

console.log('\n  recording it can never cost an order');
{
  /* PostgREST rejects the WHOLE row for one unknown column, so putting these in
     the insert would mean every order failing to save until 0006 is applied. */
  ok('the risk fields are NOT in the order insert',
    !/risk_level:\s*riskOf/.test(W),
    'an unknown column rejects the entire row');
  ok('…they are stamped afterwards, non-fatally',
    /Risk stamp skipped \(non-fatal\)/.test(W) &&
    W.indexOf('Supabase insert failed') < W.indexOf('risk_level: risk.level'));
  ok('…and only when there is something to record',
    /if \(risk\.level \|\| risk\.score !== null\)/.test(W));

  const M = fs.readFileSync(ROOT + 'migrations/0006_payment_hardening.sql', 'utf8');
  ok('the column exists in a migration for it to land in',
    /add column if not exists risk_level text/.test(M));
  /* Unbackfilled on purpose: orders taken before this genuinely have no score,
     and stamping them 'normal' would poison the first distribution. */
  ok('…and old orders are left null rather than backfilled',
    !/update .*orders.*set .*risk_level/i.test(M));
}

/* ── Stripe has to be able to SEE where the order went ──────────────────────
   The destination used to live only in PaymentIntent metadata, which is a
   key-value store for us and opaque to Stripe. So Stripe held a payment whose
   destination it could not read, and three of its own features had nothing to
   work with: tax threshold monitoring fell back to the card's billing address,
   Radar could not compare billing to shipping, and a "product not received"
   dispute had no address to answer with.

   Metadata is not a substitute, and the failure is invisible — everything
   looks correct in our own dashboard, because we can read our own metadata. */
console.log('\n  Stripe can read where the order is going');
{
  const CPI = fs.readFileSync(ROOT + 'functions/api/create-payment-intent.js', 'utf8');
  const APAY = fs.readFileSync(ROOT + 'functions/api/apple-pay-authorize.js', 'utf8');

  /* Anchored to the intent params, not just "the word shipping appears" — the
     file is full of shipping_provider, shipping_service, charged_shipping_cents
     and the like, any of which would satisfy a loose match. */
  const hasShippingHash = (src) => /shipping:\s*\{[\s\S]{0,400}?address:\s*\{/.test(src);

  ok('the main checkout puts the address on the intent, not only in metadata',
    hasShippingHash(CPI));
  ok('…including the postal code, which is what tax thresholds key off',
    /shipping:\s*\{[\s\S]{0,400}?postal_code:/.test(CPI));
  /* Both payment routes or neither: an order should look the same in the
     Stripe dashboard whether it was paid by card or by wallet. This is the
     check that would have caught the two drifting apart in the first place. */
  ok('…and the wallet route does the same, so the two agree', hasShippingHash(APAY));

  const W2 = fs.readFileSync(ROOT + 'functions/api/stripe-webhook.js', 'utf8');
  ok('the tracking number joins it once the label exists',
    /tracking_number:\s*tracking\.number/.test(W2) && /carrier:/.test(W2));
  /* Stripe REPLACES the shipping hash rather than merging into it, so an
     update carrying only the carrier would wipe the address. Sending the
     existing name and address back is what makes the update non-destructive —
     and getting this wrong would silently undo the fix above on every order
     that ships. */
  ok('…without wiping the address it is being added to',
    /shipping:\s*\{[\s\S]{0,300}?address:\s*pi\.shipping\.address/.test(W2));
  ok('…and is skipped on intents that never had one',
    /pi\.shipping && pi\.shipping\.address/.test(W2));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
