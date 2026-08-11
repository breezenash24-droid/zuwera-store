/* Who decides whether this shopper is a member.
 *
 * Six different pieces of browser code decided it independently, and each one
 * REWRITES the stored cart price — so whichever page rendered last set the
 * price, and they disagreed. The bug was reported five times in a row, each
 * time inverted from the last, because fixing one check left the others.
 *
 *   product.html      isMemberSignedIn()      presence of a cached user
 *   bag.html          normalizeCartPricing    Boolean(_bagUser)
 *   checkout.html     normalizeCartPricing    Boolean(_coUser)
 *   storefront.js     normalizeCartPricing    isSignedInMember()
 *   checkout.js       isLoggedIn()            a localStorage key existing
 *   the server        verifyAccessToken()     asks the auth service
 *
 * Only the last one is authoritative, and it is the one that decides what is
 * CHARGED. So checkout.js now asks it (/api/me) and publishes the answer as
 * window.zwHasValidSession; everything else defers to that when it exists.
 *
 * This test holds that line. A new price derivation that invents its own
 * membership test fails here, on the day it is written.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..') + '/';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* Every file that derives a price from membership. Each must consult the
   published answer; the local check may remain only as a fallback. */
const DERIVERS = ['bag.html', 'checkout.html', 'storefront.js', 'product.html'];

console.log('\n  one answer to "is this shopper a member"');

for (const file of DERIVERS) {
  const src = strip(fs.readFileSync(ROOT + file, 'utf8'));
  ok(file + ' consults the published answer', /zwHasValidSession/.test(src),
    'no reference to window.zwHasValidSession');
}

{
  /* The publisher itself. If checkout.js stops exporting it, every file above
     silently falls back to its own guess and the bug returns everywhere at
     once — with nothing failing. */
  const co = strip(fs.readFileSync(ROOT + 'checkout.js', 'utf8'));
  ok('checkout.js publishes it', /window\.zwHasValidSession\s*=/.test(co));
  ok('…and the answer comes from the server, not from parsing storage',
    /\/api\/me/.test(co), 'no call to /api/me');
  ok('…cached per session, not per browser',
    /sessionStorage/.test(co) && !/localStorage\.setItem\(\s*['"]zw_member_verified/.test(co));
}


/* ── the answer has to exist BEFORE anything prices anything ────────────────
   Every caller consulted the right function and the price still alternated,
   because checkout.html prices the cart in an inline block near the top of the
   document while checkout.js loads at the bottom. window.zwHasValidSession did
   not exist yet, so it fell back to a page-local guess — the answer arrived
   after the decision that needed it.

   So stock-rules.js publishes a best-effort version and must load BEFORE the
   pricing code on every page that prices. Checked by position, because "the
   script is present" was already true when this was broken. */
console.log('\n  the answer exists before the price is decided');
{
  /* Presence on every page that derives a price. */
  for (const file of ['checkout.html', 'bag.html', 'index.html', 'product.html']) {
    const src = fs.readFileSync(ROOT + file, 'utf8');
    ok(file + ' loads stock-rules.js',
      src.search(/<script[^>]+src="[^"]*stock-rules\.js/) !== -1, 'no stock-rules.js tag');
  }

  /* ORDER only matters where the pricing runs during parse. checkout.html and
     bag.html both call normalizeCartPricing from an inline block, so the tag
     must come first — that is the bug this whole section is about.

     index.html and product.html call theirs from functions that run after load,
     by which time a deferred script has executed, so position is irrelevant
     there. Asserting it anyway would fail for a reason unconnected to the
     defect, which is how a test starts getting ignored. */
  for (const file of ['checkout.html', 'bag.html']) {
    const src = fs.readFileSync(ROOT + file, 'utf8');
    const tag = src.search(/<script[^>]+src="[^"]*stock-rules\.js/);
    const call = src.indexOf('normalizeCartPricing(raw)');
    ok(file + ' loads it before pricing at parse time', tag !== -1 && call !== -1 && tag < call,
      'tag at ' + tag + ', call at ' + call);
    ok('…and not deferred, which would run it after that block',
      !/<script[^>]+src="[^"]*stock-rules\.js[^>]*\sdefer/.test(src));
  }
  /* ── the token has to survive a page with no Supabase client ──────────────
     checkout.html builds no Supabase client, so anything reading the token via
     sb.auth got nothing. That is not a display bug: the PAYMENT request sends
     this token, so a member was charged the guest price because the request
     carried no proof of who they were. */
  const sr0 = fs.readFileSync(ROOT + 'stock-rules.js', 'utf8');
  const w = {};
  const live = { access_token: 'TOKEN123', expires_at: Math.floor(Date.now() / 1000) + 3600 };
  const enc = (o) => 'base64-' + Buffer.from(JSON.stringify(o), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const store = { 'zuwera-auth': enc(live) };   // the key this site actually uses
  const keys = Object.keys(store);
  global.localStorage = { length: keys.length, key: (i) => keys[i], getItem: (k) => (k in store ? store[k] : null) };
  new Function('window', sr0)(w);

  ok('the token can be read without the SDK', w.ZWStock.storedAccessToken() === 'TOKEN123');
  store['zuwera-auth'] = enc({ access_token: 'X', expires_at: Math.floor(Date.now() / 1000) - 60 });
  /* An expired token cannot be refreshed without the SDK and would just be
     rejected — the same outcome as sending nothing, plus a misleading round
     trip. */
  ok('…and an expired one is withheld rather than sent', w.ZWStock.storedAccessToken() === '');
  ok('…and expiry is what decides it', w.ZWStock.hasValidSession() === false);

  /* ── THE key ───────────────────────────────────────────────────────────────
     auth.js and checkout.html create the client with storageKey:'zuwera-auth',
     so the session has NEVER lived under Supabase's default
     sb-<ref>-auth-token. Every storage check written against that default found
     nothing and concluded "signed out" — which is why a member was priced as a
     guest on every page that reads storage, while the bag, which has a working
     SDK client, priced them correctly. The store above uses 'zuwera-auth', so
     the two assertions further up already depend on this being right. */
  ok('the reader knows the key this site actually uses',
    /zuwera-auth/.test(fs.readFileSync(ROOT + 'stock-rules.js', 'utf8')),
    'stock-rules.js still only looks for sb-*-auth-token');
  ok('…and so does checkout.js',
    /zuwera-auth/.test(fs.readFileSync(ROOT + 'checkout.js', 'utf8')));
  {
    /* The Supabase default must keep working too — it is what a client created
       without an explicit storageKey would write, and guessing wrong about
       this once has already cost a night. */
    const w2 = {};
    const s2 = { 'sb-proj-auth-token': enc(live) };
    const k2 = Object.keys(s2);
    global.localStorage = { length: k2.length, key: (i) => k2[i], getItem: (k) => (k in s2 ? s2[k] : null) };
    new Function('window', sr0)(w2);
    ok('…and still reads the Supabase default', w2.ZWStock.hasValidSession() === true);
  }


  /* THE key. auth.js and checkout.html create the client with
     storageKey:'zuwera-auth', so the session has never lived under Supabase's
     default sb-<ref>-auth-token. Every storage check written against that
     default found nothing and concluded "signed out" — which is why a member
     was priced as a guest on the pages that read storage instead of asking the
     SDK, while the bag (which had a working client) priced them correctly. */
  ok('the reader knows the key this site actually uses',
    /zuwera-auth/.test(fs.readFileSync(ROOT + 'stock-rules.js', 'utf8')),
    'stock-rules.js still only looks for sb-*-auth-token');
  ok('…and so does checkout.js',
    /zuwera-auth/.test(fs.readFileSync(ROOT + 'checkout.js', 'utf8')));
  {
    const w2 = {};
    const s2 = { 'sb-proj-auth-token': enc(live) };
    const k2 = Object.keys(s2);
    global.localStorage = { length: k2.length, key: (i) => k2[i], getItem: (k) => (k in s2 ? s2[k] : null) };
    new Function('window', sr0)(w2);
    ok('…and still reads the Supabase default, which a fresh client would write',
      w2.ZWStock.hasValidSession() === true);
  }

  const co = strip(fs.readFileSync(ROOT + 'checkout.js', 'utf8'));
  ok('the payment path falls back to the stored token', /storedAccessToken/.test(co),
    'getCheckoutAuthPayload cannot recover a token without window.sb');

  const sr = strip(fs.readFileSync(ROOT + 'stock-rules.js', 'utf8'));
  ok('stock-rules.js publishes the answer', /zwHasValidSession\s*=/.test(sr));
  ok('…without clobbering the server-verified one',
    /typeof\s+w\.zwHasValidSession\s*!==\s*['"]function['"]/.test(sr),
    'it assigns unconditionally, so load order decides which wins');
  ok('…and checks expiry rather than presence', /expires_at/.test(sr));
  ok('…and understands the base64 storage shape', /base64-/.test(sr));
}

{
  /* The endpoint must use the same function that prices the cart. A separate
     implementation of "is this token valid" would put us straight back to two
     answers, which is the whole failure. */
  const me = strip(fs.readFileSync(ROOT + 'functions/api/me.js', 'utf8'));
  ok('/api/me uses the same verifier the pricing uses',
    /verifyAccessToken/.test(me) && /_cart-pricing/.test(me));
  ok('…and returns nothing but the one bit',
    !/email|user_metadata|\bid\b\s*:/.test(me), 'it exposes more than membership');
  ok('…and is never cached, since it is per visitor',
    /no-store/.test(me));
  /* Failing as a member would show a price we then refuse to honour. Failing
     as a guest shows a higher price, which a shopper can see and complain
     about. Only one of those loses money quietly. */
  ok('…and fails as a guest, never as a member',
    /member:\s*false.*error|error.*member:\s*false/s.test(me) || /catch[\s\S]{0,200}member:\s*false/.test(me));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
