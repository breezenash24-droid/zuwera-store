/* What an order is called.

   There were six formulas for the same order. Orders showed `order_number`
   (#0RT9CPIA). Receipts showed the last eight of the Stripe payment intent.
   The refund log, the approval queue, the returns workspace and the customer's
   own account page each showed the last eight of the row id. And the returns
   endpoint stamped a sixth onto every request as `orderLabel`.

   Nobody notices until they try to look one up — which is what somebody does
   when asked to approve a refund, or when a customer quotes the number from
   their account page. */

const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..') + '/';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

const BROWSER = fs.readFileSync(ROOT + 'order-number.js', 'utf8');
const WORKER = fs.readFileSync(ROOT + 'functions/api/_order-no.js', 'utf8');

const w = {};
new Function('window', BROWSER.replace('typeof window !== \'undefined\' ? window : this', 'window'))(w);
const { orderNo } = new Function(WORKER.replace(/^export\s+/gm, '') + '\n;return { orderNo };')();

console.log('\n  order_number is the real one');
{
  ok('a stored order number wins',
    w.ZWOrderNo({ order_number: '#0RT9CPIA', id: 'abc', stripe_payment_intent_id: 'pi_x' }) === '#0RT9CPIA');
  /* Stored with and without the hash depending on who wrote the row. */
  ok('…however it was stored', w.ZWOrderNo({ order_number: '0RT9CPIA' }) === '#0RT9CPIA');
  ok('…and whitespace does not make it a different order',
    w.ZWOrderNo({ order_number: '  0RT9CPIA  ' }) === '#0RT9CPIA');

  /* The fallbacks stay in the order they were previously trusted, so no
     existing order silently changes the name it has already been called. */
  ok('without one, the payment intent',
    w.ZWOrderNo({ id: 'aaaa1111bbbb2222', stripe_payment_intent_id: 'pi_3QxYzAbCdEfGhIjK' }) === '#DEFGHIJK');
  ok('…and without that, the row id',
    w.ZWOrderNo({ id: '9cb1bb3a-f5bf-4a52-b931-9534aa2f373c' }) === '#AA2F373C');

  ok('a bare id still yields something', w.ZWOrderNo('9cb1bb3a-f5bf-4a52-b931-9534aa2f373c') === '#AA2F373C');
  ok('nothing yields nothing, not "#"', w.ZWOrderNo(null) === '' && w.ZWOrderNo({}) === '');

  /* Search boxes and CSV cells: the hash is noise in one and, in some
     spreadsheets, a comment marker in the other. */
  ok('the plain form drops the hash', w.ZWOrderNoPlain({ order_number: '#0RT9CPIA' }) === '0RT9CPIA');
}

console.log('\n  the Worker agrees with the browser');
{
  /* A Worker cannot load a plain script, so there are two copies. Two copies
     with nothing comparing them is precisely how six formulas accumulated. */
  const cases = [
    { order_number: '#0RT9CPIA' },
    { order_number: '0RT9CPIA' },
    { id: 'aaaa1111bbbb2222', stripe_payment_intent_id: 'pi_3QxYzAbCdEfGhIjK' },
    { id: '9cb1bb3a-f5bf-4a52-b931-9534aa2f373c' },
    {},
    null,
  ];
  const same = cases.every((c) => orderNo(c) === w.ZWOrderNo(c));
  ok('every case gives the same answer on both sides', same,
    'if these drift, an order gets one name in the admin and another in an email');
}

console.log('\n  and nothing keeps its own version');
{
  const files = {
    'admin-main.js': fs.readFileSync(ROOT + 'admin-main.js', 'utf8'),
    'admin-receipts.js': fs.readFileSync(ROOT + 'admin-receipts.js', 'utf8'),
    'admin-returns-ui.js': fs.readFileSync(ROOT + 'admin-returns-ui.js', 'utf8'),
    'account.html': fs.readFileSync(ROOT + 'account.html', 'utf8'),
    'customer-hub.js': fs.readFileSync(ROOT + 'customer-hub.js', 'utf8'),
    'functions/api/customer-hub.js': fs.readFileSync(ROOT + 'functions/api/customer-hub.js', 'utf8'),
  };

  /* The signature of a hand-rolled one: slicing eight characters off the end
     and upper-casing them. Every hit was a place that disagreed with Orders. */
  const offenders = Object.entries(files)
    .filter(([, src]) => /slice\(-8\)\.toUpperCase\(\)/.test(src))
    .map(([name]) => name);
  ok('no page still cuts its own short id', offenders.length === 0, offenders.join(', '));

  ok('the admin delegates rather than keeping a copy',
    /window\.ZWOrderNo\(row\)/.test(files['admin-main.js']));
  ok('the returns endpoint stamps the real one onto a request',
    /orderLabel = orderNo\(matchedOrder\)/.test(files['functions/api/customer-hub.js']));

  /* Deferred, it would render the first list before the formatter existed. */
  const admin = fs.readFileSync(ROOT + 'admin.html', 'utf8');
  const account = fs.readFileSync(ROOT + 'account.html', 'utf8');
  /* `?v=` accepts a HASH, not digits. postinstall runs bump-cache-version.js,
     which rewrites every local asset version into a content hash — so the
     `?v=1` written here becomes `?v=d049b8ca` before the tests run in CI. The
     first version of this assertion matched \d+ and passed locally, where the
     hook had not run since the tag was added, and failed the moment CI did a
     clean install. Nothing was wrong with the code it was guarding. */
  const tag = /<script src="order-number\.js\?v=[0-9a-f]+"><\/script>/;
  ok('both pages load it, and not deferred',
    tag.test(admin) && tag.test(account));
  ok('…before the scripts that call it',
    admin.indexOf('order-number.js') < admin.indexOf('admin-main.js'));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
