/* One order's returns deadline, set by hand.
 *
 * The store-wide window shipped as steps 1–3: a setting, a message, and a rule
 * that counts from delivery. What it had no answer for is the case support
 * actually meets — "it arrived damaged and I was away for a month" — and a rule
 * with no exception is a rule that gets switched off the first time it is
 * inconvenient. Switching it off is worse than never having had it: the store
 * goes back to accepting a return on a three-year-old order, and now believes
 * it has a policy.
 *
 * ── WHY A DATE AND NOT A NUMBER OF DAYS ─────────────────────────────────────
 *
 * "Another 14 days" has to be counted from something, and every dated bug in
 * this area has come from two pieces of code disagreeing about which something —
 * the original rule counted from payment while the emails promised 30 days from
 * delivery, which silently shortened the window for every order that spent a
 * week in transit. A date has one meaning, it is what the customer can be told,
 * and it does not change when the store-wide window is later edited.
 *
 * It REPLACES the computed deadline rather than extending it, so the same field
 * shortens a window as well as lengthening one. A final-sale item needs that and
 * would otherwise have been a second mechanism with its own disagreements.
 *
 * ── WHAT MUST NOT REGRESS ───────────────────────────────────────────────────
 *
 * The window check fails OPEN throughout: no usable dates, an unparseable
 * override, a window configured to nonsense — allow the return. A wrongly
 * refused return is a support email and a customer who does not come back; a
 * wrongly allowed one costs a single item. Those are not the same mistake and
 * this file exists partly to stop them becoming equally likely.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const ADMIN = fs.readFileSync(path.join(ROOT, 'functions/api/admin-returns.js'), 'utf8');
const HUB   = fs.readFileSync(path.join(ROOT, 'functions/api/customer-hub.js'), 'utf8');
const GUEST = fs.readFileSync(path.join(ROOT, 'functions/api/guest-return.js'), 'utf8');

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const ahead = (d) => new Date(Date.now() + d * DAY).toISOString();

(async () => {
  const R = await import(pathToFileURL(path.join(ROOT, 'functions/api/_returns.js')).href);
  const { returnWindowFrom, overrideFrom, returnClosesAt, returnEligibility } = R;

  console.log('\n  one order can be given its own deadline\n');

  console.log('  reading the override');
  {
    ok('an ISO date is read', overrideFrom({ 'o-1': { returnsOpenUntil: ahead(5) } }, 'o-1') !== null);
    ok('a different order is unaffected', overrideFrom({ 'o-1': { returnsOpenUntil: ahead(5) } }, 'o-2') === null);
    ok('no ops blob is null', overrideFrom(null, 'o-1') === null && overrideFrom({}, 'o-1') === null);
    ok('an empty order id is null', overrideFrom({ 'o-1': { returnsOpenUntil: ahead(5) } }, '') === null);
    /* Fails open: a typo must not become a refusal nobody can explain. */
    ok('an unreadable date is treated as absent, not as expired',
      overrideFrom({ 'o-1': { returnsOpenUntil: 'next tuesday-ish' } }, 'o-1') === null);
    ok('an order with other ops but no override is null',
      overrideFrom({ 'o-1': { timeline: [{ type: 'note' }] } }, 'o-1') === null);
  }

  console.log('\n  the deadline has ONE answer');
  {
    const cfg = { returns: { windowDays: 30, transitAllowanceDays: 7 } };
    const opts = returnWindowFrom(cfg, {}, 'o-1');
    ok('the store window comes through', opts.windowDays === 30 && opts.transitDays === 7);

    const delivered = returnClosesAt({ delivered_at: ago(10), created_at: ago(20) }, opts);
    ok('a delivered order counts from delivery', delivered.source === 'delivered');
    ok('…30 days from it', Math.round((delivered.closesAt - Date.parse(ago(10))) / DAY) === 30);

    /* Orders before migration 0015 have no delivered_at and never will. */
    const placed = returnClosesAt({ created_at: ago(10) }, opts);
    ok('an undelivered order counts from placement plus transit', placed.source === 'placed');
    ok('…which is later than counting from payment',
      placed.closesAt > Date.parse(ago(10)) + 30 * DAY,
      'the transit allowance is the difference between promising 30 days and giving 23');

    const none = returnClosesAt({}, opts);
    ok('no usable date means no deadline at all', none.closesAt === null && none.source === 'none');
    const off = returnClosesAt({ created_at: ago(400) }, returnWindowFrom({}, {}, 'o-1'));
    ok('an unset store window means no deadline', off.closesAt === null,
      'defaulting to off is deliberate — 61 orders predate this and a retroactive rule refuses all of them');
  }

  console.log('\n  the override replaces the calculation');
  {
    const ops = { 'o-1': { returnsOpenUntil: ahead(14) } };
    const opts = returnWindowFrom({ returns: { windowDays: 30, transitAllowanceDays: 7 } }, ops, 'o-1');

    /* An order well outside the store window, extended by hand. */
    const late = returnClosesAt({ delivered_at: ago(200) }, opts);
    ok('an expired order becomes open again', late.source === 'override' && late.closesAt > Date.now());

    /* And the other direction, which is the point of storing a date rather than
       a number of extra days. */
    const short = returnWindowFrom({ returns: { windowDays: 30 } }, { 'o-1': { returnsOpenUntil: ago(1) } }, 'o-1');
    const closed = returnClosesAt({ delivered_at: ago(2) }, short);
    ok('…and a fresh order can be closed early', closed.source === 'override' && closed.closesAt < Date.now(),
      'final sale needs no second mechanism');

    /* An override on an order with no dates at all still applies: the admin has
       answered the question the missing dates could not. */
    const dateless = returnClosesAt({}, opts);
    ok('it applies even when the order has no dates', dateless.source === 'override');
  }

  console.log('\n  and the rule actually consults it');
  {
    const order = { id: 'o-1', status: 'confirmed', delivered_at: ago(200), created_at: ago(210),
                    items: JSON.stringify([{ name: 'Jacket', size: 'M', quantity: 1 }]) };
    const cfg = { returns: { windowDays: 30, transitAllowanceDays: 7 } };

    const refused = returnEligibility(order, [], undefined, returnWindowFrom(cfg, {}, 'o-1'));
    ok('without an override a 200-day-old order is refused', refused.ok === false && refused.code === 'window_closed');
    ok('…and says why in words a shopper can act on', /\d+ days/.test(refused.reason || ''));
    ok('…naming the store rule', refused.windowSource === 'delivered');

    const allowed = returnEligibility(order, [],
      undefined, returnWindowFrom(cfg, { 'o-1': { returnsOpenUntil: ahead(14) } }, 'o-1'));
    ok('WITH an override the same order is allowed', allowed.ok === true,
      'this is the whole feature — support can say yes without switching the rule off');

    /* An extension that has itself run out must be explained by ITS date.
       Quoting the store rule to somebody who was granted until the 14th is a
       sentence they can disprove, and it makes the exception look like a bug. */
    const expired = returnEligibility(order, [],
      undefined, returnWindowFrom(cfg, { 'o-1': { returnsOpenUntil: ago(3) } }, 'o-1'));
    ok('an expired extension refuses', expired.ok === false && expired.windowSource === 'override');
    ok('…quoting its own date, not the store policy',
      /open until \d{4}-\d{2}-\d{2}/.test(expired.reason || '') && !/30 days/.test(expired.reason || ''),
      'got: ' + expired.reason);
  }

  console.log('\n  it fails open, as the rest of the window check does');
  {
    const order = { id: 'o-1', status: 'confirmed', delivered_at: ago(200),
                    items: JSON.stringify([{ name: 'Jacket', size: 'M', quantity: 1 }]) };
    const cfg = { returns: { windowDays: 30 } };
    const junk = returnEligibility(order, [],
      undefined, returnWindowFrom(cfg, { 'o-1': { returnsOpenUntil: 'whenever' } }, 'o-1'));
    /* Unreadable override → falls back to the store rule rather than refusing
       outright or allowing everything. */
    ok('an unreadable override falls back to the store rule',
      junk.ok === false && junk.windowSource === 'delivered');
  }

  console.log('\n  the admin route');
  {
    ok('there is an action for it', /action === 'set_return_window'/.test(ADMIN));
    ok('…behind the same permission as the rest of returns', /requireAdmin\(request, env, 'return_process'\)/.test(ADMIN));
    ok('…refusing a request with no order', /Missing order id/.test(ADMIN));
    ok('…refusing a date it cannot read', /not a date we can read/.test(ADMIN));
    /* Silently clamping would store a number the admin did not type. */
    ok('…and refusing an absurd one rather than clamping it', /more than ten years away/.test(ADMIN));
    ok('an empty value clears the override', /const clearing = raw === ''/.test(ADMIN));

    /* A bare YYYY-MM-DD parsed as UTC midnight ends the window at 8pm the
       previous evening in Ohio. */
    ok('a bare date means the END of that day', /T23:59:59\.999Z/.test(ADMIN),
      'UTC midnight would close the window the evening before the date shown');

    /* Read-modify-write on a shared blob. setSetting loses whatever another
       admin saved in between — the documented hazard in this codebase. */
    ok('it writes with mutateSetting, not setSetting',
      /mutateSetting\(env, 'commerce_order_ops'/.test(ADMIN),
      'a plain write on a shared blob drops a concurrent edit');
    ok('…and records who and why on the timeline',
      /type: 'return_window'/.test(ADMIN) && /returnsWindowSetBy/.test(ADMIN),
      '"why is this order still returnable" is asked months later by someone else');
  }

  console.log('\n  every path that judges a return passes it through');
  {
    /* The feature is invisible if one caller keeps asking the old question.
       Three call sites: the signed-in list, the signed-in submit, and guest. */
    const calls = (src) => (src.match(/returnWindowFrom\([^)]*\)/g) || []);
    for (const [name, src] of [['customer-hub.js', HUB], ['guest-return.js', GUEST]]) {
      const all = calls(src);
      ok(name + ' passes the order ops to every window lookup',
        all.length > 0 && all.every((c) => /orderOps/.test(c)),
        'found: ' + all.join(' | '));
    }
    ok('customer-hub has both of its call sites covered', calls(HUB).length === 2,
      'the list and the submit are separate paths and only one being fixed is the usual bug');
  }

  console.log('\n  and an admin can actually reach it');
  {
    /* "Built but unreachable" is a repeat failure in this codebase — the PayPal
       endpoints, the return-window rule itself, the tax health check. A server
       action nothing calls is not a feature. */
    const UI = fs.readFileSync(path.join(ROOT, 'admin-orders.js'), 'utf8');
    ok('the orders page has a control', /ordersSetReturnWindow/.test(UI));
    ok('…that posts the action this route understands', /action: 'set_return_window'/.test(UI));
    ok('…on the ORDER, not on a return request', /ord-retwin-/.test(UI),
      'a shopper outside the window cannot create a request, so the Returns page has nothing to hang it on');
    ok('…and it is wired into the detail panel',
      /returnsLine\(o\.id\)/.test(UI) && /onclick="ordersSetReturnWindow/.test(UI));
    ok('clearing is the same field, not a second button',
      /Clear the date to go back to it/.test(UI));

    /* The one thing the browser must NOT do is work the deadline out again. */
    ok('the panel does not recompute the deadline itself',
      !/86400000/.test(UI) && !/windowDays\s*\*/.test(UI),
      'a second implementation of this date is how the delivered-vs-placed confusion happened');
    ok('…it re-reads from the server after saving', /await loadReturnsState\(\)/.test(UI),
      'a bare date is stored as the END of that day — echoing the typed value would show a different one');

    /* A settings read failing must not take the orders table with it. */
    ok('a failed settings read is non-fatal',
      /catch \(_\) \{ _orderOps = \{\}; _returnsCfg = \{\}; \}/.test(UI));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
