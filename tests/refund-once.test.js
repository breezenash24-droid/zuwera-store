/* Refunding the same thing twice.
   Written after a real refund: order #8A5B205C was fully refunded, with a
   label issued and its return request marked `refunded`. The customer's
   account page still offered to start a return, they did, and a second
   request for the same item landed in the admin queue looking exactly like a
   first one. */

const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..') + '/';
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  — ' + detail : '')); }
}

/* Same shim the ABAC suite uses: the module is ESM for the Worker, the tests
   are CommonJS, and stripping `export` is cheaper than a build step. */
const RSRC = fs.readFileSync(ROOT + 'functions/api/_returns.js', 'utf8');
const { returnEligibility, isLiveRequest, itemKey, reconcileReturnItems, spokenForOn, lineQty } = new Function(
  /* _returns.js now imports the shipped wording from _messages.js. new
     Function() cannot take an import, so the line is swapped for a stub — the
     text itself is covered by tests/customer-messages.test.js, which compares
     both copies of it character for character. */
  RSRC.replace(/^import .*$/gm, 'const shippedMessages = (k) => String(k);')
      .replace(/^export\s+/gm, '')
  + '\n;return { returnEligibility, isLiveRequest, itemKey, reconcileReturnItems, spokenForOn, lineQty };')();

const ORDER = { id: 'ord_1', status: 'paid', items: [
  { name: 'Aero Pro', size: 'S', color: 'Yellow' },
  { name: 'Aero Pro', size: 'M', color: 'Cyan' },
] };

console.log('\n  an order with nothing left to give back');
{
  ok('a refunded order cannot be returned',
    returnEligibility({ ...ORDER, status: 'refunded' }, []).ok === false);
  /* The wording is editable copy now, so this asserts WHICH message is used,
     not what it says — the text itself lives in customer-messages.js and is
     compared against the Worker's copy by tests/customer-messages.test.js. */
  ok('…and says why, from the editable copy',
    returnEligibility({ ...ORDER, status: 'refunded' }, []).reason === 'returnAlreadyRefunded');
  ok('a cancelled order cannot be returned',
    returnEligibility({ ...ORDER, status: 'cancelled' }, []).ok === false);
  /* American and British spellings both reach this code path depending on who
     wrote the status. */
  ok('…however it was spelled',
    returnEligibility({ ...ORDER, status: 'canceled' }, []).ok === false);
  ok('a normal order still can', returnEligibility(ORDER, []).ok === true);
}

console.log('\n  one conversation at a time');
{
  const open = [{ orderId: 'ord_1', status: 'requested', returnItems: [ORDER.items[0]] }];
  ok('a second request while one is open is refused',
    returnEligibility(ORDER, open).ok === false);
  ok('…pointing at the one they already have',
    returnEligibility(ORDER, open).reason === 'returnAlreadyOpen');

  /* Denied releases the items — they were told no and may ask again. */
  ok('a denied request does not block a new one',
    returnEligibility(ORDER, [{ orderId: 'ord_1', status: 'denied', returnItems: [ORDER.items[0]] }]).ok === true);
  ok('…which is the only status that releases',
    isLiveRequest({ status: 'denied' }) === false && isLiveRequest({ status: 'requested' }) === true);

  /* A status nobody classified must hold rather than release: refusing a
     duplicate is recoverable, paying twice is not. */
  ok('a status invented later holds by default',
    isLiveRequest({ status: 'some_new_state' }) === true);

  ok('a request on another order is irrelevant',
    returnEligibility(ORDER, [{ orderId: 'ord_9', status: 'requested', returnItems: [ORDER.items[0]] }]).ok === true);
}

console.log('\n  the item, not just the order');
{
  /* The check the order status cannot do: a PARTIAL refund leaves the order
     untouched, so an item refunded on its own is invisible at order level. */
  const doneOne = [{ orderId: 'ord_1', status: 'refunded', returnItems: [ORDER.items[0]] }];
  const v = returnEligibility(ORDER, doneOne);
  ok('an item already returned is not offered again',
    v.ok === true && v.availableItems.length === 1 && v.availableItems[0].size === 'M');

  const bothDone = [{ orderId: 'ord_1', status: 'refunded', returnItems: ORDER.items }];
  ok('…and when none are left, the order is refused',
    returnEligibility(ORDER, bothDone).ok === false);
  ok('…saying so', returnEligibility(ORDER, bothDone).reason === 'returnItemsSpent');

  ok('size and colour are part of what makes an item',
    itemKey({ name: 'Aero Pro', size: 'S', color: 'Yellow' })
      !== itemKey({ name: 'Aero Pro', size: 'M', color: 'Yellow' }));
  ok('…and casing is not', itemKey({ name: 'AERO PRO', size: 's' }) === itemKey({ name: 'aero pro', size: 'S' }));
}

console.log('\n  and it is wired to the things that decide');
{
  const hub = fs.readFileSync(ROOT + 'functions/api/customer-hub.js', 'utf8');
  const ref = fs.readFileSync(ROOT + 'functions/api/admin-refund.js', 'utf8');
  const rec = fs.readFileSync(ROOT + 'admin-receipts.js', 'utf8');
  const acct = fs.readFileSync(ROOT + 'account.html', 'utf8');
  const hubjs = fs.readFileSync(ROOT + 'customer-hub.js', 'utf8');

  /* Ownership was the only check. That is how the second request got in. */
  ok('the endpoint refuses an ineligible return', /returnEligibility\(matchedOrder, myRequests, say\)/.test(hub));
  ok('…and the pages read the same answer rather than their own',
    /returnable: eligible\.ok/.test(hub) && /o\.returnable !== false/.test(hubjs)
      && /o\.returnable === false/.test(acct));

  /* Orders predating the flag must not vanish from the picker — hiding on a
     missing field would strip returns entirely. The endpoint still refuses. */
  ok('an order with no flag is still offered', /returnable !== false/.test(hubjs),
    'hiding on a missing field would silently remove the ability to return anything');

  // ── the admin side, where the money actually moves ─────────────────────────
  /* A full refund sets status and the old guard caught it. A PARTIAL one
     deliberately does not, so nothing counted what had already gone back. */
  ok('what was already refunded is read before refunding again', /refundedSoFar\(/.test(ref));
  ok('…from Stripe, not from a second ledger here',
    /stripe\.refunds\.list\(/.test(ref) && /paymentIntents\.retrieve/.test(ref));
  ok('…and a failed read is not mistaken for "nothing refunded yet"',
    /known: true/.test(ref) && /if \(already\.known\)/.test(ref),
    'a bare 0 would read as no refunds and permit the one this exists to stop');
  ok('refunding past what is left is refused', /is left to refund on this order/.test(ref));
  ok('…before Stripe is called', ref.indexOf('if (already.known)') < ref.indexOf('stripe.refunds.create'));

  /* `refunded` used to be in the allowed set, so a return already paid out
     read as clearance to pay it out again. */
  ok('a return already refunded blocks another refund',
    /a return on this order is already refunded/.test(ref)
      && !/'item_received', 'completed', 'refunded', 'closed'/.test(ref));

  /* An order can carry more than one request — the bug that started this
     produced exactly that — and .find() picked whichever came first. */
  ok('every request on the order is checked, not the first one found',
    /requests\.filter\(r => String\(r\.orderId/.test(ref));

  ok('the panel warns before the button, not after', /id="refmod-already"/.test(rec)
    && /action: 'check'/.test(rec));
  ok('…and a check that cannot run says nothing rather than all-clear',
    /!d\.known/.test(rec));
}

console.log('\n  you cannot return what you did not buy');
{
  /* The request body is whatever somebody POSTs. The only check used to be
     that the NAME appeared on the order — size, colour, quantity and price all
     came from the request and were stored as sent. */
  const ORD = { id: 'o1', status: 'paid', items: [
    { name: 'Aero Pro', size: 'S', color: 'Yellow', quantity: 2, price: 40 },
    { name: 'Track Tee', size: 'M', color: 'Black' },
  ] };
  const R = (req, spoken) => reconcileReturnItems(ORD, req, spoken || new Map());

  ok('a size that was never bought is refused',
    R([{ name: 'Aero Pro', size: 'XXL', color: 'Yellow' }]).items.length === 0);
  ok('a colour that was never bought is refused',
    R([{ name: 'Aero Pro', size: 'S', color: 'Black' }]).items.length === 0);
  ok('…and an item from no order at all',
    R([{ name: 'Something Else', size: 'S' }]).items.length === 0);
  ok('…each said back rather than silently dropped',
    R([{ name: 'Aero Pro', size: 'XXL' }]).rejected[0].why === 'not on this order');

  ok('what WAS bought goes through', R([{ name: 'Aero Pro', size: 'S', color: 'Yellow' }]).items.length === 1);

  /* Two of a line is two, not unlimited and not one. */
  ok('you cannot return more of an item than you bought',
    R([{ name: 'Aero Pro', size: 'S', color: 'Yellow', quantity: 9 }]).items[0].quantity === 2);
  ok('…and asking repeatedly does not get you more',
    R([{ name: 'Aero Pro', size: 'S', color: 'Yellow', quantity: 2 },
       { name: 'Aero Pro', size: 'S', color: 'Yellow', quantity: 2 }])
      .items.reduce((n, i) => n + i.quantity, 0) === 2);
  ok('…nor does a line with no quantity mean unlimited',
    R([{ name: 'Track Tee', size: 'M', color: 'Black', quantity: 5 }]).items[0].quantity === 1);
  ok('a missing quantity is one, not zero', lineQty({}) === 1 && lineQty({ quantity: 3 }) === 3);
  ok('…and nonsense collapses to one',
    lineQty({ quantity: -4 }) === 1 && lineQty({ quantity: 'abc' }) === 1 && lineQty({ quantity: 2.7 }) === 2);

  /* Nothing a requester wrote reaches the admin queue, because the queue is
     what a refund gets read from. */
  const forged = R([{ name: 'Aero Pro', size: 'S', color: 'Yellow', price: 9999, sku: 'FAKE' }]).items[0];
  ok('the stored item is the order\'s, not the request\'s',
    forged.price === 40 && forged.sku === undefined);

  /* Already-returned quantity comes off the top. */
  const spoken = spokenForOn([{ orderId: 'o1', status: 'item_received',
    returnItems: [{ name: 'Aero Pro', size: 'S', color: 'Yellow', quantity: 1 }] }], 'o1');
  ok('one of a pair already returned leaves one',
    R([{ name: 'Aero Pro', size: 'S', color: 'Yellow', quantity: 2 }], spoken).items[0].quantity === 1);
  ok('…and both returned leaves none',
    R([{ name: 'Aero Pro', size: 'S', color: 'Yellow' }],
      spokenForOn([{ orderId: 'o1', status: 'refunded',
        returnItems: [{ name: 'Aero Pro', size: 'S', color: 'Yellow', quantity: 2 }] }], 'o1')).items.length === 0);

  /* The counted version fixed a real refusal too: a Set could not tell
     "bought two, returned one" from "bought two, returned both". */
  const half = returnEligibility(ORD, [{ orderId: 'o1', status: 'refunded',
    returnItems: [{ name: 'Aero Pro', size: 'S', color: 'Yellow', quantity: 1 }] }]);
  ok('returning one of two still leaves the other returnable',
    half.ok === true && half.availableItems.some(i => i.size === 'S' && i.quantity === 1));

  const hub = fs.readFileSync(ROOT + 'functions/api/customer-hub.js', 'utf8');
  ok('the endpoint reconciles instead of matching names',
    /reconcileReturnItems\(matchedOrder/.test(hub)
      && !/const allNames = new Set/.test(hub));
  /* The worst possible reading of "none of that was valid". */
  ok('all-invalid is refused, not turned into the whole order',
    /code: 'items_invalid'/.test(hub),
    'the old code fell back to every item on the order');
  ok('an over-ask is recorded for the admin to see', /rejectedItems/.test(hub));
}

console.log('\n  the returns workspace shows one step at a time');
{
  const ui = fs.readFileSync(ROOT + 'admin-returns-ui.js', 'utf8');

  /* Ten buttons at equal weight, all present in every state, so the only way
     to know which to press was to already know the process. */
  ok('there is a stage bar', /const STAGES = \[/.test(ui) && /stageOf = \(s\)/.test(ui));
  ok('one action is primary, chosen from the stage', /const primary = \(/.test(ui));
  ok('…and an exchange and a refund do not both offer themselves',
    /wantsExchange \? \{ label: 'Start the exchange'/.test(ui) || /at === 2 && wantsExchange/.test(ui));
  ok('the rest are folded away but still reachable', /Other actions ▾/.test(ui),
    'a process you cannot step back through is worse than a cluttered one');

  /* Three ad-hoc colours meant one hue said "safe" on one button and "email"
     on another. */
  ok('the hand-picked button colours are gone',
    !/background:rgba\(52,211,153,\.15\);border-color:rgba\(52,211,153,\.4\)/.test(ui)
      && !/background:rgba\(56,189,248,\.15\)/.test(ui));

  /* Nothing ever locked Resolution — the button that commits it is six fields
     further down, so changing it and seeing nothing happen read exactly like a
     disabled control. Misclick "Exchange Started" and the way back looked shut. */
  ok('status and resolution commit when picked',
    /id="ret-detail-status-\$\{id\}" class="form-select" onchange="saveReturnDetails/.test(ui)
      && /id="ret-detail-resolution-\$\{id\}" class="form-select" onchange="saveReturnDetails/.test(ui));
  ok('…and say so on the label', /saves as you pick/.test(ui));
  ok('…and the confirmation names what it saved', /Saved — /.test(ui),
    'these now fire without a button press, so "saved" alone says nothing about what moved');
}

console.log('\n  a refunded order does not offer a refund');
{
  const ui = fs.readFileSync(ROOT + 'admin-returns-ui.js', 'utf8');
  const rec = fs.readFileSync(ROOT + 'admin-receipts.js', 'utf8');

  /* The complaint: it walks you to the end — auth code and all — and only then
     says no, while the finished refund for the same order sits below it. */

  /* `refunded` was in the set of statuses that ALLOW a refund, so a request
     already paid out went on offering to pay out again. Same mistake the
     endpoint had. */
  ok('a request already refunded stops offering to refund',
    /new Set\(\['item_received', 'completed', 'closed'\]\)/.test(ui)
      && !/'item_received', 'completed', 'refunded', 'closed'/.test(ui));

  /* The order's own state, which the request does not carry: a return can sit
     at "item received" while the order was refunded from Receipts an hour ago. */
  ok('the panel reads the order status, not just the request status',
    /select\('id,status,order_number,stripe_payment_intent_id'\)/.test(ui) && /function retOrderSettled/.test(ui));
  ok('…and it gates the refund action', /REFUND_ALLOWED_STATUSES\.has\(r\.status \|\| ''\) && !retOrderSettled\(r\)/.test(ui));

  /* A failed lookup is not evidence that a refund happened. */
  ok('an unknown order status does not block', /empty means unknown, which does not/.test(ui));

  /* Disabling one button is not enough when the same function is reachable
     from two of them and from the console. */
  ok('the modal refuses to open on a settled order', /retOrderSettled\(req\)/.test(ui));
  ok('…including from Other actions', /disabled title="This order has already been refunded"/.test(ui));
  ok('…and it says which reason applies', /there is nothing left to refund/.test(ui));

  /* Receipts already did this. Named so nobody "fixes" it into a button. */
  ok('the receipts list already hid its button, and still does',
    /This order has been refunded\./.test(rec));
}

console.log('\n  an order has one name');
{
  const adm = fs.readFileSync(ROOT + 'admin-main.js', 'utf8');
  const req = fs.readFileSync(ROOT + 'functions/api/abac-request.js', 'utf8');

  /* Four names for the same order. Orders showed #0RT9CPIA; Receipts the last
     eight of the payment intent; the refund log, the approval queue and the
     customer's account page the last eight of the row id. Searching any of
     them anywhere else finds nothing — which is exactly what somebody does
     when asked to approve a refund they want to check first. */
  /* The formula itself moved to order-number.js and is covered by
     tests/order-number.test.js, including that the Worker's copy agrees with
     it. What matters here is that this file no longer keeps its own. */
  ok('there is one formatter, and it is not defined here',
    /window\.zwOrderNo = function/.test(adm) && /window\.ZWOrderNo\(row\)/.test(adm));

  /* Panels holding only an id have to look up what it is called, or they
     invent a fourth name. */
  ok('panels that hold only an id look the name up', /window\.zwLoadOrderNumbers = async function/.test(adm));
  ok('…the refund log does', /zwLoadOrderNumbers\(shown\.map/.test(adm));
  ok('…and the approval queue does', /zwLoadOrderNumbers\(rows\.map/.test(adm));

  /* A link landing on a page that calls it something else is the same problem
     one click along. */
  ok('the link goes where that name is the one on screen', /href="#orders"/.test(adm)
    && /document\.getElementById\('ord-search'\)/.test(adm));
  ok('…and searches by the name it displays', /zwOrderNo\(String\(id\)\) \|\| ''\)\.replace\(\/\^#\/, ''\)/.test(adm));

  /* Number(null) is 0 and finite, so an unknown amount printed as "$0.00" —
     a refund of nothing, which makes the request look like a mistake. */
  ok('an unknown amount is not rendered as zero',
    /if \(n === null \|\| n === undefined \|\| n === ''\) return ''/.test(adm));
  ok('…it says the full amount instead', /' the full amount'/.test(adm));

  // approving does the thing
  /* A yes somebody still has to act on is a yes that gets forgotten — they
     already filled the form in once. */
  ok('approving can carry the refund out', /admin-refund/.test(req) && /completed = \{ at, stripeRefundId/.test(req));
  ok('…as the approver, under their own code', /const refundKey = String\(body\.refundKey \|\| ''\)\.trim\(\)/.test(req));
  ok('…for the amount that was asked about, not whatever is on the order now',
    /Number\(target\.amount\)/.test(req));
  /* Recording "approved" over a refund that did not happen would tell them it
     was done AND leave a waiver behind for a second attempt. */
  ok('a failed refund is not recorded as an approval',
    /Not approved — \$\{completionError\} Nothing was changed\./.test(req));
  ok('…and a completed one leaves nothing to spend',
    /usedAt: completed \? completed\.at : undefined/.test(req));
  ok('the requester is told either way', /async function notifyRequester/.test(req));
  ok('…and the three outcomes read differently',
    /Done — \$\{what\} has been processed/.test(req) && /is yours to finish/.test(req)
      && /Not approved — \$\{what\}/.test(req));
  ok('…without a failed email un-deciding it', /could not notify requester/.test(req));
}

console.log('\n  no form when there is nothing to submit');
{
  const acct = fs.readFileSync(ROOT + 'account.html', 'utf8');
  const hub = fs.readFileSync(ROOT + 'customer-hub.js', 'utf8');

  /* The form listed every order ever placed, took a resolution and a reason,
     and refused on submit — "You already have a request open for this order"
     arriving after the work rather than before it. Twice over, on two screens. */
  ok('the account page only offers returnable orders',
    /const returnableOrders = orders\.filter\(o => o && o\.returnable !== false\)/.test(acct));
  ok('…and hides the whole form when there are none',
    /const canStart = returnableOrders\.length > 0/.test(acct) && /\$\{canStart \? `/.test(acct));
  ok('…saying why, rather than just vanishing',
    /Nothing to return right now/.test(acct),
    'a section that disappears with no explanation reads as a bug');
  ok('…while the history stays', /Request History/.test(acct));

  /* Same screen in the account modal. It filtered the picker but still drew
     the form — half the fix, which is how the first version of this shipped. */
  ok('the modal does the same', /const canStart = orders\.filter/.test(hub)
    && /\$\{canStart \? `/.test(hub));

  /* The disabled state was standing in for this and doing it badly: a greyed
     button under a filled-in form reads as "something is wrong with what I
     typed", not "there is nothing here to send". */
  ok('the button no longer fakes it with a disabled state',
    !/ret-submit[^>]*orders\.length \? '' : 'disabled'/.test(acct)
      && !/zw-return-submit[^>]*orders\.length \? '' : 'disabled'/.test(hub));
}


console.log('\n  a refund tells the return it happened');
{
  const ref = fs.readFileSync(ROOT + 'functions/api/admin-refund.js', 'utf8');

  /* Three places can refund an order and only the one doing it knew. A return
     sitting at "item received" stayed open after the money went back from
     Receipts — the workspace showed work outstanding that was already done,
     and the customer's account page showed a request under review after they
     had been refunded. */
  ok('a successful refund closes the return it settled',
    /Close the return this refund just settled/.test(ref)
      && /status: 'refunded', updatedAt: at/.test(ref));
  ok('…only the ones still open',
    /'requested', 'approved', 'label_sent', 'item_received', 'exchange_in_progress'/.test(ref));
  ok('…and only when Stripe actually returned a refund', /&& stripeRefundId\)/.test(ref));

  /* The money has already moved. Failing the request now would say the refund
     did not happen, and somebody would do it again. */
  ok('failing to close it never fails the refund',
    /could not close the linked return/.test(ref));
  ok('…and it says who did it and from where', /Refunded from the /.test(ref));

  /* The email was already unconditional on every refund. Asserted so it stays
     that way — it is the only thing the customer sees when a refund happens
     outside the returns flow. */
  ok('the customer is emailed on any refund, whichever panel issued it',
    /if \(\(action === 'cancel_refund' \|\| action === 'refund'\) && order\.email\)/.test(ref));

  /* A SEVENTH order-number formula, in the Worker — missed because the guard
     test listed six files by name and this was not one of them. */
  ok('the refund email uses the shared order number',
    /orderNumber:\s+orderNo\(order\)/.test(ref)
      && !/order\.order_number \|\| String\(orderId\)\.slice\(-8\)/.test(ref));
}


console.log('\n  a refunded return says so everywhere, and the stock comes back');
{
  const ui = fs.readFileSync(ROOT + 'admin-returns-ui.js', 'utf8');
  const ret = fs.readFileSync(ROOT + 'functions/api/admin-returns.js', 'utf8');

  /* admin-returns.js never writes to `orders`, so setting a return to
     `refunded` from the dropdown recorded one word and left the order saying
     `confirmed` forever. Making that dropdown save-on-change fixed a real
     complaint and, in the same stroke, made the disconnected route the easy
     one. `refunded` means money moved, and money only moves through
     admin-refund — which also updates the order, closes the request and emails
     the customer. */
  ok('the returns endpoint still does not touch orders',
    !/from\('orders'\)/.test(ret) && !/orders\?id=eq/.test(ret),
    'if this ever changes, the guard below can be reconsidered');
  ok('refunded cannot be picked by hand',
    /value !== 'refunded' \|\| current === 'refunded'/.test(ui));
  ok('…with a second guard on the save itself',
    /Use "Mark refunded" to issue the refund/.test(ui),
    'the save is reachable from a console and from the Save Details button');

  /* The item is back and paid for; the stock it came from is still down.
     Nothing linked those, so a returned item stayed unsellable until somebody
     remembered a button — the inverse of the sold-out problem. */
  ok('a refund offers the restock', /window\.openRestockModal\(requestId\)/.test(ui));

  /* Offered, not done: only the person holding the item knows whether it came
     back fit to sell. */
  ok('…with nothing ticked by default',
    !/id="rst-chk-\$\{i\}" checked/.test(ui) && /Tick what came back in sellable condition/.test(ui),
    'auto-opening a pre-ticked form puts damaged goods back on sale by default');
  ok('…and a select-all for when it all is', /id="rst-all"/.test(ui));
  ok('…keeping the per-item quantity that was already there',
    /id="rst-qty-\$\{i\}" type="number" min="1" max="\$\{qty\}"/.test(ui));
}


console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
