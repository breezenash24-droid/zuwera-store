/* Store credit is offered again, and this file is why that is now honest.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 *
 * `store-credit-is-not-offered.test.js`, which held the opposite invariant for
 * exactly as long as it was true. Four forms let a shopper choose store credit
 * — the signed-in return form in account.html, the customer hub's, the guest
 * form and the multi-step flow in returns.html — and behind all four there was
 * no balance anywhere: no table, no redemption at checkout, nothing on the
 * account page that could display one. A shopper picked it, a staff member
 * confirmed it, and the money existed only as a word on a status page.
 *
 * The option was removed from all four in one change, and that test was written
 * to keep it removed until three things existed: a ledger, a way to spend it,
 * and a way for a return to issue it. All three do now. So the test flips, and
 * what it guards flips with it — from "nobody may offer this" to "it may be
 * offered, and here is everything that has to stay true for that to be honest".
 *
 * ── THE FOUR FORMS ARE NAMED INDIVIDUALLY, STILL ────────────────────────────
 *
 * That was the original file's sharpest idea and it survives the flip. These
 * forms ask one question in four places, and a change applied to three of them
 * is a change that looks done — with the fourth left promising something the
 * others no longer do. It cost a removal once; it would cost a false promise
 * now.
 *
 * ── AND THE READ PATH IS STILL SEPARATE FROM THE WRITE PATH ─────────────────
 *
 * A return settled as credit years ago still has to render as "Store Credit",
 * still has to send the email that says so, and still has to be findable in the
 * admin filter — whatever the forms are offering today. Those assertions are
 * carried over unchanged, because they were never about whether the feature
 * exists.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const refund = read('functions/api/admin-refund.js');
const retUi = read('admin-returns-ui.js');

console.log('\n  store credit is offered again, on all four forms\n');

{
  const FORMS = {
    'account.html': 'the signed-in return form',
    'customer-hub.js': 'the customer hub',
    'returns.html': 'the multi-step flow and the guest form',
  };
  for (const [f, what] of Object.entries(FORMS)) {
    ok('  ' + f + ' — ' + what,
      /value="store_credit"|data-value="store_credit"/.test(read(f)),
      'this form asks the same question as the other three and must offer the same answers');
  }
  ok('  admin-returns-ui.js — the resolution picker, no longer marked retired',
    /<option value="store_credit" \$\{r\.resolution === 'store_credit' \? 'selected' : ''\}>Store Credit<\/option>/.test(retUi));

  /* returns.html carries TWO of them. The guest form is a string built at
     runtime and the wizard is static markup, which is exactly how one of them
     gets missed. */
  ok('  …and returns.html really does carry both of its forms',
    (read('returns.html').match(/store_credit/g) || []).length >= 4);
}

console.log('\n  …but only where the store can honour it');
{
  const GATED = ['account.html', 'customer-hub.js', 'returns.html'];
  for (const f of GATED) {
    ok('  ' + f + ' hides the option until the store runs credit',
      /data-zw-needs-credit/.test(read(f)),
      'an option that leads to "store credit is switched off" should not have been offered');
  }
  const offer = read('store-credit-offer.js');
  ok('the gate is the same switch the till reads',
    /fetch\('\/api\/stored-value'\)/.test(offer)
    && /getSetting\(env, 'stored_value'/.test(read('functions/api/_stored-value.js')));
  ok('…and a failed check leaves it hidden, rather than offered',
    /\.catch\(function \(\) \{ answer = false; return answer; \}\)/.test(offer));
  ok('…and it is hidden before the question is asked, not after',
    /hideAll\(\);\s*\n\s*ask\(\)/.test(offer),
    'a form that flashes an option and takes it away has already offered it');
  /* The hub form and the guest form are assembled from strings after the page
     has loaded. One pass at load reveals two forms out of four, which is the
     original bug wearing a new costume. */
  ok('…and forms built later are covered too',
    /MutationObserver/.test(offer));
  ok('…and every page carrying one of those forms loads the gate',
    ['account.html', 'returns.html', 'index.html', 'product.html']
      .every((f) => /store-credit-offer\.js/.test(read(f))));
}

console.log('\n  a return can now actually issue it, which is what changed');
{
  ok('the refund route issues credit instead of calling a processor',
    /import \{ issue as issueStoredValue, storedValueEnabled(, voidCode)? \} from '\.\/_stored-value\.js'/.test(refund)
    && /kind: 'store_credit'/.test(refund));

  /* It goes through the route that already asks who you are, asks for
     REFUND_SECRET, and checks the spending limits. A second endpoint would have
     needed its own copy of all of that. */
  ok('…behind the same authorization code and limits as any other refund',
    refund.indexOf("if (settlement === 'store_credit')") > refund.indexOf('refundKey !== secret'));

  ok('…and refuses when the store has credit switched off',
    /if \(!await storedValueEnabled\(env\)\)/.test(refund),
    'issuing into a till that will not accept it is the promise this was removed for');

  ok('the credit is bound to the account when the order has one',
    /ownerUserId: order\.user_id \|\| null/.test(refund),
    'otherwise it never appears on the account page it was issued to');
}

console.log('\n  and it cannot be paid twice');
{
  /* $50 given as credit and then $50 returned to the card is paying for the
     same item twice — and no processor can be asked about the credit half,
     because Stripe has never heard of it. */
  ok('credit already given comes off the same ceiling as money already refunded',
    /const remaining = Math\.max\(0, already\.chargedCents - already\.refundedCents - creditCents\);/.test(refund));

  ok('…counted from its own field, so the processor ledger stays true',
    /Number\(e\.storeCreditCents\) > 0/.test(refund)
    && /\.\.\.\(storeCreditCents > 0 \? \{ storeCreditCents \} : \{\}\)/.test(refund),
    'writing it into stripeRefundAmount would report refunds no card ever received');

  /* A processor absorbs a double-click through an idempotency key. Issuing
     cannot — it writes a new instrument every time, by design. So an unknown
     ceiling is refused rather than guessed at. */
  ok('an unknown ceiling refuses rather than guesses, because credit cannot be un-issued',
    /if \(!already\.known\) \{[\s\S]{0,400}?store credit needs a known ceiling/.test(refund));

  ok('…and the refusal message names both tenders',
    /already\.refundedCents \/ 100\)\.toFixed\(2\)\} to the card/.test(refund)
    && /creditCents \/ 100\)\.toFixed\(2\)\} as store credit/.test(refund),
    '"$40 has already gone back" sends somebody looking for a card refund that does not exist');

  ok('nothing is written until the credit actually exists',
    refund.indexOf('storeCreditCode = issued.code') < refund.indexOf('// ── 10. Update order in Supabase'),
    'an order marked settled against a credit that failed to issue owes money nobody can see');
}

console.log('\n  the sale is still a returned sale');
{
  ok('the tax is reversed whichever tender settled it',
    /const refunded = Number\(stripeRefundAmount \|\| storeCreditCents \|\| 0\);/.test(refund),
    'the goods came back — the tax on them stops being something this store owes');

  ok('the order is still marked settled',
    /isFullRefund \? 'refunded' : order\.status/.test(refund));

  ok('the return closes, and records that it was credit',
    /\(stripeRefundId \|\| storeCreditCode\)/.test(refund)
    && /resolution: 'store_credit', storeCreditCents/.test(refund),
    'a return settled as credit that reads as "Refund" tells the customer to watch their card');
}

console.log('\n  the code goes to the customer and nowhere else');
{
  ok('the audit log carries the amount and never the code',
    /The amount, never the code/.test(refund)
    && !/storeCreditCode,?\s*\n\s*newStatus/.test(refund));

  ok('the customer gets it by email',
    /storeCreditCode,\s*\n\s+storeCreditCents,\s*\n\s+\}\);/.test(refund));

  /* Everything the refund email says about timing is false for credit: no bank,
     no 5–10 business days, nothing that will ever appear on a statement. */
  ok('…in an email written for credit, not a relabelled refund email',
    /const creditBody = `/.test(refund)
    && /bodyHtml: isCredit \? creditBody : body/.test(refund));

  ok('…and the admin sees it once, in a dialog rather than a toast',
    /function showStoreCreditIssued/.test(retUi)
    && /Shown once and never again/.test(retUi));

  ok('…which cannot be dismissed by a stray click outside it',
    /No backdrop-click close/.test(retUi),
    'it holds the only copy of something spendable');
}

console.log('\n  every return already settled that way still reads correctly');
{
  ok('the customer account still labels it',
    /if \(r === 'store_credit'\) return 'Store Credit';/.test(read('account.html')));
  ok('the admin returns table still labels it',
    /store_credit:'Credit'/.test(retUi));
  ok('the status page still explains the credit-applied state',
    /store_credit_issued:\s*\{ label: 'Credit Applied'/.test(read('returns.html')));
  ok('the status email still says the right word',
    /resolution === 'store_credit' \? 'store credit'/.test(read('functions/api/send-return-status-email.js')));
  ok('the return label email does too',
    /resolution === 'store_credit' \? 'store credit'/.test(read('functions/api/generate-return-label.js')));
  ok('the admin can still filter for them',
    /<option value="store_credit">Store Credit<\/option>/.test(read('admin.html')));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
