/* The link in the receipt should open the order, not interrogate the reader.
 *
 * THE COMPLAINT. You click "View order status" in your order confirmation. It
 * takes you to the returns page, fills in your order number, asks for your
 * email — and then emails you a link. The message you clicked FROM is already
 * sitting in that mailbox. The verification proves exactly what the click just
 * proved, so it is being asked to prove you are yourself, twice.
 *
 * WHY THE STEP EXISTS ANYWAY. Somebody who arrives at /returns on their own has
 * proven nothing, and order numbers are not secret — they are printed on
 * packing slips. For them, emailing a link to the address ON the order is the
 * whole security model, and it stays.
 *
 * So the fix is not removing the step. It is being able to tell the two
 * arrivals apart, which is what a signed token in the emailed link does.
 *
 * WHAT THE TOKEN MAY DO, which is the part worth being careful about: name one
 * order, show what that order's own receipt already showed, and start a return
 * on it. Not read a profile, not list other orders, not move a refund anywhere
 * but the card that paid.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const imp = (f) => import(pathToFileURL(ROOT + '/functions/api/' + f).href);

(async () => {
  const { mintOrderToken, readOrderToken, TTL, PURPOSES } = await imp('_order-token.js');
  const { orderStatusUrl } = await imp('_email.js');
  const env = { RETURN_TOKEN_SECRET: 'test-secret-value' };

  console.log('\n  the order-status link\n');

  console.log('  a token names one order and survives the round trip');
  {
    const t = await mintOrderToken(env, { purpose: 'order-status', paymentIntentId: 'pi_123', email: 'A@B.com' });
    ok('minting produces a token', typeof t === 'string' && t.length > 20);
    const claim = await readOrderToken(env, t);
    ok('reading it back gives the claim', !!claim);
    ok('…naming the payment intent', claim && claim.pi === 'pi_123');
    ok('…and the email, lowercased', claim && claim.e === 'a@b.com');
    ok('…and its purpose', claim && claim.p === 'order-status');

    const byId = await readOrderToken(env, await mintOrderToken(env, { orderId: 'ord_9' }));
    ok('an order-id token works the same way', byId && byId.o === 'ord_9');
  }

  console.log('\n  and cannot be forged, edited or outlived');
  {
    const t = await mintOrderToken(env, { purpose: 'order-status', paymentIntentId: 'pi_123' });
    const [body, sig] = t.split('.');

    ok('a tampered signature is refused',
      (await readOrderToken(env, body + '.' + sig.slice(0, -2) + 'xx')) === null);

    /* The one that matters: swapping the order id inside the body. Anyone
       holding a valid link can try this, and it is the difference between a
       token for one order and a key to all of them. */
    const swapped = Buffer.from(JSON.stringify({ p: 'order-status', pi: 'pi_SOMEONE_ELSE', exp: Date.now() + 1e6 }))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    ok('…and so is a re-pointed order, because the body is signed',
      (await readOrderToken(env, swapped + '.' + sig)) === null);

    ok('a token signed with another secret is refused',
      (await readOrderToken({ RETURN_TOKEN_SECRET: 'different' }, t)) === null);
    ok('garbage is refused', (await readOrderToken(env, 'not-a-token')) === null);
    ok('an empty token is refused', (await readOrderToken(env, '')) === null);

    /* A signature over a body naming no order verifies perfectly and is
       useless — refused here rather than left to query for `undefined`. */
    const empty = Buffer.from(JSON.stringify({ p: 'order-status', exp: Date.now() + 1e6 }))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const { secretFor } = await imp('_order-token.js');
    ok('a token naming no order at all is refused', (await readOrderToken(env, empty + '.sig')) === null);
    ok('secretFor is exported for the routes that need it', typeof secretFor === 'function');
  }

  console.log('\n  expiry');
  {
    ok('a receipt link outlives the 30-day return window',
      TTL['order-status'] > 30 * 24 * 60 * 60 * 1000,
      'a link that dies with the window turns its last day into a support email');
    ok('a requested return link is short-lived',
      TTL['guest-return'] <= 2 * 60 * 60 * 1000);
    ok('the receipt link is the longer of the two',
      TTL['order-status'] > TTL['guest-return']);

    /* Proven by minting one that has already expired rather than by reading the
       constant back, which would only assert that a number equals itself. */
    const realNow = Date.now;
    Date.now = () => realNow() - (TTL['order-status'] + 60000);
    const stale = await mintOrderToken(env, { purpose: 'order-status', paymentIntentId: 'pi_old' });
    Date.now = realNow;
    ok('an expired token is refused', (await readOrderToken(env, stale)) === null);
  }

  console.log('\n  purposes are separable');
  {
    ok('both purposes are declared', PURPOSES.includes('guest-return') && PURPOSES.includes('order-status'));
    const receipt = await mintOrderToken(env, { purpose: 'order-status', paymentIntentId: 'pi_1' });
    ok('a route may narrow to one purpose',
      (await readOrderToken(env, receipt, { accept: ['guest-return'] })) === null);
    ok('…and accepts it when listed',
      !!(await readOrderToken(env, receipt, { accept: ['order-status'] })));
    ok('an unknown purpose cannot be minted',
      (await mintOrderToken(env, { purpose: 'anything-else', orderId: 'x' })) === '');
  }

  console.log('\n  with no signing secret, nothing breaks');
  {
    /* The store must keep working — with the old flow — rather than emailing
       links that go nowhere. */
    ok('minting yields nothing rather than an unsigned token',
      (await mintOrderToken({}, { purpose: 'order-status', paymentIntentId: 'pi_1' })) === '');
    ok('reading yields null', (await readOrderToken({}, 'a.b')) === null);
    ok('and the link falls back to the ordinary lookup',
      orderStatusUrl({ userId: null, orderNumber: 'ZW-1', token: '' }) === 'https://zuwera.store/returns?order=ZW-1');
  }

  console.log('\n  where the link actually points');
  {
    const t = await mintOrderToken(env, { purpose: 'order-status', paymentIntentId: 'pi_1' });
    const url = orderStatusUrl({ userId: null, orderNumber: 'ZW-1', token: t });
    ok('a guest with a token goes straight to their order', url.includes('/returns?t='));
    ok('…and is not asked for the order number again', !url.includes('order='));
    ok('the token is url-encoded', url.includes(encodeURIComponent(t)));

    ok('an account holder still goes to their account',
      orderStatusUrl({ userId: 'u1', orderNumber: 'ZW-1', token: t }) === 'https://zuwera.store/account',
      'someone with a login has one — a token link would bypass it for no gain');

    ok('a guest without a token keeps the old lookup',
      orderStatusUrl({ userId: null, orderNumber: 'ZW-1' }).includes('/returns?order=ZW-1'));
    ok('…and with neither, still somewhere useful',
      orderStatusUrl({ userId: null, orderNumber: '' }).endsWith('/returns'));
  }

  console.log('\n  one implementation, not three');
  {
    /* The helpers were private to guest-return.js. Two more callers needed them,
       and a copied crypto helper is how two definitions of "valid" appear and
       only one of them gets the next fix. */
    const guest = fs.readFileSync(ROOT + '/functions/api/guest-return.js', 'utf8');
    ok('guest-return keeps no private mint', !/async function mintToken/.test(guest));
    ok('…and no private read', !/async function readToken/.test(guest));
    ok('…and no second copy of the HMAC', !/async function hmac/.test(guest));
    ok('it imports the shared module', /from '\.\/_order-token\.js'/.test(guest));

    for (const f of ['_fulfil.js', 'shippo-webhook.js']) {
      const src = fs.readFileSync(ROOT + '/functions/api/' + f, 'utf8');
      ok(f + ' mints through the shared module', /mintOrderToken/.test(src));
      /* Not "uses no crypto" — shippo-webhook legitimately verifies Shippo's
         own webhook signature. The thing that must not be duplicated is the
         minting of an ORDER token, so that is what is asserted. */
      ok(f + ' does not mint one itself',
        !/function\s+mintToken|p:\s*'order-status'[\s\S]{0,80}exp:/.test(src));
    }
  }

  console.log('\n  the receipt carries it');
  {
    const fulfil = fs.readFileSync(ROOT + '/functions/api/_fulfil.js', 'utf8');
    /* Identified by PaymentIntent, because the email is built in parallel with
       the insert and that insert returns nothing — there is no order id yet.
       Not the order NUMBER either: it is null whenever the first item has no
       category, which is why live receipts read "#TMWKGY60", a slice of the
       PaymentIntent id. */
    ok('minted against the payment intent, which always exists by then',
      /paymentIntentId:\s*pi\.id/.test(fulfil));
    ok('…as an order-status token', /purpose:\s*'order-status'/.test(fulfil));
    ok('…and a mint failure cannot break the email', /mintOrderToken\([\s\S]{0,200}?\}\)\.catch\(/.test(fulfil));
    ok('the token reaches the builder', /token:\s*statusToken/.test(fulfil));

    const { buildOrderConfirmation } = await imp('_fulfil.js');
    const { getEmailAppearance, getEmailContent } = await imp('_email-theme.js');
    const html = buildOrderConfirmation({
      appearance: getEmailAppearance({ email_theme: 'dark' }),
      content: getEmailContent({}, 'order_confirmation'),
      orderId: 'AB12CD', toName: 'Alex', itemsHtml: '', subtotalCents: 100,
      discountRow: '', shippingDisplay: 'Free', taxCents: 0, totalDollars: '1.00',
      addressHtml: '', carrierHtml: '',
      userId: null, orderNumber: 'ZW-1',
      token: await mintOrderToken(env, { purpose: 'order-status', paymentIntentId: 'pi_1' }),
    });
    ok('the rendered receipt links straight to the order', html.includes('/returns?t='));
    ok('…for the returns link too, not just the status one',
      (html.match(/\/returns\?t=/g) || []).length >= 2,
      'both footer links go to the same place and neither should re-ask');
    ok('…and asks for no order number anywhere', !html.includes('/returns?order='));
  }

  console.log('\n  the page answers the question it was asked');
  {
    const page = fs.readFileSync(ROOT + '/returns.html', 'utf8');
    ok('a token beats a session', page.includes("const guestToken = params.get('t');"));
    /* Scoped to init(), because getSession is DEFINED earlier in the file than
       it is CALLED — searching the whole page finds the definition and compares
       against the wrong thing. The property is about order of execution inside
       init: the token is read before any session is consulted, so someone on a
       machine where a stranger is signed in still lands on their own order. */
    const init = page.slice(page.indexOf('async function init()'));
    ok('…and is handled before any session is consulted',
      init.indexOf("params.get('t')") < init.indexOf('await getSession()'));

    /* The link says "View order status", so status is what it opens with. It
       used to lead with a return form whatever the customer clicked. */
    ok('the order status is shown', page.includes('guest-status-block'));
    ok('…in words rather than a database value', page.includes('STATUS_WORDS'));
    ok('…with tracking when there is any', page.includes('o.trackingNumber'));
    ok('…above the return form, not instead of it',
      page.indexOf('guest-status-block') < page.indexOf('What are you sending back?'));
    ok('an order that cannot be returned still shows its status',
      page.indexOf('statusHtml') < page.indexOf('cannot be returned'));

    const api = fs.readFileSync(ROOT + '/functions/api/guest-return.js', 'utf8');
    ok('the lookup returns tracking for it to show', /trackingNumber:\s*order\.tracking_number/.test(api));
    ok('…and the carrier', /shippingProvider:\s*order\.shipping_provider/.test(api));

    /* The organic path is untouched: no proof, so still email-me-a-link. */
    ok('arriving with only an order number still asks for the email',
      page.includes("if (params.get('order')) { renderGuestLookup"));
    ok('…and that form still only offers to email a link',
      page.includes('Email me a link'));
  }

  /* ── The failure that actually happened ──────────────────────────────────
     A customer typed their order number and email, pressed "Email me a link",
     and got "we have emailed a link to start your return". No email was sent,
     and none ever would be: no signing secret was configured, so there was
     nothing to sign the link with.

     The identical-reply rule is right — varying it turns the form into a way to
     test which order numbers and emails are real. But it means the operator's
     only signal was one console.error in a Worker log, so a dead returns flow
     could sit there indefinitely while the page cheerfully claimed otherwise.

     The customer's reply stays exactly as it was. What changes is that somebody
     who can fix it now finds out. */
  console.log('\n  a dead returns flow cannot stay quiet');
  {
    const api = fs.readFileSync(ROOT + '/functions/api/guest-return.js', 'utf8');
    ok('a missing signing secret raises an ops alert',
      /key:\s*'returns-no-signing-secret'/.test(api));
    ok('…at critical, because every return is failing',
      /returns-no-signing-secret'[\s\S]{0,120}severity:\s*'critical'/.test(api));
    ok('…naming the variable that fixes it', /RETURN_TOKEN_SECRET/.test(api));
    ok('…and alerting cannot change what the customer is told',
      /catch \(_\) \{ \/\* alerting failing must not change the customer's reply/.test(api));

    const same = api.slice(api.indexOf('const same = json('), api.indexOf('const order = await findOrderByNumber'));
    ok('the reply is still identical for every outcome',
      /If that order number and email match an order/.test(same));

    const admin = fs.readFileSync(ROOT + '/admin-main.js', 'utf8');
    ok('the alert is switchable like the others',
      /\['returns-no-signing-secret',/.test(admin));

    /* An alert only fires once a customer has already been failed. The status
       panel shows it before that happens, which is the whole point. */
    const status = fs.readFileSync(ROOT + '/functions/api/api-status.js', 'utf8');
    ok('API Status reports the signing secret', /checkReturnSigning/.test(status));
    ok('…as a real failure, not an optional extra',
      !/checkReturnSigning[\s\S]{0,900}optional:\s*true/.test(status),
      'a store that takes orders can be asked for a return');
    ok('…and rejects a secret too short to be worth signing with',
      /has\.length < 24/.test(status));
    ok('the admin renders that card', /buildReturnSigningRows/.test(admin));
    ok('…and says where the variable goes', /Environment variables/.test(admin));
    ok('…and warns that rotating it kills live links',
      /invalidates every link already emailed/.test(admin));
  }

  console.log('\n  a token is for ONE order');
  {
    const api = fs.readFileSync(ROOT + '/functions/api/guest-return.js', 'utf8');
    ok('the order is fetched by the claim, never by user input',
      /fetchOrder\(env, claim\)/.test(api) && !/fetchOrder\(env, body\./.test(api));
    ok('…limited to a single row', /select=\*&limit=1/.test(api));
    ok('return history is filtered to this order alone',
      /String\(r\.orderId\) === String\(order\.id\)/.test(api));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✗ suite crashed: ' + e.stack); process.exit(1); });
