/* Who gets the member price written into their cart.
 *
 * The checkout page re-prices the stored cart from the live catalogue on load,
 * and picked member-vs-regular using isLoggedIn(). That function returned true
 * if a key matching sb-*-auth-token merely EXISTED — not whether it held a
 * session, not whether that session had expired. supabase-js writes the key
 * when it initialises, so signed-out visitors had one too.
 *
 * The result: a guest had the MEMBER price persisted into localStorage while
 * the server correctly quoted the regular one. The header rendered the cart,
 * the summary rendered the server, and the same screen showed $35 and $40.
 * Because the rewrite is async, a reload showed whichever won — so the price
 * looked random, and it SURVIVED refreshes because the wrong number was saved.
 *
 * Reported as: "you go in it and it's at $40, but if you refresh it goes back
 * to the $35 it was."
 */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..') + '/';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

/* Lifted from source so this tests the shipped function, not a copy of it. */
const SRC = fs.readFileSync(ROOT + 'checkout.js', 'utf8');
const start = SRC.indexOf('  function isLoggedIn()');
const end = SRC.indexOf('  async function run()');
if (start < 0 || end < 0 || end <= start) {
  console.log('  ✗ could not locate isLoggedIn in checkout.js');
  process.exit(1);
}
const build = (store) => new Function('localStorage',
  SRC.slice(start, end) + '\n;return isLoggedIn;'
)(store);

// Minimal localStorage: only what the function touches.
function storage(entries) {
  const keys = Object.keys(entries);
  return {
    length: keys.length,
    key: (i) => keys[i],
    getItem: (k) => (k in entries ? entries[k] : null),
  };
}

const KEY = 'sb-qfgnrsifcwdubkolsgsq-auth-token';
const soon = (s) => Math.floor(Date.now() / 1000) + s;

console.log('\n  the member price goes to members');

{
  const live = build(storage({ [KEY]: JSON.stringify({ access_token: 'tok', expires_at: soon(3600) }) }));
  ok('a valid session is a member', live() === true);
}
{
  // Supabase has stored the session wrapped as well as bare over the years.
  const wrapped = build(storage({ [KEY]: JSON.stringify({ currentSession: { access_token: 'tok', expires_at: soon(3600) } }) }));
  ok('…including the older wrapped shape', wrapped() === true);
}
{
  /* THE BUG. An expired token still leaves the key in place, and the old check
     saw the key and said yes — writing $35 into a cart the server prices at
     $40. */
  const expired = build(storage({ [KEY]: JSON.stringify({ access_token: 'tok', expires_at: soon(-60) }) }));
  ok('an EXPIRED session is not a member', expired() === false);
}
{
  /* THE OTHER HALF. supabase-js writes this key on init, so a signed-out
     visitor has one. The key's existence was the entire old test. */
  const empty = build(storage({ [KEY]: 'null' }));
  ok('the key existing with no session is not a member', empty() === false);
}
{
  const noToken = build(storage({ [KEY]: JSON.stringify({ expires_at: soon(3600) }) }));
  ok('a session with no token is not a member', noToken() === false);
}
{
  /* "Cannot tell" must not mean "yes" — treating unknown as a member is the
     mistake in miniature. */
  const noExpiry = build(storage({ [KEY]: JSON.stringify({ access_token: 'tok' }) }));
  ok('a session with no readable expiry is not a member', noExpiry() === false);
}
{
  const junk = build(storage({ [KEY]: 'not json at all' }));
  ok('unparseable storage is not a member, and does not throw', junk() === false);
}
{
  const none = build(storage({ 'some-other-key': 'x' }));
  ok('no auth key at all is not a member', none() === false);
}
{
  /* More than one project key can be present. One valid session is enough, and
     a dead one alongside it must not veto. */
  const two = build(storage({
    'sb-dead-auth-token': JSON.stringify({ access_token: 't', expires_at: soon(-10) }),
    [KEY]: JSON.stringify({ access_token: 'tok', expires_at: soon(3600) }),
  }));
  ok('a live session still counts beside a dead one', two() === true);
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
