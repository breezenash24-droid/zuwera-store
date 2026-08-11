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
