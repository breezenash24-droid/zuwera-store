/* Store credit is not offered ON A RETURN, because a return cannot issue it.
 *
 * ── WHAT THIS FILE USED TO SAY, AND WHY IT CHANGED ──────────────────────────
 *
 * It used to say "store credit is not offered, because there is none". Four
 * forms let a shopper choose it — the signed-in return form in account.html,
 * the customer hub's, the guest form and the multi-step flow in returns.html —
 * plus the admin's resolution picker, and behind all five there was no balance
 * anywhere: no table, no redemption path at checkout, nothing on the account
 * page that could display one. A shopper picked it, a staff member confirmed
 * it, and the money existed only as a word on a status page.
 *
 * That is no longer the reason. Migration 0030 built the ledger, and the three
 * surfaces that make it real are now built too: an admin can issue credit, a
 * shopper can spend it at checkout, and they can see the balance and the code
 * on their account page. Store credit EXISTS and is spendable — so the
 * assertion this file used to make, that commerce-checkout.js has no
 * redemption path, is now false ON PURPOSE. Keeping it would be asserting the
 * feature away.
 *
 * ── WHAT IS STILL MISSING IS ONE STEP, NOT THE WHOLE THING ──────────────────
 *
 * Nothing issues credit FROM A RETURN. /api/admin-refund is where money moves —
 * it is the only route that refunds a processor, reverses the tax, closes the
 * request and emails the customer — and it has no store-credit settlement in
 * it. Until it does, a return form offering store credit would recreate the
 * exact bug that got the option removed: a shopper picks it, an admin confirms
 * it, and nothing issues.
 *
 * So the rule has not changed, only its trigger. The forms get the option back
 * in the same change that lets a return settle as credit, and not before. The
 * two assertions at the end of this file are what will fail on that day, and
 * their failure message says what to do about it.
 *
 * ── WHAT WAS REMOVED AND WHAT WAS DELIBERATELY KEPT ─────────────────────────
 *
 * REMOVED: every way to CHOOSE it on a return.
 * KEPT:    every way to READ it.
 *
 * A return already settled as credit still has to render as "Store Credit",
 * still has to send the email that says so, and still has to be findable in the
 * admin filter. Deleting the vocabulary as well as the choice would turn those
 * rows into "Refund" — quietly restating history to match the code, which is a
 * worse lie than the one being fixed. The admin's per-return dropdown keeps the
 * option only when that return already carries it, marked "(retired)", so it
 * reads correctly and can be moved to refund or exchange.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');

console.log('\n  store credit is not offered on a return, because a return cannot issue it\n');

console.log('  no form lets anybody choose it');
{
  /* Named individually. These four ask the same question in four places — the
     comment in account.html says so — and a fix applied to three of them is a
     fix that looks done. */
  const FORMS = {
    'account.html': 'the signed-in return form',
    'customer-hub.js': 'the customer hub',
    'returns.html': 'the multi-step flow and the guest form',
  };
  for (const [f, what] of Object.entries(FORMS)) {
    ok('  ' + f + ' — ' + what,
      !/value="store_credit"|data-value="store_credit"/.test(code(f)),
      'this form still offers a resolution the system cannot honour');
  }
  ok('  admin-returns-ui.js — the resolution picker',
    !/<option value="store_credit"(?! selected>Store Credit \(retired\))/.test(code('admin-returns-ui.js'))
    && /r\.resolution === 'store_credit' \? '<option value="store_credit" selected>Store Credit \(retired\)<\/option>' : ''/.test(read('admin-returns-ui.js')),
    'offered only for a return that already carries it, so it can be read and moved');
}

console.log('\n  but every return already settled that way still reads correctly');
{
  ok('the customer account still labels it',
    /if \(r === 'store_credit'\) return 'Store Credit';/.test(read('account.html')));
  ok('the admin returns table still labels it',
    /store_credit:'Credit'/.test(read('admin-returns-ui.js')));
  ok('the status page still explains the credit-applied state',
    /store_credit_issued:\s*\{ label: 'Credit Applied'/.test(read('returns.html')));
  ok('the status email still says the right word',
    /resolution === 'store_credit' \? 'store credit'/.test(read('functions/api/send-return-status-email.js')));
  ok('the return label email does too',
    /resolution === 'store_credit' \? 'store credit'/.test(read('functions/api/generate-return-label.js')));

  /* The one place an option tag survives on purpose. */
  ok('the admin can still FILTER for them',
    /<option value="store_credit">Store Credit<\/option>/.test(read('admin.html')),
    'a filter is a question about existing rows, not a choice about a new one');
  ok('…and says why it is exempt',
    /Store Credit stays HERE and nowhere else/.test(read('admin.html')),
    'otherwise the next person tidying this up removes it and hides the rows');
}

console.log('\n  the balance itself is real now — that is no longer the blocker');
{
  /* These four used to be asserted EMPTY, and three of them still would be if
     the rule were "no file may mention credit". They are the redemption path,
     and it exists: the till quotes against a code, holds it, and captures it
     when the payment succeeds. */
  ok('the till can spend a balance',
    /storedValueCode/.test(read('functions/api/_cart-pricing.js'))
    && /quoteAgainst/.test(read('functions/api/_cart-pricing.js')));
  ok('…and holds it rather than trusting the browser',
    /await hold\(env, storedValue\.code/.test(read('functions/api/create-payment-intent.js')));
  ok('…and a shopper has somewhere to type the code',
    /zw-sv-input/.test(read('checkout.html'))
    && /applyStoredValueFromInput/.test(read('commerce-checkout.js')));
  ok('…and somewhere to find out what it is',
    /my-stored-value/.test(read('account.html')));
  ok('…and an admin has a way to create one',
    fs.existsSync(path.join(ROOT, 'stored-value-admin.js'))
    && /action === 'issue'/.test(read('functions/api/admin-stored-value.js')));
}

console.log('\n  but a RETURN still cannot issue one, which is the last step');
{
  /* THESE TWO ARE THE REMINDER NOW. admin-refund.js is the only route money
     moves through on a return — processor refund, tax reversal, closing the
     request, emailing the customer — and admin-returns.js is the one that
     records the resolution. When a store-credit settlement lands in either,
     these fail, and the failure means: put the option back on all four forms
     in that same change. */
  ok('nothing issues credit from the refund route yet',
    !/_stored-value|storedValue|issueStoreCredit/i.test(read('functions/api/admin-refund.js')),
    'IT DOES NOW — re-offer store credit on the four return forms in this change');
  ok('…nor from the returns-update route',
    !/_stored-value|storedValue|issueStoreCredit/i.test(read('functions/api/admin-returns.js')),
    'IT DOES NOW — re-offer store credit on the four return forms in this change');
}


console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
