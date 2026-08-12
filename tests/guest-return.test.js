/* Returns for people who never made an account.
 *
 * Guest checkout is the default path — on this store's own numbers the largest
 * single spender has no profile at all — and the entire returns flow hung off
 * the account page. "Create an account to send back the thing you already
 * bought" is a support email, not a policy.
 *
 * The security property worth testing is not "does it work". It is that a
 * lookup cannot be used to LEARN anything. Order numbers are printed on packing
 * slips and are not secret, so an endpoint that answers "no such order"
 * differently from "here you go" is a way to test which order numbers exist and
 * which email belongs to each. Every reply to `start` is therefore identical,
 * and access is delivered by emailing the address already on the order rather
 * than handing it back to whoever asked.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SRC = fs.readFileSync(ROOT + '/functions/api/guest-return.js', 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

(async () => {
  const { pathToFileURL } = require('url');
  const mod = await import(pathToFileURL(ROOT + '/functions/api/guest-return.js').href);

  const post = (body, env = {}) => mod.onRequestPost({
    request: new Request('https://zuwera.store/api/guest-return', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env: { SITE_URL: 'https://zuwera.store', ...env },
  });

  console.log('\n  guest returns\n');

  console.log('  a lookup teaches you nothing');
  {
    /* No Supabase configured, so nothing can be found — which is exactly the
       "wrong guess" case. It must read the same as a right one. */
    const miss = await post({ action: 'start', orderNumber: 'ZW-0001', email: 'nobody@nowhere.test' });
    const missBody = await miss.json();
    const miss2 = await post({ action: 'start', orderNumber: 'GARBAGE', email: 'x' });
    const miss2Body = await miss2.json();

    ok('an unmatched lookup still answers 200', miss.status === 200, String(miss.status));
    ok('…with the same words every time',
      JSON.stringify(missBody) === JSON.stringify(miss2Body), JSON.stringify(missBody));
    ok('…which promise nothing about whether the order exists',
      /If that order number and email match/.test(missBody.message || ''), missBody.message);
    /* The single most important line in the file. */
    ok('the reply is one shared object, so the branches cannot drift apart',
      /const same = json\(/.test(CODE));
    /* The property: whatever goes wrong inside `start` — no order, no signing
       secret, the mail provider down — the caller gets `same`. Asserted by
       checking the catch returns it, rather than by grepping for the word
       "send", which matched "you are sending it back" in an unrelated
       validation message and would have passed on anything. */
    const startBlock = CODE.slice(CODE.indexOf("action === 'start'"), CODE.indexOf("action === 'lookup'"));
    ok('every path out of the lookup returns the same reply',
      /catch \(e\) \{[\s\S]*?console\.error\('\[guest-return\] start failed[\s\S]*?\}\s*return same;/.test(startBlock),
      'catch does not fall through to `same`');
    ok('…including when there is no signing secret',
      /link not sent'\);\s*return same;/.test(startBlock));
    /* Anchored to the start of a line, so it counts RETURN STATEMENTS. Matching
       "return " anywhere caught "Start your return for order" inside the email
       copy and reported a control-flow problem that did not exist. */
    const stray = startBlock.match(/^\s*return\s+(?!same\b)/gm) || [];
    ok('…and it never returns anything but `same`', stray.length === 0,
      stray.length + ' early return(s) that are not `same`');
  }

  console.log('\n  access is emailed, never returned');
  {
    ok('the token goes out in an email', /sendTransactional\(/.test(CODE));
    ok('…to the address on the ORDER, not the one typed in',
      /to: order\.email/.test(CODE));
    /* If the token came back in the response, guessing an order number would
       be enough — the email step is the whole control. */
    ok('…and never comes back in the response body',
      !/json\(\{[^}]*token/.test(CODE), 'a token appears in a response');
    ok('the link is short-lived', /TOKEN_TTL_MS/.test(CODE));
  }

  console.log('\n  the token is narrow');
  {
    ok('it is signed', /hmac\(body, secret\)/.test(CODE));
    ok('…and compared in constant time', /constantTimeEqual/.test(CODE));
    ok('…and expiry is checked on read', /Date\.now\(\) > payload\.exp/.test(CODE));
    /* It shares a signing key with the shipping-rate token when no dedicated
       secret is set, so the purpose has to be inside the signed body — without
       it, one kind of token could be presented as the other. */
    ok('it carries a purpose, so another token cannot be used as this one',
      /p: 'guest-return'/.test(CODE) && /payload\.p !== 'guest-return'/.test(CODE));
    ok('…and names exactly one order', /o: String\(orderId/.test(CODE));

    const bad = await post({ action: 'lookup', token: 'forged.signature' });
    ok('a forged token is refused', bad.status === 401, String(bad.status));
    const none = await post({ action: 'submit', token: '' });
    ok('a missing token is refused', none.status === 401, String(none.status));
  }

  console.log('\n  a guest gets the same rules, not looser ones');
  {
    /* A second door into the same room. If the guest path checked eligibility
       differently, it would become the way round the rules. */
    ok('eligibility is the shared function', /returnEligibility\(order, mine, say\)/.test(CODE));
    ok('items are reconciled by the shared function',
      /reconcileReturnItems\(order, submitted, spokenForOn\(mine, order\.id\)\)/.test(CODE));
    /* Falling back to the whole order when every line was rejected is the
       worst possible reading of "none of that was valid". */
    ok('an all-invalid selection is refused, not widened to the whole order',
      /if \(!items\.length\)/.test(CODE) && /items_invalid/.test(CODE));
    ok('an empty selection still means the whole order', /availableItems/.test(CODE));
    ok('a reason is required', /Please tell us why/.test(CODE));
  }

  console.log('\n  it cannot read anything else');
  {
    /* The token names one order. Reading that email's other orders, or the
       whole returns list, would turn a return link into an account. */
    ok('the order is fetched by id, one row',
      /orders\?id=eq\.' \+ encodeURIComponent\(orderId\)/.test(CODE) && /limit=1/.test(CODE));
    ok('only this order\'s return history is returned',
      /String\(r\.orderId\) === String\(order\.id\)/.test(CODE));
    ok('the response carries no other customer field',
      !/user_id|profiles/.test(CODE));
  }

  console.log('\n  the admin queue can tell');
  {
    /* A blank userId reads like a data fault. Saying "guest" says what it is. */
    ok('a guest request is flagged as one', /guest: true/.test(CODE));
    ok('…and still carries what the queue renders',
      ['orderLabel', 'orderTotal', 'orderItems', 'shippingAddress', 'customerName']
        .every((f) => new RegExp(f + ':').test(CODE)));
    ok('the order number matches what is printed on the receipt',
      /orderNo\(order\)/.test(CODE));
    ok('the write is compare-and-set, not read-modify-write',
      /mutateSetting\(env, 'commerce_returns'/.test(CODE));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
