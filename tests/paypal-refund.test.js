/* Refunding a PayPal order, from the panel, without reaching for Stripe.
 *
 * order.stripe_payment_intent_id holds PayPal capture ids too — reusing that
 * column kept order dedupe working across both processors with no second code
 * path. The cost is that everything downstream which read the id as "a Stripe
 * payment" was wrong the moment PayPal existed, and the refund route was the
 * worst place for that to be true: a customer is owed money and the button
 * fails in Stripe's own words about a resource that does not exist.
 *
 * ── WHAT PAYPAL CAN AND CANNOT TELL US ──────────────────────────────────────
 *
 * The Stripe path answers two questions before moving anything: how much has
 * already gone back, and is this request inside what remains. It refuses
 * locally rather than letting the processor refuse, because a local refusal can
 * name what already happened.
 *
 * PayPal has no "list the refunds on this capture" call. GET on the capture
 * gives a STATUS — COMPLETED, PARTIALLY_REFUNDED, REFUNDED — so a full refund
 * is knowable exactly and a partial one is knowable only as "some, amount
 * unspecified".
 *
 * That gap is the whole subject of this file. The temptation is to report the
 * unknown case as 0, and 0 is the one answer that must never be given: it reads
 * as "nothing refunded yet" and permits exactly the double refund the check
 * exists to prevent. Unknown has to stay unknown, and PayPal's own ceiling is
 * the backstop.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const REFUND = fs.readFileSync(path.join(ROOT, 'functions/api/admin-refund.js'), 'utf8');

const ENV = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' };

/* A fake PayPal. Records what was sent, so the assertions are about the request
   that would really have gone out. */
function net(routes) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const m = (init && init.method) || 'GET';
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_) {}
    calls.push({ method: m, url: u, body, headers: (init && init.headers) || {} });

    /* Both json() and text(). paypalToken reads json(), paypalFetch reads
       text() and parses — a response object with only one of them makes every
       call fail, and two of these assertions passed for that reason before the
       harness was fixed. A test that passes because the code errored is worse
       than one that fails. */
    const respond = (status, payload) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    });

    if (u.indexOf('/v1/oauth2/token') !== -1) {
      return respond(200, { access_token: 't', expires_in: 3600 });
    }
    const r = routes.find((x) => u.indexOf(x.u) !== -1 && (!x.m || x.m === m));
    return respond(r ? (r.status || 200) : 404, r ? r.body : { error: 'unrouted ' + m + ' ' + u });
  };
  return calls;
}

(async () => {
  const PP = await import(pathToFileURL(ROOT + '/functions/api/_paypal.js').href);
  const realFetch = globalThis.fetch;

  console.log('\n  refunding a PayPal order\n');

  console.log('  what PayPal says about the capture');
  {
    net([{ u: '/v2/payments/captures/CAP1', body: { status: 'COMPLETED', amount: { value: '70.00' } } }]);
    const s = await PP.paypalCaptureState(ENV, 'CAP1');
    ok('a completed capture is known', s.known === true && s.fullyRefunded === false);
    ok('…with the amount it took', s.chargedCents === 7000);

    net([{ u: '/v2/payments/captures/CAP2', body: { status: 'REFUNDED', amount: { value: '70.00' } } }]);
    const done = await PP.paypalCaptureState(ENV, 'CAP2');
    ok('a fully refunded capture says so', done.fullyRefunded === true && done.known === true);

    /* THE HONEST GAP. PayPal will not say how much of a partial refund went
       back, so this must not become a number. */
    net([{ u: '/v2/payments/captures/CAP3', body: { status: 'PARTIALLY_REFUNDED', amount: { value: '70.00' } } }]);
    const part = await PP.paypalCaptureState(ENV, 'CAP3');
    ok('a partial refund is flagged', part.partiallyRefunded === true);
    ok('…and NOT reported as known', part.known === false,
      'known:true here would let a caller treat an unspecified amount as zero');
    ok('…and not as fully refunded either', part.fullyRefunded === false);

    net([{ u: '/v2/payments/captures/GONE', status: 404, body: { message: 'not found' } }]);
    const missing = await PP.paypalCaptureState(ENV, 'GONE');
    ok('an unreadable capture is unknown, not zero-refunded',
      missing.known === false && missing.fullyRefunded === false,
      'a confident zero reads as "nothing refunded yet" and permits a double refund');
  }

  console.log('\n  issuing the refund');
  {
    const calls = net([{ m: 'POST', u: '/refund', body: { id: 'REF1', status: 'COMPLETED', amount: { value: '70.00' } } }]);
    const out = await PP.refundPayPalCapture(ENV, { captureId: 'CAP1', amountCents: 0, note: 'damaged', requestId: 'zwr_abc' });
    ok('it succeeds', out.ok === true && out.id === 'REF1');
    ok('…reporting what actually went back', out.amountCents === 7000);

    const post = calls.filter((c) => c.method === 'POST' && c.url.indexOf('/refund') !== -1)[0];
    ok('it posts to the capture being refunded', post && post.url.indexOf('/v2/payments/captures/CAP1/refund') !== -1);
    /* No amount means the lot — PayPal's own convention, and it avoids a
       rounding disagreement on a full refund. */
    ok('a full refund sends no amount at all', post && !post.body.amount,
      'sending our own total invites a cent of disagreement on the one refund that must be exact');
    ok('the reason travels with it', post && post.body.note_to_payer === 'damaged');
    /* A refund issued twice is money leaving twice, and the obvious trigger is
       an admin clicking again because the first click looked like it did
       nothing. */
    ok('…under an idempotency key', post && post.headers['PayPal-Request-Id'] === 'zwr_abc');
  }

  console.log('\n  a partial refund');
  {
    const calls = net([{ m: 'POST', u: '/refund', body: { id: 'REF2', status: 'COMPLETED', amount: { value: '25.50' } } }]);
    const out = await PP.refundPayPalCapture(ENV, { captureId: 'CAP1', amountCents: 2550 });
    ok('the amount is sent', out.ok === true);
    const post = calls.filter((c) => c.method === 'POST')[0];
    ok('…as a decimal string, not cents', post && post.body.amount.value === '25.50',
      'PayPal wants decimals; sending 2550 would refund twenty-five hundred dollars');
    ok('…in the right currency', post && post.body.amount.currency_code === 'USD');
  }

  console.log('\n  when PayPal refuses');
  {
    net([{ m: 'POST', u: '/refund', status: 422, body: { details: [{ issue: 'CAPTURE_FULLY_REFUNDED', description: 'already refunded' }] } }]);
    const done = await PP.refundPayPalCapture(ENV, { captureId: 'CAP1' });
    ok('an already-refunded capture is reported as that', done.ok === false && done.alreadyRefunded === true);
    ok('…in words an admin can act on', /already been fully refunded/.test(done.error));

    net([{ m: 'POST', u: '/refund', status: 422, body: { details: [{ issue: 'REFUND_AMOUNT_EXCEEDED', description: 'too much' }] } }]);
    const over = await PP.refundPayPalCapture(ENV, { captureId: 'CAP1', amountCents: 999999 });
    ok('refunding past what is left is refused', over.ok === false);
    ok('…and said plainly', /more than is left to refund/.test(over.error));

    /* Anything unmapped must still surface rather than becoming a generic
       failure — hiding the reason is how a support case takes a day. */
    net([{ m: 'POST', u: '/refund', status: 500, body: { message: 'PayPal is having a moment' } }]);
    const odd = await PP.refundPayPalCapture(ENV, { captureId: 'CAP1' });
    ok('an unmapped failure passes the reason through', /PayPal is having a moment/.test(odd.error));

    const bad = await PP.refundPayPalCapture({}, { captureId: 'CAP1' });
    ok('unconfigured PayPal refuses before calling anything', bad.ok === false && /not configured/.test(bad.error));
  }

  globalThis.fetch = realFetch;

  console.log('\n  reconciling what PayPal knows with what this panel recorded');
  {
    /* RUN, not read. This was written inline in the request handler first, and
       the regex assertions on that source passed with the credibility check
       deleted AND with the outside-this-panel branch replaced by `if (false)` —
       two mutations that both move real money, neither of which turned anything
       red. It is a pure function now for exactly that reason. */
    const R = PP.reconcilePayPalRefunds;
    const capture = (status, cents) => ({
      status,
      chargedCents: cents,
      fullyRefunded: status === 'REFUNDED',
      partiallyRefunded: status === 'PARTIALLY_REFUNDED',
      known: status !== 'PARTIALLY_REFUNDED',
    });

    const clean = R(capture('COMPLETED', 7000), 0, 0);
    ok('nothing refunded, and both sources agree', clean.known === true && clean.refundedCents === 0,
      'only when BOTH say nothing has gone back is "nothing" a fact rather than an assumption');

    const full = R(capture('REFUNDED', 7000), 0, 0);
    ok('a fully refunded capture is exact from the processor',
      full.known === true && full.refundedCents === 7000,
      'even with no local record — PayPal holds the money and it says so');

    const partial = R(capture('PARTIALLY_REFUNDED', 7000), 2500, 1);
    ok('a partial refund we issued is known exactly', partial.known === true && partial.refundedCents === 2500,
      'PayPal confirms some went back; our ledger says how much');
    ok('…leaving the right amount refundable', partial.chargedCents - partial.refundedCents === 4500);

    /* THE CASE THIS EXISTS FOR. */
    const elsewhere = R(capture('PARTIALLY_REFUNDED', 7000), 0, 0);
    ok('a refund issued in PayPal’s dashboard is detected',
      elsewhere.refundedOutsideThisPanel === true,
      'PayPal says partly refunded and this panel has no record of it');
    ok('…and is NOT reported as zero refunded', elsewhere.known === false,
      'a zero here reads as "nothing refunded yet" and permits a second refund on top');

    /* The ledger is our record of an intent; PayPal's is the record of the
       money. Where they conflict, the ledger is the side that is wrong. */
    const lying = R(capture('COMPLETED', 7000), 5000, 1);
    ok('a ledger claiming a refund PayPal has not seen is discarded',
      lying.refundedCents === 0,
      'the processor holds the money — a refund it has not heard of is not a refund');
    const toobig = R(capture('PARTIALLY_REFUNDED', 7000), 9000, 2);
    ok('…as is one claiming more than was ever captured', toobig.refundedCents === 0);
    /* Neither is passed off as known, and the COMPLETED case is the one worth
       being deliberate about. It is tempting to say "PayPal is authoritative,
       so nothing has been refunded" — but the two sources DISAGREE, and a
       refund's status can lag its money. If the ledger is the accurate side,
       calling this knowably-zero permits a second refund on top of a first.
       Unknown is the answer that cannot cost anything. */
    ok('…and neither is passed off as known', lying.known === false && toobig.known === false,
      'a disagreement is not a fact, whichever side looks more authoritative');

    /* Junk in must not become a confident number out. */
    ok('a missing capture state is unknown, not zero-refunded',
      R(null, 0, 0).known === false);
    ok('negative or absurd ledger values are floored',
      R(capture('PARTIALLY_REFUNDED', 7000), -500, -2).refundedCents === 0);
  }

  console.log('\n  the route sends it to the right processor');
  {
    const code = REFUND.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

    ok('PayPal orders take the PayPal path', /isPayPal && \(action === 'refund'/.test(code));
    ok('…and Stripe orders no longer take it unconditionally', /!isPayPal && \(action === 'refund'/.test(code),
      'the Stripe block used to run for every order regardless of who took the money');

    /* Asking Stripe about a PayPal id is not merely useless: the lookup throws,
       the catch leaves `already` zeroed, and zero reads as "nothing refunded
       yet" — permitting the second refund. */
    ok('Stripe is not asked about a PayPal payment', /stripe_payment_intent_id && !isPayPal/.test(code),
      'the failed lookup would leave a zero that reads as "nothing refunded yet"');

    ok('the stored id is unprefixed before PayPal sees it', /replace\(\/\^paypal_\/, ''\)/.test(code),
      'the prefix exists so the id is never mistaken for a Stripe one; PayPal wants it bare');

    ok('check reports which processor it asked', /check: true, orderId, processor/.test(code));
    ok('an already-refunded order is blocked before PayPal is called',
      /blocked: already fully refunded/.test(code));

    ok('the local refund ledger is consulted', /AUDIT_LOG_KEY/.test(code) && /ledgerCents/.test(code));
    ok('…only for successful refunds on this order',
      /e\.success === true/.test(code) && /String\(e\.orderId \|\| ''\) === String\(orderId\)/.test(code));
    ok('…and refused rather than guessed at when it disagrees',
      /blocked: refunded outside this panel, amount unknown/.test(code));
    ok('…with an instruction rather than a shrug', /issue the remainder there/.test(code));
    ok('failures are written to the audit log', /note: 'paypal: ' \+ out\.error/.test(code));
    ok('cancel still needs no processor at all', /action !== 'cancel'/.test(code),
      'cancelling an unpaid order moves no money');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
