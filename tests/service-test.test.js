/* "Run it and show me."
 *
 * The status panel asks each vendor "is this key valid". Worth knowing, and not
 * the question that costs a morning. A key can be perfectly valid while the
 * thing it is for does not work:
 *
 *   — Stripe Tax enabled in the Stripe dashboard but not SELECTED as this
 *     store's engine, so the built-in table quietly prices every order;
 *   — a translate key that is fine against a target language the tag mapping
 *     mangles;
 *   — shipping credentials that are fine against a ship-from address that is
 *     not, which Shippo reports in `messages` rather than as an error;
 *   — a live secret key paired with a test-mode webhook secret, which is the
 *     one that leaves payments succeeding and fulfilment dead on go-live day.
 *
 * None of those is visible to a key-validity check, and every one of them is
 * the sort of thing somebody discovers from a customer.
 *
 * ONLY PROBES THAT SAY SOMETHING NEW. A "test Cloudinary" button that repeats
 * the usage call already on the card is furniture, and furniture is how a panel
 * of buttons stops being read.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SRC = fs.readFileSync(path.join(ROOT, 'functions/api/admin-service-test.js'), 'utf8');
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');

(async () => {
  const mod = await import(pathToFileURL(ROOT + '/functions/api/admin-service-test.js').href);
  const call = (body, env = {}) => mod.onRequestPost({
    request: { headers: { get: () => null }, json: async () => body }, env,
  });

  console.log('\n  service tests\n');

  console.log('  nobody but an admin can run these');
  {
    /* They reach real vendors with the store's own credentials, and the
       shipping probe would let an anonymous caller spend Shippo API quota. */
    const noTok = await call({ service: 'tax' });
    ok('no token → 401', noTok.status === 401);
    const get = await mod.onRequestGet();
    ok('GET is not a way in', get.status === 405);
    ok('every request is verified against Supabase', /await verifyAdmin\(env, token\)/.test(SRC));
    ok('…before any probe runs',
      SRC.indexOf('verifyAdmin') < SRC.indexOf('const probe = PROBES[which]'));
  }

  console.log('\n  an unknown probe is refused, not guessed at');
  {
    ok('the probe list is a lookup, not a string concat', /const PROBES = \{/.test(SRC));
    ok('…and an unknown name is rejected', /Unknown test: /.test(SRC));
    ok('…listing what IS available, so the reply is useful',
      /available: Object\.keys\(PROBES\)/.test(SRC));
  }

  console.log('\n  nothing here spends money or reaches a customer');
  {
    /* The line that keeps this button safe to press. A "test" that buys a label
       or charges a card is a test nobody dares run twice. */
    ok('shipping quotes rates and buys nothing',
      /\/shipments\//.test(SRC) && !/\/transactions\//.test(SRC),
      'transactions/ is the endpoint that PURCHASES a label');
    ok('…and says so in the result', /Nothing was purchased/.test(SRC));
    ok('stripe reads the balance rather than creating anything',
      /v1\/balance/.test(SRC) && !/v1\/payment_intents/.test(SRC));
    ok('no SMS probe exists, because sending one costs money', !/twilio/i.test(SRC));
    ok('email is not here — it has its own endpoint, because sending is not free of consequence',
      !/api\.resend\.com/.test(SRC));
  }

  console.log('\n  the tax probe answers the question the status badge cannot');
  {
    ok('it calls the REAL resolveTax, not a copy',
      /import \{ resolveTax \} from '\.\/_tax\.js'/.test(SRC) && /await resolveTax\(\{/.test(SRC),
      'a probe that reimplements the thing it tests proves only the reimplementation');
    ok('it names the engine that actually priced it', /Priced by \$\{engine\}/.test(SRC));
    /* An address where every engine agrees would prove nothing. */
    ok('…against an address where engines visibly disagree',
      /Cincinnati/.test(SRC) && /7\.8%/.test(SRC));
    ok('…and says when the built-in table is the one answering',
      /state-level only/.test(SRC));
    ok('…and reports a silent fallback, which otherwise looks like success',
      /fellBack/.test(SRC));
  }

  console.log('\n  the stripe probe catches the go-live trap');
  {
    ok('it reports which MODE the key is in', /sk_live_/.test(SRC) && /sk_test_/.test(SRC));
    /* Test and live webhooks are separate endpoints with separate secrets.
       Moving the key without the secret leaves payments succeeding and
       fulfilment dead, with every visible signal saying fine. */
    ok('…and warns that the webhook secret must match that mode',
      /make sure it came from the ' \+ keyMode \+ '-mode endpoint/.test(SRC));
    ok('…and shouts when there is no webhook secret at all',
      /NO STRIPE_WEBHOOK_SECRET is set/.test(SRC));
  }

  console.log('\n  failures report the vendor\'s own words');
  {
    /* "Could not connect" is a morning gone; the actual message is usually the
       fix. This is the lesson from admin-email-test, where a verbatim 422
       naming the From field ended a long hunt. */
    ok('a thrown probe returns its message', /detail: \(e && e\.message\) \|\| String\(e\)/.test(SRC));
    ok('…rather than a generic failure', !/Something went wrong/.test(SRC));
    ok('Shippo\'s real reason is pulled out of messages[]',
      /body\.messages \|\| \[\]/.test(SRC),
      'the cause is almost always the ship-from address, and it lives there');
    ok('Stripe\'s error message is surfaced', /body\.error && body\.error\.message/.test(SRC));
    ok('every probe is timed, so a slow one is distinguishable from a broken one',
      /ms: Date\.now\(\) - started/.test(SRC));
  }

  console.log('\n  the buttons exist and cannot inject');
  {
    ok('there is a shared runner', /async function runServiceTest\(service, btn\)/.test(ADMIN));
    /* A vendor error is untrusted text being written into innerHTML. */
    ok('vendor output is escaped before rendering',
      /escapeHtml\(r\.headline/.test(ADMIN) && /escapeHtml\(r\.detail\)/.test(ADMIN));
    ok('the button is disabled while it runs, so it cannot be double-fired',
      /btn\.disabled = true/.test(ADMIN) && /finally \{ btn\.disabled = false/.test(ADMIN));

    /* Most go through testButton(), which builds the onclick from a template —
       so the literal call string never appears in source and asserting on it
       would fail for the wrong reason. Assert the registration instead. */
    ok('translate has one', /testButton\('translate'/.test(ADMIN));
    ok('stripe has one', /testButton\('stripe'/.test(ADMIN));
    ok('shipping has one', /runServiceTest\('shipping'/.test(ADMIN));
    ok('…and testButton always pairs a button with its output box',
      /id="svctest-\$\{service\}"/.test(ADMIN));
    ok('tax has one, on the page where the engine is chosen', /runServiceTest\('tax'/.test(HTML));

    /* Every button needs its own output box or the result lands nowhere. */
    ok('…and each has somewhere to print its result',
      ADMIN.includes('svctest-shipping') && /id="svctest-\$\{service\}"/.test(ADMIN) && HTML.includes('svctest-tax'));

    /* Buttons and probes must be the same set — a button for a probe that does
       not exist reports "Unknown test" to somebody who did nothing wrong. */
    const probeNames = (SRC.match(/const PROBES = \{[^}]*\}/) || [''])[0];
    ok('every button maps to a real probe',
      ['tax', 'translate', 'shipping', 'stripe'].every((n) => probeNames.includes(n + ':')),
      probeNames);
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✗ suite crashed: ' + e.stack); process.exit(1); });
