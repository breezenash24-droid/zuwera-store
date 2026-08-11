/* checkout-tax.js — where the shopper's tax figure comes from.
 *
 * It used to come from a rate table in the browser. That table disagreed with
 * the server: a cart shown at $93.75 was charged $94.39, because the browser
 * said Hamilton County was 7.0% and the configured tax engine said 7.8%. The
 * browser had no way to know an engine setting existed.
 *
 * So the table was deleted rather than corrected — correcting it fixes one ZIP
 * and leaves every other jurisdiction free to drift again. The browser now asks
 * /api/tax-quote, which calls the same resolveTax() that charges the card.
 *
 * These tests pin the two halves of that. First, that the table has not come
 * back — this is the assertion that actually stops the bug recurring, because
 * a re-added table would pass every behavioural test below by coincidence.
 * Second, that a quoted rate is what the summary displays, that "not told yet"
 * is distinguishable from "no tax here", and that cents and dollars round the
 * same way the server rounds.
 */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SRC = fs.readFileSync(ROOT + '/checkout-tax.js', 'utf8');

/* The "no table" guard below is about code, not commentary — the file's header
   explains the Hamilton County bug in words, and a guard that trips over its
   own documentation teaches people to delete the documentation. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CODE = stripComments(SRC);

/* Load the module the way a browser would, with a fetch we control.
   `quote` is what /api/tax-quote will answer; `calls` records what was asked. */
function load(quote) {
  const calls = [];
  const events = [];
  const store = {};
  const win = {
    addEventListener() {},
    dispatchEvent(e) { events.push(e); return true; },
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
  };
  const fetchStub = (url) => {
    calls.push(String(url));
    const answer = typeof quote === 'function' ? quote(String(url)) : quote;
    if (answer === null) return Promise.reject(new Error('network'));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) });
  };
  function CustomEventStub(type, init) { this.type = type; this.detail = init && init.detail; }
  new Function('window', 'document', 'fetch', 'CustomEvent', SRC)(
    win, { addEventListener() {}, readyState: 'complete' }, fetchStub, CustomEventStub,
  );
  return { T: win.ZWCheckoutTax, calls, events };
}

/* Let the fetch chain settle. The module resolves through several .then()s. */
const settle = () => new Promise((r) => setImmediate(r));

(async () => {
  console.log('\n  checkout tax\n');

  console.log('  the table is gone, and must stay gone');
  {
    /* The one assertion that stops this bug coming back. Everything below would
       still pass if somebody re-added a hardcoded table as a "fast path". */
    const decimals = CODE.match(/\b0\.0\d+\b/g) || [];
    ok('no tax rates are written in this file', decimals.length === 0,
      decimals.join(', '));
    ok('…no county table', !/Cuyahoga|Hamilton|Franklin/.test(CODE));
    ok('…no state rate table', !/STATE_RATES|DEFAULT_US_STATE_TAX_RATES/.test(CODE));
    ok('…no ZIP3 table', !/ZIP3/.test(CODE));

    /* State NAMES are fine and deliberately kept: turning "Ohio" into "OH" is
       spelling, and spelling cannot drift away from the server the way a rate
       can. Pinned so a future cleanup doesn't remove it as "more duplication". */
    ok('state names are still resolved locally', /CALIFORNIA/.test(SRC));
  }

  console.log('\n  state codes');
  {
    const { T } = load({ rate: 0, stateCode: '', engine: 'builtin' });
    ok('two-letter codes pass through', T.normalizeStateCode('CA') === 'CA');
    ok('lowercase is accepted', T.normalizeStateCode('ca') === 'CA');
    ok('full names resolve', T.normalizeStateCode('California') === 'CA');
    ok('…including two-word states', T.normalizeStateCode(' new jersey ') === 'NJ');
    ok('punctuation is ignored', T.normalizeStateCode('D.C.') === 'DC');
    ok('an unrecognised two-letter code is passed through, not guessed at',
      T.normalizeStateCode('XX') === 'XX');
    ok('an unrecognised full name resolves to nothing', T.normalizeStateCode('Atlantis') === '');
    ok('null is safe', T.normalizeStateCode(null) === '');
  }

  console.log('\n  it asks the server');
  {
    const { T, calls } = load({ rate: 0.078, stateCode: 'OH', engine: 'ziptax' });
    await T.ensure('OH', '45202');
    await settle();

    ok('the quote comes from /api/tax-quote', calls.some((u) => /\/api\/tax-quote/.test(u)), calls.join(' | '));
    ok('…and carries the address it is asking about',
      calls.some((u) => /state=OH/.test(u) && /zip=45202/.test(u)), calls.join(' | '));

    /* The whole point: 7.8% is a number no table in this repo contains. It can
       only have come from the server, which is the fix. */
    ok('the server\'s rate is what gets charged to the display',
      T.taxCents(8000, 'OH', '45202') === 624, String(T.taxCents(8000, 'OH', '45202')));
    ok('…and the engine that produced it is reported',
      T.engineFor('OH', '45202') === 'ziptax');
  }

  console.log('\n  told nothing vs told zero');
  {
    const { T } = load({ rate: 0, stateCode: 'OR', engine: 'builtin' });

    /* Oregon has no sales tax. "0" is the right answer to show. */
    ok('an unasked address is not known yet', T.isKnown('OR', '97201') === false);
    ok('…and reports no tax rather than a guess', T.taxCents(10000, 'OR', '97201') === 0);

    await T.ensure('OR', '97201');
    await settle();
    ok('once answered, it is known', T.isKnown('OR', '97201') === true);
    ok('…and still zero, which is now a figure worth showing',
      T.taxCents(10000, 'OR', '97201') === 0);
  }

  console.log('\n  rounding matches the server');
  {
    /* resolveTax does Math.round(taxableCents * rate). Dollars-as-floats
       rounded at the end lands a penny out often enough to matter, so
       taxDollars is routed through the cents path rather than reimplementing. */
    const { T } = load({ rate: 0.0725, stateCode: 'OH', engine: 'builtin' });
    await T.ensure('OH', '43215');
    await settle();

    const cents = T.taxCents(3555, 'OH', '43215');
    ok('cents are rounded, not truncated', cents === Math.round(3555 * 0.0725), String(cents));
    ok('dollars agree with cents to the penny',
      Math.round(T.taxDollars(35.55, 'OH', '43215') * 100) === cents,
      T.taxDollars(35.55, 'OH', '43215') + ' vs ' + cents);
    ok('a zero subtotal is never taxed', T.taxCents(0, 'OH', '43215') === 0);
    ok('a negative subtotal is never taxed', T.taxCents(-500, 'OH', '43215') === 0);
    ok('rounding lands on whole cents', Number.isInteger(T.taxCents(9999, 'OH', '43215')));
  }

  console.log('\n  the summary finds out');
  {
    /* Six call sites read tax synchronously while rendering. The answer arrives
       later, so it has to announce itself or the page shows a pending line for
       ever. */
    const { T, events } = load({ rate: 0.065, stateCode: 'CA', engine: 'builtin' });
    await T.ensure('CA', '90210');
    await settle();
    /* By ZIP, not the first event: loading the module fires an address-less ask
       so the bag and product pages get a geo-located rate before anyone types
       anything, and that one lands first. */
    const e = events.filter((x) => x.type === 'zw:tax').find((x) => x.detail.zip === '90210');
    ok('a landed rate fires zw:tax', !!e, events.map((x) => x.type + ':' + x.detail.zip).join(','));
    ok('…saying which address it was for', !!e && e.detail.state === 'CA');
    ok('the address-less ask on load fires too',
      events.some((x) => x.type === 'zw:tax' && x.detail.zip === ''));
  }

  console.log('\n  it asks once');
  {
    /* Six summaries rendering the same cart must not be six requests. */
    const { T, calls } = load({ rate: 0.06, stateCode: 'KY', engine: 'builtin' });
    const before = calls.length;
    T.ensure('KY', '40202'); T.ensure('KY', '40202'); T.ensure('KY', '40202');
    await settle();
    const asked = calls.length - before;
    ok('three simultaneous asks are one request', asked === 1, asked + ' requests');

    T.ensure('KY', '40202');
    await settle();
    ok('…and a known rate asks again not at all', calls.length - before === 1);
  }

  console.log('\n  a failed quote does not invent a number');
  {
    const { T } = load(null);   // fetch rejects
    await T.ensure('OH', '45202');
    await settle();
    ok('an unreachable endpoint leaves the rate unknown', T.isKnown('OH', '45202') === false);
    ok('…and shows no tax rather than a stale table figure',
      T.taxCents(8000, 'OH', '45202') === 0);
  }

  console.log('\n  one answerer');
  {
    const endpoint = fs.readFileSync(ROOT + '/functions/api/tax-quote.js', 'utf8');
    const pricing  = fs.readFileSync(ROOT + '/functions/api/_cart-pricing.js', 'utf8');

    ok('the endpoint calls resolveTax', /resolveTax\(/.test(endpoint));
    ok('…the same one the payment path calls', /resolveTax\(/.test(pricing));
    /* The endpoint must not grow its own table either — that would be the same
       bug one file to the left. */
    ok('…and keeps no table of its own',
      !/0\.0\d/.test(endpoint) && !/STATE_RATES/.test(endpoint));

    /* resolveTax reads Admin → Tax itself when the caller doesn't pass it, so a
       new caller cannot price without the store's overrides by forgetting to. */
    const tax = fs.readFileSync(ROOT + '/functions/api/_tax.js', 'utf8');
    ok('overrides are loaded even when a caller forgets them',
      /dbOverrides \|\| await loadTaxOverrides\(env\)/.test(tax));
  }

  console.log('\n  the browser and the charge agree, end to end');
  {
    /* Not a source assertion this time: the browser module is wired to the real
       /api/tax-quote handler, and the handler's answer is compared against what
       resolveTax() gives the payment path for the same address. That is the
       whole fix stated as one check — the summary and the card charge are the
       same number because they are the same call. */
    const { pathToFileURL } = require('url');
    const api = (f) => import(pathToFileURL(ROOT + '/functions/api/' + f).href);
    const { onRequestGet } = await api('tax-quote.js');
    const { resolveTax } = await api('_tax.js');

    /* An unconfigured store: no Supabase, no provider keys, no env overrides.
       resolveTax falls all the way through to the built-in table, which is the
       path every store runs on out of the box. */
    const env = {};
    const ADDRESS = { state: 'OH', zip: '45202', country: 'US' };
    const CART = 8000;   // $80.00, the cart from the report

    let served = null;
    const handlerFetch = async (url) => {
      const res = await onRequestGet({
        request: new Request('https://zuwera.store' + url),
        env, params: {}, waitUntil() {},
      });
      served = await res.clone().json();
      return { ok: res.ok, json: () => res.json() };
    };

    const { T } = load(async (url) => {
      const r = await handlerFetch(url);
      return r.json();
    });

    await T.ensure(ADDRESS.state, ADDRESS.zip, CART);
    await settle();

    const shown = T.taxCents(CART, ADDRESS.state, ADDRESS.zip);
    const charged = await resolveTax({ env, request: null, address: ADDRESS, taxableCents: CART });

    ok('the endpoint answered at all', !!served, JSON.stringify(served));
    ok('what the summary shows equals what the card is charged',
      shown === charged.taxCents,
      'shown ' + shown + 'c vs charged ' + charged.taxCents + 'c');

    /* The specific failure that started this. $80.00 at two different rates is
       $93.75 on screen and $94.39 on the statement; pinning the totals means a
       future divergence names itself in dollars rather than in basis points. */
    const SHIP = 815;
    ok('…so one total, not two',
      (CART + shown + SHIP) === (CART + charged.taxCents + SHIP),
      '$' + ((CART + shown + SHIP) / 100).toFixed(2) + ' vs $' + ((CART + charged.taxCents + SHIP) / 100).toFixed(2));

    /* And the rate is genuinely being carried across, not defaulted to zero on
       both sides — which would make the equality above true and meaningless. */
    ok('the agreed figure is a real rate, not zero on both sides',
      charged.taxCents > 0, JSON.stringify(charged));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
