/* checkout-tax.js — the money maths, and the admin override path.
 *
 * The built-in STATE_RATES table is a FALLBACK, not the whole story: rates are
 * layered over it from site_settings.tax_rate_overrides (served by
 * /api/tax-config). A reviewer reading only the constant will conclude the
 * rates are hardcoded and unmaintainable; the override merge is thirty lines
 * further down. These tests pin both halves so neither can quietly stop
 * working — the fallback being wrong and the override being ignored look
 * identical from the outside, and both charge the customer the wrong amount.
 */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

/* Load the module the way a browser would: it attaches to window. */
function load() {
  const src = fs.readFileSync(ROOT + '/checkout-tax.js', 'utf8');
  const win = { addEventListener() {} };
  new Function('window', 'document', 'fetch', 'localStorage', src)(
    win,
    { addEventListener() {}, readyState: 'complete' },
    () => new Promise(() => {}),                 // never resolves: no override applied
    { getItem: () => null, setItem() {} }
  );
  return win.ZWCheckoutTax;
}
const T = load();

console.log('\n  checkout tax\n');

console.log('  state codes');
{
  ok('two-letter codes pass through', T.normalizeStateCode('CA') === 'CA');
  ok('lowercase is accepted', T.normalizeStateCode('ca') === 'CA');
  ok('full names resolve', T.normalizeStateCode('California') === 'CA');
  ok('…including two-word states', T.normalizeStateCode(' new jersey ') === 'NJ');
  ok('punctuation is ignored', T.normalizeStateCode('D.C.') === 'DC');
  // A two-letter input is passed through even if it is not a real state — the
  // safety net is one layer down, where an unknown code has no rate and so is
  // taxed at zero (asserted below). Worth pinning as the actual contract rather
  // than assuming the normaliser validates.
  ok('an unrecognised two-letter code is passed through, not guessed at',
    T.normalizeStateCode('XX') === 'XX');
  ok('an unrecognised full name resolves to nothing', T.normalizeStateCode('Atlantis') === '');
  ok('null is safe', T.normalizeStateCode(null) === '');
}

console.log('\n  rates');
{
  const $100 = 10000;   // cents
  ok('a flat-rate state charges its flat rate', T.taxCents($100, 'KY') === 600, T.taxCents($100, 'KY') + '');
  ok('a no-tax state charges nothing', T.taxCents($100, 'OR') === 0);
  ok('an unknown state charges nothing rather than guessing', T.taxCents($100, 'XX') === 0);
  ok('no state yet charges nothing', T.taxCents($100, '') === 0);

  // Ohio and Illinois are ZIP-resolved; everything else falls back to the state rate.
  const oh = T.taxCents($100, 'OH', '43215');
  ok('Ohio resolves by ZIP', oh > 0 && oh !== T.taxCents($100, 'OH'), oh + ' vs state ' + T.taxCents($100, 'OH'));
  ok('…and falls back to the state rate without one', T.taxCents($100, 'OH') > 0);

  ok('a zero subtotal is never taxed', T.taxCents(0, 'CA') === 0);
  ok('a negative subtotal is never taxed', T.taxCents(-500, 'CA') === 0);
  ok('rounding lands on whole cents', Number.isInteger(T.taxCents(9999, 'CA')));
}

console.log('\n  admin overrides');
{
  // The claim worth pinning: rates are NOT frozen in the file. This is the
  // merge a reviewer reading only the constant will miss.
  const src = fs.readFileSync(ROOT + '/checkout-tax.js', 'utf8');
  ok('the module fetches admin overrides', /api\/tax-config/.test(src));
  ok('…and merges them over the built-in state rates', /Object\.assign\(STATE_RATES,\s*ov\.stateRates\)/.test(src));
  ok('…over the flat-rate states too', /Object\.assign\(FLAT,\s*ov\.flatRates\)/.test(src));
  ok('…and over the per-ZIP tables', /ov\.ohCountyRates/.test(src) && /ov\.ilZip3Rates/.test(src));

  const api = fs.readFileSync(ROOT + '/functions/api/tax-config.js', 'utf8');
  ok('the endpoint reads them from settings', /tax_rate_overrides/.test(api));

  // And prove the merge actually changes the answer.
  const src2 = fs.readFileSync(ROOT + '/checkout-tax.js', 'utf8');
  const win = { addEventListener() {} };
  new Function('window', 'document', 'fetch', 'localStorage', src2)(
    win, { addEventListener() {}, readyState: 'complete' },
    () => Promise.resolve({ ok: true, json: () => Promise.resolve({ stateRates: { CA: 0.99 } }) }),
    { getItem: () => null, setItem() {} }
  );
  // The fetch resolves on a microtask; give it one before asserting.
  Promise.resolve().then(() => {}).then(() => {
    const after = win.ZWCheckoutTax.taxCents(10000, 'CA');
    ok('an override actually changes what is charged', after === 9900, after + ' cents');
    console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
  });
}
