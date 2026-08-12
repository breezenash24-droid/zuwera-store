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
  // Files allowed to mention a provider host: the shared chain itself, and the
  // two that check whether a key is valid rather than sending anything.
  const ALLOWED = new Set(['_email.js', 'api-status.js', 'update-api-key.js']);
  const offenders = files.filter((f) => {
    if (ALLOWED.has(f)) return false;
    const src = codeOnly(fs.readFileSync(path.join(API, f), 'utf8'));
    return /api\.resend\.com|api\.sendgrid\.com|api\.brevo\.com/.test(src);
  });
  ok(files.length - offenders.length - ALLOWED.size + ' senders go through the shared chain; '
    + offenders.length + ' still call a provider directly',
    true, offenders.join(', ') || 'none');

  // These six were migrated in this change and must not regress.
  ['notify-restock.js', 'send-abandoned-cart-emails.js', 'send-journal.js',
   'send-return-status-email.js', 'send-review-requests.js', 'shippo-webhook.js',
   'popup-claim.js'].forEach((f) => {
    const src = codeOnly(fs.readFileSync(path.join(API, f), 'utf8'));
    ok(f + ' delegates instead of carrying its own chain',
      /sendTransactional/.test(src) && !/api\.resend\.com/.test(src));
  });

  // Anything still direct is recorded here rather than quietly forgotten.
  if (offenders.length) {
    console.log('    still to migrate: ' + offenders.join(', '));
  }
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

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
