/* A return could be settled as store credit, and store credit did not exist.
 *
 * Four separate forms offered it — the signed-in return form in account.html,
 * the customer hub's, the guest form and the multi-step flow in returns.html,
 * plus the admin's resolution picker. The returns.html card said, in words,
 * "Credit towards your next Zuwera order".
 *
 * There was no credit. Searched at the time:
 *
 *     no credit or balance table in schema.sql or any supabase-*.sql
 *     no reference in checkout.js, commerce-checkout.js, _cart-pricing.js
 *       or create-payment-intent.js
 *     nothing on the account page that could display a balance
 *
 * So a shopper picked it, a staff member confirmed it, and the money existed
 * only as a word on a status page. That is the worst of the three possible
 * states: not having the feature is honest, having it is useful, and appearing
 * to have it means somebody is owed money the system cannot pay.
 *
 * ── WHAT WAS REMOVED AND WHAT WAS DELIBERATELY KEPT ─────────────────────────
 *
 * REMOVED: every way to CHOOSE it.
 * KEPT:    every way to READ it.
 *
 * A return already settled as credit still has to render as "Store Credit",
 * still has to send the email that says so, and still has to be findable in the
 * admin filter. Deleting the vocabulary as well as the choice would turn those
 * rows into "Refund" — quietly restating history to match the code, which is a
 * worse lie than the one being fixed. The admin's per-return dropdown keeps the
 * option only when that return already carries it, marked "(retired)", so it
 * reads correctly and can be moved to refund or exchange.
 *
 * Building the ledger properly is on the work queue. Until it exists, not
 * offering it is the honest position.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');

console.log('\n  store credit is not offered, because there is none\n');

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

console.log('\n  and nothing pretends a balance exists');
{
  const MONEY = ['checkout.js', 'commerce-checkout.js',
    'functions/api/_cart-pricing.js', 'functions/api/create-payment-intent.js'];
  for (const f of MONEY) {
    ok('  ' + f + ' has no credit redemption path',
      !/store.?credit/i.test(read(f)),
      'if this ever gains one, the option belongs back on the forms above');
  }
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
