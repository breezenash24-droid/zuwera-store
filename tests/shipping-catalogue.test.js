/* Two shipping platforms in the catalogue, listed as what they are.
 *
 * Shipping already works: /api/shippo-rates asks Shippo and Veeqo together,
 * dedupes by carrier+service, takes the cheaper, and lets Veeqo carry on alone
 * once Shippo's free tier is spent. The provider that quoted is signed into the
 * rate token so the label is bought from the same one.
 *
 * EasyPost and ShipStation are not in that path. So the only honest way to list
 * them is kind:'guide' — the same treatment the sales-tax providers get, and
 * for the same reason: nothing reads their keys, so a card offering to "connect"
 * one would be offering something that does not exist. The failure that avoids
 * is specific and quiet — a card that looks finished while checkout carries on
 * quoting from somewhere else entirely.
 *
 * Which is why the detectors are the part worth testing. A key set for a
 * provider nothing reads is WORSE than no key, because it looks done; that state
 * has to shout rather than sit there reading "off". And when rates already work,
 * the card should say so, because "do I need this?" is the actual question
 * somebody is opening it to answer.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  × ' + e : '')); } };

const SRC = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');

/* The real catalogue and the real state logic, run rather than read. Asserting
   on source text would pass just as happily on a card wired the wrong way. */
function loadModule() {
  const slice = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to));
  const cat  = slice('const ZW_INTEGRATION_CATALOG = [', 'function integrationConfigured');
  const conf = slice('function integrationConfigured', '/* ─── Is it actually working?');
  const fns  = slice('const INTEGRATION_STATES = {', 'function renderIntegrationTroubleshooting');
  const shim = `
    let _maskedKeys = {}; const API_KEY_DEFS = {};
    const localStorage = { getItem: () => null, setItem: () => {} };
    const document = { readyState: 'complete', getElementById: () => null, addEventListener: () => {} };
  `;
  return new Function(shim + cat + conf + fns + `;return {
    CATALOG: ZW_INTEGRATION_CATALOG,
    state: integrationState,
    setSignals: (s) => { _intSignals = s; },
    setIntegrations: (i) => { _integrations = i; },
    setKeys: (k) => { _maskedKeys = k || {}; },
  };`)();
}

const M = loadModule();
const find = (k) => M.CATALOG.find((x) => x.key === k);
const stateOf = (k, keys) => {
  M.setSignals({ loaded: true });
  M.setIntegrations({});
  M.setKeys(keys || {});
  return M.state(find(k));
};

/* What a store that has shipping working today actually has set. */
const WIRED = { SHIPPO_API_KEY: 'shippo_live_••••', VEEQO_API_KEY: '••••' };

console.log('\n  EasyPost and ShipStation\n');

console.log('  they are in the catalogue');
{
  for (const k of ['easypost', 'shipstation']) {
    const it = find(k);
    ok(k + ' is listed', !!it);
    if (!it) continue;
    ok('…with a name, blurb and cost', !!it.name && !!it.blurb && !!it.free);
    ok('…filed under Shipping', it.cat === 'Shipping', it.cat);
    ok('…with a link to the provider', /^https:\/\//.test(it.docs || ''), it.docs);
    ok('…and steps that end somewhere actionable', Array.isArray(it.steps) && it.steps.length >= 4);
  }
  /* Search is by name, category and blurb, so the category is the thing that
     makes both findable by typing "shipping". */
  const shipping = M.CATALOG.filter((it) => it.cat === 'Shipping');
  ok('searching the catalogue for shipping finds both', shipping.length === 2, String(shipping.length));
}

console.log('\n  listed as guides, because nothing reads their keys');
{
  /* THE CLAIM THAT WOULD BE FALSE. kind:'server' renders a "Set up" button and
     a key field, and saves through the masked key store — which for these two
     would store a secret that no code path ever looks at. */
  ok('easypost is a guide, not a key entry', find('easypost').kind === 'guide');
  ok('shipstation is a guide, not a key entry', find('shipstation').kind === 'guide');
  ok('neither claims a `service` to save a key against',
    !find('easypost').service && !find('shipstation').service);

  /* Rate-shopping really is two providers, and the cards say so rather than
     implying they would be joining an empty seat. */
  const RATES = fs.readFileSync(path.join(ROOT, 'functions/api/shippo-rates.js'), 'utf8');
  ok('shippo-rates does not know about easypost', !/easypost/i.test(RATES));
  ok('…nor shipstation', !/shipstation/i.test(RATES));
  ok('…and the two it does know are named in the card copy',
    /Shippo and Veeqo/.test(find('easypost').detect({}, { maskedKeys: WIRED }).why));
}

console.log('\n  a key nobody reads is worse than no key');
{
  /* This is the state that must not read as "off". Somebody pastes a key,
     the card says nothing changed, and they reasonably conclude shipping is
     now going through EasyPost. It is not, and nothing would ever tell them. */
  const e = stateOf('easypost', { ...WIRED, EASYPOST_API_KEY: 'EZ••••' });
  ok('a stray EASYPOST_API_KEY raises attention', e.state === 'attention', e.state);
  ok('…and says nothing reads it', /nothing reads it/.test(e.why));
  ok('…and says what is quoting instead', /Shippo and Veeqo/.test(e.why));

  const s = stateOf('shipstation', { ...WIRED, SHIPSTATION_API_KEY: 'SS••••' });
  ok('a stray SHIPSTATION_API_KEY raises attention', s.state === 'attention', s.state);
  /* ShipStation is Basic auth — two credentials. Either one alone is just as
     misleading as both. */
  const secretOnly = stateOf('shipstation', { ...WIRED, SHIPSTATION_API_SECRET: 'SS••••' });
  ok('…and so does the secret on its own', secretOnly.state === 'attention', secretOnly.state);
  ok('…because it takes a key AND a secret',
    /API Key and API Secret/.test(find('shipstation').steps.join(' ')));
}

console.log('\n  answering "do I need this?"');
{
  const both = stateOf('easypost', WIRED);
  ok('with both providers set, easypost is off', both.state === 'off');
  ok('…and says rates are already being shopped', /already rate-shop/.test(both.why));
  ok('…and names the two reasons it would still be worth it',
    /coverage/.test(both.why) && /negotiated/.test(both.why));

  const one = stateOf('easypost', { SHIPPO_API_KEY: 'shippo_live_••••' });
  ok('with only Shippo, it is an alternative rather than an addition',
    /alternative rather than an addition/.test(one.why), one.why);

  /* The one case where the card is genuinely useful advice. */
  const none = stateOf('easypost', {});
  ok('with nothing quoting, it says this is worth a look', /worth a look/.test(none.why), none.why);

  /* ShipStation is not a rate provider, and the commonest mistake is treating
     it as a Shippo replacement. The card refuses to imply that. */
  const ss = stateOf('shipstation', WIRED);
  ok('shipstation says it is not a replacement', /not a replacement/.test(ss.why), ss.why);
  ok('…and names what it actually solves', /packing and batch labels/.test(ss.why));
}

console.log('\n  the detectors survive being called before signals land');
{
  /* renderIntegrationStore paints once from settings and again once the probes
     return, so every detector runs at least once with nothing in hand. A throw
     here is caught and shown as "unknown", which would hide a real answer the
     masked keys could already have given. */
  for (const k of ['easypost', 'shipstation']) {
    const it = find(k);
    let threw = false;
    for (const ctx of [undefined, {}, { maskedKeys: undefined }, { maskedKeys: {} }]) {
      try { it.detect({}, ctx); } catch (_) { threw = true; }
    }
    ok(k + ' never throws on a missing context', !threw);
    ok('…and still returns a usable state', ['off', 'attention'].includes(it.detect({}, {}).state));
  }
}

console.log('\n  nothing else moved');
{
  /* Adding to the array is easy to get wrong in a way that only shows up as
     another card quietly vanishing. */
  const keys = M.CATALOG.map((i) => i.key);
  ok('no duplicate keys', new Set(keys).size === keys.length);
  for (const k of ['clarity', 'crisp', 'slack', 'stripe_tax', 'apple_pay', 'taxjar', 'sovos']) {
    ok(k + ' is still there', keys.includes(k));
  }
  const noDocs = M.CATALOG.filter((i) => i.kind === 'guide' && !i.docs);
  ok('every guide still links somewhere', noDocs.length === 0, noDocs.map((i) => i.key).join(', '));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
