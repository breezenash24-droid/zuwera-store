/* A member's cart came to $35 on one load and $40 on the next.
 *
 * The storefront decides membership by asking "is there a session object?" —
 * which an EXPIRED session still passes — while the server calls /auth/v1/user
 * and asks "is this token valid?". Different questions, and they disagree the
 * moment an access token lapses (Supabase issues them for about an hour) while
 * the cached object lives on.
 *
 * It alternated rather than failing outright because the renewal races the
 * checkout: getSession() starts a refresh when the token is stale but resolves
 * with whatever it currently holds. Win the race, member price; lose it, full
 * price. Reloading re-ran the race, so the price looked like a coin toss.
 *
 * getCheckoutAuthPayload must therefore never hand back a token the server
 * would reject. These drive it with the session shapes that produced the bug.
 */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..') + '/';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

/* Lifted from source rather than reimplemented, so this tests the shipped
   function and not a copy of it that can quietly drift. */
const SRC = fs.readFileSync(ROOT + 'checkout.js', 'utf8');
const start = SRC.indexOf('const TOKEN_SAFETY_WINDOW_S');
const end = SRC.indexOf('// ===================== LIVE CATALOG REPRICE');
if (start < 0 || end < 0 || end <= start) {
  console.log('  ✗ could not locate getCheckoutAuthPayload in checkout.js');
  process.exit(1);
}
const load = (win) => new Function('window', 'console',
  SRC.slice(start, end) + '\n;return getCheckoutAuthPayload;'
)(win, { warn() {}, error() {} });

const now = () => Math.floor(Date.now() / 1000);

/* A stub standing in for supabase-js. It records whether a refresh happened,
   which is the whole behaviour under test. */
function client({ expiresIn, token = 'tok_old', refreshTo = 'tok_new', refreshFails = false, noSession = false }) {
  const state = { refreshes: 0 };
  return {
    state,
    sb: {
      auth: {
        getSession: async () => ({
          data: { session: noSession ? null : { access_token: token, expires_at: now() + expiresIn } },
        }),
        refreshSession: async () => {
          state.refreshes += 1;
          if (refreshFails) throw new Error('network');
          return { data: { session: { access_token: refreshTo, expires_at: now() + 3600 } } };
        },
      },
    },
  };
}

(async function () {
  console.log('\n  the token sent is one the server would accept');

  {
    const c = client({ expiresIn: 3600 });
    const out = await load({ sb: c.sb })();
    ok('a healthy token is sent as-is', out.accessToken === 'tok_old', out.accessToken);
    ok('…and is not refreshed needlessly', c.state.refreshes === 0, String(c.state.refreshes));
  }

  {
    // The bug: expired, but the cached object still looks like a session.
    const c = client({ expiresIn: -30 });
    const out = await load({ sb: c.sb })();
    ok('an EXPIRED token is renewed before the quote', c.state.refreshes === 1, String(c.state.refreshes));
    ok('…and the renewed token is the one sent', out.accessToken === 'tok_new', out.accessToken);
  }

  {
    /* Not yet expired, but close enough that it can lapse between here and the
       server reading it. That in-flight window is the race itself. */
    const c = client({ expiresIn: 30 });
    const out = await load({ sb: c.sb })();
    ok('a token about to lapse is renewed too', c.state.refreshes === 1, String(c.state.refreshes));
    ok('…so it cannot expire in flight', out.accessToken === 'tok_new', out.accessToken);
  }

  {
    /* Refresh failed. The stale token is probably useless, but sending it is
       the pre-existing behaviour; dropping it would GUARANTEE guest pricing
       where before it was merely likely. Never send nothing. */
    const c = client({ expiresIn: -30, refreshFails: true });
    const out = await load({ sb: c.sb })();
    ok('a failed refresh still sends what we have', out.accessToken === 'tok_old', out.accessToken);
  }

  {
    const c = client({ expiresIn: 0, noSession: true });
    const out = await load({ sb: c.sb })();
    ok('no session means no token, not a crash', out.accessToken === '', JSON.stringify(out));
    ok('…and nothing is refreshed', c.state.refreshes === 0, String(c.state.refreshes));
  }

  {
    /* Signed-out shoppers are the majority of traffic and must not be broken
       by any of this. */
    const out = await load({})();
    ok('a page with no Supabase client returns empty', out.accessToken === '', JSON.stringify(out));
  }

  {
    /* An expiry we cannot read is exactly the case that was silently costing
       members their discount, so it must renew rather than be trusted. */
    const c = client({ expiresIn: 3600 });
    c.sb.auth.getSession = async () => ({ data: { session: { access_token: 'tok_old' } } });
    const out = await load({ sb: c.sb })();
    ok('a session with no expiry is renewed rather than trusted', c.state.refreshes === 1, String(c.state.refreshes));
    ok('…and sends the renewed token', out.accessToken === 'tok_new', out.accessToken);
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
