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

const W = fs.readFileSync(ROOT + 'functions/api/stripe-webhook.js', 'utf8');
const riskOf = new Function(
  W.slice(W.indexOf('function riskOf(pi)'), W.indexOf('// ─── Entry point')) + '\n;return riskOf;')();

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

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
