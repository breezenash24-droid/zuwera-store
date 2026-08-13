/* An engine that collects nothing, everywhere, silently.
 *
 * This store is set to Stripe Tax. Stripe Tax charges tax only in jurisdictions
 * you have added a REGISTRATION for in its dashboard. With none added it does
 * not error, does not warn, and does not fall back — it answers 200 OK with
 * tax_amount_exclusive: 0 for every address on earth. A $120 cart to California,
 * New York and Ohio all came back at $0.00 tax on the live site.
 *
 * Every control on the Tax page reported this as healthy, because every control
 * on the Tax page reports what is CONFIGURED. The engine label said "💳 Stripe
 * Tax" in confident green. The fallback never fired, because nothing failed. The
 * logs were clean. The first thing that would have gone wrong is a filing.
 *
 * So the page now asks rather than assumes. The subtlety, and the whole reason
 * this is a test and not a one-line check, is that ZERO IS OFTEN CORRECT:
 * Oregon has no sales tax, clothing is exempt in Pennsylvania and under $110 a
 * garment in New York. A check that shouted at every zero would be noise, and
 * noise gets turned off. It has to shout only at the pattern that cannot be
 * innocent — nothing, in states that tax what this store sells.
 *
 * The other half is the failure that must NOT shout: if the probe itself cannot
 * reach the endpoint, that is unknown, not zero. Reporting a network blip as
 * "you are collecting nothing" sends someone into their Stripe dashboard to fix
 * a problem they do not have, and the next real alarm is the one they ignore.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const TAXJS = fs.readFileSync(path.join(ROOT, 'admin-tax.js'), 'utf8');
const HTML  = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');

/* The real source, lifted and run. Asserting that a comparison EXISTS is how a
   check that has been disabled goes on passing, which this session has already
   been caught by once. */
const START = TAXJS.indexOf('const TAX_HEALTH_PROBES');
const END   = TAXJS.indexOf('const TAX_ENGINE_META');
if (START < 0 || END < START) {
  console.log('  ✗ could not find the health check in admin-tax.js');
  process.exit(1);
}
const SRC = TAXJS.slice(START, END);

/* answers: state code -> what /api/tax-quote replies, or an Error to throw. */
function build(engine, answers) {
  const box = { id: 'tax-engine-health', innerHTML: '' };
  const sel = { value: engine };
  const nodes = { 'tax-engine-health': box, 'tax-engine-select': sel };
  const asked = [];

  const document = { getElementById: (i) => nodes[i] || null };
  const window = {
    TAX_ENGINE_META: {
      builtin:    { icon: '📋', name: 'Built-in table' },
      stripe_tax: { icon: '💳', name: 'Stripe Tax' },
      taxjar:     { icon: '🧮', name: 'TaxJar' },
      none:       { icon: '🚫', name: 'Collect no tax' },
    },
  };
  const fetch = async (url) => {
    asked.push(url);
    const state = (String(url).match(/[?&]state=([A-Z]{2})/) || [])[1] || '';
    const a = answers[state];
    if (a instanceof Error) throw a;
    if (a && a.httpStatus) return { ok: false, status: a.httpStatus };
    return { ok: true, status: 200, json: async () => a || {} };
  };

  const api = new Function('document', 'window', 'fetch', `
    ${SRC}
    return { taxEngineHealth, escH, PROBES: TAX_HEALTH_PROBES, AMOUNT: TAX_HEALTH_AMOUNT };
  `)(document, window, fetch);

  return { box, api, asked, run: () => api.taxEngineHealth() };
}

const ZERO = { rate: 0, taxCents: 0, engine: 'stripe_tax' };

(async () => {

console.log('\n  is the tax engine actually collecting anything\n');

console.log('  the live failure: zero everywhere, no error');
{
  const h = build('stripe_tax', { CA: ZERO, TX: ZERO, OH: ZERO });
  await h.run();
  ok('it says so, out loud', /returning no tax anywhere/.test(h.box.innerHTML),
    'this is the exact state the live store was in and nothing on the page reported it');
  ok('…in red rather than as a note', /ef4444/.test(h.box.innerHTML));
  ok('…naming the engine that is doing it', /Stripe Tax/.test(h.box.innerHTML));
  ok('…and the states it asked about', /CA/.test(h.box.innerHTML) && /TX/.test(h.box.innerHTML));

  /* An alarm that does not say what to do is an alarm that gets lived with.
     For Stripe Tax the cause is one screen away and is almost never anything
     else. */
  ok('it points at registrations, which is the actual cause',
    /Registrations/.test(h.box.innerHTML) && /registration/i.test(h.box.innerHTML));
  ok('…and says to start with the home state', /home state/.test(h.box.innerHTML));
}

console.log('\n  a working engine');
{
  const h = build('stripe_tax', {
    CA: { taxCents: 1025 }, TX: { taxCents: 825 }, OH: { taxCents: 780 },
  });
  await h.run();
  ok('no alarm', !/returning no tax anywhere/.test(h.box.innerHTML));
  ok('it confirms rather than going blank', /is returning tax/.test(h.box.innerHTML),
    'silence reads the same whether the check ran or not');
  ok('…with the figures it got back', /\$10\.25/.test(h.box.innerHTML) && /\$7\.80/.test(h.box.innerHTML));
}

console.log('\n  a zero that is legitimate');
{
  /* Registered in California only. Two zeroes and one charge is a store with
     one registration, which is a normal and correct way to be. */
  const h = build('stripe_tax', { CA: { taxCents: 1025 }, TX: ZERO, OH: ZERO });
  await h.run();
  ok('one state collecting is enough to be quiet', !/returning no tax anywhere/.test(h.box.innerHTML),
    'shouting at every zero would make the check worthless — most stores are registered in one state');
  ok('…and the silent ones are still named', /TX/.test(h.box.innerHTML) && /OH/.test(h.box.innerHTML));
  ok('…as expected rather than as a fault', /expected if you are not registered/.test(h.box.innerHTML));
}

console.log('\n  not knowing is not the same as zero');
{
  const h = build('stripe_tax', {
    CA: new Error('network'), TX: new Error('network'), OH: new Error('network'),
  });
  await h.run();
  ok('a dead endpoint is reported as unknown', /Could not check/.test(h.box.innerHTML));
  ok('…not as an alarm', !/returning no tax anywhere/.test(h.box.innerHTML),
    'a blip would send someone into Stripe to fix a problem they do not have');
  ok('…and not as a pass', !/is returning tax/.test(h.box.innerHTML));
  ok('…saying it is a check on this page, not on checkout',
    /does not mean checkout is affected/.test(h.box.innerHTML));
}
{
  const h = build('stripe_tax', { CA: { httpStatus: 500 }, TX: { httpStatus: 500 }, OH: { httpStatus: 500 } });
  await h.run();
  ok('an HTTP error is unknown too', /Could not check/.test(h.box.innerHTML));
}
{
  const h = build('stripe_tax', { CA: { unavailable: true }, TX: { unavailable: true }, OH: { unavailable: true } });
  await h.run();
  ok('the endpoint saying "unavailable" is unknown, not zero', /Could not check/.test(h.box.innerHTML),
    'tax-quote answers 200 {unavailable:true} when resolveTax cannot run — reading that as taxCents 0 would be a false alarm');
}

console.log('\n  a partial answer still counts');
{
  /* One probe unreachable, the two that answered both zero. The evidence that
     is present is still evidence. */
  const h = build('stripe_tax', { CA: new Error('timeout'), TX: ZERO, OH: ZERO });
  await h.run();
  ok('two zeroes and a timeout is still the alarm', /returning no tax anywhere/.test(h.box.innerHTML));
  const text = h.box.innerHTML.replace(/<[^>]*>/g, '');
  ok('…naming the two it heard from', /\bTX\b/.test(text) && /\bOH\b/.test(text));
  ok('…and not the one it never reached', !/\bCA\b/.test(text),
    'listing a state that timed out as returning $0.00 would be a made-up fact');
}

console.log('\n  the backup answering is worth saying');
{
  const h = build('stripe_tax', {
    CA: { taxCents: 900, fallbackFrom: 'stripe_tax' },
    TX: { taxCents: 800, fallbackFrom: 'stripe_tax' },
    OH: { taxCents: 700, fallbackFrom: 'stripe_tax' },
  });
  await h.run();
  ok('a fallback answer is not passed off as the provider',
    /backup table/i.test(h.box.innerHTML),
    'these are the table’s rates under the provider’s name — the exact confusion the rest of this page exists to prevent');
  ok('…and it still counts as collecting', /is returning tax/.test(h.box.innerHTML));
}

console.log('\n  collecting nothing on purpose');
{
  const h = build('none', { CA: ZERO, TX: ZERO, OH: ZERO });
  await h.run();
  ok('“collect no tax” collecting no tax is the setting working', h.box.innerHTML === '');
  ok('…and it does not even ask', h.asked.length === 0, 'three pointless requests on every page load');
}

console.log('\n  which states it asks about');
{
  const h = build('stripe_tax', {});
  const states = h.api.PROBES.map((p) => p.state);

  /* THE ASSERTION THE WHOLE CHECK RESTS ON. A zero only means something in a
     state where a positive answer was owed. Probe New York with a $100 garment
     and the correct answer is zero — clothing under $110 is exempt there — and
     the check would cry wolf at a perfectly healthy store on every page load. */
  const EXEMPTING = ['NY', 'PA', 'NJ', 'MN', 'MA', 'VT', 'RI'];
  const NO_SALES_TAX = ['OR', 'NH', 'MT', 'DE', 'AK'];
  ok('no state that exempts clothing', !states.some((s) => EXEMPTING.includes(s)),
    'a clothing store would show a false alarm forever');
  ok('no state with no sales tax at all', !states.some((s) => NO_SALES_TAX.includes(s)));
  ok('more than one, so a single odd jurisdiction cannot decide it', states.length >= 3);
  ok('each carries a ZIP', h.api.PROBES.every((p) => /^\d{5}$/.test(p.zip)),
    'rates are county- and city-level; a bare state code is not enough to price');

  /* Above New York's $110 threshold anyway, so adding NY later would not
     quietly reintroduce the false alarm. */
  ok('the probe amount is a realistic order', h.api.AMOUNT >= 5000 && h.api.AMOUNT <= 50000);
}

console.log('\n  it measures the path customers are on');
{
  const h = build('stripe_tax', { CA: ZERO, TX: ZERO, OH: ZERO });
  await h.run();
  ok('it asks /api/tax-quote', h.asked.every((u) => u.startsWith('/api/tax-quote')),
    'calling Stripe directly would test a path no customer takes — tax-quote runs the same resolveTax() the charge does');
  ok('…with an amount, or the answer is zero by arithmetic',
    h.asked.every((u) => /[?&]amount=[1-9]/.test(u)),
    'this is exactly the mistake that made the first report of this bug wrong: no amount, so tax on nothing was nothing');
  ok('…and shipping, which several states tax', h.asked.every((u) => /[?&]shipping=/.test(u)));
  ok('…uncached, so a fixed registration shows up on reload',
    /cache: 'no-store'/.test(SRC), 'tax-quote is edge-cached for five minutes');
}

console.log('\n  built by concatenation, so escaped');
{
  const h = build('stripe_tax', {});
  ok('markup in a name cannot become markup',
    h.api.escH('<img src=x onerror=1>') === '&lt;img src=x onerror=1&gt;');
  ok('quotes too, since these land in style attributes',
    h.api.escH('a"b') === 'a&quot;b');
}

console.log('\n  wired into the page');
{
  ok('the banner has somewhere to render', /id="tax-engine-health"/.test(HTML));
  ok('loading the tax settings runs the check',
    /window\.taxEngineOnChange\(\);\s*taxEngineHealth\(\);/.test(TAXJS));
  /* Changing the engine is the one moment the answer is most likely to have
     changed, and taxEngineLoad is what runs afterwards. */
  ok('changing the engine re-runs it', /closeTaxEngineModal\(\); taxEngineLoad\(\);/.test(TAXJS));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

})();
