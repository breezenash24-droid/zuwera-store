/* One send chain, in one place.
 *
 * Eleven files each had their own copy of Resend → Brevo → Loops, with small
 * differences in from-name and reply-to. Adding SendGrid meant editing eleven
 * files and getting eleven right — the exact duplication that has produced
 * silent divergence elsewhere here (two typography maps, four copies of an RLS
 * allow-list). So the chain moved into _email.js, and this asserts it stays
 * there.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const API = path.join(ROOT, 'functions', 'api');
const files = fs.readdirSync(API).filter((f) => f.endsWith('.js'));
const shared = fs.readFileSync(path.join(API, '_email.js'), 'utf8');

console.log('\n  email providers\n');

console.log('  the shared chain');
{
  ok('sendTransactional exists', /export async function sendTransactional/.test(shared));
  ['api.resend.com', 'api.sendgrid.com', 'api.brevo.com'].forEach((h) => {
    ok('…calls ' + h, shared.includes(h));
  });
  ok('…and falls through to Loops last', /loopsFallback/.test(shared));

  // Order matters: it is a failover chain, not a set. Measured inside the
  // function body — loopsFallback is also DEFINED earlier in this file, so
  // searching the whole file finds the definition, not the call.
  const body = shared.slice(shared.indexOf('export async function sendTransactional'));
  const order = ['api.resend.com', 'api.sendgrid.com', 'api.brevo.com', 'loopsFallback']
    .map((h) => body.indexOf(h));
  ok('providers are tried in order: Resend → SendGrid → Brevo → Loops',
    order.every((v, i) => i === 0 || v > order[i - 1]), order.join(' < '));

  ok('a provider that throws does not abort the chain', /\.catch\(\(\) => null\)/.test(shared));
  ok('every provider unavailable throws rather than reporting success',
    /throw new Error\('No email provider configured\.'\)/.test(shared));
  ok('callers keep their own from-name', /fromName = 'Zuwera'/.test(shared));
  ok('…and their own reply-to', /replyTo \? \{ reply_to/.test(shared));
}

console.log('\n  nothing calls a provider directly any more');
{
  /* Files allowed to name a provider host, and why each one is.
     Every entry is an exemption someone has to justify — which is the point.
     This list used to be three names beside an assertion hardcoded to `true`,
     so five files carrying their own chain passed the gate silently, including
     _fulfil.js: the order confirmation, the most important email the store
     sends, and the one that then shipped a fault the shared chain could not
     have had. An exemption written down is a decision; `ok(..., true)` is a
     check that cannot fail. */
  const ALLOWED = new Map([
    ['_email.js',            'is the shared chain'],
    ['api-status.js',        'checks whether a key is valid; never sends'],
    ['update-api-key.js',    'same — validates a key on save'],
    ['admin-email-test.js',  'deliberately tries EVERY provider and reports each verbatim response; delegating would hide exactly what it exists to show'],
    ['_notify-ops.js',       'must be able to route AROUND a named provider (avoid:[...]) — an alert saying "Resend is down" sent via Resend arrives only when it is not needed'],
    ['_fulfil.js',           'order confirmation: carries per-tier ops alerts that sendTransactional does not express. TO MIGRATE — see note below'],
    ['admin-refund.js',      'not yet migrated'],
    ['generate-return-label.js', 'not yet migrated'],
  ]);
  const offenders = files.filter((f) => {
    if (ALLOWED.has(f)) return false;
    const src = codeOnly(fs.readFileSync(path.join(API, f), 'utf8'));
    return /api\.resend\.com|api\.sendgrid\.com|api\.brevo\.com/.test(src);
  });
  /* A real assertion. A new file that hand-rolls a chain now fails here rather
     than being counted in a message nobody reads. */
  ok('no NEW file hand-rolls its own provider chain',
    offenders.length === 0,
    offenders.join(', ') + ' — either use sendTransactional() or add an entry to ALLOWED saying why not');

  /* And the exemptions must stay honest: an entry that no longer calls a
     provider directly is a stale excuse, and stale excuses are how the list
     grows until it means nothing. */
  const stale = [...ALLOWED.keys()].filter((f) => {
    if (f === '_email.js') return false;   // the chain itself
    if (!fs.existsSync(path.join(API, f))) return true;
    const src = codeOnly(fs.readFileSync(path.join(API, f), 'utf8'));
    return !/api\.resend\.com|api\.sendgrid\.com|api\.brevo\.com/.test(src);
  });
  ok('every exemption is still needed', stale.length === 0,
    stale.join(', ') + ' no longer calls a provider directly — remove the exemption');

  // These six were migrated in this change and must not regress.
  ['notify-restock.js', 'send-abandoned-cart-emails.js', 'send-journal.js',
   'send-return-status-email.js', 'send-review-requests.js', 'shippo-webhook.js',
   'popup-claim.js'].forEach((f) => {
    const src = codeOnly(fs.readFileSync(path.join(API, f), 'utf8'));
    ok(f + ' delegates instead of carrying its own chain',
      /sendTransactional/.test(src) && !/api\.resend\.com/.test(src));
  });

  /* Named rather than quietly forgotten. These three send real customer mail
     through a chain that is not the shared one, so they do not get its
     invalid-sender guard (the one that caught "Zuwera <undefined>") and do not
     get the SendGrid tier. Migrating them needs sendTransactional to grow
     per-tier alerting first — otherwise the move trades a duplicated chain for
     lost visibility, which is not an improvement. */
  const toMigrate = ['_fulfil.js', 'admin-refund.js', 'generate-return-label.js'];
  console.log('    still to migrate: ' + toMigrate.join(', '));
}

console.log('\n  SendGrid');
{
  const settings = fs.readFileSync(path.join(API, '_settings.js'), 'utf8');
  const envOnly = settings.slice(settings.indexOf('ENV_ONLY_KEYS'), settings.indexOf('Get a single setting'));
  ok('SENDGRID_API_KEY is env-only, like the other senders', /'SENDGRID_API_KEY'/.test(envOnly));

  const allowed = settings.slice(settings.indexOf('const ALLOWED_KEYS'), settings.indexOf('export { ALLOWED_KEYS }'));
  ok('…and not admin-editable', !/'SENDGRID_API_KEY'/.test(allowed));

  const admin = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');
  ok('it appears in More Integrations, not the API key list', /key:'sendgrid',\s*kind:'guide'/.test(admin));
  ok('…and the card says where the key goes', /SENDGRID_API_KEY/.test(admin));
  ok('…and warns about domain verification, which is why mail lands in spam',
    /Sender Authentication/.test(admin));
}

console.log('\n  moving cards between the two sections');
{
  const admin = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');
  ok('a card can be tucked into More Integrations', /moveApiCard\('\$\{serviceKey\}','down'\)/.test(admin));
  ok('…and moved back up', /moveApiCard\('\$\{it\.tucked\}','up'\)/.test(admin));
  ok('the choice is stored per store, not per browser', /key: 'api_layout'/.test(admin));
  ok('a tucked service disappears from the API grid', /apiIsDemoted\(serviceKey\)\) return ''/.test(admin));
  ok('…and reappears in the catalogue', /cat: 'Moved here'/.test(admin));
  ok('…still opening the same key editor', /key\.indexOf\('svc_'\) === 0/.test(admin));
}

/* ── The From address ────────────────────────────────────────────────────────
   A real 422 from Resend, found in its logs:

     "from": "Zuwera <undefined>"
     "Invalid `from` field."

   One of the nine callers of sendTransactional passed no fromEmail, so the
   template interpolated undefined into a header. The message was rejected, the
   caller never saw it, and an approved refund request was silently never
   announced to the person who asked for it.

   The sender is a property of the STORE, not of the message, so a caller
   omitting it is not doing anything unreasonable. The default belongs with the
   function that needs it. */
(async () => {
  const { pathToFileURL } = require('url');
  const { sendTransactional } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_email.js')).href);

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };

  console.log('\n  the From address');
  try {
    const KEYED = { RESEND_API_KEY: 're_test' };

    sent.length = 0;
    await sendTransactional({ env: KEYED, to: 'a@b.test', subject: 's', html: '<p>h</p>' });
    ok('a caller that passes no sender still produces a valid one',
      sent.length === 1 && /^Zuwera <[^\s@]+@[^\s@]+>$/.test(sent[0].body.from), sent[0] && sent[0].body.from);
    ok('…and it is never the literal "undefined"',
      !/undefined/.test(sent[0].body.from), sent[0] && sent[0].body.from);

    sent.length = 0;
    await sendTransactional({
      env: { ...KEYED, EMAIL_FROM: 'hello@zuwera.store' },
      to: 'a@b.test', subject: 's', html: '<p>h</p>',
    });
    ok('EMAIL_FROM is used when the caller omits one',
      sent[0].body.from === 'Zuwera <hello@zuwera.store>', sent[0].body.from);

    sent.length = 0;
    await sendTransactional({
      env: { ...KEYED, EMAIL_FROM: 'hello@zuwera.store' },
      to: 'a@b.test', subject: 's', html: '<p>h</p>', fromEmail: 'support@zuwera.store',
    });
    ok('…and an explicit sender still wins',
      sent[0].body.from === 'Zuwera <support@zuwera.store>', sent[0].body.from);

    /* Refusing beats sending garbage: each provider rejects a malformed From
       differently and all of them silently, so one loud failure here is worth
       three quiet ones downstream. */
    sent.length = 0;
    const bad = await sendTransactional({
      env: KEYED, to: 'a@b.test', subject: 's', html: '<p>h</p>', fromEmail: 'not-an-email',
    });
    ok('a malformed sender is refused rather than sent', sent.length === 0 && bad && bad.ok === false,
      JSON.stringify(bad));
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log('\n  every caller passes one');
  {
    const dir = path.join(ROOT, 'functions/api');
    const offenders = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      let i = src.indexOf('sendTransactional({');
      while (i >= 0) {
        /* The call's own argument object, to the closing brace. */
        const chunk = src.slice(i, src.indexOf('})', i) + 2);
        if (!/fromEmail/.test(chunk)) offenders.push(f);
        i = src.indexOf('sendTransactional({', i + 1);
      }
    }
    /* Belt as well as braces: the default above means a miss is no longer
       fatal, but a caller that names its sender is a caller whose emails can be
       told apart in a provider's logs. */
    ok('no caller relies on the default', offenders.length === 0, offenders.join(', '));
  }

  console.log('\n  a way to test email without placing an order');
  {
    /* There was no way to find out whether email worked without placing an
       order and waiting. When nothing arrived, every layer was a suspect and
       the only evidence was a console.warn in a log nobody reads. */
    const t = fs.readFileSync(path.join(ROOT, 'functions/api/admin-email-test.js'), 'utf8');
    ok('the endpoint exists', t.length > 0);
    ok('it is admin-only', /verifyAdmin\(env/.test(t));
    /* verifyAdmin returns the user or null — never { ok }. Checking for that
       rejects every admin, which is a fine way to make a diagnostic tool need
       diagnosing. */
    ok('…checked the way verifyAdmin actually answers',
      /if \(!admin\)/.test(t) && !/admin\?\.ok/.test(t));
    ok('it resolves the sender exactly as real emails do', /EMAIL_FROM/.test(t));
    ok('…and refuses an invalid one with the address in the message',
      /is not a valid email/.test(t));
    /* The reason it exists: a provider's own words are actionable, "could not
       send" is not. */
    ok('it reports the provider response verbatim', /response: text\.slice/.test(t));
    ok('…for every configured provider, not just the first that works',
      /attempts\.filter\(\(a\) => a\.ok\)/.test(t));
    ok('a provider being unreachable is a result, not an exception',
      /catch \(e\) \{\s*return \{ provider/.test(t));
    /* "Sent" is the most misleading word in email: every provider answers 200
       for ACCEPTED, which is not delivered. */
    ok('it says accepted is not delivered', /queued, not delivered/.test(t));
    ok('…and names where to look for bounces', /suppressed address/.test(t));
  }

  console.log('\n  the go-live warning is where somebody will be standing');
  {
    /* Switching to live is when this store is most likely to break, and in the
       quietest way: payments start working and fulfilment silently stops,
       because Stripe keeps test and live webhooks — and their signing secrets
       — entirely separate. Swap only the key and every delivery fails
       signature verification while the customer is still charged. */
    const admin = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');
    const stripeCard = admin.slice(admin.indexOf('stripe: {'), admin.indexOf('shippo: {'));

    ok('the Stripe card carries a note', stripeCard.includes('note:'));
    ok('…saying it is two changes, not one', stripeCard.includes('two changes, not one'));
    ok('…naming both variables that must move together',
      stripeCard.includes('STRIPE_SECRET_KEY') && stripeCard.includes('STRIPE_WEBHOOK_SECRET'));
    /* The consequence is the point. "The webhooks differ" is forgettable;
       "the customer is charged and nothing ships" is not. */
    ok('…and what breaks if only one moves',
      stripeCard.includes('no confirmation email') && stripeCard.includes('customer is charged'));
    ok('…and how to prove it worked', stripeCard.includes('confirm the confirmation email arrives'));
    ok('a card-level note is actually rendered', admin.includes('const cardNote = def.note'));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
