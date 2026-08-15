/* One order, all the way through.
 *
 * Every link in this chain has its own test. The CHAIN has never had one, and
 * the chain is where this repo's worst outages have lived — every one of them a
 * link that broke while the links either side kept passing:
 *
 *   buildOrderConfirmation referenced an undeclared `meta` and threw on every
 *   order for weeks. No confirmation email was ever sent. Nothing failed
 *   loudly; the email step simply rejected inside a Promise.allSettled.
 *
 *   A column written before its migration ran made PostgREST reject the whole
 *   order row, and saveOrderToSupabase was ABOVE the email, the stock decrement
 *   and the loyalty credit — so one bad insert silently took out all of
 *   fulfilment. The customer paid and got nothing.
 *
 *   /api/stock asked product_sizes for a column that lives on product_images.
 *
 * What they share: the pieces were individually fine. So this test runs the
 * whole thing — price the cart, build the metadata, fulfil the payment —
 * against a fake network, and asserts what a CUSTOMER would notice.
 *
 * ── THE ONE NUMBER ──────────────────────────────────────────────────────────
 *
 * A cart total appears in three places that are computed at different times by
 * different code: what the processor is asked to charge, what is written on the
 * order row, and what the confirmation email says. This repo has shipped bugs
 * where two of those disagreed — order items stored in cents while the admin
 * read them as dollars (a 100× error), and a member charged $40 for a $35 bag.
 * A test that checks one of them proves nothing about the other two, so this
 * checks that they are the SAME number.
 */
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

/* ── A fake network ─────────────────────────────────────────────────────────
   Routes are matched in order on method + URL substring, so a test can override
   one call and leave the rest of the store working. Every request is recorded:
   the assertions are about what fulfilment SENT, which is the only thing a
   customer or an accountant ever sees. */
function net(overrides) {
  const calls = [];
  const routes = (overrides || []).concat([
    // ── catalogue ──
    { m: 'GET', u: '/rest/v1/products?select=*', body: () => [{
      id: 'prod-1', sku: 'ZW-JKT', title: 'Zuwera Vogue', price: 70, category: 'Jackets',
      image_url: 'https://img.test/jkt.jpg', active: true, tax_category: 'clothing',
    }] },
    { m: 'GET', u: '/rest/v1/product_sizes', body: () => [
      { id: 'ps-1', product_id: 'prod-1', size: 'M', stock_quantity: 5, color_name: 'Black' },
    ] },
    { m: 'GET', u: '/rest/v1/products?select=id,sku,title,image_url', body: () => [
      { id: 'prod-1', sku: 'ZW-JKT', title: 'Zuwera Vogue', image_url: 'https://img.test/jkt.jpg' },
    ] },
    { m: 'GET', u: '/rest/v1/products?select=category', body: () => [{ category: 'Jackets' }] },
    { m: 'GET', u: '/rest/v1/color_variants', body: () => [] },
    { m: 'GET', u: '/rest/v1/product_images', body: () => [] },
    { m: 'GET', u: '/rest/v1/products?select=id,sku,title&', body: () => [] },
    // ── settings ──
    { m: 'GET', u: '/rest/v1/site_settings', body: () => [] },
    { m: 'POST', u: '/rest/v1/site_settings', body: () => [] },
    /* Found by the unrouted check below rather than by reading the code, which
       is the whole reason that check exists: pricing looks up whether this
       customer is tax-exempt, and the email builder re-reads the catalogue for
       item images. Neither is obvious from the call site. */
    { m: 'GET', u: '/rest/v1/tax_exemptions', body: () => [] },
    /* The pricing system (migration 0022). Empty on both: no price list rows
       means the catalogue price stands, which is the state every store is in
       until somebody opens that screen — and the state this whole test's
       expected totals are written against. */
    { m: 'GET', u: '/rest/v1/prices', body: () => [] },
    { m: 'GET', u: '/rest/v1/price_lists', body: () => [] },
    { m: 'GET', u: '/rest/v1/products?select=title,sku,image_url', body: () => [] },
    // ── the order ──
    { m: 'GET', u: '/rest/v1/orders?stripe_payment_intent_id=', body: () => [] },
    { m: 'GET', u: '/rest/v1/orders?select=id&order_number=', body: () => [] },
    { m: 'POST', u: '/rest/v1/orders', body: () => [{ id: 'order-1' }] },
    { m: 'PATCH', u: '/rest/v1/orders', body: () => [] },
    // ── stock ──
    { m: 'POST', u: '/rest/v1/rpc/decrement_stock', body: () => 1 },
    // ── everything else that must not be able to fail the order ──
    { m: 'PATCH', u: '/rest/v1/abandoned_carts', body: () => [] },
    { m: 'GET', u: '/rest/v1/referral_codes', body: () => [] },
    { m: 'GET', u: '/rest/v1/loyalty_ledger', body: () => [] },
    { m: 'POST', u: '/rest/v1/loyalty_ledger', body: () => [] },
    { m: 'POST', u: 'api.resend.com', body: () => ({ id: 'email-1' }) },
    { m: 'POST', u: 'api.stripe.com', body: () => ({ id: 'tax-calc-1' }) },
    { m: 'POST', u: 'goshippo.com', status: 500, body: () => ({ error: 'no label in tests' }) },
  ]);

  const fetchImpl = async (url, init) => {
    const u = String(url);
    const m = (init && init.method) || 'GET';
    let bodyParsed = null;
    try { bodyParsed = init && init.body ? JSON.parse(init.body) : null; } catch (_) { bodyParsed = String(init.body); }
    calls.push({ method: m, url: u, body: bodyParsed });

    const r = routes.find((x) => x.m === m && u.indexOf(x.u) !== -1);
    const status = r ? (r.status || 200) : 404;
    const payload = r ? r.body(u, bodyParsed) : { error: 'unrouted: ' + m + ' ' + u };
    const text = JSON.stringify(payload);
    return {
      ok: status >= 200 && status < 300, status,
      json: async () => JSON.parse(text),
      text: async () => text,
      headers: { get: () => null },
    };
  };

  return {
    calls, fetchImpl,
    /* Requests of one kind, so an assertion can be about the order row rather
       than about call number nine. */
    of: (method, frag) => calls.filter((c) => c.method === method && c.url.indexOf(frag) !== -1),
    unrouted: () => calls.filter((c) => !routes.some((x) => x.m === c.method && c.url.indexOf(x.u) !== -1)),
  };
}

const ENV = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  RESEND_API_KEY: 're_test',
  EMAIL_FROM: 'Zuwera <orders@zuwera.store>',
  SITE_URL: 'https://zuwera.store',
};

const ADDRESS = {
  name: 'Jane Smith', email: 'jane@example.com',
  line1: '123 Main St', line2: '', city: 'Cincinnati',
  state: 'OH', zip: '45202', country: 'US',
};

(async () => {
  const CP = await import(pathToFileURL(ROOT + '/functions/api/_cart-pricing.js').href);
  const FL = await import(pathToFileURL(ROOT + '/functions/api/_fulfil.js').href);

  const realFetch = globalThis.fetch;

  /* Price a cart and fulfil the resulting payment, exactly as
     create-payment-intent → stripe-webhook does. Returns everything the
     assertions need to compare the three copies of the total. */
  async function placeOrder(opts) {
    const n = net((opts && opts.routes) || []);
    globalThis.fetch = n.fetchImpl;
    try {
      const quote = await CP.quoteCart({
        items: [{ productId: 'prod-1', size: 'M', colorName: 'Black', quantity: 2, price: 70 }],
        address: ADDRESS,
        shippingRate: null,
        promoCode: (opts && opts.promoCode) || '',
        deliveryMethod: 'hand_delivery',   // no label to buy, so no courier in the loop
        env: ENV,
        request: new Request('https://zuwera.store/api/create-payment-intent', { method: 'POST' }),
      });
      const orderNumber = 'ZW-TEST-00001';
      const meta = CP.buildOrderMetadata({ orderNumber, address: ADDRESS, quote });
      const payment = { id: 'pi_test_1', amount: quote.totalCents, currency: 'usd', metadata: meta };
      await FL.handleSuccessfulPayment(payment, meta, ENV, null);
      return { n, quote, meta, payment };
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log('\n  one order, all the way through\n');

  console.log('  the money is one number in every place it appears');
  let base;
  {
    base = await placeOrder();
    const { n, quote, meta } = base;

    ok('the cart priced from the catalogue, not from the browser',
      quote.subtotalCents === 14000,
      'two jackets at $70 = $140; got ' + quote.subtotalCents +
      ' — a browser-supplied price would have been trusted');

    const posted = n.of('POST', '/rest/v1/orders')[0];
    ok('an order row was written', !!posted, 'the customer paid and nothing recorded it');

    const row = posted && (Array.isArray(posted.body) ? posted.body[0] : posted.body);
    /* THE COMPARISON. Charged, recorded and emailed have to be the same
       figure — they are computed at different times by different code, and
       this repo has shipped two bugs where they were not. */
    ok('…for the amount that was charged',
      row && Math.round(Number(row.total) * 100) === quote.totalCents,
      'order row says ' + (row && row.total) + ', charge was ' + (quote.totalCents / 100));

    const email = n.of('POST', 'api.resend.com')[0];
    ok('a confirmation email was sent', !!email,
      'this is the failure that ran for weeks — an undeclared variable threw inside allSettled');
    const html = email ? JSON.stringify(email.body) : '';
    const dollars = (quote.totalCents / 100).toFixed(2);
    ok('…quoting the same total', html.indexOf(dollars) !== -1,
      'email should contain ' + dollars);
    ok('…addressed to the person who bought it', html.indexOf('jane@example.com') !== -1);
    ok('…carrying the order number they can quote at you',
      html.indexOf('ZW-TEST-00001') !== -1 || JSON.stringify(row || {}).indexOf('ZW-TEST-00001') !== -1);
  }

  console.log('\n  the shelf moves by exactly what was sold');
  {
    const rpc = base.n.of('POST', '/rest/v1/rpc/decrement_stock');
    ok('stock was decremented', rpc.length === 1, 'got ' + rpc.length + ' calls');
    const b = rpc[0] && rpc[0].body;
    ok('…for the product that was bought', b && b.p_product_id === 'prod-1');
    ok('…the size that was bought', b && b.p_size === 'M');
    /* product_sizes is per-colour. Decrementing without the colour takes stock
       off whichever row matches first — the bug that let a size sell out while
       still advertising one left. */
    ok('…and the COLOUR that was bought', b && b.p_color_name === 'Black',
      'stock is per-colour; without this the wrong variant is decremented');
    ok('…by the quantity ordered', b && b.p_qty === 2, 'ordered 2, decremented ' + (b && b.p_qty));
  }

  console.log('\n  a courier that cannot be reached does not cost the order');
  {
    /* Not contrived — it is what this env produces, and finding out why was
       worth the detour. The cart asks for hand delivery, but resolveShipping
       checks the ZIP against the admin's allow-list rather than believing the
       browser, and an empty allow-list means a real parcel. Shippo has no key
       here, so the label fails.

       Which is the interesting case: the customer has already been charged by
       the time fulfilment runs, so a courier outage must cost a label and
       nothing else. */
    ok('a forged hand-delivery does not become free shipping',
      base.quote.shipping.handDelivery === false,
      'the ZIP allow-list is server-authoritative; believing the browser here is free postage for anyone who asks');
    ok('the failed label is recorded where someone will see it',
      base.n.of('POST', '/rest/v1/site_settings').length >= 1,
      'a declined card on the Shippo account would otherwise fail in silence');
    ok('…and the order still completed', base.n.of('POST', '/rest/v1/orders').length === 1);
  }

  console.log('\n  nothing in the chain was left unrouted');
  {
    /* A call this harness does not know about is a step nobody has looked at.
       Better to fail here than to discover it in a Worker log. */
    const stray = base.n.unrouted();
    ok('every request the order made is accounted for', stray.length === 0,
      stray.map((c) => c.method + ' ' + c.url).join(' | '));
  }

  /* The two blocks below break things on purpose, and the code under test is
     built to shout when they do — correctly. But "ORDER NOT SAVED" scrolling
     past a green build teaches everyone to ignore it, so the shouting is
     captured here rather than suppressed at the source. */
  async function quietly(fn) {
    const e = console.error, w = console.warn, l = console.log;
    console.error = console.warn = console.log = () => {};
    try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; }
  }

  console.log('\n  a broken link does not take the rest with it');
  {
    /* The documented outage: the order insert threw and everything BELOW it —
       email, stock, loyalty — never ran. The customer had paid. */
    const r = await quietly(() => placeOrder({ routes: [
      { m: 'POST', u: '/rest/v1/orders', status: 400, body: () => ({ message: 'column "x" does not exist' }) },
    ] }));
    ok('the order row failing does not stop the confirmation email',
      r.n.of('POST', 'api.resend.com').length === 1,
      'a customer who has been charged must still hear from us');
    ok('…nor the stock decrement',
      r.n.of('POST', '/rest/v1/rpc/decrement_stock').length === 1,
      'otherwise the shelf keeps advertising something that has been sold');
    ok('…and handleSuccessfulPayment still resolves rather than throwing', true);
  }
  {
    /* And the other direction: email is the step most likely to be down, and it
       must not cost the order row. */
    const r = await quietly(() => placeOrder({ routes: [
      { m: 'POST', u: 'api.resend.com', status: 500, body: () => ({ message: 'provider down' }) },
    ] }));
    ok('email failing does not stop the order being recorded',
      r.n.of('POST', '/rest/v1/orders').length === 1);
    ok('…nor the stock decrement',
      r.n.of('POST', '/rest/v1/rpc/decrement_stock').length === 1);
  }

  console.log('\n  the same payment twice changes nothing twice');
  {
    /* Stripe retries webhooks. A retry that decrements stock again sells
       inventory that was never bought. */
    const n = net([
      { m: 'GET', u: '/rest/v1/orders?stripe_payment_intent_id=', body: () => [{ id: 'order-1' }] },
    ]);
    globalThis.fetch = n.fetchImpl;
    try {
      const quote = await CP.quoteCart({
        items: [{ productId: 'prod-1', size: 'M', colorName: 'Black', quantity: 2, price: 70 }],
        address: ADDRESS, shippingRate: null, promoCode: '', deliveryMethod: 'hand_delivery',
        env: ENV, request: new Request('https://zuwera.store/x', { method: 'POST' }),
      });
      const meta = CP.buildOrderMetadata({ orderNumber: 'ZW-TEST-00001', address: ADDRESS, quote });
      await FL.saveOrderToSupabase({ id: 'pi_test_1', amount: quote.totalCents }, meta, { number: '', url: '', label: '' }, ENV);
      ok('an order that already exists is not written again',
        n.of('POST', '/rest/v1/orders').length === 0,
        'a webhook retry would create a duplicate order');
    } finally { globalThis.fetch = realFetch; }
  }

  console.log('\n  what the order row has to carry');
  {
    const row = (() => {
      const p = base.n.of('POST', '/rest/v1/orders')[0];
      return p && (Array.isArray(p.body) ? p.body[0] : p.body);
    })();
    ok('the payment reference, so a refund can find it', row && row.stripe_payment_intent_id === 'pi_test_1');
    ok('the customer email, so they can be told anything later', row && String(row.email || '').indexOf('jane@example.com') !== -1);
    /* ship_state, not state — the analytics page reads this exact name, and
       reading the wrong one produced a tax report with every order unassigned. */
    ok('the destination state under the name the reports read',
      row && row.ship_state === 'OH',
      'admin analytics reads ship_state; a different name means no order has a state');

    const items = row && (typeof row.items === 'string' ? JSON.parse(row.items) : row.items);
    ok('the items, as a list', Array.isArray(items) && items.length === 1);
    /* Order items store `amount` in CENTS. An admin page that reads it as
       dollars is off by 100×, which has happened. */
    ok('…priced in cents, as everything downstream expects',
      items && items[0] && Number(items[0].amount) === 7000,
      'expected 7000 cents; got ' + (items && items[0] && items[0].amount));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('  ✗ the harness itself threw — ' + (e && e.stack || e));
  process.exit(1);
});
