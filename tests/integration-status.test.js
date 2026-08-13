/* The integrations panel has to say what is actually happening.
 *
 * THE BUG. integrationConfigured() answers "is a value stored for this", and
 * returns FALSE for every kind:'guide' — correctly, because a guide is set up on
 * the vendor's dashboard and there is nothing in our settings to look at.
 *
 * The panel then used that boolean as the badge. So the two most consequential
 * integrations in the store — Apple Pay, which is taking payments, and Stripe
 * Tax, which is pricing every order — both rendered as "Set up elsewhere",
 * indistinguishable from never having been touched. Neither said so anywhere,
 * and the "N of M connected" count left both out.
 *
 * A guide can now DETECT itself from evidence already in reach: a
 * domain-verification file this site serves, the tax engine the checkout
 * actually calls. Evidence, not a stored intention — and "unknown" when a
 * signal could not be read, never a confident wrong answer.
 *
 * Two relationships are asserted here as well, because both fail silently:
 * `conflicts` (two chat widgets = two bubbles) and `requires` (the Apple Pay QR
 * button rides on card 1's domain verification, so enabling it alone produces a
 * button that appears and then fails — which looks like it works).
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SRC = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');

/* Load the catalogue and the state logic out of the admin bundle and run them
   for real. Asserting on source text would have passed on the broken version —
   the old code READ correctly, it just answered the wrong question. */
function loadModule() {
  const slice = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to));
  const cat  = slice('const ZW_INTEGRATION_CATALOG = [', 'function integrationConfigured');
  const conf = slice('function integrationConfigured', '/* ─── Is it actually working?');
  const fns  = slice('const INTEGRATION_STATES = {', 'function renderIntegrationTroubleshooting');
  // Enough DOM for the module-scope IIFE that remembers the open/closed state.
  const shim = `
    let _maskedKeys = {}; const API_KEY_DEFS = {};
    const localStorage = { getItem: () => null, setItem: () => {} };
    const document = { readyState: 'complete', getElementById: () => null, addEventListener: () => {} };
  `;
  return new Function(shim + cat + conf + fns + `;return {
    CATALOG: ZW_INTEGRATION_CATALOG,
    state: integrationState,
    relations: integrationRelations,
    configured: integrationConfigured,
    STATES: INTEGRATION_STATES,
    setSignals: (s) => { _intSignals = s; },
    setIntegrations: (i) => { _integrations = i; },
  };`)();
}

const M = loadModule();
const find = (k) => M.CATALOG.find((x) => x.key === k);
const stateOf = (k, signals, integrations) => {
  M.setSignals(signals || {});
  M.setIntegrations(integrations || {});
  return M.state(find(k));
};

console.log('\n  integration status\n');

console.log('  the panel loads at all');
{
  ok('the catalogue is there', Array.isArray(M.CATALOG) && M.CATALOG.length > 15, String(M.CATALOG.length));
  ok('there are five states, not two',
    Object.keys(M.STATES).length === 5 && M.STATES.live && M.STATES.attention && M.STATES.unknown);
  /* Every entry has to render. A catalogue entry missing a field is a card that
     throws mid-render and takes the whole grid with it. */
  const broken = M.CATALOG.filter((it) => !it.key || !it.name || !it.cat || !it.kind || typeof it.blurb !== 'string');
  ok('every entry has the fields the card renders', broken.length === 0, broken.map((b) => b.key).join(', '));
  const badKind = M.CATALOG.filter((it) => !['guide', 'toggle', 'storefront', 'server'].includes(it.kind));
  ok('…and a kind the renderer understands', badKind.length === 0, badKind.map((b) => b.key).join(', '));
  /* Relationships must point at entries that exist, or the notice reads
     "Needs undefined set up first". */
  const dangling = [];
  for (const it of M.CATALOG) {
    for (const k of [].concat(it.requires || [], it.conflicts || [], it.pairsWith || [])) {
      if (!find(k)) dangling.push(it.key + ' → ' + k);
    }
  }
  ok('every declared relationship names a real integration', dangling.length === 0, dangling.join(', '));
  /* A conflict only one side declares is a conflict that reports itself on one
     card and not the other. */
  const oneSided = [];
  for (const it of M.CATALOG) {
    for (const k of (it.conflicts || [])) {
      const other = find(k);
      if (other && !(other.conflicts || []).includes(it.key)) oneSided.push(it.key + ' ↔ ' + k);
    }
  }
  ok('…and conflicts are declared on both sides', oneSided.length === 0, oneSided.join(', '));

  /* Every state a card can render must exist in the map, or the badge renders
     `undefined`. Exercised across every entry rather than reasoned about. */
  const bad = [];
  for (const it of M.CATALOG) {
    for (const sig of [{}, { taxEngine: 'stripe_tax', applePayFile: true }, { taxEngine: 'builtin', applePayFile: false }]) {
      const s = stateOf(it.key, sig, {});
      if (!s || !s.states || !s.states.label || !M.STATES[s.state]) bad.push(it.key + '/' + (s && s.state));
    }
  }
  ok('every entry produces a renderable state under every signal set', bad.length === 0, bad.join(', '));
}

console.log('\n  Stripe Tax says whether it is actually pricing orders');
{
  /* Enabling Stripe Tax in the Stripe dashboard does NOT make this store use
     it — Admin → Tax selects the engine. Two switches, two places, and having
     only the first looks finished while the built-in table charges every
     order. */
  const live = stateOf('stripe_tax', { taxEngine: 'stripe_tax' });
  ok('selected as the engine → live', live.state === 'live', live.state + ': ' + live.why);
  ok('…and says what that means', /pricing every order/i.test(live.why));

  const off = stateOf('stripe_tax', { taxEngine: 'builtin' });
  ok('a different engine selected → not live', off.state === 'off', off.state);
  ok('…and names the engine actually in use', /builtin/.test(off.why), off.why);

  const unknown = stateOf('stripe_tax', {});
  ok('signal unavailable → unknown, not a guess', unknown.state === 'unknown', unknown.state);
}

console.log('\n  Apple Pay checks the file Stripe actually fetches');
{
  /* The domain-association file is the one part of Apple Pay this site owns and
     the one part that can silently break — a routing or headers change and
     Stripe's fetch 404s, verification lapses, the button vanishes, and nothing
     errors anywhere. */
  const served = stateOf('apple_pay', { applePayFile: true });
  ok('file served → ready', served.state === 'ready', served.state + ': ' + served.why);
  /* Honest about its limits: a served file cannot prove the domain is
     registered in Stripe, so this must not claim "live". */
  ok('…without overclaiming, because registration cannot be checked from here',
    /if the domain is registered/i.test(served.why));

  const missing = stateOf('apple_pay', { applePayFile: false });
  ok('file missing → attention, not silence', missing.state === 'attention', missing.state);
  ok('…saying the button will not appear', /will not appear/i.test(missing.why));

  const unknown = stateOf('apple_pay', {});
  ok('could not reach it → unknown', unknown.state === 'unknown', unknown.state);

  /* The file has to actually be in the repo, or the check is asserting against
     something that was never deployed. */
  ok('and the verification file is really in the repo',
    fs.existsSync(path.join(ROOT, '.well-known/apple-developer-merchantid-domain-association')));
}

console.log('\n  integrations that must not run together');
{
  const both = { crisp: { id: 'x', enabled: true }, tawk: { id: 'y', enabled: true } };
  const c = stateOf('crisp', {}, both);
  const t = stateOf('tawk', {}, both);
  ok('two chat widgets both on → attention on Crisp', c.state === 'attention', c.state + ': ' + c.why);
  ok('…and on Tawk.to too, not just one of them', t.state === 'attention', t.state);
  ok('…naming the other one', /Tawk/i.test(c.why) && /Crisp/i.test(t.why));
  ok('…and saying why it matters', /bubbles|watching/i.test(c.why), c.why);

  const onlyOne = stateOf('crisp', {}, { crisp: { id: 'x', enabled: true } });
  ok('one on its own is simply live', onlyOne.state === 'live', onlyOne.state);
}

console.log('\n  integrations that depend on another');
{
  /* Turning the QR button on without card 1 produces a button that appears and
     then fails — worse than it not appearing, because it looks like it works. */
  const orphan = stateOf('apple_pay_qr', {}, { apple_pay_qr: { enabled: true } });
  ok('QR button on without its prerequisite → attention', orphan.state === 'attention', orphan.state + ': ' + orphan.why);
  ok('…naming what is missing', /Apple Pay/i.test(orphan.why) && /first/i.test(orphan.why));

  const off = stateOf('apple_pay_qr', {}, {});
  ok('…and an integration that is simply off does not nag', off.state === 'off', off.state);
}

console.log('\n  the count reflects what is running');
{
  /* The old count called integrationConfigured, which is false for every guide,
     so Apple Pay and Stripe Tax — both live — were missing from it. */
  const countLine = SRC.slice(SRC.indexOf('const countEl = document.getElementById(\'integrationCount\')'), SRC.indexOf('// Anything tucked away'));
  ok('the summary counts by state, not by "is a value stored"',
    /ZW_INTEGRATION_CATALOG\.map\(integrationState\)/.test(countLine));
  ok('…and surfaces anything needing attention', /need\$\{needsEyes === 1/.test(countLine) || /needs? attention/.test(countLine));
}

console.log('\n  every card explains itself when it breaks');
{
  const withGuide = M.CATALOG.filter((it) => it.kind === 'guide' || it.kind === 'toggle');
  const documented = M.CATALOG.filter((it) => Array.isArray(it.troubleshoot) && it.troubleshoot.length);
  ok('the most consequential integrations carry troubleshooting',
    documented.length >= 5, documented.length + ' documented of ' + M.CATALOG.length);
  const malformed = documented.filter((it) => it.troubleshoot.some((r) => !r.symptom || !r.cause || !r.fix));
  ok('…and every entry has symptom, cause and fix', malformed.length === 0, malformed.map((m) => m.key).join(', '));

  ok('Apple Pay is one of them', (find('apple_pay').troubleshoot || []).length >= 3);
  ok('Stripe Tax is one of them', (find('stripe_tax').troubleshoot || []).length >= 2);

  ok('the dialog renders them', /function renderIntegrationTroubleshooting/.test(SRC));
  ok('…and is wired into every path that opens it',
    (SRC.match(/renderIntegrationTroubleshooting\(item\)/g) || []).length >= 3);
  const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  ok('…with somewhere to put them', /id="int-setup-trouble"/.test(html));
  ok('…hidden until an integration has some', /id="int-setup-trouble" style="display:none;"/.test(html));
}

console.log('\n  the signals are gathered once, and never block the panel');
{
  ok('there is a signal loader', /async function loadIntegrationSignals/.test(SRC));
  ok('…reading the tax engine actually in use', /\/api\/tax-config/.test(SRC));
  ok('…and probing the Apple Pay verification file', /apple-developer-merchantid-domain-association/.test(SRC));
  /* Drawn immediately, upgraded when the probes land. Awaiting them first would
     blank the panel while a network request runs. */
  ok('the panel paints before the probes finish',
    /renderIntegrationStore\(\);\s*[\s\S]{0,600}?loadIntegrationSignals\(\)/.test(SRC));
  ok('…and a failed probe cannot break the panel', /loadIntegrationSignals\(\)[\s\S]{0,60}?\.catch\(/.test(SRC));

  /* This assertion previously pinned `.then(renderIntegrationStore)` — the
     BROKEN form. A bare function reference in .then receives the resolved value
     as its first argument, and that argument is the search filter, so the
     signals object arrived as a search term, stringified to "[object Object]",
     and emptied the whole catalogue. The test asserted the exact shape of the
     bug and passed. */
  /* Comment-stripped, because the fix's own note quotes the broken form to
     explain it — and a regex that reads prose reports a bug in an explanation.
     That has happened more than once in this repo. */
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  ok('the redraw is not handed the resolved promise value as a search term',
    !/\.then\(renderIntegrationStore\)/.test(CODE),
    '.then(fn) passes its argument — this empties the panel');
  ok('…and the filter ignores anything that is not a string',
    /typeof filter === 'string' \? filter/.test(SRC),
    'a stray Event or promise value must not be treated as a search term');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
