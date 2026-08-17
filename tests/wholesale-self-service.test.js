/* What a shopper may find out, and may change, about their own trade terms.
 *
 * Two storefront surfaces now touch profiles.wholesale — the column that
 * decides what somebody is charged. Migration 0024 puts a trigger on it so a
 * customer cannot grant themselves trade pricing from a browser console, and
 * /api/my-wholesale runs with the service key, which that trigger exempts. So
 * this endpoint is the only place a customer can affect their own pricing at
 * all, and the whole question is what it refuses.
 *
 *   STATUS IS NEVER TAKEN FROM THE REQUEST. It is the literal 'applied'. The
 *   one thing a body must never be able to say is 'approved'.
 *
 *   AN APPLICATION NEVER OVERWRITES A DECISION. Re-applying while approved
 *   would demote a live trade account to a pending one — a self-inflicted price
 *   rise. Re-applying while SUSPENDED would be worse: a suspension is somebody
 *   else's judgement, and clearing it by filling in a form again is an undo
 *   button on it.
 *
 *   ONE SHOPPER READS ONE ACCOUNT. The profile is keyed by the id the auth
 *   server returned, never by anything in the request.
 *
 * The minimum is the other half: it was enforced at the till and announced
 * nowhere, so a buyer chose everything and was refused at the end. Showing it
 * must not become a SECOND opinion about the figure — the bag promising $250
 * while checkout enforces $500 is worse than not showing it at all.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const API = read('functions/api/my-wholesale.js');
const MIN = read('wholesale-minimum.js');
const APPLY = read('wholesale-apply.js');
const BAG = read('bag.html');
const ACCOUNT = read('account.html');

console.log('\n  a shopper and their own trade terms\n');

console.log('  the files were read');
{
  ok('the endpoint has content', API.length > 2000, String(API.length));
  ok('both storefront modules too', MIN.length > 1000 && APPLY.length > 2000);
}

console.log('\n  an applicant cannot approve themselves');
{
  ok("status is a constant in the file, not a field from the body",
    /status: 'applied'/.test(API), 'the endpoint must supply it');
  /* The decisive check: nothing anywhere reads a status off the request. */
  ok('no status is ever read from the request body',
    !/body\.status/.test(API),
    'a body that can name a status is a body that can name "approved"');
  ok('…and the record is built field by field, not spread from the body',
    !/\.\.\.body/.test(API) && !/wholesale: body/.test(API),
    'spreading the body would carry whatever it contained straight through');
}

console.log('\n  an application never overwrites a decision');
{
  ok('an approved account is told there is nothing to apply for',
    /prevStatus === 'approved'/.test(API) && /409/.test(API),
    're-applying would demote a live trade account');
  ok('a suspended account is refused rather than reset',
    /prevStatus === 'suspended'/.test(API),
    'a suspension is somebody else\'s decision, not a form to fill in again');
  ok('…and both answer 409, which is a conflict rather than a failure',
    (API.match(/409, cors\(env\)/g) || []).length >= 2);
}

console.log('\n  one shopper, one account');
{
  ok('the profile is keyed by the verified user id',
    /profiles\?select=[^`']*&id=eq\.\$\{encodeURIComponent\(userId\)\}/.test(API),
    'an id from the request would let one customer read another');
  ok('the write is keyed the same way',
    /profiles\?id=eq\.\$\{encodeURIComponent\(user\.id\)\}/.test(API));
  ok('a signed-out shopper gets an answer, not an error',
    /signedIn: false/.test(API),
    '401 on the normal case would make every bag page log a failure');
}

console.log('\n  the minimum has one source');
{
  ok('the endpoint reads it through the same helper the till uses',
    /wholesaleMinimumCents\(/.test(API),
    'a second computation is how a bag promises $250 and checkout enforces $500');
  /* The property is "the figure is the server's", not "no arithmetic happens" —
     the first version of this banned `* 100` outright and flagged the progress
     bar's percentage, which is a length and not money. An assertion that fires
     on the wrong thing gets weakened or deleted, so it has to name what it
     actually cares about: the raw column is never read, and the only minimum
     in the file is the one the endpoint returned. */
  ok('the browser never reads the raw column',
    !/min_order_cents/.test(MIN),
    'reading the stored field would bypass wholesaleMinimumCents and its approved-only rule');
  ok('…and the only minimum it knows is the one it was handed',
    (MIN.match(/minOrderCents/g) || []).length > 0
    && !/minimum\s*=\s*\d/.test(MIN) && !/25000|50000/.test(MIN),
    'a figure typed into the page is a second opinion about money');
  ok('…and only shows it to an approved trade buyer',
    /d\.isWholesale/.test(MIN),
    'an applicant has no minimum because they have no trade pricing yet');

  /* The till still refuses. Showing the figure must not have moved the rule. */
  const CART = read('functions/api/_cart-pricing.js');
  ok('the till still enforces it',
    /minOrderCents > 0 && subtotalCents < minOrderCents/.test(CART),
    'the browser can be told; only the till can refuse');
}

console.log('\n  the bag says it while there is still time');
{
  ok('the bag has somewhere to put it', /id="wholesale-minimum"/.test(BAG));
  ok('…hidden by default, so a retail shopper never sees a gap',
    /id="wholesale-minimum" hidden/.test(BAG));
  ok('it repaints on every recalculation, not once',
    /ZWWholesaleMinimum\.paint\(/.test(BAG),
    'removing the item that crossed the line has to un-cross it');
  ok('the subtotal is handed over in whole cents',
    /Math\.round\(subtotal \* 100\)/.test(BAG),
    'a float carried through is how a bag says "reached" about an order refused by a penny');
  ok('the module is loaded before the code that calls it',
    BAG.indexOf('wholesale-minimum.js') > 0
    && BAG.indexOf('wholesale-minimum.js') < BAG.indexOf('ZWWholesaleMinimum.paint('));
  ok('it names what the figure does NOT count',
    /shipping, tax and discount codes do not go towards it/.test(MIN),
    'the same three the till excludes');
}

console.log('\n  the application form is reachable and honest');
{
  ok('the account page has a panel for it', /id="panel-trade"/.test(ACCOUNT));
  ok('…and a tab that starts hidden', /id="acct-tab-trade"[^>]*display:none/.test(ACCOUNT),
    'a permanent Wholesale tab on a retail account is a question nobody asked');
  ok('the module is loaded', /wholesale-apply\.js/.test(ACCOUNT));
  ok('the form sends no status of its own', !/status:/.test(APPLY.slice(APPLY.indexOf('body: JSON.stringify'), APPLY.indexOf('body: JSON.stringify') + 300)));
  ok('a suspended buyer is told re-applying will not help',
    /re-applying will not lift it/.test(APPLY));
  ok('non-prepaid terms say checkout still takes payment',
    /checkout still takes payment today/.test(APPLY),
    'otherwise a buyer expects an invoice and meets a card form');
  ok('the page re-reads the server rather than painting its own optimism',
    /_state = await load\(\);\s*\n\s*render\(\);/.test(APPLY));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
