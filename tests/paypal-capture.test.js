/* The half that moves money.
 *
 * paypal-create-order builds an order the buyer can approve. This takes the
 * funds. They are separate files so the one that can charge somebody is read on
 * its own, and this suite exists for the same reason.
 *
 * WHAT IS TRUSTED. Not the browser. It sends the cart again and the cart is
 * re-priced from the catalog, exactly as at create time. Two numbers then have
 * to agree before anything is captured: what the store now says the order
 * costs, and what PayPal holds an approval for. A disagreement means something
 * moved between approval and capture — a price edit, a promo expiring, a rate
 * changing — and the answer is to refuse BEFORE taking the money. Capturing
 * first and reconciling after means a customer has paid an amount nobody
 * intended and the fix is a refund they never asked for.
 *
 * That gate is the whole safety of this endpoint, and the first version of this
 * suite only checked that the comparison EXISTED — which passes just as happily
 * when it has been disabled. It is a function now, and it gets run.
 *
 * DOING IT ONCE. Two guards, because they fail differently: PayPal-Request-Id
 * makes a retried capture the same request rather than a second one, and a
 * primary-key claim in processed_events means two racing requests cannot both
 * fulfil. And a release, because a DECLINED capture must give the claim back —
 * otherwise the buyer's second attempt with a working card is waved through as
 * a duplicate: paid for, never fulfilled.
 *
 * ONE METADATA SHAPE. Fulfilment reads a flat map of forty-odd fields that used
 * to be built inline in create-payment-intent. Copying it for PayPal would mean
 * two lists that agree today, and a field added to one and not the other is an
 * order that fulfils with a piece missing — found late, by a customer, on
 * whichever route is used less.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const CAP = fs.readFileSync(path.join(ROOT, 'functions/api/paypal-capture.js'), 'utf8');
const CPI = fs.readFileSync(path.join(ROOT, 'functions/api/create-payment-intent.js'), 'utf8');
const PRICING = fs.readFileSync(path.join(ROOT, 'functions/api/_cart-pricing.js'), 'utf8');

(async () => {
  const C = await import(pathToFileURL(ROOT + '/functions/api/paypal-capture.js').href);
  const P = await import(pathToFileURL(ROOT + '/functions/api/_cart-pricing.js').href);

  console.log('\n  capturing a PayPal payment\n');

  console.log('  money is read in cents, never floated');
  {
    /* Parsing to a float and multiplying is how a one-cent discrepancy appears
       out of nowhere and blocks a legitimate capture. */
    ok('a whole amount', C.amountToCents('120') === 12000);
    ok('two decimals', C.amountToCents('120.45') === 12045);
    ok('one decimal is tenths, not hundredths', C.amountToCents('120.4') === 12040);
    ok('zero', C.amountToCents('0.00') === 0);
    ok('a value that would round badly as a float', C.amountToCents('117.30') === 11730);
    ok('a negative', C.amountToCents('-4.05') === -405);
    for (const bad of ['', null, undefined, 'abc', '1.234', '1,20']) {
      ok('rejects ' + JSON.stringify(bad), Number.isNaN(C.amountToCents(bad)));
    }
  }

  console.log('\n  nothing is captured until the numbers agree');
  {
    const agree = C.captureDecision({ orderNumber: 'ZW-1', approvedCents: 4723, quotedCents: 4723 });
    ok('matching totals capture', agree.action === 'capture');

    const moved = C.captureDecision({ orderNumber: 'ZW-1', approvedCents: 4723, quotedCents: 4900 });
    ok('a price that moved refuses', moved.action === 'refuse' && moved.reason === 'amount-changed');
    ok('…as a 409, not a 500', moved.status === 409);
    ok('one cent more is still a refusal',
      C.captureDecision({ orderNumber: 'ZW-1', approvedCents: 4723, quotedCents: 4724 }).action === 'refuse');
    ok('…and one cent less, too',
      C.captureDecision({ orderNumber: 'ZW-1', approvedCents: 4723, quotedCents: 4722 }).action === 'refuse',
      'cheaper is still not the amount they approved');

    ok('an unreadable approved amount refuses',
      C.captureDecision({ orderNumber: 'ZW-1', approvedCents: NaN, quotedCents: 4723 }).reason === 'no-reference');
    ok('…and so does a missing order number',
      C.captureDecision({ orderNumber: '', approvedCents: 4723, quotedCents: 4723 }).reason === 'no-reference');

    ok('an order PayPal already completed is not captured again',
      C.captureDecision({ orderNumber: 'ZW-1', approvedCents: 4723, quotedCents: 4723, paypalStatus: 'COMPLETED' }).action === 'already');
    ok('…and is reported as success, not an error',
      C.captureDecision({ orderNumber: 'ZW-1', approvedCents: 1, quotedCents: 1, paypalStatus: 'completed' }).status === 200,
      'telling them it failed invites them to pay twice');
    ok('an APPROVED order still captures',
      C.captureDecision({ orderNumber: 'ZW-1', approvedCents: 1, quotedCents: 1, paypalStatus: 'APPROVED' }).action === 'capture');
  }

  console.log('\n  …and the handler actually consults it');
  {
    ok('the decision is taken', /const decision = captureDecision\(\{/.test(CAP));
    ok('…before the capture call', CAP.indexOf('const decision = captureDecision') < CAP.indexOf("+ '/capture'"));
    ok('…and a refusal charges nothing', /decision\.action === 'refuse'/.test(CAP) && /Nothing has been charged/.test(CAP));
    /* The buyer's approved figure is authoritative; ours is what we will
       fulfil. Neither comes from the browser. */
    ok('the amount comes from PayPal, not the request body',
      /approvedCents = amountToCents\(unit\.amount\?\.value\)/.test(CAP));
    ok('the order number comes from the approval too',
      /orderNumber = String\(unit\.custom_id \|\| ''\)/.test(CAP),
      'minting a second one would split one order across two references');
    ok('the cart is re-priced from the catalog', /quoteCart\(\{/.test(CAP));
    ok('the order is read before anything is charged',
      CAP.indexOf("await paypalFetch(env, '/v2/checkout/orders/'") < CAP.indexOf("+ '/capture'"));
  }

  console.log('\n  it can only happen once');
  {
    ok('the capture call carries a request id', /requestId: 'zwc_'/.test(CAP));
    ok('…derived from the order id, so a retry is the same request',
      /sha256Base64Url\(paypalOrderId\)/.test(CAP));
    ok('the claim is a primary-key insert', /rest\/v1\/processed_events/.test(CAP) && /409\) return true/.test(CAP));
    ok('…keyed so it cannot collide with a Stripe event', /'paypal_' \+ paypalOrderId/.test(CAP));
    /* Against the CALL SITE, not the import at the top — which is what this
       compared against first, and it passed for the wrong reason. */
    ok('…and claimed before fulfilment runs',
      CAP.indexOf('if (await alreadyFulfilled(env, paypalOrderId))')
        < CAP.indexOf('await handleSuccessfulPayment(payment'));
    ok('a duplicate claim answers as success', /duplicate: true \}, 200/.test(CAP));

    /* The release, which is the half people forget. */
    ok('a failed capture gives the claim back', /await releaseClaim\(env, paypalOrderId\)/.test(CAP));
    ok('…before returning the error', CAP.indexOf('releaseClaim(env, paypalOrderId)') < CAP.indexOf('INSTRUMENT_DECLINED'));
    ok('…by deleting the row it inserted', /method: 'DELETE'/.test(CAP) && /event_id=eq\./.test(CAP));
  }

  console.log('\n  an unreachable dedupe table does not eat orders');
  {
    /* Treating "cannot establish" as "already done" would silently drop every
       order — far worse than the duplicate it guards against. */
    ok('a missing table proceeds', /PayPal dedupe unavailable[\s\S]{0,80}?return false;/.test(CAP));
    ok('…and so does a thrown request', /PayPal dedupe check failed[\s\S]{0,80}?return false;/.test(CAP));
  }

  console.log('\n  a decline is the buyer’s to act on');
  {
    ok('INSTRUMENT_DECLINED is separated out', /issue === 'INSTRUMENT_DECLINED'/.test(CAP));
    ok('…and told them plainly', /declined\. Please choose another/.test(CAP));
    ok('…as retryable', /retryable: true/.test(CAP));
    ok('…with a 402 rather than a 500', /\}, 402, headers\)/.test(CAP));
    ok('anything else keeps PayPal’s detail in the log, not on screen',
      /console\.error\('PayPal capture failed for'/.test(CAP));
  }

  console.log('\n  once money has moved, nothing may throw its way out');
  {
    /* An order that is paid for and not recorded is the worst state available. */
    ok('fulfilment is wrapped', /try \{[\s\S]{0,400}?handleSuccessfulPayment\(payment, meta, env, null\)[\s\S]{0,200}?catch \(e\)/.test(CAP));
    ok('…and a failure is logged with both references',
      /captured but fulfilment failed[\s\S]{0,60}?orderNumber, captureId/.test(CAP));
    ok('…while the buyer is still told it worked',
      CAP.indexOf("console.error('PayPal order captured") < CAP.indexOf('ok: true, orderNumber, captureId'));
  }

  console.log('\n  it hands fulfilment exactly what the card route does');
  {
    ok('create-payment-intent no longer builds the map inline',
      /metadata: buildOrderMetadata\(\{ orderNumber, address, quote, featureFlagsMeta \}\)/.test(CPI));
    ok('…and the capture builds it the same way',
      /buildOrderMetadata\(\{ orderNumber, address, quote/.test(CAP));
    ok('there is one builder', (PRICING.match(/export function buildOrderMetadata/g) || []).length === 1);

    /* Run it. Every field fulfilment reads has to be present and a string. */
    const quote = {
      attributedUser: { id: 'u1' },
      lineItems: [{ sku: 'ZW-1', name: 'Tee', amount: 3500, quantity: 1, size: 'M', color: 'Black' }],
      inventoryItems: [{ sku: 'ZW-1', quantity: 1 }],
      subtotalCents: 3500, discountCents: 0, normalizedPromoCode: '',
      shipping: { provider: 'USPS', servicelevel: 'Priority', rateObjectId: 'r1', source: 'shippo',
                  remoteShipmentId: '', actualShippingCents: 700, shippingCents: 950,
                  qualifiesFree: false, handDelivery: false },
      tax: { engine: 'stripe_tax', ref: 'txn_1' }, taxStateCode: 'OH', taxRate: 0.078,
      taxCents: 273, totalCents: 4723,
    };
    const meta = P.buildOrderMetadata({ orderNumber: 'ZW-TEST', address: { email: 'a@b.co', name: 'A' }, quote });
    for (const f of ['order_number', 'customer_email', 'items', 'inv', 'delivery_method',
                     'tax_state', 'tax_amount_cents', 'tax_engine', 'tax_ref',
                     'total_amount_cents', 'charged_shipping_cents', 'ship_country']) {
      ok('carries ' + f, meta[f] !== undefined && meta[f] !== null);
    }
    ok('every value is a string', Object.values(meta).every((v) => typeof v === 'string'),
      'fulfilment parses this as Stripe metadata, which is string-only');
    ok('the fallback engine stamp survives',
      P.buildOrderMetadata({ orderNumber: 'x', quote: { ...quote, tax: { engine: 'stripe_tax', fallbackFrom: 'stripe_tax' } } })
        .tax_engine === 'stripe_tax→builtin');
    ok('hand delivery is recorded as such',
      P.buildOrderMetadata({ orderNumber: 'x', quote: { ...quote, shipping: { ...quote.shipping, handDelivery: true } } })
        .delivery_method === 'hand_delivery');

    /* Line items are trimmed to Stripe's 500-char cap for BOTH routes, so a
       PayPal order cannot carry a longer list than a card one and fulfilment
       parses the same thing either way. */
    const big = { ...quote, lineItems: Array.from({ length: 40 }, (_, i) => ({
      sku: 'SKU-' + i, name: 'A rather long product name here ' + i, amount: 3500, quantity: 1, size: 'M', color: 'Black' })) };
    ok('a large cart is trimmed rather than truncated mid-JSON',
      JSON.parse(P.buildOrderMetadata({ orderNumber: 'x', quote: big }).items).length === 40);
  }

  console.log('\n  the marker that says which way it was paid');
  {
    ok('the order records the provider', /meta\.payment_provider = 'paypal'/.test(CAP));
    ok('…and PayPal’s own capture id', /meta\.paypal_capture_id = captureId/.test(CAP));
    /* Fulfilment only reads .id and .amount off the payment, so nothing here
       pretends to be a Stripe object beyond those two. */
    ok('what is handed to fulfilment is plainly not a Stripe object',
      /const payment = \{\s*\n\s*id: 'paypal_' \+ captureId,/.test(CAP));
    ok('…and its amount is what PayPal actually took',
      /amount: Number\.isFinite\(capturedCents\) \? capturedCents : quote\.totalCents/.test(CAP));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✗ suite crashed: ' + e.stack); process.exit(1); });
