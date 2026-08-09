/* The server half: /api/popup-claim's offer logic, plus a static check that
   every field the admin editor reads actually exists in admin.html. */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const R = ROOT + '/';
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + (e ? '  \u2014 ' + e : '')); } };

/* ── load popup-claim.js with its imports stubbed ─────────────────────────── */
let src = fs.readFileSync(R + 'functions/api/popup-claim.js', 'utf8');
// Strip EVERY import (the file now pulls in the email theme, the email log and
// the settings cache too), then inject stubs for each.
src = src.replace(/^import[\s\S]*?;$/gm, '').replace(/^export /gm, '');
src += '\n;module.exports = { parsePopupSettings, codeForEmail, popupPromo, expiryDate, isExpired, discountLabel, sendWelcomeEmail, onRequestPost };';
const mod = { exports: {} };
const emailSends = [];
new Function(
  'module', 'crypto', 'TextEncoder', 'cors', 'json', 'mutateSetting',
  'getEmailAppearance', 'getEmailContent', 'fillTemplate', 'renderEmailShell',
  'logEmail', 'fetchSiteSettings', 'resolveSetting', 'fetch', src
)(
  mod, require('crypto').webcrypto, TextEncoder,
  () => ({}), (b, s) => ({ body: b, status: s }), async (env, key, fn) => fn(env.__cfg || {}),
  () => ({ bg: '#000', panel: '#111', text: '#fff', muted: '#999', border: '#333', accent: '#f0f', fontHead: 'H', fontBody: 'B', fontMono: 'M', logo: '', logoHeight: 20 }),
  (cache, type) => ({ subject: 'Welcome — {discount} inside', kicker: 'Welcome', heading: 'You are in', intro: 'Your code is {code}.', footer: 'bye' }),
  (str, vars) => String(str == null ? '' : str).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null) ? String(vars[k]) : ''),
  (a, parts) => '<html>' + JSON.stringify(parts) + '</html>',
  async (env, entry) => { emailSends.push(entry); },
  async () => ({}),
  (key) => (key === 'RESEND_API_KEY' ? 'test-resend-key' : ''),
  async (url, init) => { emailSends.push({ url: String(url), init }); return { ok: true, json: async () => ({}), text: async () => '' }; }
);
const { parsePopupSettings, codeForEmail, popupPromo, isExpired, discountLabel, sendWelcomeEmail } = mod.exports;

(async function () {
  console.log('\n  popup-claim.js\n');

  console.log('  offer terms come from the server');
  {
    const s = parsePopupSettings({ enabled: true, discount: { value: 15, type: 'fixed' } });
    ok('reads the configured discount', s.value === 15 && s.type === 'fixed');
    ok('defaults to off', parsePopupSettings({}).enabled === false);
    ok('a non-boolean "enabled" is not truthy', parsePopupSettings({ enabled: 'yes' }).enabled === false);
    ok('negative values are floored at 0', parsePopupSettings({ discount: { value: -99 } }).value === 0);
    ok('junk discount type falls back to percent', parsePopupSettings({ discount: { type: 'free' } }).type === 'percent');
    ok('prefix is sanitised to code-safe characters',
      parsePopupSettings({ discount: { prefix: 'we!l come$$' } }).prefix === 'WELCOME');
    ok('an empty prefix still yields a usable one', parsePopupSettings({ discount: { prefix: '!!!' } }).prefix === 'WELCOME');
  }

  console.log('\n  per-email codes');
  {
    const a = await codeForEmail('shopper@example.com', 'WELCOME');
    const b = await codeForEmail('shopper@example.com', 'WELCOME');
    const c = await codeForEmail('someone.else@example.com', 'WELCOME');
    ok('the same address always yields the same code (nothing new is minted)', a === b, a + ' vs ' + b);
    ok('a different address yields a different code', a !== c, a + ' vs ' + c);
    ok('the code carries the admin prefix', a.indexOf('WELCOME') === 0, a);
    ok('the code is promo-safe (A-Z0-9 only)', /^[A-Z0-9]+$/.test(a), a);
    ok('no ambiguous characters in the random part', !/[IO01]/.test(a.slice('WELCOME'.length)), a);

    // 400 addresses → 400 distinct codes, no collisions.
    const seen = new Set();
    for (let i = 0; i < 400; i++) seen.add(await codeForEmail('user' + i + '@example.com', 'ZW'));
    ok('400 addresses produce 400 distinct codes', seen.size === 400, seen.size + ' distinct');
  }

  console.log('\n  the promo it writes');
  {
    const s = parsePopupSettings({ enabled: true, discount: { value: 20, minSubtotal: 50, expiryDays: 14 } });
    const single = popupPromo('WELCOMEABCDE', s, true);
    ok('a unique code is capped at one use', single.maxUsage === 1);
    ok('a shared code has no usage cap', popupPromo('WELCOME10', s, false).maxUsage === null);
    ok('the minimum spend is carried through', single.minSubtotal === 50);
    ok('expiry is the YYYY-MM-DD format the validator parses', /^\d{4}-\d{2}-\d{2}$/.test(single.expirationDate), single.expirationDate);
    ok('0 days means never expires', popupPromo('X', parsePopupSettings({ discount: { expiryDays: 0 } }), true).expirationDate === '');
    ok('it is labelled so cleanup can find it later', single.label === 'Popup');
    ok('it starts unused', single.usageCount === 0 && single.active === true);
  }

  console.log('\n  expiry housekeeping');
  {
    const past = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    ok('a past date counts as expired', isExpired({ expirationDate: past }) === true);
    ok('a future date does not', isExpired({ expirationDate: future }) === false);
    ok('no date never expires', isExpired({ expirationDate: '' }) === false);
    ok("today's code is still live (not off by one)",
      isExpired({ expirationDate: new Date().toISOString().slice(0, 10) }) === false);
  }

  /* ── the welcome email ──────────────────────────────────────────────────── */
  console.log('\n  welcome email');
  {
    ok('off unless the admin turns it on', parsePopupSettings({}).welcomeEmail === false);
    ok('a non-boolean does not enable it', parsePopupSettings({ welcomeEmail: { on: 'yes' } }).welcomeEmail === false);
    ok('the toggle round-trips', parsePopupSettings({ welcomeEmail: { on: true } }).welcomeEmail === true);
    ok('the discount phrase matches the code description',
      discountLabel({ type: 'percent', value: 10 }) === '10% off' && discountLabel({ type: 'fixed', value: 15 }) === '$15 off');

    emailSends.length = 0;
    const sent = await sendWelcomeEmail({}, { to: 'a@b.com', code: 'WELCOME10', label: '10% off' });
    ok('sends through a configured provider', sent === true);
    const call = emailSends.find(e => e.url && /resend/.test(e.url));
    ok('…to the address that signed up', call && JSON.parse(call.init.body).to[0] === 'a@b.com');
    ok('…with the placeholders filled', call && /10% off/.test(JSON.parse(call.init.body).subject),
      call && JSON.parse(call.init.body).subject);
    ok('…and the code in the body', call && /WELCOME10/.test(JSON.parse(call.init.body).html));
    const log = emailSends.find(e => e.type === 'popup_welcome');
    ok('every send is logged so a silent failure is visible', !!log && log.status === 'sent');

    // Email-only mode: no code, and the wording must still make sense.
    emailSends.length = 0;
    await sendWelcomeEmail({}, { to: 'a@b.com', code: '', label: '' });
    const c2 = emailSends.find(e => e.url && /resend/.test(e.url));
    const parts = c2 && JSON.parse(JSON.parse(c2.init.body).html.replace(/^<html>|<\/html>$/g, ''));
    ok('with no code, no code block is drawn', parts && parts.bodyHtml === '');

    const theme = fs.readFileSync(R + 'functions/api/_email-theme.js', 'utf8');
    ok('the type has default copy like every other email', /popup_welcome:\s*\{/.test(theme));
    const claim = fs.readFileSync(R + 'functions/api/popup-claim.js', 'utf8');
    ok('sending never blocks the response', /waitUntil\(p\)/.test(claim));
    ok('a provider outage cannot fail a good signup', /sendWelcomeEmail\([^)]*\)\.catch\(\(\) => \{\}\)/.test(claim));

    const admin = fs.readFileSync(R + 'admin.html', 'utf8');
    ok('the toggle is on the popup page', /id="popWelcomeEmail"/.test(admin));
    ok('the wording is editable in the Emails section', /value="popup_welcome"/.test(admin));
  }

  /* ── unpublished content is not public ──────────────────────────────────── */
  console.log('\n  drafts are not public');
  {
    const land = fs.readFileSync(R + 'landing.js', 'utf8');
    ok("?preview=1 no longer switches the anon read to the draft",
      /var key = 'landing_pages_published';/.test(land));
    // Comments stripped: the file explains WHY it no longer reads the draft, and
    // that explanation necessarily names the key.
    const landCode = land.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok('…and the draft key appears nowhere in the code', !/'landing_pages'/.test(landCode));
    ok('the builder pane still gets its config pushed to it', /ZW_LANDING_PREVIEW/.test(land));

    const sql = fs.readFileSync(R + 'supabase-hide-drafts.sql', 'utf8');
    const list = (sql.match(/ARRAY\[([\s\S]*?)\]/) || [])[1] || '';
    ok('the SQL drops landing_pages from the public allow-list', !/'landing_pages'/.test(list));
    ok('…while keeping the published key', /'landing_pages_published'/.test(list));
  }

  /* ── admin form wiring ──────────────────────────────────────────────────── */
  console.log('\n  admin editor wiring');
  {
    const html = fs.readFileSync(R + 'admin.html', 'utf8');
    const js = fs.readFileSync(R + 'admin-main.js', 'utf8');
    const block = js.slice(js.indexOf('function paintPopupForm'), js.indexOf('// ─── API Key Editor Modal'));
    const ids = [...new Set([...block.matchAll(/'(pop[A-Za-z]+)'/g)].map(m => m[1]))]
      .filter(id => id !== 'popup');
    const missing = ids.filter(id => !new RegExp('id="' + id + '"').test(html));
    ok(ids.length + ' field ids referenced by the editor all exist in admin.html',
      missing.length === 0, missing.join(', '));

    ok('the page is registered in the admin nav', /id:'popup'/.test(html));
    ok('the page markup exists', /<div id="popup" class="page">/.test(html));
    ok('navigateTo loads it', /page === 'popup'\)\s*\{\s*loadPopupSettings\(\)/.test(js.replace(/\s+/g, ' ')) || /loadPopupSettings\(\);/.test(js));
    ok('the storefront module is loaded for the live preview', /email-popup\.js\?v=/.test(html));
    ok('…without arming its triggers in the admin', /__zwPopupNoAutoOpen\s*=\s*true/.test(html));

    const rbac = fs.readFileSync(R + 'functions/api/_rbac.js', 'utf8');
    ok('the page id is registered for RBAC', /'popup'/.test(rbac.slice(rbac.indexOf('PAGE_IDS'), rbac.indexOf('PAGE_WRITE_PERM'))));
    ok('editing it needs the coupon capability, not the content one', /popup:\s*'coupon_write'/.test(rbac));
  }

  /* ── storefront delivery ────────────────────────────────────────────────── */
  console.log('\n  delivery');
  {
    const pages = fs.readdirSync(R).filter(f => f.endsWith('.html') &&
      !['admin.html', 'builder.html', 'analytics.html', 'diagnostic.html', 'mobile.html', 'm-bag.html', 'mobile-checkout.html'].includes(f));
    const missing = pages.filter(f => !/email-popup\.js/.test(fs.readFileSync(R + f, 'utf8')));
    ok(pages.length + ' storefront pages all load the module', missing.length === 0, missing.join(', '));

    const sqlFiles = ['supabase-bag-panel.sql', 'supabase-image-effects.sql',
      'supabase-feature-flags-public-read.sql', 'supabase-email-popup.sql'];
    const lists = sqlFiles.map(f => {
      const m = fs.readFileSync(R + f, 'utf8').match(/USING \(key = ANY \(ARRAY\[([\s\S]*?)\]\)\)/);
      return m ? (m[1].match(/'[^']+'/g) || []).join(',') : null;
    });
    ok('all four copies of the public-read allow-list are identical',
      lists.every(l => l && l === lists[0]));
    ok('…and every one of them includes email_popup', lists.every(l => l && l.includes("'email_popup'")));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
