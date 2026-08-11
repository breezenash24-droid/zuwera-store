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
function loadTax(settings = {}) {
  let src = fs.readFileSync(ROOT + '/functions/api/_tax.js', 'utf8')
    .replace(/^import [^\n]*\n/gm, '')
    .replace(/^export /gm, '');
  src += '\n;module.exports={resolveTax,getTaxRateForAddress,getTaxEngineConfig,normalizeStateCode,TAX_ENGINES};';
  const mod = { exports: {} };
  new Function('module', 'fetchSiteSettings', 'fetch', 'console', 'setTimeout', src)(
    mod,
    async () => settings,
    globalThis.fetch,
    { error() {}, warn() {}, log() {} },  // quiet: failures here are the point
    setTimeout
  );
  return mod.exports;
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

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
