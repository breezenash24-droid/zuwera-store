/* Whose name is on the email?
 *
 * `brandName(env)` has existed in _config.js for a long time and exactly ONE
 * Worker called it. Thirty others wrote "Zuwera" out by hand — in from-names,
 * subject lines, sign-offs, copyright footers and body copy — so a second store
 * running this code would send its customers emails signed by the first one.
 * That is the blocker on the white-label fork, and it is not a small one: an
 * email is the most personal thing the system sends.
 *
 * The fix is not thirty imports. site_settings.brand.name already holds the
 * store's name — the storefront reads it as window.ZW_BRAND_NAME — and the
 * email theme, which already decides an email's fonts, colours and logo, was
 * the obvious place to also decide whose name is on it. getEmailAppearance()
 * returns `brand` now, resolved from site_settings.brand.name → env
 * BRAND_NAME → the shipped default, so a store that has set nothing is
 * unchanged to the byte.
 *
 * WHAT IS NOT DONE, and this file counts it rather than implying otherwise:
 * the domain (zuwera.store), the reply-to addresses (orders@zuwera.store) and
 * a handful of admin-facing strings are still literals. Those are separate
 * settings — siteUrl(env) and EMAIL_FROM — and folding them into the brand
 * name would be three questions answered by one value again.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const API = path.join(ROOT, 'functions', 'api');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*$/gm, ' ');
const read = (f) => strip(fs.readFileSync(path.join(API, f), 'utf8'));

console.log('\n  the brand is a setting, not a literal\n');

console.log('  the email theme knows the name');
{
  const theme = read('_email-theme.js');
  ok('getEmailAppearance resolves a brand name', /brand: brandNameValue/.test(theme));
  ok('…from the setting the storefront already uses',
    /brand\.name/.test(theme),
    'site_settings.brand.name is where the store name lives; the emails were not reading it');
  ok('…then the env override, then the shipped default',
    /env\.BRAND_NAME \|\| env\.ZW_BRAND_NAME/.test(theme) && /\|\| 'Zuwera'/.test(theme),
    'a store that has set nothing must be unchanged');
  ok('…and it takes env so that chain is reachable',
    /getEmailAppearance\(cache = \{\}, env = null\)/.test(theme));
}

console.log('\n  the emails a customer actually receives');
{
  /* The three that carry the most weight: the order confirmation, the return
     status update, and the return label. Between them they are most of what a
     shopper ever gets from the store. */
  for (const f of ['_fulfil.js', 'send-return-status-email.js', 'generate-return-label.js']) {
    const src = read(f);
    ok(f + ' signs itself from the setting', /\$\{a\.brand\}|\$\{appearance\.brand\}|name: a\.brand/.test(src));
  }
  const fulfil = read('_fulfil.js');
  ok('the order confirmation from-name is the setting',
    /from:\s+`\$\{a\.brand\} </.test(fulfil),
    'the from-name is the first thing a recipient reads and it was hardcoded');
  ok('…and its Brevo sender too', /sender:\s+\{ name: a\.brand/.test(fulfil),
    'two providers, two from-names — missing one sends half the mail under the wrong name');
}

console.log('\n  every appearance call can reach the env');
{
  /* The fallback chain is only as good as the argument. A caller that forgot to
     pass env silently drops to the shipped default, which looks correct on the
     store it was written for and wrong on every other one. */
  const missed = [];
  for (const f of fs.readdirSync(API).filter((x) => x.endsWith('.js'))) {
    const src = read(f);
    if (f === '_email-theme.js') continue;
    for (const m of src.matchAll(/getEmailAppearance\(([^)]*)\)/g)) {
      if (!/\benv\b/.test(m[1])) missed.push(f);
    }
  }
  ok('no caller drops env on the floor', missed.length === 0,
    [...new Set(missed)].join(', '));
}

console.log('\n  a reply goes back to the store that sent it');
{
  /* NOT a fork problem — a LIVE one, found while counting domain literals.
   *
   * Every mailer resolved its from-address properly:
   *
   *     const fromEmail = resolveSetting('EMAIL_FROM', env, cache) || 'orders@zuwera.store';
   *
   * and then set the reply-to to the literal anyway. So a store that had set
   * EMAIL_FROM sent mail FROM its own address and routed every customer reply
   * to orders@zuwera.store — someone else's inbox, silently, on the one action
   * a shopper takes when something has gone wrong.
   *
   * The from-address is already the setting, so the reply-to is the same value
   * and never a second copy of it. */
  const offenders = [];
  for (const f of fs.readdirSync(API).filter((x) => x.endsWith('.js'))) {
    const src = read(f);
    if (/reply_?[tT]o[^,\n]*['"][^'"]*@[^'"]*['"]/.test(src)) offenders.push(f);
  }
  ok('no mailer hardcodes a reply-to address', offenders.length === 0,
    offenders.join(', ') + ' — replies land in whoever wrote the literal');

  const fulfil = read('_fulfil.js');
  ok('the order confirmation replies to its own from-address',
    /reply_to: fromEmail/.test(fulfil) && /replyTo:\s+\{ email: fromEmail \}/.test(fulfil),
    'two providers again — one fixed and one not sends half the replies to the wrong place');
}

console.log('\n  what is still hardcoded, counted');
{
  /* A budget, like the colour one. It went from 30 files to this, and it may
     only go down. The remainder is mostly the DOMAIN and the reply-to
     addresses, which are siteUrl(env) and EMAIL_FROM — different settings, and
     folding them into the brand name would recreate the problem. */
  /* 80 → 42. What is left is deliberately NOT the brand name:
       - the DOMAIN (zuwera.store, orders@zuwera.store) — siteUrl(env) and
         EMAIL_FROM, different settings, and folding them into the name is the
         mistake this file exists to prevent
       - the LOGO asset path, which a fork replaces with its own file
       - sample data in email-preview.js, which renders a demo, not an email
       - the shipped fallback inside _email-theme.js, which is the last link in
         the chain and has to be a literal or there is nothing to fall back to
     Every place the store's NAME is printed to a customer or an admin now
     reads the setting. */
  const BUDGET = 42;
  const files = [];
  for (const f of fs.readdirSync(API).filter((x) => x.endsWith('.js'))) {
    const n = (read(f).match(/Zuwera/g) || []).length;
    if (n) files.push([f, n]);
  }
  const total = files.reduce((s, r) => s + r[1], 0);
  ok('hardcoded brand mentions are not increasing', total <= BUDGET,
    total + ' across ' + files.length + ' files (budget ' + BUDGET + ')');
  console.log('    ' + files.sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map((r) => r[0] + ' ' + r[1]).join('   '));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
