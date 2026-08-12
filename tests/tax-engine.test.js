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
    (field, env = {}) => String(env['FROM_' + field] || env['SHIPPO_FROM_' + field] || '').trim(),
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
    const cpi = fs.readFileSync(ROOT + '/functions/api/create-payment-intent.js', 'utf8');
    const pricing = fs.readFileSync(ROOT + '/functions/api/_cart-pricing.js', 'utf8');
    ok('the shared quote asks the engine layer', /await resolveTax\(/.test(pricing));
    /* Both files, because "no local copy of the table" has to hold everywhere
       pricing could plausibly be done — a table reintroduced in either place is
       the same bug. */
    ok('…and no longer carries its own copy of the table',
      !/DEFAULT_US_STATE_TAX_RATES/.test(pricing) && !/DEFAULT_US_STATE_TAX_RATES/.test(cpi));
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
    ok('…scaled to the discounted total, exactly', /remainder/.test(pricing) && /discountedSubtotalCents \/ subtotalCents/.test(pricing));
    ok('the calculation handle is carried on the payment', /tax_ref: tax\.ref/.test(cpi));
    ok('a completed sale is reported from fulfilment', /reportSaleToTaxProvider/.test(fulfil));
    ok('…and the provider\'s transaction id stored for the refund to find',
      /metadata\[tax_txn\]/.test(fulfil));
    ok('a refund reverses it', /reverseTaxSale\(/.test(refund));

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

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
