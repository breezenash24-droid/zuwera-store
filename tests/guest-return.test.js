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

  console.log('\n  the page a guest actually uses');
  {
    const page = fs.readFileSync(ROOT + '/returns.html', 'utf8');

    ok('the returns page offers a way in without an account',
      /data-guest-lookup/.test(page) && /Checked out as a guest/.test(page));
    /* The page renders this prompt TWICE — once before paint so a signed-out
       visitor sees it immediately, and again from init(). The file's own
       comment says to keep them in sync; if only one carries the guest option
       it appears and then vanishes, which is worse than never showing it. */
    ok('…in both copies of the signed-out prompt, so it does not flash and vanish',
      (page.match(/data-guest-lookup/g) || []).length >= 2,
      (page.match(/data-guest-lookup/g) || []).length + ' occurrence(s)');
    /* An attribute rather than an id, precisely BECAUSE it is emitted twice —
       a duplicate id in the shipped file fails the deployment check, and
       binding only the first copy leaves a dead button on the other. */
    ok('…and every copy is wired, not just the first',
      /querySelectorAll\('\[data-guest-lookup\]'\)/.test(page));

    /* Read from the query string and acted on BEFORE getSession(). Somebody who
       clicked the email for this order wants that order, not whatever account
       happens to be signed in on the machine they are using. */
    /* Scoped to init(), because getSession() is called from several functions
       and comparing positions across the whole file compared the guard against
       an unrelated call defined hundreds of lines earlier. */
    const init = page.slice(page.indexOf('async function init()'));
    ok('a return link is honoured before any session check',
      page.includes("const guestToken = params.get('t')")
      && init.includes('if (guestToken) { await renderGuestReturn')
      && init.indexOf('if (guestToken)') < init.indexOf('await getSession()'));

    ok('it talks to the guest endpoint', /fetch\('\/api\/guest-return'/.test(page));
    /* The server's sentence is the same whether or not the lookup matched.
       Rewording it per outcome in the browser would undo that. */
    ok('…and shows the server\'s wording rather than inventing its own',
      /out\.message \|\| out\.error/.test(page));

    ok('an ineligible order shows no form at all',
      /if \(!data\.eligible\)/.test(page));
    ok('the reasons are the page\'s existing list, not a second one',
      /REASONS\.map/.test(page));
    ok('all three resolutions are offered', /value="exchange"/.test(page) && /value="store_credit"/.test(page));
    ok('an empty selection is explained as "the whole order"',
      /return the whole order/i.test(page));

    /* The confirmation email's "View order status" was hardcoded to /account.
       A guest has no account, so it asked them to log in — and on a shared
       computer where somebody else was signed in, it showed THAT person's
       orders. A customer clicking a link in their own receipt landed in a
       stranger's account. */
    /* Every email that offers "see your order" had the same hardcoded /account
       link. One helper decides it now, because it was repeated — the order
       confirmation and the delivered notice both had it, and fixing one would
       have left the other. */
    const { orderStatusUrl } = await import(pathToFileURL(ROOT + '/functions/api/_email.js').href);
    ok('an account holder goes to their account',
      orderStatusUrl({ userId: 'u1', orderNumber: '#ZW-1' }).endsWith('/account'));
    ok('a guest goes to the lookup, carrying the order number',
      orderStatusUrl({ userId: null, orderNumber: '#ZW-1' }).includes('/returns?order='));
    ok('…and without one, still somewhere useful',
      orderStatusUrl({ userId: null, orderNumber: '' }).endsWith('/returns'));

    /* No email template may hardcode this again. Both the order confirmation
       and the delivered notice did. */
    const emailFiles = fs.readdirSync(ROOT + '/functions/api')
      .filter((f) => f.endsWith('.js') && f !== '_email.js');
    const hardcoded = emailFiles.filter((f) => {
      const src = fs.readFileSync(ROOT + '/functions/api/' + f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return /zuwera\.store\/account/.test(src);
    });
    ok('no template hardcodes an account link any more', hardcoded.length === 0, hardcoded.join(', '));

    /* confirm.html is the AUTH page — password resets, email verification.
       "View your order" pointed there and showed a sign-in flow instead. */
    const noConfirm = emailFiles.filter((f) =>
      /confirm\.html\?order=/.test(fs.readFileSync(ROOT + '/functions/api/' + f, 'utf8')));
    ok('…and none sends a customer to the auth page to see an order',
      noConfirm.length === 0, noConfirm.join(', '));

    const fulfil = fs.readFileSync(ROOT + '/functions/api/_fulfil.js', 'utf8');
    /* Plain includes rather than regexes: these assertions are about literal
       strings in source, and escaping them has been a source of its own bugs
       today — twice a regex matched something unintended and passed.

       These now check DELEGATION rather than the inline strings they used to
       pin, because the branch moved into the shared helper above. Pinning the
       old inline form would fail for the right reason and read like a
       regression. */
    ok('the receipt asks the helper where to send this customer',
      fulfil.includes('orderStatusUrl({ userId: meta.user_id'));
    ok('…and keeps no copy of the decision', !fulfil.includes("'https://zuwera.store/account'"));
    /* The returns link is for the RETURNS flow, so it goes to the guest lookup
       for everyone — an account holder reaching it through their account is
       already handled by the status link above. */
    ok('…and the returns link carries the order number for a guest',
      fulfil.includes('orderStatusUrl({ userId: null, orderNumber: meta.order_number })'));
    ok('the page fills that number in', page.includes("params.get('order')"));
    /* Before the session check: the person may have no account AND be on a
       machine where somebody else does. That is the exact case being fixed. */
    ok('…and goes to the lookup without asking anyone to log in',
      page.includes("if (params.get('order')) { renderGuestLookup"));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
