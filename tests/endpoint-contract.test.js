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

  /* ── A refusal must say WHOSE fault it was ────────────────────────────────
     Every throw in create-payment-intent used to land in one catch that
     answered 500, so "your size sold out" and "Stripe is down" were the same
     status. Out of stock is the most ordinary legitimate reason a checkout is
     refused, and it was reporting itself as a server fault — to alerting, to
     retry logic, and to anything reading resp.ok before the body.

     Both directions are asserted, because only the pair is meaningful. A change
     that made everything 409 would satisfy the first check alone while hiding
     real faults, which is strictly worse than what it replaced. */
  console.log('\n  a stale cart is not a server fault');

  const cpi = await import(pathToFileURL(DIR + 'create-payment-intent.js').href).catch(() => null);
  if (!cpi || typeof cpi.onRequestPost !== 'function') {
    ok('create-payment-intent is importable for status checks', false);
  } else {
    const realFetch = globalThis.fetch;
    // Every lookup succeeds and finds nothing — the shape a deleted product,
    // an emptied size row, and an unconfigured settings table all arrive in.
    globalThis.fetch = async () => new Response('[]', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });

    const cartBody = {
      items: [{ id: '00000000-0000-0000-0000-000000000000', size: 'M', quantity: 1 }],
      address: { email: 'probe@example.com', name: 'P', line1: '1 A St', city: 'NY', state: 'NY', zip: '10001', country: 'US' },
    };
    const call = async (env) => {
      try {
        return await cpi.onRequestPost({ request: mockRequest(cartBody), env, params: {}, waitUntil() {} });
      } catch (e) { return e; }
    };

    /* Configured store, product gone. The catalog answered; it just has no such
       row. Nothing is broken, so nothing should read as broken. */
    const stale = await call({
      STRIPE_SECRET_KEY: 'sk_test_' + 'x'.repeat(24),
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
    });
    ok('a missing product returns a Response', stale instanceof Response,
      stale instanceof Error ? 'threw: ' + stale.message : 'returned ' + typeof stale);
    if (stale instanceof Response) {
      ok('a missing product is 4xx, not a server error',
        stale.status >= 400 && stale.status < 500, 'status ' + stale.status);
      let body = null;
      try { body = JSON.parse(await stale.clone().text()); } catch (_) {}
      /* The shopper-facing text must survive the status change — checkout.js
         renders data.error and never looks at the status, so a "fix" that
         emptied the message would pass a status check and blank the screen. */
      ok('a missing product still says what is wrong',
        !!(body && typeof body.error === 'string' && /no longer available/i.test(body.error)),
        body ? JSON.stringify(body).slice(0, 80) : 'no JSON body');
    }

    /* Same request, catalog credentials absent. This one IS ours: the throw is
       untagged, and untagged must stay 500 or the classification has become a
       way to relabel genuine faults as the customer's problem. */
    const broken = await call({ STRIPE_SECRET_KEY: 'sk_test_' + 'x'.repeat(24) });
    ok('an unconfigured catalog returns a Response', broken instanceof Response,
      broken instanceof Error ? 'threw: ' + broken.message : 'returned ' + typeof broken);
    if (broken instanceof Response) {
      ok('an unconfigured catalog is still a 500', broken.status >= 500, 'status ' + broken.status);
    }

    globalThis.fetch = realFetch;
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('harness failed:', e); process.exit(1); });
