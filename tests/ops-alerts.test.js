/* The failovers worked and nobody found out. These check that the alerting is
   real — that it reaches a channel, that it cannot leave through the provider
   it is reporting on, and that a bad afternoon does not turn into four hundred
   messages, which is the same as no alerting at all. */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..') + '/';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  \u2014 ' + extra : '')); }
}

const N = fs.readFileSync(ROOT + 'functions/api/_notify-ops.js', 'utf8');

console.log('\n  an alert reaches a person');
{
  ok('slack, email and sms are all wired', /OPS_SLACK_WEBHOOK/.test(N) &&
    /api\.brevo\.com/.test(N) && /api\.twilio\.com/.test(N));
  /* SMS restraint is the feature. A channel that fires on warnings gets muted,
     and a muted channel is not a channel. */
  ok('sms is critical-only, so warnings cannot train someone to ignore it',
    /RANK\[severity\] >= RANK\[cfg\.smsFrom\]/.test(N));
  /* One dead channel must not stop the others — the whole point is that
     SOMETHING reaches a person. */
  ok('a dead channel does not stop the rest', /Promise\.allSettled/.test(N));
  ok('…and the notifier can never break the request it reports on',
    /export async function notifyOps/.test(N) && /catch \(e\) \{[\s\S]{0,120}return \{ error: 'notifier failed' \}/.test(N));
  ok('there is a log line for the state where nothing is configured',
    /\[ops-alert\]/.test(N), 'a new deployment starts with no channels set');
}

console.log('\n  the alert does not leave through the thing that broke');
{
  /* "Resend is down", sent via Resend, arrives exactly when it is not needed
     and vanishes exactly when it is. */
  ok('the email channel honours an avoid list',
    /const skip = new Set\(\(avoid \|\| \[\]\)/.test(N) &&
    /!skip\.has\('resend'\)/.test(N) && /!skip\.has\('brevo'\)/.test(N));
  const W = fs.readFileSync(ROOT + 'functions/api/stripe-webhook.js', 'utf8');
  ok('the Brevo-fallback alert avoids Resend', /avoid: \['resend'\]/.test(W));
  ok('the both-down alerts avoid Resend AND Brevo',
    (W.match(/avoid: \['resend', 'brevo'\]/g) || []).length >= 2);
}

console.log('\n  a bad afternoon is not four hundred messages');
{
  ok('the same event is sent at most once an hour',
    /DEDUPE_WINDOW_MS = 60 \* 60 \* 1000/.test(N) && /if \(!firstSend\(key, Date\.now\(\)\)\)/.test(N));
  ok('…and the dedupe map is bounded, not a slow leak', /function prune\(/.test(N));
  /* Per-isolate, so this reduces rather than guarantees. Stated in the file
     because a comment that oversold it would let someone skip the real fix. */
  ok('…and the per-isolate limit is written down rather than implied',
    /per-isolate/.test(N));

  const { __test } = (() => {
    // Strip every `export ` prefix, not a list of the forms present today — the
    // list version broke the moment a new export was added to the module.
    const src = N.replace(/export const __test[\s\S]*$/, '').replace(/^export\s+/gm, '');
    const fn = new Function(src + '\n;return { firstSend, seen };');
    return { __test: fn() };
  })();
  const now = Date.now();
  ok('the first send of an event goes', __test.firstSend('k', now) === true);
  ok('…the second inside the window does not', __test.firstSend('k', now + 1000) === false);
  ok('…and it is allowed again once the window passes',
    __test.firstSend('k', now + 60 * 60 * 1000 + 1) === true);
  ok('…while a different event is never suppressed by another',
    __test.firstSend('other', now + 2000) === true);
}

console.log('\n  every failover edge actually alerts');
{
  const W = fs.readFileSync(ROOT + 'functions/api/stripe-webhook.js', 'utf8');
  const S = fs.readFileSync(ROOT + 'functions/api/shippo-rates.js', 'utf8');
  ok('email: Resend → Brevo', /key: 'email-fallback-brevo'/.test(W));
  ok('email: the third-tier Loops send', /key: 'email-fallback-loops'/.test(W));
  ok('email: every provider down is critical',
    /severity: 'critical', key: 'email-all-providers-down'/.test(W));
  /* Warned BEFORE the quota is spent. "You have run out" arrives too late to
     act on, and acting while there is still room is the only reason to know. */
  ok('shipping: the Shippo quota warns before it is spent, not after',
    /shippoCount >= Math\.floor\(limit \* alertCfg\.quotaWarnAt\)/.test(S));
  ok('shipping: the silent degradation to one provider is named',
    /key: 'shippo-quota-spent-'/.test(S) && /no longer comparing two providers/.test(S));
  ok('shipping: no rates at all is critical, because it costs orders now',
    /severity: 'critical', key: 'shipping-no-rates'/.test(S));
  ok('shipping: Veeqo going quiet is reported too, not just Shippo',
    /key: 'veeqo-no-rates'/.test(S));
  /* Quota keys carry the month, or one warning would silence the next month's. */
  ok('…and quota alerts are keyed per month, not once forever',
    /shippo-quota-' \+ shippoMonthKey\(\)/.test(S));
}


console.log('\n  the store decides what is worth waking someone for');
{
  /* Hardcoding severity was me deciding whose night gets interrupted. A store
     sending ten emails a day does not want an SMS because Resend blipped; one
     sending ten thousand might. */
  const cfgOf = new Function(
    N.replace(/export const __test[\s\S]*$/, '').replace(/^export\s+/gm, '') +
    '\n;return alertConfig;')();

  const d = cfgOf({});
  ok('defaults apply when nothing is configured',
    d.quotaWarnAt === 0.8 && d.smsFrom === 'critical' && d.mute.length === 0);
  ok('a stored config is honoured', cfgOf({ ops_alerts: { smsFrom: 'warn' } }).smsFrom === 'warn');
  ok('...including when it arrives as a JSON string, as settings rows do',
    cfgOf({ ops_alerts: '{"smsFrom":"warn"}' }).smsFrom === 'warn');
  ok('a real threshold is used as given', cfgOf({ ops_alerts: { quotaWarnAt: 0.5 } }).quotaWarnAt === 0.5);
  /* 0 would warn on the very first label; above 1 could never fire at all.
     Both are ways of configuring the alert into uselessness. */
  ok('a quota threshold of 0 is rejected, not obeyed', cfgOf({ ops_alerts: { quotaWarnAt: 0 } }).quotaWarnAt === 0.8);
  ok('...and so is one above 1', cfgOf({ ops_alerts: { quotaWarnAt: 4 } }).quotaWarnAt === 0.8);
  ok('an unknown severity name falls back rather than disabling SMS silently',
    cfgOf({ ops_alerts: { smsFrom: 'shout' } }).smsFrom === 'critical');
  ok('nonsense in the row does not take the alerting down with it',
    cfgOf({ ops_alerts: 'not json' }).quotaWarnAt === 0.8);
  ok('severity is overridable per event key',
    /RANK\[cfg\.severity\[key\]\] \? cfg\.severity\[key\] : asked/.test(N));
  /* Muting happens BEFORE dedupe, or a muted event would consume the hour-slot
     of one that shares its key. */
  ok('a muted event is dropped before it can consume a dedupe slot',
    N.indexOf('cfg.mute.indexOf(key)') < N.indexOf('if (!firstSend(key'));
  const S2 = fs.readFileSync(ROOT + 'functions/api/shippo-rates.js', 'utf8');
  const W2 = fs.readFileSync(ROOT + 'functions/api/stripe-webhook.js', 'utf8');
  ok('every alert call passes the settings, or the overrides are ignored',
    (S2.match(/settings: settingsCache/g) || []).length >= 4 &&
    (W2.match(/settings: emailKeyCache/g) || []).length >= 3);
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
