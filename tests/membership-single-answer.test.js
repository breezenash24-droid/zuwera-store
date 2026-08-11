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
