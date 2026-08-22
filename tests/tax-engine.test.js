/* Who calculates the tax, and what happens when they can't.
   _tax.js sits on the payment path, so the property that matters most is not
   "the arithmetic is right" — it is "a third party having a bad day cannot stop
   a customer paying". Most of this file is about failure. */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

/* Load _tax.js with its ESM wrapper stripped and its one import stubbed. The
   settings read is the only thing it needs from outside, so the stub is the
   whole seam. */
function loadTax(settings = {}, fetchStub) {
  let src = fs.readFileSync(ROOT + '/functions/api/_tax.js', 'utf8')
    .replace(/^import [^\n]*\n/gm, '')
    .replace(/^export /gm, '');
  src += '\n;module.exports={resolveTax,getTaxRateForAddress,getTaxEngineConfig,normalizeStateCode,'
      +  'TAX_ENGINES,TAX_CATEGORIES,taxCodeFor,recordTaxSale,reverseTaxSale};';
  const mod = { exports: {} };
  /* Every import _tax.js has must be injected here, because the wrapper above
     strips the import lines. A missing one is not a syntax error — the adapter
     throws at call time and resolveTax dutifully falls back to the table, so
     the suite reports a wrong RATE rather than a missing function. */
  new Function('module', 'fetchSiteSettings', 'shipFromValue', 'fetch', 'console', 'setTimeout', src)(
    mod,
    async () => settings,
    /* Same precedence as the real _ship-from.js: SHIP_FROM_ first, then the two
       older spellings it still accepts. */
    (field, env = {}) => String(
      env['SHIP_FROM_' + field] || env['FROM_' + field] || env['SHIPPO_FROM_' + field] || '',
    ).trim(),
    fetchStub || globalThis.fetch,
    { error() {}, warn() {}, log() {} },  // quiet: failures here are the point
    setTimeout
  );
  return mod.exports;
}

/* Records every outbound call so a test can assert what a provider was actually
   sent, not merely what came back. Most of the bugs in this layer are things
   never put in the request. */
function spyFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? String(init.body) : '', init });
    const r = responder ? responder(String(url), init) : null;
    return {
      ok: r ? r.ok !== false : true,
      status: r && r.status ? r.status : 200,
      json: async () => (r && r.body) || {},
    };
  };
  fn.calls = calls;
  return fn;
}

const OHIO = { state: 'OH', zip: '45202', country: 'US', city: 'Cincinnati', line1: '1 Main St' };

(async function () {
  console.log('\n  the built-in table still answers\n');
  {
    const { resolveTax } = loadTax({});
    const out = await resolveTax({ env: {}, request: null, address: OHIO, taxableCents: 10000 });
    // 452xx → Hamilton County, 7%
    ok('prices an Ohio address by county', out.taxCents === 700, out.taxCents + ' cents');
    ok('reports which engine answered', out.engine === 'builtin', out.engine);
    ok('defaults to the table when nothing is configured', out.rate === 0.07, String(out.rate));
  }

  {
    const { resolveTax } = loadTax({});
    const out = await resolveTax({ env: {}, request: null, address: { state: 'OR', country: 'US' }, taxableCents: 10000 });
    ok('a no-tax state is zero, not a fallback rate', out.taxCents === 0);
  }

  console.log('\n  shelving it');
  {
    const { resolveTax } = loadTax({ tax_engine: { engine: 'none' } });
    const out = await resolveTax({ env: {}, request: null, address: OHIO, taxableCents: 10000 });
    ok('engine "none" collects nothing', out.taxCents === 0 && out.engine === 'none');
  }

  console.log('\n  absorbing someone else\'s numbers');
  const externalCfg = { tax_engine: { engine: 'external', endpoint: 'https://tax.example.test/calc' } };
  const reply = (body) => async () => ({ ok: true, json: async () => body });

  for (const [label, body, expected] of [
    ['cents',   { taxCents: 812 },      812],
    ['dollars', { taxAmount: 8.12 },    812],
    ['a rate',  { rate: 0.0812 },       812],
    ["TaxJar's field name", { tax: { amount_to_collect: 8.12 } }, 812],
  ]) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = reply(body);
    const { resolveTax } = loadTax(externalCfg);
    const out = await resolveTax({ env: {}, request: null, address: OHIO, taxableCents: 10000 });
    globalThis.fetch = realFetch;
    ok('takes an endpoint that answers in ' + label, out.taxCents === expected, out.taxCents + ' cents');
  }

  console.log('\n  when the provider cannot answer');
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('connection refused'); };
    const { resolveTax } = loadTax(externalCfg);
    const out = await resolveTax({ env: {}, request: null, address: OHIO, taxableCents: 10000 });
    globalThis.fetch = realFetch;
    ok('falls back to the table rather than failing the order', out.taxCents === 700, out.taxCents + ' cents');
    ok('says which engine it fell back from', out.fallbackFrom === 'external', String(out.fallbackFrom));
    ok('and records that something went wrong', out.failed === true);
  }

  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const { resolveTax } = loadTax(externalCfg);
    const out = await resolveTax({ env: {}, request: null, address: OHIO, taxableCents: 10000 });
    globalThis.fetch = realFetch;
    ok('a 500 is a fallback, not an exception', out.taxCents === 700 && out.failed === true);
  }

  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = reply({ nothing: 'useful' });
    const { resolveTax } = loadTax(externalCfg);
    const out = await resolveTax({ env: {}, request: null, address: OHIO, taxableCents: 10000 });
    globalThis.fetch = realFetch;
    ok('an unreadable reply is a fallback, never a silent zero', out.taxCents === 700);
  }

  {
    // Fallback off: the admin has said an approximate number is worse than none.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    const { resolveTax } = loadTax({ tax_engine: { engine: 'external', endpoint: 'https://x.test', fallback: false } });
    const out = await resolveTax({ env: {}, request: null, address: OHIO, taxableCents: 10000 });
    globalThis.fetch = realFetch;
    ok('fallback:false collects nothing and flags it', out.taxCents === 0 && out.failed === true);
  }

  {
    const { resolveTax } = loadTax({ tax_engine: { engine: 'taxjar' } });   // no TAXJAR_API_KEY
    const out = await resolveTax({ env: {}, request: null, address: OHIO, taxableCents: 10000 });
    ok('a configured provider with no key falls back, not crashes', out.taxCents === 700 && out.fallbackFrom === 'taxjar');
  }

  console.log('\n  configuration');
  {
    const { getTaxEngineConfig } = loadTax({ tax_engine: { engine: 'nonsense' } });
    const cfg = await getTaxEngineConfig({});
    ok('an unknown engine name falls back to the table', cfg.engine === 'builtin', cfg.engine);
    ok('the fallback defaults to on', cfg.fallback === true);
  }
  {
    const { getTaxEngineConfig } = loadTax({});
    const cfg = await getTaxEngineConfig({});
    ok('no setting at all means the table', cfg.engine === 'builtin');
  }

  /* ── a blip must not reprice the cart ─────────────────────────────────────
     Reported by the shop owner as "every time you reload it's a gamble on
     whether you get the best price". The same cart came to $48.80 or $48.48:
     the provider returned Hamilton County's 7.8%, the table returned 7.0%, and
     which one answered depended on whether an API replied inside three seconds.

     Falling back keeps checkout alive and must stay. What must not stay is the
     fallback silently CHANGING THE PRICE. */
  console.log('\n  a provider blip does not reprice the cart');
  {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls > 1) throw new Error('provider down');     // healthy once, then not
      return new Response(JSON.stringify({ tax: { amount_to_collect: 7.8, rate: 0.078 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { resolveTax } = loadTax({ tax_engine: { engine: 'taxjar', fallback: true } });
    globalThis.fetch = realFetch;

    const env = { TAXJAR_API_KEY: 'k' };
    const first = await resolveTax({ env, request: null, address: OHIO, taxableCents: 10000 });
    ok('the provider prices it at its own rate', first.taxCents === 780, first.taxCents + ' cents');

    const second = await resolveTax({ env, request: null, address: OHIO, taxableCents: 10000 });
    ok('…and the same cart costs the same when the provider then fails',
      second.taxCents === first.taxCents, first.taxCents + ' then ' + second.taxCents);
    ok('…reusing the last known rate rather than the table',
      second.cached === true && second.rate === 0.078, JSON.stringify({ cached: second.cached, rate: second.rate }));

    /* The cache must not answer for somewhere it never priced. A remembered
       Ohio rate applied to Oregon would be a confident wrong number, which is
       worse than the table's honest approximation. */
    const elsewhere = await resolveTax({
      env, request: null, taxableCents: 10000,
      address: { state: 'OR', zip: '97201', country: 'US', city: 'Portland', line1: '1 Main St' },
    });
    ok('a cached rate is never served for another jurisdiction',
      elsewhere.cached !== true, JSON.stringify({ cached: elsewhere.cached, rate: elsewhere.rate }));
  }

  console.log('\n  the payment path uses it');
  {
    /* Tax is resolved in _cart-pricing.js now, not in the Stripe route. The
       pricing moved there so PayPal could charge the same totals without
       importing Stripe, and this check followed it — the claim being made is
       "the payment path asks the engine layer", and the payment path is now
       shared. Checking the old file would pass or fail for reasons that have
       nothing to do with tax. */
    /* The metadata these fields live in was extracted to _cart-pricing.js so the
       PayPal capture builds the SAME map — a second copy of forty fields is a
       field added to one and not the other. Read both; the assertions are about
       what fulfilment receives, not which file assembles it. */
    const cpi = fs.readFileSync(ROOT + '/functions/api/create-payment-intent.js', 'utf8')
      + fs.readFileSync(ROOT + '/functions/api/_cart-pricing.js', 'utf8');
    const pricing = fs.readFileSync(ROOT + '/functions/api/_cart-pricing.js', 'utf8');
    ok('the shared quote asks the engine layer', /await resolveTax\(/.test(pricing));
    /* Both files, because "no local copy of the table" has to hold everywhere
       pricing could plausibly be done — a table reintroduced in either place is
       the same bug. */
    ok('…and no longer carries its own copy of the table',
      !/DEFAULT_US_STATE_TAX_RATES/.test(pricing) && !/DEFAULT_US_STATE_TAX_RATES/.test(cpi));

    /* EVERY route that charges, not just the two that were checked.
       This assertion was scoped to _cart-pricing and create-payment-intent, and
       apple-pay-authorize sat outside it carrying a second, simpler tax
       implementation: state rates only, no county lookup, env vars only, no
       engine. A Cincinnati order paid by Apple Pay was charged Ohio's 5.75%
       while the same cart on a card was charged Hamilton County's 7.8%.

       Scoped by directory rather than by a list, so a payment route added
       later is covered without anyone remembering to add it here. */
    const chargeRoutes = fs.readdirSync(ROOT + '/functions/api')
      .filter((f) => /^(create-payment-intent|paypal-create-order|apple-pay-authorize|_cart-pricing)\.js$/.test(f));
    ok('every payment route is checked, not a hand-picked two', chargeRoutes.length >= 4,
      chargeRoutes.join(', '));
    for (const f of chargeRoutes) {
      const src = fs.readFileSync(ROOT + '/functions/api/' + f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      ok(f + ' keeps no rate table of its own',
        !/DEFAULT_US_STATE_TAX_RATES|OH_COUNTY_RATES|IL_ZIP3_RATES/.test(src));
      ok('…and does not decide a rate for itself',
        !/function getTaxRateForAddress/.test(src));
    }
    ok('stamps the engine on the PaymentIntent', /tax_engine:/.test(cpi));
    const hook = fs.readFileSync(ROOT + '/functions/api/stripe-webhook.js', 'utf8')
      + fs.readFileSync(ROOT + '/functions/api/_fulfil.js', 'utf8');
    ok('the webhook records it on the order', /tax_engine:\s*meta\.tax_engine/.test(hook));
  }

  /* ── Switching provider must be a setting, not a project ─────────────────
     The store wants Stripe Tax now and might want TaxJar later. That is only
     true if everything downstream of "who prices it" is provider-neutral: the
     cart lines, the product categories, reporting the sale, reversing it on a
     refund. These check the seams where a provider name could leak out. */
  console.log('\n  the cart reaches the provider as real lines');
  {
    const CART = [
      { sku: 'TEE-S', name: 'Tee', quantity: 3, amountTotal: 8000, taxCategory: 'clothing' },
      { sku: 'CAP',   name: 'Cap', quantity: 1, amountTotal: 2000, taxCategory: 'general'  },
    ];

    const stripeSpy = spyFetch(() => ({ body: { id: 'taxcalc_1', tax_amount_exclusive: 812 } }));
    const { resolveTax: stripeTax } = loadTax({
      tax_engine: { engine: 'stripe_tax', taxCodes: { stripe_tax: { clothing: 'txcd_CLOTHES' } } },
    }, stripeSpy);
    const sOut = await stripeTax({
      env: { STRIPE_SECRET_KEY: 'sk_test' }, request: null, address: OHIO,
      taxableCents: 10000, shippingCents: 815, lineItems: CART,
    });
    const sBody = decodeURIComponent(stripeSpy.calls[0].body).replace(/\+/g, ' ');

    ok('each cart line is sent separately, not as one lump',
      /line_items\[0\]\[amount\]=8000/.test(sBody) && /line_items\[1\]\[amount\]=2000/.test(sBody), sBody.slice(0, 200));
    /* Why it matters: New York exempts clothing under $110 per garment. A lump
       cannot express that; three $80 shirts and one $240 line are different
       questions with different right answers. */
    ok('…with the quantity, so per-item thresholds can apply',
      /line_items\[0\]\[quantity\]=3/.test(sBody), sBody.slice(0, 200));
    ok('the category becomes the provider\'s own code',
      /line_items\[0\]\[tax_code\]=txcd_CLOTHES/.test(sBody), sBody.slice(0, 200));
    ok('a category with no code configured sends none, rather than a guess',
      !/line_items\[1\]\[tax_code\]/.test(sBody), sBody.slice(0, 200));
    ok('shipping is declared, since many states tax it',
      /shipping_cost\[amount\]=815/.test(sBody), sBody.slice(0, 200));
    ok('the calculation handle comes back for reporting', sOut.ref === 'taxcalc_1', sOut.ref);

    /* Same cart, same categories, different provider — and nothing about the
       cart had to change. This is the claim the whole layer exists to make. */
    const jarSpy = spyFetch(() => ({ body: { tax: { amount_to_collect: 8.12, rate: 0.0812 } } }));
    const { resolveTax: jarTax } = loadTax({
      tax_engine: { engine: 'taxjar', taxCodes: { taxjar: { clothing: '20010' } } },
    }, jarSpy);
    const jOut = await jarTax({
      env: { TAXJAR_API_KEY: 'k' }, request: null, address: OHIO,
      taxableCents: 10000, shippingCents: 815, lineItems: CART,
    });
    const jBody = JSON.parse(jarSpy.calls[0].body);

    ok('the same cart goes to TaxJar as lines too', jBody.line_items.length === 2, JSON.stringify(jBody.line_items));
    ok('…with TaxJar\'s code for the same neutral category',
      jBody.line_items[0].product_tax_code === '20010', JSON.stringify(jBody.line_items[0]));
    ok('…and no code where none is configured',
      !('product_tax_code' in jBody.line_items[1]), JSON.stringify(jBody.line_items[1]));
    ok('both providers priced the same cart to the same cents',
      sOut.taxCents === jOut.taxCents, sOut.taxCents + ' vs ' + jOut.taxCents);
  }

  console.log('\n  a completed sale is reported, so there is something to file');
  {
    const ORDER = {
      orderNumber: 'ZW-1001', createdAt: '2026-08-11T00:00:00Z',
      subtotalCents: 10000, shippingCents: 815, taxCents: 812,
      address: { state: 'OH', zip: '45202', city: 'Cincinnati', line1: '1 Main St', country: 'US' },
    };

    const spy = spyFetch(() => ({ body: { id: 'tax_txn_1' } }));
    const { recordTaxSale } = loadTax({ tax_engine: { engine: 'stripe_tax' } }, spy);
    const r = await recordTaxSale({ env: { STRIPE_SECRET_KEY: 'sk' }, ref: 'taxcalc_1', order: ORDER });
    ok('Stripe Tax is told the calculation became a sale',
      r.ok && /tax\/transactions\/create_from_calculation/.test(spy.calls[0].url), JSON.stringify(r));
    ok('…tagged with the order number, so it can be found again',
      /reference=ZW-1001/.test(decodeURIComponent(spy.calls[0].body)), spy.calls[0].body);
    ok('…and the transaction id comes back to be stored', r.id === 'tax_txn_1', r.id);

    const jarSpy = spyFetch(() => ({ body: { order: { transaction_id: 'ZW-1001' } } }));
    const { recordTaxSale: jarRecord } = loadTax({ tax_engine: { engine: 'taxjar' } }, jarSpy);
    const jr = await jarRecord({ env: { TAXJAR_API_KEY: 'k' }, ref: '', order: ORDER });
    ok('TaxJar is told too, from the same call with the same arguments',
      jr.ok && /transactions\/orders/.test(jarSpy.calls[0].url), JSON.stringify(jr));
    /* TaxJar files from the order rather than from a prior quote, so it needs no
       handle — proving the caller genuinely does not have to know which. */
    ok('…even though it was given no calculation handle', jr.ok && jr.id === 'ZW-1001', jr.id);

    /* Engines with no filing product must not be made to look like a failure —
       otherwise every order on the built-in table logs an error for ever. */
    for (const engine of ['builtin', 'ziptax', 'none']) {
      const { recordTaxSale: skipRecord } = loadTax({ tax_engine: { engine } }, spyFetch());
      const sr = await skipRecord({ env: {}, ref: '', order: ORDER });
      ok(engine + ' reports nothing, and says so rather than failing',
        sr.ok && !!sr.skipped, JSON.stringify(sr));
    }

    /* The customer has already paid. A provider outage here is a bookkeeping
       retry, never an exception into the fulfilment path. */
    const boom = spyFetch(() => { throw new Error('provider down'); });
    const { recordTaxSale: failRecord } = loadTax({ tax_engine: { engine: 'stripe_tax' } }, boom);
    let threw = false;
    let fr = null;
    try { fr = await failRecord({ env: { STRIPE_SECRET_KEY: 'sk' }, ref: 'taxcalc_1', order: ORDER }); }
    catch (_) { threw = true; }
    ok('a provider outage never throws into fulfilment', !threw);
    ok('…it reports the failure instead, so it is visible', fr && fr.ok === false && !!fr.error, JSON.stringify(fr));
  }

  console.log('\n  a refund reverses the filing, or you pay tax on a sale that came back');
  {
    const ORDER = { orderNumber: 'ZW-1001', address: { state: 'OH', zip: '45202', country: 'US' } };

    const spy = spyFetch(() => ({ body: { id: 'rev_1' } }));
    const { reverseTaxSale } = loadTax({ tax_engine: { engine: 'stripe_tax' } }, spy);
    const full = await reverseTaxSale({
      env: { STRIPE_SECRET_KEY: 'sk' }, transactionId: 'tax_txn_1',
      order: ORDER, amountCents: 10812, taxCents: 812, full: true,
    });
    ok('Stripe Tax gets a reversal against the recorded transaction',
      full.ok && /create_reversal/.test(spy.calls[0].url), JSON.stringify(full));
    ok('…referring to the transaction the sale was filed under',
      /original_transaction=tax_txn_1/.test(decodeURIComponent(spy.calls[0].body)), spy.calls[0].body);
    ok('…as a full reversal when the whole order came back',
      /mode=full/.test(decodeURIComponent(spy.calls[0].body)), spy.calls[0].body);

    const partSpy = spyFetch(() => ({ body: { id: 'rev_2' } }));
    const { reverseTaxSale: partial } = loadTax({ tax_engine: { engine: 'stripe_tax' } }, partSpy);
    await partial({
      env: { STRIPE_SECRET_KEY: 'sk' }, transactionId: 'tax_txn_1',
      order: ORDER, amountCents: 4000, taxCents: 300, full: false,
    });
    const pBody = decodeURIComponent(partSpy.calls[0].body);
    ok('a partial refund reverses only its share', /mode=partial/.test(pBody), pBody);
    ok('…as a negative amount, which is what a reversal is', /flat_amount=-4000/.test(pBody), pBody);

    const jarSpy = spyFetch(() => ({ body: { refund: { transaction_id: 'ZW-1001-refund' } } }));
    const { reverseTaxSale: jarReverse } = loadTax({ tax_engine: { engine: 'taxjar' } }, jarSpy);
    const jr = await jarReverse({
      env: { TAXJAR_API_KEY: 'k' }, transactionId: '',
      order: ORDER, amountCents: 4000, taxCents: 300, full: false,
    });
    const jBody = JSON.parse(jarSpy.calls[0].body);
    ok('TaxJar gets the refund from the same call', jr.ok && /transactions\/refunds/.test(jarSpy.calls[0].url));
    ok('…pointing back at the order it reverses', jBody.transaction_reference_id === 'ZW-1001', JSON.stringify(jBody));
    ok('…with negative amounts, since a refund is a sale in reverse',
      jBody.amount < 0 && jBody.sales_tax < 0, JSON.stringify(jBody));
  }

  console.log('\n  the money path carries all of it');
  {
    const pricing = fs.readFileSync(ROOT + '/functions/api/_cart-pricing.js', 'utf8');
    const cpi     = fs.readFileSync(ROOT + '/functions/api/create-payment-intent.js', 'utf8');
    const fulfil  = fs.readFileSync(ROOT + '/functions/api/_fulfil.js', 'utf8');
    const refund  = fs.readFileSync(ROOT + '/functions/api/admin-refund.js', 'utf8');

    ok('the quote sends the cart as lines', /lineItems: taxLineItems/.test(pricing));
    /* Lines that do not add up to what is charged would have the provider tax
       money nobody paid, which a promo makes routine rather than rare. */
    /* Was pinned to `discountedSubtotalCents / subtotalCents`. The base moved
       when gift cards arrived: they are not taxed at purchase, so they are out
       of the taxable figure AND out of these lines. What has to hold is that
       the lines are scaled to whatever WILL be taxed and reconciled against
       that same number — an engine reads either the lines or the single figure,
       never both, so the two describing different money is two answers to one
       question. */
    ok('…scaled to exactly what will be taxed, and reconciled to the cent',
      /taxableCents \/ discountableSubtotalCents/.test(pricing)
      && /const remainder = taxableCents - allocated;/.test(pricing));
    /* In the shared metadata builder, so PayPal carries it too — a tax provider
       only files a sale it can refer back to, and an order paid the other way
       would have been unreportable. */
    ok('the calculation handle is carried on the payment', /tax_ref: tax\.ref/.test(pricing));
    ok('a completed sale is reported from fulfilment', /reportSaleToTaxProvider/.test(fulfil));
    /* On the ORDER, not on a Stripe PaymentIntent (migration 0019). It used to
       be written as intent metadata, which works for exactly as long as Stripe
       is the only processor — a PayPal order has no intent, so that call failed,
       the reference was never stored, and the refund reversed nothing. Silently,
       because this whole step is best-effort by design. */
    ok('…and the provider\'s transaction id stored for the refund to find',
      /tax_txn: result\.id/.test(fulfil));
    ok('…somewhere every processor can write to', /rest\/v1\/orders\?stripe_payment_intent_id=eq\./.test(fulfil)
      && !/metadata\[tax_txn\]/.test(fulfil),
      'intent metadata is unreachable for anything that is not Stripe');
    ok('a refund reverses it', /reverseTaxSale\(/.test(refund));
    ok('…reading it from the order, with a legacy fallback for older ones',
      /order\.tax_txn/.test(refund) && /legacyTaxTransactionId/.test(refund),
      'orders placed before 0019 still have it only on the intent');

    /* The Tax page writes the whole engine config back on every save. It used
       to write only { engine, fallback, endpoint }, so saving the engine picker
       would silently drop the categories and provider codes underneath it —
       the same read-modify-write loss this codebase has hit before. */
    const adminTax = fs.readFileSync(ROOT + '/admin-tax.js', 'utf8');
    ok('saving the engine keeps the categories and codes',
      /\.\.\._taxEngineCfg,/.test(adminTax));
    ok('…and the category picker is actually reachable',
      /tax-default-category/.test(adminTax) && /tax-category-wrap/.test(fs.readFileSync(ROOT + '/admin.html', 'utf8')));
    /* The seam that matters: none of these files may name a provider. The
       moment one does, switching provider stops being a setting. */
    for (const [name, src] of [['the quote', pricing], ['fulfilment', fulfil], ['the refund', refund]]) {
      ok(name + ' names no tax provider of its own',
        !/taxjar|stripe_tax|ziptax|avalara/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
    }
  }

  console.log('\n  a customer who does not owe tax');
  {
    /* An exemption is the one setting that makes tax vanish, so every branch
       here fails CLOSED — unreadable, expired, revoked or wrong-state all mean
       "charge them", because the alternative is a silent tax holiday. */
    const CERT = [{ id: 'e1', certificate: 'OH-123', states: [], expires_at: null, revoked_at: null }];
    const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
    const reply = (rows) => spyFetch(() => ({ body: rows }));

    let spy = reply(CERT);
    let { resolveTax: rt } = loadTax({}, spy);
    let out = await rt({ env, request: null, address: OHIO, taxableCents: 10000, customer: { email: 'wholesale@shop.test' } });
    ok('a held certificate zeroes the tax', out.taxCents === 0 && out.exempt === true, JSON.stringify(out));
    /* A zero nobody can explain is indistinguishable from a bug at filing
       time, so the certificate is stamped on the answer. */
    ok('…and says which certificate did it', out.exemptionCertificate === 'OH-123', out.exemptionCertificate);
    ok('…and the provider is never even asked', spy.calls.every((c) => /tax_exemptions/.test(c.url)), spy.calls.map(c => c.url).join(' '));

    ({ resolveTax: rt } = loadTax({}, reply([{ ...CERT[0], expires_at: '2020-01-01T00:00:00Z' }])));
    out = await rt({ env, request: null, address: OHIO, taxableCents: 10000, customer: { email: 'x@y.test' } });
    ok('an expired certificate is not an exemption', !out.exempt && out.taxCents === 700, JSON.stringify(out));

    ({ resolveTax: rt } = loadTax({}, reply([{ ...CERT[0], states: ['CA'] }])));
    out = await rt({ env, request: null, address: OHIO, taxableCents: 10000, customer: { email: 'x@y.test' } });
    ok('a certificate for another state is not an exemption', !out.exempt, JSON.stringify(out));

    ({ resolveTax: rt } = loadTax({}, spyFetch(() => { throw new Error('db down'); })));
    out = await rt({ env, request: null, address: OHIO, taxableCents: 10000, customer: { email: 'x@y.test' } });
    ok('an unreadable database charges tax rather than skipping it',
      !out.exempt && out.taxCents === 700, JSON.stringify(out));

    ({ resolveTax: rt } = loadTax({}, reply(CERT)));
    out = await rt({ env, request: null, address: OHIO, taxableCents: 10000 });
    ok('an anonymous shopper is never exempt', !out.exempt, JSON.stringify(out));
  }

  console.log('\n  shadow mode — a measurement, not a charge');
  {
    const cfg = { tax_engine: { engine: 'builtin', shadowEngine: 'ziptax' } };
    const rows = [];
    const spy = spyFetch((url) => {
      if (/zip-tax/.test(url)) return { body: { results: [{ taxSales: 0.078 }] } };
      return { body: {} };
    });
    const { resolveTax: rt } = loadTax(cfg, spy);

    const jobs = [];
    const out = await rt({
      env: { ZIPTAX_API_KEY: 'k', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc' },
      request: null, address: OHIO, taxableCents: 10000,
      waitUntil: (p) => jobs.push(p),
    });

    /* The charge is the LIVE engine's, always. */
    ok('the charge comes from the live engine, not the shadow',
      out.taxCents === 700 && out.engine === 'builtin', JSON.stringify(out));
    ok('the shadow run is deferred, not awaited by the customer', jobs.length === 1, jobs.length + ' deferred');

    await Promise.all(jobs);
    const logged = spy.calls.find((c) => /tax_shadow_log/.test(c.url));
    ok('…and its answer is recorded', !!logged, spy.calls.map((c) => c.url).join(' '));
    if (logged) {
      const row = JSON.parse(logged.body);
      ok('…with both figures and the difference between them',
        row.live_cents === 700 && row.shadow_cents === 780 && row.delta_cents === 80, logged.body);
      ok('…naming which engine said what',
        row.live_engine === 'builtin' && row.shadow_engine === 'ziptax', logged.body);
    }

    /* Without a Worker context there is nowhere to defer to, and making a
       customer wait for a comparison would cost the sale it is measuring. */
    const { resolveTax: rt2 } = loadTax(cfg, spyFetch());
    const out2 = await rt2({ env: {}, request: null, address: OHIO, taxableCents: 10000 });
    ok('no waitUntil means no shadow run at all', out2.taxCents === 700);

    const { resolveTax: rt3 } = loadTax({ tax_engine: { engine: 'builtin', shadowEngine: 'builtin' } }, spyFetch());
    const jobs3 = [];
    await rt3({ env: {}, request: null, address: OHIO, taxableCents: 10000, waitUntil: (p) => jobs3.push(p) });
    ok('an engine is never shadowed by itself', jobs3.length === 0);
  }

  console.log('\n  the two new providers');
  {
    const CART = [{ sku: 'TEE', quantity: 2, amountTotal: 8000, taxCategory: 'clothing' }];
    const env = {
      TAXCLOUD_API_LOGIN_ID: 'id', TAXCLOUD_API_KEY: 'k',
      AVALARA_ACCOUNT_ID: '1', AVALARA_LICENSE_KEY: 'k',
      SHIP_FROM_STREET1: '2930 Short Vine St', SHIP_FROM_CITY: 'Cincinnati',
      SHIP_FROM_STATE: 'OH', SHIP_FROM_ZIP: '45219',
    };

    const tcSpy = spyFetch(() => ({ body: { CartID: 'cart1', CartItemsResponse: [{ CartItemIndex: 0, TaxAmount: 6.24 }], ResponseType: 3 } }));
    const { resolveTax: tc } = loadTax({ tax_engine: { engine: 'taxcloud', taxCodes: { taxcloud: { clothing: '20010' } } } }, tcSpy);
    const tcOut = await tc({ env, request: null, address: OHIO, taxableCents: 8000, shippingCents: 815, lineItems: CART });
    const tcBody = JSON.parse(tcSpy.calls[0].body);
    ok('TaxCloud is asked, and answers in cents', tcOut.taxCents === 624, JSON.stringify(tcOut));
    ok('…with the origin address the labels use', tcBody.origin.Zip5 === '45219', JSON.stringify(tcBody.origin));
    ok('…and the category as a TIC', tcBody.cartItems[0].TIC === 20010, JSON.stringify(tcBody.cartItems[0]));
    ok('…returning a cart handle for reporting the sale', tcOut.ref === 'cart1');

    const avSpy = spyFetch(() => ({ body: { totalTax: 6.24, code: 'ZW-1' } }));
    const { resolveTax: av } = loadTax({ tax_engine: { engine: 'avalara', companyCode: 'ZUWERA' } }, avSpy);
    const avOut = await av({ env, request: null, address: OHIO, taxableCents: 8000, shippingCents: 815, lineItems: CART });
    const avBody = JSON.parse(avSpy.calls[0].body);
    ok('Avalara is asked, and answers in cents', avOut.taxCents === 624, JSON.stringify(avOut));
    /* A quote must not land in the filing ledger — that is what separates
       SalesOrder from a committed SalesInvoice. */
    ok('…as an uncommitted SalesOrder, so a quote is not filed',
      avBody.type === 'SalesOrder' && avBody.commit === false, avBody.type + ' commit=' + avBody.commit);
    ok('…against the configured company', avBody.companyCode === 'ZUWERA');
    ok('…with shipping declared as freight', avBody.lines.some((l) => l.number === 'FREIGHT'), JSON.stringify(avBody.lines));
    ok('…and sandbox until told otherwise', /sandbox\.rest\.avatax\.com/.test(avSpy.calls[0].url), avSpy.calls[0].url);

    /* Reversing a partial refund by voiding would remove the tax on the WHOLE
       sale, so it refuses rather than reversing more than came back. */
    const { reverseTaxSale: avRev } = loadTax({ tax_engine: { engine: 'avalara' } }, spyFetch());
    const partial = await avRev({ env, transactionId: 't', order: { orderNumber: 'ZW-1' }, amountCents: 1000, taxCents: 78, full: false });
    ok('Avalara refuses a partial reversal rather than voiding the whole sale',
      partial.ok === false && /ReturnInvoice/.test(partial.error), JSON.stringify(partial));
  }

  console.log('\n  per-product categories reach the provider');
  {
    const pricing = fs.readFileSync(ROOT + '/functions/api/_cart-pricing.js', 'utf8');
    ok('the catalog carries each product\'s category',
      /taxCategory: String\(product\.tax_category/.test(pricing));
    ok('…into the tax lines', /taxCategory: item\.taxCategory/.test(pricing));
    ok('…and a blank one falls back to the store default',
      /item\.taxCategory \|\| config\.defaultCategory/.test(fs.readFileSync(ROOT + '/functions/api/_tax.js', 'utf8')));

    const mig = fs.readFileSync(ROOT + '/migrations/0011_tax_categories_exemptions_shadow.sql', 'utf8');
    ok('the column exists in a migration', /add column if not exists tax_category/.test(mig));
    /* Both new tables can zero or explain tax, so neither may be reachable
       from a browser session. */
    ok('exemptions are service-only', /tax exemptions are service-only[\s\S]*?using \(false\)/.test(mig));
    ok('the shadow log is service-only', /shadow log is service-only[\s\S]*?using \(false\)/.test(mig));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
