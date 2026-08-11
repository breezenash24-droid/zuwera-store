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
const { returnEligibility, isLiveRequest, itemKey } = new Function(
  RSRC.replace(/^export\s+/gm, '') + '\n;return { returnEligibility, isLiveRequest, itemKey };')();

const ORDER = { id: 'ord_1', status: 'paid', items: [
  { name: 'Aero Pro', size: 'S', color: 'Yellow' },
  { name: 'Aero Pro', size: 'M', color: 'Cyan' },
] };

console.log('\n  an order with nothing left to give back');
{
  ok('a refunded order cannot be returned',
    returnEligibility({ ...ORDER, status: 'refunded' }, []).ok === false);
  ok('…and says why, in words a customer can act on',
    /nothing left to return/.test(returnEligibility({ ...ORDER, status: 'refunded' }, []).reason));
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
    /already have a request open/.test(returnEligibility(ORDER, open).reason));

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
  ok('…saying so', /already been returned or refunded/.test(returnEligibility(ORDER, bothDone).reason));

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
  ok('the endpoint refuses an ineligible return', /returnEligibility\(matchedOrder, myRequests\)/.test(hub));
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

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
