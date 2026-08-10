/* Every endpoint must RETURN a Response. None may throw.
 *
 * create-payment-intent.js called json() and never imported it, so every
 * return path threw ReferenceError — including the catch block. The handler
 * could not report its own failure, Cloudflare answered 1101, and checkout was
 * down. Parsing passed. Imports resolved. Named exports existed. An unbound
 * identifier only fails when its line runs, so nothing static could see it.
 *
 * So this runs them. Each handler is imported for real and invoked with a mock
 * env and a mock request, then the result is checked. A handler that throws
 * fails here instead of in production.
 *
 * The mock env is deliberately EMPTY. Missing configuration is the path every
 * endpoint has and almost nobody exercises — it is the path tonight's bug lived
 * on, and it is the one that runs first when a secret is renamed or an
 * environment is misconfigured. */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..') + '/';
const DIR = ROOT + 'functions/api/';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  \u2014 ' + extra : '')); }
}

/* Payment and money-moving endpoints first — these are the ones where a throw
   costs an order rather than a page. */
const CRITICAL = [
  'create-payment-intent.js',
  'shippo-rates.js',
  'tax-config.js',
  'stripe-webhook.js',
  'admin-refund.js',
  'apple-pay-authorize.js',
  'popup-claim.js',
];

const mockRequest = (body) => new Request('https://zuwera.store/api/x', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

// Nothing configured. The path a renamed secret or a fresh environment takes.
const emptyEnv = {};

/* Endpoints that read rather than charge. These may answer 200 with defaults on
   an unconfigured store; the ones that move money may not. */
const READ_ONLY = new Set(['tax-config.js']);

async function run() {
  console.log('\n  every payment endpoint returns a Response, never throws');

  for (const file of CRITICAL) {
    if (!fs.existsSync(DIR + file)) { ok(file + ' exists', false, 'not found'); continue; }
    let mod = null, importErr = '';
    try {
      mod = await import(pathToFileURL(DIR + file).href);
    } catch (e) { importErr = e.message; }

    /* A module that will not import is a route that 404s or 1101s in
       production. This is the check that would have caught a bad import. */
    ok(file + ' imports cleanly', !!mod, importErr);
    if (!mod) continue;

    const handler = mod.onRequestPost || mod.onRequest || mod.onRequestGet;
    ok(file + ' exports a handler', typeof handler === 'function');
    if (typeof handler !== 'function') continue;

    let result = null, threw = '';
    try {
      result = await handler({ request: mockRequest({}), env: emptyEnv, params: {}, waitUntil() {} });
    } catch (e) {
      threw = (e && e.name === 'ReferenceError' ? 'ReferenceError: ' : '') + ((e && e.message) || String(e));
    }

    /* THE assertion. json() unbound produced exactly this: a throw escaping the
       handler, leaving Cloudflare to answer instead of the code. */
    ok(file + ' does not throw on an unconfigured env', !threw, threw);
    ok(file + ' returns a Response', result instanceof Response,
      result === null ? 'returned nothing' : 'returned ' + typeof result);

    if (result instanceof Response) {
      /* The body has to be readable by the caller. checkout.js does .json() on
         this, and an HTML or empty body is what surfaced as "Unexpected token
         '<'" three layers from the cause. */
      let text = '';
      try { text = await result.clone().text(); } catch (_) {}
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (_) {}
      ok(file + ' answers with JSON the client can read', parsed !== null,
        'status ' + result.status + ', body starts: ' + String(text).slice(0, 60));
      /* Money-moving endpoints must FAIL when unconfigured — quietly returning
         200 would mean an order proceeding on a half-configured store. Read-only
         config endpoints legitimately answer 200 with defaults, so they are
         exempt by name rather than by loosening the rule for everyone. */
      if (!READ_ONLY.has(file)) {
        ok(file + ' refuses rather than claiming success when unconfigured',
          result.status >= 400, 'status ' + result.status);
      }
    }
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('harness failed:', e); process.exit(1); });
