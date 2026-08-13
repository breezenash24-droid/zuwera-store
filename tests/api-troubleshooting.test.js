/* Every card says what to do when it breaks.
 *
 * The panel could tell you a service was failing and not one thing about what
 * to do next. That gap is where the time goes: "Resend is failing" sends
 * somebody to Resend's documentation, which describes Resend and not this
 * store — and the failures that actually happen here are specific to how it is
 * wired.
 *
 * WHAT EARNS A LINE. Generic advice ("check your API key") is what the vendor's
 * own docs already say. What belongs here is the thing you can only know from
 * running THIS store: that Resend accepting a message is not the same as
 * delivering it, that Shippo hides the real error inside messages[] rather than
 * in the status, that a Stripe key and its webhook secret have separate modes
 * and moving one without the other leaves fulfilment dead while payments
 * succeed. Most of these are failures this store has actually had.
 *
 * Symptom first, because that is the only part the reader already has — they
 * arrive with a broken thing, not a diagnosis.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const ADMIN = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'admin.css'), 'utf8');
const STATUS = fs.readFileSync(path.join(ROOT, 'functions/api/api-status.js'), 'utf8');

/* Loaded and RUN, not regex-matched. A malformed entry renders as an empty
   line, which reads like a bug in the panel rather than a gap in the content. */
const TROUBLE = new Function(
  ADMIN.slice(ADMIN.indexOf('const API_TROUBLESHOOTING = {'), ADMIN.indexOf('function renderApiTroubleshooting'))
  + ';return API_TROUBLESHOOTING;',
)();

console.log('\n  API troubleshooting\n');

console.log('  the content is well formed');
{
  const services = Object.keys(TROUBLE);
  ok('there is troubleshooting for a real number of services', services.length >= 12, String(services.length));
  const malformed = [];
  let rows = 0;
  for (const k of services) {
    if (!Array.isArray(TROUBLE[k]) || !TROUBLE[k].length) { malformed.push(k + ' (empty)'); continue; }
    for (const r of TROUBLE[k]) {
      rows += 1;
      if (!r || !r.symptom || !r.cause || !r.fix) malformed.push(k);
    }
  }
  ok(rows + ' entries, every one with symptom, cause and fix', malformed.length === 0, malformed.join(', '));

  /* A fix that does not tell you where to go is a restatement of the problem. */
  const vague = [];
  for (const k of Object.keys(TROUBLE)) {
    for (const r of TROUBLE[k]) {
      if (r.fix.length < 25) vague.push(k + ': ' + r.fix);
    }
  }
  ok('…and every fix is actually actionable', vague.length === 0, vague.join(' | '));
}

console.log('\n  it covers the services that are actually rendered');
{
  /* Keyed to what /api/status returns. Troubleshooting for a service that does
     not exist is dead content nobody will ever see; a rendered card with none
     is the gap this exists to close. */
  const built = STATUS.slice(STATUS.indexOf('const out = {'), STATUS.indexOf('if (typeof extra === \'function\')'));
  const serviceNames = [...built.matchAll(/^\s{4}([a-z][A-Za-z]*):/gm)].map((m) => m[1]);
  ok('the status endpoint returns a set of services', serviceNames.length >= 10, serviceNames.join(', '));

  const missing = serviceNames.filter((n) => !TROUBLE[n]);
  ok('every service the panel renders has troubleshooting', missing.length === 0, missing.join(', '));

  const orphan = Object.keys(TROUBLE).filter((k) => !serviceNames.includes(k) && k !== 'returnSigning');
  ok('…and none is written for a service that does not exist', orphan.length === 0, orphan.join(', '));

  /* returnSigning is not a vendor and is deliberately included: it is the one
     that fails completely silently, telling customers a link was sent. */
  ok('the silent one is covered too', !!TROUBLE.returnSigning);
}

console.log('\n  it is reference material, not noise');
{
  /* Twelve cards each showing four symptoms would bury the numbers people come
     here to read. */
  ok('it renders collapsed', /<details class="api-trouble">/.test(ADMIN));
  ok('…with a summary you can see is clickable', /<summary>When it does not work<\/summary>/.test(ADMIN));
  ok('…and is not force-opened', !/<details class="api-trouble" open>/.test(ADMIN));
  ok('the style exists', /\.api-trouble summary \{/.test(CSS));
  ok('…and reuses the row styling rather than inventing a second one',
    /\.api-trouble > \.int-trouble-row/.test(CSS) && /\.int-trouble-sym/.test(CSS));
}

console.log('\n  it is wired into every card');
{
  ok('the card template calls it', /\$\{renderApiTroubleshooting\(serviceKey\)\}/.test(ADMIN));
  /* Cards without a serviceKey (Email Branding, Cron) pass null, and the
     function must return '' rather than throwing or printing "undefined". */
  const fn = ADMIN.slice(ADMIN.indexOf('function renderApiTroubleshooting'), ADMIN.indexOf('function renderApiCard'));
  ok('…and a card with no service renders nothing rather than breaking',
    /if \(!rows \|\| !rows\.length\) return '';/.test(fn));
  ok('content is escaped before it reaches innerHTML',
    /escapeHtml\(r\.symptom\)/.test(fn) && /escapeHtml\(r\.cause\)/.test(fn) && /escapeHtml\(r\.fix\)/.test(fn));
}

console.log('\n  the advice is specific to this store, not the vendor\'s docs');
{
  /* Each of these is a failure that actually happened here, and none of them is
     in the vendor's documentation because none of them is the vendor's fault. */
  const all = JSON.stringify(TROUBLE);
  ok('Resend: accepted is not delivered', /Accepted is not delivered/.test(all));
  ok('Stripe: test and live webhooks are separate', /SEPARATE webhook endpoints/.test(all));
  ok('Shippo: the real error hides in messages[]', /messages\[\]/.test(all));
  ok('Supabase: the service-role key falls back to anon and RLS blocks silently',
    /falls back to the anon key/.test(all));
  ok('Supabase: an unapplied migration rejects the whole row',
    /rejects the whole row/.test(all));
  ok('Veeqo: needs Amazon Shipping V2, which is off by default',
    /Amazon Shipping V2/.test(all));
  ok('PostHog: the browser key and the API key are different things',
    /browser key and the API key are different/.test(all));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
