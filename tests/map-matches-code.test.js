/* Is the admin map telling the truth about the site?
 *
 * The map is a drawing. It says "the product page's stock line shows soldOut"
 * because SURFACES in customer-messages.js says so — and SURFACES is written by
 * hand. If product.html actually rendered a different message there, the map
 * would go on showing the old one and look perfectly healthy.
 *
 * A map that can be right while the site is wrong is worth very little, so this
 * checks the claim against the code: every message a surface lists must
 * actually be referenced by that surface's source, and every message a source
 * references must be listed on its surface.
 *
 * WHAT THIS STILL CANNOT SEE, so the limit is written down rather than implied:
 *   - CONDITIONS. That lastInBag is used on the product page is checked; that it
 *     is used on the right BRANCH is not. A message wired to the wrong condition
 *     passes here.
 *   - LAYOUT. A message can be correct and still be clipped, hidden or painted
 *     the same colour as its background. That is what happened when the bag row
 *     could not grow.
 *   - Whether the deployed /api/stock serves what the settings row holds.
 * Those need eyes on the real site.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..') + '/';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

const w = {};
new Function('window', fs.readFileSync(ROOT + 'customer-messages.js', 'utf8'))(w);
const M = w.ZWMessages;

/* Which files draw each surface. The map names screens in a shopper's words;
   this is the only place that maps those onto code. */
const SOURCE = {
  'Product page': ['product.html'],
  /* stock-rules.js counts as part of the bag. The bag's back-in-stock replies
     come from ZWStock.joinWaitlist(), which picks the message and hands back its
     KEY — bag.html then renders `res.key`, so those four names appear nowhere in
     bag.html itself. The map's claim is true; the indirection is what hid it.
     Verified by hand before writing this line, not assumed. */
  'Bag': ['bag.html', 'stock-rules.js'],
  'Quick-add panel': ['quick-add-modal.js'],
  'Collection grid': ['drop001.html'],
  'Log in': ['zw-login.js'],
  'Checkout — refused by the server': ['functions/api/_cart-pricing.js'],
  /* Checkout — paying reaches its messages through declineKey(), never by
     literal name, so it is checked separately below. */
};

/* Any of the accessors, with the key as the first or second argument. */
/* Every accessor, including the module-local ones. stock-rules.js calls its own
   `msg()` rather than ZWStock.msg, and missing that was what made this test's
   first run look like a discrepancy in the map rather than a gap in the test. */
const KEY_RE = /(?:ZWStock\.msg|ZWStock\.applyMsg|quickAddMsg|quickAddApplyMsg|colMsg|authMsg|ZWMessages\.get|ZWMessages\.apply|\bsay|\bmsg|\bapplyMsg)\(\s*(?:[^,()]*\([^()]*\)\s*,\s*|[A-Za-z_$][\w$.]*\s*,\s*)?'([a-zA-Z][\w]*)'/g;

function keysIn(files) {
  const found = new Set();
  for (const f of files) {
    const src = fs.readFileSync(ROOT + f, 'utf8');
    let m;
    const re = new RegExp(KEY_RE.source, 'g');
    while ((m = re.exec(src))) { if (M.has(m[1])) found.add(m[1]); }
  }
  return found;
}

console.log('\n  what the map claims, the code actually does');

for (const surface of M.surfaces()) {
  const files = SOURCE[surface.name];
  if (!files) continue;
  const actual = keysIn(files);
  /* `rare` is still a claim about this surface — the message IS referenced
     there, it just should not fire in normal use — so it counts as listed. */
  const claimed = new Set([...surface.keys, ...surface.rare]);

  /* The dangerous direction: the map advertises a message on a screen that
     never shows it, so somebody edits it expecting to change that screen. */
  const overclaimed = [...claimed].filter((k) => !actual.has(k));
  ok(surface.name + ' shows everything the map says it does', overclaimed.length === 0,
    overclaimed.join(', ') + ' — listed on this surface but not used in ' + files.join(', '));

  /* The other direction: a message the screen really does show, missing from
     the map, so the map quietly under-reports what an edit will touch. */
  const unlisted = [...actual].filter((k) => !claimed.has(k));
  ok('…and nothing it shows is missing from the map', unlisted.length === 0,
    unlisted.join(', ') + ' — used in ' + files.join(', ') + ' but not listed on this surface');
}

console.log('\n  the payment screen, which never names its messages');
{
  /* checkout.js asks declineKey() for a message, so the decline keys appear
     nowhere in it as literals. The claim to verify is therefore against the
     MAP itself: the surface must list exactly the messages declineKey can
     return, or a decline could arrive with no drawing to explain it. */
  const paying = M.surfaces().find((s) => s.name === 'Checkout — paying');
  ok('the paying screen is on the map', !!paying);

  const CODES = ['insufficient_funds', 'incorrect_cvc', 'invalid_cvc', 'incorrect_number',
    'invalid_number', 'expired_card', 'invalid_expiry_month', 'invalid_expiry_year',
    'incorrect_zip', 'card_not_supported', 'currency_not_supported', 'call_issuer',
    'lost_card', 'stolen_card', 'pickup_card', 'fraudulent', 'merchant_blacklist',
    'do_not_honor', 'generic_decline', 'processing_error', 'try_again_later', 'anything_else'];
  const reachable = new Set(CODES.map((c) => M.declineKey(c)));
  const listed = new Set(paying ? paying.keys : []);

  const missing = [...reachable].filter((k) => !listed.has(k));
  ok('every message a decline can produce is drawn', missing.length === 0, missing.join(', '));

  const extra = [...listed].filter((k) => !reachable.has(k));
  ok('…and nothing is drawn that no decline can produce', extra.length === 0, extra.join(', '));

  const co = fs.readFileSync(ROOT + 'checkout.js', 'utf8');
  ok('…and checkout.js really does go through declineKey', /declineKey\(/.test(co));
}

console.log('\n  the map reads the same source of truth the storefront does');
{
  /* The admin page loads customer-messages.js and NOT stock-rules.js, so the
     module's own fetch runs and the map is populated from /api/stock — the same
     endpoint a shopper's browser reads. If the map instead rendered the values
     sitting in the admin form, it could show wording that had never been saved
     or served. */
  const admin = fs.readFileSync(ROOT + 'admin.html', 'utf8');
  ok('admin loads the shared module', /customer-messages\.js/.test(admin));
  ok('…and not stock-rules.js, so the module fetches for itself',
    !/src="[^"]*stock-rules\.js/.test(admin));
  ok('…from the endpoint the storefront reads',
    /\/api\/stock/.test(fs.readFileSync(ROOT + 'customer-messages.js', 'utf8')));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
