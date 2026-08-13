/* Whether the checkout offers PayPal — and what it must never decide for itself.
 *
 * Both server halves of PayPal existed before this and neither was reachable:
 * an endpoint that creates an order, an endpoint that captures it, and nothing
 * on any page calling either. Making them reachable is the safe half — no money
 * moves in this file's subject matter — but "safe" here has two specific
 * meanings that are worth pinning down, because both are easy to lose later.
 *
 * ── ONE: TWO CONDITIONS, NOT ONE ────────────────────────────────────────────
 *
 * Credentials in the environment are not enough to light the button. PAYPAL_ENV
 * defaults to sandbox — deliberately, so a variable that is missing, misspelled
 * or dropped in a migration cannot silently start taking real money — which
 * means the first credentials nearly any store adds are sandbox credentials. If
 * having them were sufficient, saving them would put a button on the live
 * storefront that opens a window no real shopper can pay through. The store
 * would look broken to everyone except the person testing it in sandbox on
 * purpose, which is the person least likely to notice.
 *
 * So: credentials AND an admin switch. The whole endpoint is that one `&&`, and
 * an assertion that reads the source cannot tell an `&&` from an `||`.
 *
 * ── TWO: THE BROWSER NEVER NAMES A PRICE ────────────────────────────────────
 *
 * The button sends the cart. quoteCart() prices it on the server from the
 * catalog, the same call the card path makes, and capture re-prices it and
 * refuses if the total moved. That comparison is the safety of the entire flow,
 * and it is worth exactly nothing if the browser is ever allowed to send an
 * amount instead — so this test watches for one appearing.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const BUTTON   = fs.readFileSync(path.join(ROOT, 'paypal-button.js'), 'utf8');
const CHECKOUT = fs.readFileSync(path.join(ROOT, 'checkout.js'), 'utf8');
const COMMERCE = fs.readFileSync(path.join(ROOT, 'commerce-checkout.js'), 'utf8');
const HTML     = fs.readFileSync(path.join(ROOT, 'checkout.html'), 'utf8');

(async () => {
  const CFG = await import(pathToFileURL(ROOT + '/functions/api/paypal-config.js').href);
  const PP  = await import(pathToFileURL(ROOT + '/functions/api/_paypal.js').href);
  const CM  = await import(pathToFileURL(ROOT + '/functions/api/_commerce.js').href);

  console.log('\n  whether PayPal is offered\n');

  console.log('  it takes both, and only both');
  {
    ok('credentials and the switch → offered',
      CFG.paypalOffered({ configured: true, adminEnabled: true }) === true);
    /* THE ONE THAT MATTERS. This is the state a store is in for the whole gap
       between adding sandbox keys and being ready to go live. */
    ok('credentials without the switch → not offered',
      CFG.paypalOffered({ configured: true, adminEnabled: false }) === false,
      'sandbox keys would put a button on the live storefront that nobody can pay through');
    ok('the switch without credentials → not offered',
      CFG.paypalOffered({ configured: false, adminEnabled: true }) === false);
    ok('neither → not offered',
      CFG.paypalOffered({ configured: false, adminEnabled: false }) === false);
  }

  console.log('\n  what counts as switched on');
  {
    /* An unreadable database, an absent key and a settings row that never
       existed all arrive as something falsy, and none of them is a person
       deciding to accept PayPal. */
    for (const v of [undefined, null, '', 0, 'true', 'yes', 1, {}]) {
      ok('a ' + JSON.stringify(v) + ' does not enable it',
        CFG.paypalOffered({ configured: true, adminEnabled: v }) === false);
    }
  }

  console.log('\n  sandbox is the default, and stays it');
  {
    ok('nothing set → sandbox', PP.paypalConfig({}).mode === 'sandbox');
    ok('a typo → sandbox', PP.paypalConfig({ PAYPAL_ENV: 'LIVE ' }).mode === 'live',
      'trimmed and lowercased, so a trailing space is not a silent downgrade');
    ok('“production” is not “live” → sandbox',
      PP.paypalConfig({ PAYPAL_ENV: 'production' }).mode === 'sandbox',
      'anything not exactly live must read as sandbox — the failure of this default is real money moving unintentionally');
    ok('an id without a secret is not configured',
      PP.paypalConfig({ PAYPAL_CLIENT_ID: 'abc' }).configured === false);
  }

  console.log('\n  the response, end to end');
  {
    const realFetch = globalThis.fetch;
    /* Stubs the one settings read getSetting makes. */
    const withSettings = (value) => { globalThis.fetch = async () => ({
      ok: true, status: 200, json: async () => [{ value }], text: async () => '',
    }); };
    const env = {
      SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'k',
      PAYPAL_CLIENT_ID: 'client-abc', PAYPAL_CLIENT_SECRET: 'SECRET-DO-NOT-LEAK',
    };

    withSettings({ payments: { paypal: { enabled: true } } });
    const on = await (await CFG.onRequestGet({ env })).json();
    ok('offered when both are true', on.enabled === true);
    ok('…and the client id is returned, because the SDK needs it in a URL',
      on.clientId === 'client-abc');

    withSettings({ payments: { paypal: { enabled: false } } });
    const off = await (await CFG.onRequestGet({ env })).json();
    ok('switched off → not offered', off.enabled === false);
    ok('…and no client id is handed out', off.clientId === '');
    /* Two states that need completely different next steps: "add credentials"
       and "turn it on". A single enabled:false cannot tell them apart. */
    ok('…but the panel can still see credentials exist', off.configured === true);

    withSettings({});
    const bare = await (await CFG.onRequestGet({ env })).json();
    ok('a commerce_config with no payments key → not offered', bare.enabled === false);

    /* The database being unreachable is not consent. */
    globalThis.fetch = async () => { throw new Error('supabase down'); };
    const broken = await (await CFG.onRequestGet({ env })).json();
    ok('an unreadable settings row → not offered', broken.enabled === false,
      'failing open on a payment method would be the wrong direction to fail');
    ok('…and it still answers rather than throwing', broken.configured === true);

    withSettings({ payments: { paypal: { enabled: true } } });
    const body = await (await CFG.onRequestGet({ env })).text();
    ok('the secret is never in the response', !/SECRET-DO-NOT-LEAK/.test(body),
      'the client id is public by design; the secret is the whole of the security');

    globalThis.fetch = realFetch;
  }

  console.log('\n  the setting survives being read back');
  {
    /* sanitizeCommerceConfig is the only thing between the stored blob and
       everything that reads it, so a key it does not list is a setting that
       saves, reloads as absent and reverts to off. That exact bug silently
       disabled promo usage limits once already (#145). */
    const out = CM.sanitizeCommerceConfig({ payments: { paypal: { enabled: true } } });
    ok('payments is carried through sanitising',
      out.payments && out.payments.paypal && out.payments.paypal.enabled === true,
      'dropping it here reads as "the PayPal button stopped appearing" with nothing in the panel to explain it');
  }

  console.log('\n  the browser does not name a price');
  {
    ok('the button posts the cart, not a total',
      !/\btotalCents\b|\bamount:\s*\d|value:\s*['"]?\d/.test(BUTTON),
      'capture compares the re-priced cart against the approved amount — a browser-supplied total would make that comparison meaningless');
    ok('…and reads the totals it gets back only for display',
      !/body\.total|payload\.total/.test(BUTTON));
  }

  console.log('\n  one reader of the form');
  {
    /* PayPal needs the identical facts the card path needs, and a second copy
       of the collection block is how a field gets added to the form, wired
       into one collector, and quietly missing from orders placed the other
       way. */
    ok('the form is read in one function', /function collectCheckoutAddress\(\)/.test(CHECKOUT));
    ok('…and the card path calls it', /const collected = collectCheckoutAddress\(\);/.test(CHECKOUT));
    ok('…and the PayPal button calls the same one', /form\.collect\(\)/.test(BUTTON));
    ok('the button does not read the fields itself',
      !/getElementById\(['"]pay-(name|email|addr1|city|zip)/.test(BUTTON),
      'a second collector is a second answer to "where is this going"');

    ok('the shipping rate is settled before an amount is shown',
      /ensureRate\([^)]*\)[\s\S]{0,200}?paypal-create-order/.test(BUTTON),
      'createOrder returns the amount the buyer approves — a rate landing after it moves a figure they already agreed to, and capture then rightly refuses the whole payment');
  }

  console.log('\n  the promo follows the shopper to PayPal');
  {
    /* The wrapper that injects the promo code, the delivery method and the
       feature-flag snapshot used to test `url === '/api/create-payment-intent'`
       — a literal written when there was one payment processor. */
    ok('the injection list is named rather than inline', /PRICED_ENDPOINTS/.test(COMMERCE));
    for (const u of ['/api/create-payment-intent', '/api/paypal-create-order', '/api/paypal-capture']) {
      ok(u + ' gets the promo injected', new RegExp("'" + u + "'").test(COMMERCE));
    }
    ok('…and the comparison is against the list',
      /PRICED_ENDPOINTS\.includes\(url\)/.test(COMMERCE),
      'a shopper would get their discount on a card and not through PayPal');
    /* Capture re-quotes and refuses on a mismatch, so it needs the same promo
       the order was created with or it refuses every discounted order. */
    ok('capture is on the list too, or every promo order fails at the last step',
      /'\/api\/paypal-capture'/.test(COMMERCE));

    ok('the button posts through the wrapped helper', /window\.postJSON/.test(BUTTON),
      'calling fetch directly would bypass the promo injection entirely');
  }

  console.log('\n  a declined funding source is not a dead end');
  {
    ok('a retryable capture reopens the PayPal window', /actions\.restart\(\)/.test(BUTTON));
    ok('…and only for that case', /res\.retryable/.test(BUTTON),
      'restarting on any other failure loops the buyer through a window that will refuse them again');
  }

  console.log('\n  wired into the page');
  {
    ok('there is somewhere to draw it', /id="paypal-button"/.test(HTML));
    ok('…hidden until the config says otherwise', /id="paypal-button"[^>]*display:none/.test(HTML));
    ok('the sandbox notice exists', /id="paypal-test-banner"/.test(HTML));
    ok('the script is loaded', /paypal-button\.js/.test(HTML));

    /* Deferred scripts run in order, so this one must come after both the file
       that publishes ZWCheckoutForm and the file that wraps postJSON. */
    const iBtn = HTML.indexOf('src="paypal-button.js');
    ok('…after checkout.js', HTML.indexOf('checkout.js?') < iBtn);
    ok('…and after commerce-checkout.js', HTML.indexOf('commerce-checkout.js?') < iBtn,
      'loading first would mean the promo wrapper is not installed yet');

    ok('checkout.js publishes the shared form helpers', /window\.ZWCheckoutForm\s*=/.test(CHECKOUT));
    for (const k of ['collect', 'ensureRate', 'payload', 'auth', 'confirmed']) {
      ok('…including ' + k, new RegExp('\\b' + k + ':').test(CHECKOUT.slice(CHECKOUT.indexOf('window.ZWCheckoutForm'))));
    }
  }

  console.log('\n  PayPal credentials stay in Cloudflare');
  {
    const S = await import(pathToFileURL(ROOT + '/functions/api/_settings.js').href);
    for (const k of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_ENV']) {
      ok(k + ' is env-only', S.ENV_ONLY_KEYS.has(k) && !S.ALLOWED_KEYS.has(k));
    }
    /* PAYPAL_ENV is not a credential, which is why it is easy to miss. It
       decides whether payments are real — admin-writable, it would let a
       session flip a store into sandbox, where every payment succeeds on
       screen and no money ever arrives. */
    ok('…and a stored value cannot override the environment',
      S.resolveSetting('PAYPAL_ENV', { PAYPAL_ENV: 'live' }, { PAYPAL_ENV: 'sandbox' }) === 'live',
      'a leftover row must not silently move a live store into sandbox');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
