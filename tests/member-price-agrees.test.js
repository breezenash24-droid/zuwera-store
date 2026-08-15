/* $35 in the bag, $40 at the till.
 *
 * Both pages price the same cart, and both have to answer the same question
 * first: is this shopper a member. They answered it differently.
 *
 *   checkout.js  asks the SERVER — /api/me, verdict cached in sessionStorage —
 *                and only falls back to reading localStorage if it has no
 *                answer yet.
 *   stock-rules  read localStorage and decided for itself. Full stop.
 *
 * checkout.js wins wherever both load, and it is not loaded on bag.html. So a
 * token that is present and unexpired but which the SERVER does not accept —
 * revoked, from another project, a membership lapsed server-side — read as a
 * member on the bag and a guest at the checkout. Two prices for one cart, with
 * nothing on either page admitting the other existed.
 *
 * The server already refuses to charge above the displayed price, so nobody
 * was ever billed the higher figure. That guard is why this was a display bug
 * rather than a theft. It is still the bug most likely to lose the sale: the
 * number moved between the page where they decided and the page where they pay.
 *
 * Reading the cached verdict only fixes the SECOND visit, and shoppers reach
 * the bag before the checkout — so the bag asks too, once per session, when
 * there is a token worth asking about.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SR   = fs.readFileSync(path.join(ROOT, 'stock-rules.js'), 'utf8');
const CO   = fs.readFileSync(path.join(ROOT, 'checkout.js'), 'utf8');
const BAG  = fs.readFileSync(path.join(ROOT, 'bag.html'), 'utf8');
const CHTM = fs.readFileSync(path.join(ROOT, 'checkout.html'), 'utf8');
const SRV  = fs.readFileSync(path.join(ROOT, 'functions/api/_cart-pricing.js'), 'utf8');

console.log('\n  one price for one cart\n');

console.log('  which answer each page gets, and when');
{
  /* Both pages load BOTH files — stock-rules.js during parse, checkout.js near
     the bottom. So the first paint of the cart uses this file's answer and
     every render after uses checkout.js's. That window is the bug: the prices
     the shopper first sees are drawn from a guess, then corrected under them. */
  ok('the bag loads stock-rules', /<script src="stock-rules\.js/.test(BAG));
  ok('…and checkout.js after it', BAG.indexOf('stock-rules.js') < BAG.indexOf('checkout.js?v'));
  ok('the cart is drawn before checkout.js runs',
    BAG.indexOf('renderCart();') < BAG.indexOf('checkout.js?v'),
    'if this stops being true there is no first-paint window left to fix');
  ok('checkout.js overwrites the answer unconditionally',
    /window\.zwHasValidSession = isLoggedIn;/.test(CO));
}

console.log('\n  both now consult the server’s verdict first');
{
  ok('checkout.js checks the verified answer before anything else',
    /function isLoggedIn\(\)\s*\{[\s\S]{0,200}?if \(verifiedMember !== null\) return verifiedMember;/.test(CO));
  ok('stock-rules.js now does the same', /var v = verifiedMember\(\);\s*\n\s*if \(v !== null\) return v;/.test(SR));
  ok('…from the same cache key', /MEMBER_CACHE_KEY = 'zw_member_verified'/.test(SR) &&
    /MEMBER_CACHE_KEY = 'zw_member_verified'/.test(CO));
  /* sessionStorage, not localStorage: a verdict must not outlive signing out
     in another tab. */
  ok('…in sessionStorage', /sessionStorage\.getItem\(MEMBER_CACHE_KEY\)/.test(SR));
  ok('…and only 1/0 count as an answer', /=== '1'\) return true;[\s\S]{0,60}?=== '0'\) return false;/.test(SR),
    'anything else must read as "not asked yet", not as false');
}

/* Run the precedence. A cached verdict has to beat the local scan even when
   the scan would say the opposite — that IS the case that broke. */
{
  const fnStart = SR.indexOf('var MEMBER_CACHE_KEY');
  const fnEnd = SR.indexOf('\n  }', SR.indexOf('return false;', SR.indexOf('function hasValidSession'))) + 4;
  const mk = (cached, tokenValid) => new Function('sessionStorage', 'localStorage', 'Date', `
    ${SR.slice(fnStart, fnEnd)}
    var AUTH_KEY = /^(zuwera-auth|sb-.*-auth-token)$/;
    function readStoredSession(v) { return v; }
    return hasValidSession;`)(
      { getItem: () => cached },
      tokenValid
        ? { length: 1, key: () => 'zuwera-auth',
            getItem: () => JSON.stringify({ access_token: 'x', expires_at: Math.floor(Date.now() / 1000) + 3600 }) }
        : { length: 0, key: () => null, getItem: () => null },
      Date);

  ok('a server "no" beats a token that looks fine', mk('0', true)() === false,
    'this is the exact case: valid-looking token, server says guest');
  ok('a server "yes" beats no token at all', mk('1', false)() === true);
  ok('no verdict falls through to the local scan', mk(null, true)() === true);
  ok('…and to false when there is nothing to scan', mk(null, false)() === false);
  ok('a junk cache value is not read as "no"', mk('maybe', true)() === true,
    'a corrupt entry must mean "not asked yet", not "guest"');
}

console.log('\n  and it does not ask the server twice');
{
  /* checkout.js is on both pages and already verifies, then re-renders the
     cart when the verdict contradicts the guess. A second call from here would
     be a duplicate request on every page load to learn something already on
     its way. Reading the cached verdict is the whole fix. */
  /* The call, not the word — this file explains in a comment why it does not
     make it, and that comment should not fail the check it describes. */
  ok('stock-rules does not call /api/me', !/fetch\(\s*['"]\/api\/me/.test(SR));
  ok('checkout.js does', /fetch\('\/api\/me'/.test(CO));
  ok('…and re-renders the cart afterwards', /renderCart === 'function'\) renderCart\(\)/.test(CO));
  ok('…caching the verdict where this file can read it',
    /sessionStorage\.setItem\(MEMBER_CACHE_KEY/.test(CO));
  ok('stock-rules never reaches into the bag directly', !/renderCart/.test(SR),
    'it loads on pages that have no cart at all');
}

console.log('\n  the rule itself still matches the server');
{
  /* Copies of one expression — bag, checkout, server. They agree today; this is
     what notices when one of them stops.

     The SERVER's copy moved out of _cart-pricing.js when colourways gained
     their own prices (migration 0021): "which price applies" now depends on the
     colour as well as on membership, so the rule lives in _variant-price.js and
     is shared with the browser through variant-price.js. This assertion follows
     it there rather than being loosened — the property is unchanged, only its
     address. tests/variant-pricing.test.js runs the two implementations against
     one table and fails on any disagreement, which is the stronger check;
     leaving a stale regex here pointing at a file that no longer contains the
     rule would have passed forever once someone deleted the line it matched. */
  const rule = /isMember && member(Price|Cents) > 0 && \(!regular(Price|Cents) \|\| member(Price|Cents) < regular(Price|Cents)\)/;
  const VP = fs.readFileSync(path.join(ROOT, 'functions/api/_variant-price.js'), 'utf8');
  const serverRule = /Boolean\(isMember\) && memberCents > 0 && \(!regularCents \|\| memberCents < regularCents\)/;
  ok('the server picks the member price the same way', serverRule.test(VP),
    'the rule lives in _variant-price.js since colourways gained their own prices');
  ok('…and the cart path uses that shared rule rather than its own',
    /resolveVariantPrice\(product, colorVariant, isMember\)/.test(SRV),
    'a second derivation left in _cart-pricing.js is one some path will reach');
  ok('the bag does too', rule.test(BAG));
  ok('and the checkout', rule.test(CHTM));

  /* The backstop that made this a display bug rather than a billing one. */
  ok('and the server still refuses to charge above what was shown',
    /NEVER CHARGE MORE THAN WAS SHOWN/.test(SRV));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
