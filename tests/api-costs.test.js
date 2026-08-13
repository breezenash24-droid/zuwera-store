/* "Am I paying for anything, and what is about to start?"
 *
 * Every card on the API panel knew its own free tier and nothing added them up.
 * That is how a 0.5% per-order tax charge configured on a different page goes
 * unnoticed for months, and how a store crosses Shippo's 30-label allowance
 * without realising labels have quietly moved to a second billing account.
 *
 * THE RULE FOR THIS PAGE: nothing is invented. Every line is either a rate that
 * is a matter of public record, or a measured position against a published free
 * tier. Where a number cannot be known from here — how many orders you took,
 * what Shippo actually billed — it says so and points at the dashboard that
 * knows, rather than producing a total that looks authoritative and is a guess.
 *
 * A wrong figure on a costs page is worse than no figure, because somebody
 * makes a decision with it. Most of these assertions exist to keep that true.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const ADMIN = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'admin.css'), 'utf8');

const COSTS = new Function(
  ADMIN.slice(ADMIN.indexOf('const SERVICE_COSTS = ['), ADMIN.indexOf('function renderCostSummary'))
  + ';return SERVICE_COSTS;',
)();

console.log('\n  running costs\n');

console.log('  the data is complete and well formed');
{
  ok('several services are priced', COSTS.length >= 7, String(COSTS.length));
  const bad = COSTS.filter((c) => !c.key || !c.name || !c.kind);
  ok('every entry names a service and a kind', bad.length === 0, bad.map((b) => b.key).join(', '));
  const kinds = [...new Set(COSTS.map((c) => c.kind))];
  ok('…and only kinds the renderer handles',
    kinds.every((k) => ['per-sale', 'tiered'].includes(k)), kinds.join(', '));

  const perSale = COSTS.filter((c) => c.kind === 'per-sale');
  ok('anything charged per use states its rate', perSale.every((c) => c.rate), 'a rate is the whole point');
  const tiered = COSTS.filter((c) => c.kind === 'tiered');
  ok('anything with a ceiling states the ceiling', tiered.every((c) => c.free));
  ok('…and says what happens when you cross it', tiered.every((c) => c.over));
}

console.log('\n  the usage readings survive real shapes');
{
  /* Run against the shapes /api/status actually returns, not invented ones —
     a usage function that throws takes the whole panel with it. */
  const real = {
    shippo: { freeTier: { used: 26, limit: 30 } },
    brevo: { credits: 299 },
    deepl: { characterCount: 0, characterLimit: 500000 },
    cloudinary: { credits: { usage: 0.5, limit: 25 } },
    supabase: {}, resend: {},
  };
  const threw = [];
  for (const c of COSTS.filter((x) => x.kind === 'tiered')) {
    for (const shape of [real[c.key] || {}, {}, { credits: null }, { freeTier: null }]) {
      try { c.usage(shape); } catch (e) { threw.push(c.key + ': ' + e.message); }
    }
  }
  ok('no usage reading throws, on a full or an empty response', threw.length === 0, threw.join(' | '));

  const shippo = COSTS.find((c) => c.key === 'shippo');
  ok('Shippo reads its real free-tier position', shippo.usage(real.shippo) === '26 / 30 used');
  ok('…and reports nothing rather than zero when the data is absent', shippo.usage({}) === null);

  const deepl = COSTS.find((c) => c.key === 'deepl');
  ok('DeepL reads characters against the limit', /500,000/.test(deepl.usage(real.deepl)));
}

console.log('\n  it does not invent numbers');
{
  /* The two that genuinely cannot be measured from this page. Saying so is the
     honest answer; a plausible-looking total is not. */
  const resend = COSTS.find((c) => c.key === 'resend');
  ok('Resend admits its usage is not reported', /does not report usage/.test(resend.usage({})));
  const supa = COSTS.find((c) => c.key === 'supabase');
  ok('Supabase points at the dashboard that knows', /only visible in the Supabase dashboard/.test(supa.over));

  const fn = ADMIN.slice(ADMIN.indexOf('function renderCostSummary'), ADMIN.indexOf('function renderApiCard'));
  ok('the page says it is not a bill', /nothing here is a bill/.test(fn));
  /* No arithmetic across services — there is no honest way to add a per-sale
     rate to a free-tier position, and a total would imply there was. */
  ok('…and computes no grand total', !/totalCost|sum\(|reduce\(/.test(fn));
}

console.log('\n  the charge that is easiest to miss');
{
  const fn = ADMIN.slice(ADMIN.indexOf('function renderCostSummary'), ADMIN.indexOf('function renderApiCard'));
  /* Stripe Tax is 0.5% per order it prices, is configured on the Tax page, and
     has no card on this one. It is the exact shape of cost that goes unnoticed. */
  ok('a paid tax engine is listed as a running cost', /_intSignals && _intSignals\.taxEngine/.test(fn));
  ok('…and the free built-in table is not', /!== 'builtin'/.test(fn));
  ok('…nor "no tax at all"', /!== 'none'/.test(fn));
}

console.log('\n  it is rendered, and cannot break the page');
{
  ok('there is somewhere to put it', /id="api-cost-summary"/.test(HTML));
  ok('…above the cards, where the question is asked',
    HTML.indexOf('id="api-cost-summary"') < HTML.indexOf('id="api-grid"'));
  ok('it is rendered on every status load', /renderCostSummary\(s\);/.test(ADMIN));
  const fn = ADMIN.slice(ADMIN.indexOf('function renderCostSummary'), ADMIN.indexOf('function renderApiCard'));
  ok('a missing host is survived rather than thrown on', /if \(!host\) return;/.test(fn));
  /* An unconfigured service costs nothing and should not be listed as if it
     might. */
  ok('services that are not set up are skipped', /s\.configured === false\) continue;/.test(fn));
  ok('every value is escaped', (fn.match(/escapeHtml\(/g) || []).length >= 8);
  ok('the styling exists', /\.api-costs \{/.test(CSS) && /\.api-costs-cols/.test(CSS));
  ok('…and stacks to one column on a narrow screen', /@media \(min-width: 760px\) \{ \.api-costs-cols/.test(CSS));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
