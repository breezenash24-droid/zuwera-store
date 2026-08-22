/* Creating money is guarded at least as well as taking it out.
 *
 * The asymmetry this file exists to correct, measured on 2026-08-21:
 *
 *                                    refunds   issuing a gift card
 *     admin identity verified          yes            yes
 *     permission checked               yes            yes
 *     ABAC limits applied              yes            yes
 *     written to the audit log         yes            yes
 *     second factor beyond admin       yes            NO
 *     rate limited                     yes            NO
 *     lockout on repeated failure      yes            NO
 *     aggregate cap                    no             NO
 *     self-dealing refused             n/a            NO
 *
 * Taking money OUT of the store was guarded five ways. Putting spendable money
 * INTO the world was guarded two — and a refund at least has an order behind it
 * that somebody can point at, where a freshly issued code has nothing behind it
 * at all. The audit row records the amount and deliberately never the code, so
 * a stolen session could write itself the per-call maximum and the record of it
 * could not even say which card to cancel.
 *
 * Four holes, all confirmed by reading the code rather than assumed, all closed
 * here.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const issue = read('functions/api/admin-stored-value.js');
const refund = read('functions/api/admin-refund.js');
const secret = read('functions/api/_money-secret.js');
const pricing = read('functions/api/_cart-pricing.js');
const panel = read('stored-value-admin.js');

console.log('\n  issuing money needs the factor admin access does not give you\n');

ok('the issue action checks the shared secret',
  /await checkMoneySecret\(env, \{/.test(issue)
  && /if \(!secret\.ok\)/.test(issue));

/* REFUND_SECRET is a Cloudflare environment variable with no reset button in
   the panel, on purpose. Reusing it rather than inventing a second one: a new
   secret is one more thing to set, and an unset one either breaks issuing on
   every store that upgrades or fails open, which is the hole in a config file. */
ok('…and it is the same secret refunds use',
  /const expected = env\.REFUND_SECRET;/.test(secret)
  && /const secret = env\.REFUND_SECRET;/.test(refund));

ok('…failing closed when no secret is configured',
  /if \(!expected\) \{[\s\S]{0,400}?status: 503/.test(secret),
  'a store that has not set it has decided nothing about who may mint money, and the safe reading of undecided is nobody');

/* LOOKUP AND VOID DELIBERATELY DO NOT NEED IT. Void is how a card that should
   not exist gets cancelled; putting the mint's lock on the fire exit would mean
   a stolen code could not be killed by whoever noticed it. */
ok('…and voiding a card is NOT behind it',
  issue.indexOf('await checkMoneySecret') > issue.indexOf("if (action === 'void')")
  || !/action === 'void'[\s\S]{0,600}?checkMoneySecret/.test(issue),
  'cancelling a code somebody should not have must never be the slow path');

ok('the panel asks for it, and does not keep it',
  /id="svAuthKey"/.test(panel)
  && /authKey: \$\('svAuthKey'\)\?\.value/.test(panel)
  && /if \(\$\('svAuthKey'\)\) \$\('svAuthKey'\)\.value = '';/.test(panel));

console.log('\n  and it is metered, like every other door onto money');

ok('five wrong codes lock issuing for an hour',
  /const MAX_BAD = 5;/.test(secret)
  && /const LOCKOUT_MS = 60 \* 60 \* 1000;/.test(secret));

ok('…counted in its own ledger, not the refund one',
  /rateLimitKey: 'stored_value_rate_limit'/.test(issue),
  'sharing a counter would let a refund lockout hide an issuing attack, and the reverse');

ok('…and a counter that cannot be written does not open the door',
  /catch \(_\) \{ \/\* a counter that cannot be written must not open the door \*\/ \}/.test(secret));

ok('the compare does not leak the length',
  /let same = given\.length === expected\.length;/.test(secret)
  && /Math\.max\(given\.length, expected\.length\)/.test(secret));

console.log('\n  nobody issues to themselves');

/* The condition AND the refusal it reaches. An earlier version of this checked
   only that the comparison appeared in the file — which stayed true when the
   whole branch was disabled with `if (false && …)`, because the text was still
   there. A test that a dead branch passes is not a test. */
ok('an issue to the signer’s own account or address is refused',
  /if \(\(ownerUserId && String\(ownerUserId\) === String\(admin\.id\)\)[\s\S]{0,120}?\|\| \(mine && ownerEmail\.toLowerCase\(\) === mine\)\) \{[\s\S]{0,700}?\}, 403, headers\);/.test(issue),
  'the comparison has to GATE something, not merely exist');

ok('…and the refusal is on the record too',
  /action: 'stored_value\.issue_refused'/.test(issue),
  'a refused attempt is the most interesting row in the log');

console.log('\n  and a day has a ceiling, not just a keystroke');

/* The $5,000 cap is per CALL. It stops a mistyped amount and nothing else: a
   hundred calls of $4,999 were a hundred separate decisions each of which
   passed, because nothing counted them. */
ok('the daily total is capped per admin',
  /await mutateSetting\(env, ISSUE_LEDGER_KEY/.test(issue)
  && /if \(mineToday \+ amountCents > cap\)/.test(issue));

ok('…claimed atomically, so two at once cannot both be allowed',
  /mutateSetting/.test(issue),
  'the same lost-update race already fixed in promo counts, stock, and the balance itself');

ok('…per admin rather than per store',
  /ledger\[admin\.id\]/.test(issue),
  'a shared budget lets one person’s ordinary work mask another’s theft');

console.log('\n  a refund cannot leave a live card the order paid for');

/* Buy a $100 card, take the code, spend it, ask for the money back. Both halves
   are ordinary alone and nothing connected them, so the store paid twice. */
ok('the refund route looks up what the order minted',
  /async function cardsIssuedByOrder/.test(refund)
  && /source_ref=eq\.\$\{encodeURIComponent\('order:' \+ orderNumber\)\}/.test(refund));

ok('an unspent card is voided BEFORE the money moves',
  refund.indexOf('await voidCode(env, card.code') < refund.indexOf('const out = await proc.refund('),
  'refund-then-void has a window where the customer holds both the cash and a live code');

ok('an already-spent card stops the refund instead',
  /if \(spent\.length\) \{[\s\S]{0,400}?already been spent/.test(refund),
  'who absorbs that loss is a decision, and not one an endpoint should make quietly');

ok('…and so does a lookup that could not answer',
  /if \(!issued\.known\) \{[\s\S]{0,600}?\}, 503, h\);/.test(refund)
  && /could not read the gift cards this order issued/.test(refund),
  '"could not tell" is not "nothing to worry about" — the same rule the processor ledger follows');

ok('the admin is told which cards went with the refund',
  /giftCardsVoided/.test(refund),
  'an admin who is not told a $100 card went too will hear it from the customer');

console.log('\n  and one instrument cannot launder into another');

ok('stored value is refused as tender on a cart holding a gift card',
  /if \(storedValueCode && giftCardSubtotalCents > 0\)/.test(pricing));

ok('…for the whole cart, not per line',
  /A gift card cannot be paid for with a gift card or store credit/.test(pricing),
  'splitting tender per line is a second pricing path in the place where a bug means money');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
