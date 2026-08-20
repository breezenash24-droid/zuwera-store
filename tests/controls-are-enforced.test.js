/* Four controls that reported a state they could not produce.
 *
 * Every one of these EXISTED before this file did. That is the point: a feature
 * you do not have is a known quantity, and a switch that says it is on gets
 * trusted in exactly the moment it fails. The audit that produced this list
 * found no missing security features at all — it found four that stopped short
 * of the thing they appeared to do.
 *
 *   A1  MFA was enforced by the login SCREEN. /auth/v1/user answers for an
 *       aal1 token, so a session that never passed the challenge resolved to a
 *       full admin at all 21 endpoints that call verifyAdmin.
 *
 *   A2  The audit log was written by the BROWSER, with admin_user_id taken
 *       from the page's own idea of who it was, and one failure set
 *       auditTableReady = false for the rest of the session.
 *
 *   A3  Turnstile guarded ONE FORM. /api/verify-turnstile had a single caller
 *       and no endpoint required a token. Application rate limiting existed in
 *       5 of 117 endpoint files, none of them public.
 *
 *   A4  The Content-Security-Policy was on the Report-Only header.
 *       (Held by tests/csp-is-enforced-and-complete.test.js — it needed a
 *       whole file, because promoting it safely meant proving the allow-list
 *       matched the code.)
 *
 * Source-level assertions. These are shapes, not behaviours: what they hold is
 * that the enforcement stays in the one place it cannot be forgotten from.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
/* Comments stripped. These files EXPLAIN what was removed — the audit latch and
   the forgeable header are each named at length in the prose saying why they
   are gone — so an absence assertion that reads comments finds the explanation
   and reports it as the defect. Same reason install-has-migration-effects
   strips them before looking for CREATE statements. */
const code = (f) => read(f)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ');

const COMMERCE = read('functions/api/_commerce.js');
const AUDIT = read('functions/api/_audit.js');
const AUDIT_EP = read('functions/api/admin-audit.js');
const RL = read('functions/api/_ratelimit.js');
const TS = read('functions/api/_turnstile.js');
const ADMIN = read('admin-main.js');
const HEALTH = read('functions/api/health.js');
const MIG = read('migrations/0029_the_controls_are_enforced_in_the_database.sql');

console.log('\n  the controls are enforced where they cannot be skipped\n');

console.log('  A1 · the second factor reaches the endpoints');
{
  ok('verifyAdmin reads the assurance level off the token',
    /const aal = assuranceOf\(accessToken\);/.test(COMMERCE));
  ok('…and refuses anything that is not aal2',
    /if \(aal !== 'aal2'\) \{[\s\S]{0,220}return null;/.test(COMMERCE),
    'an absent claim fails too — "did not say" is not evidence a factor was used');
  /* In verifyAdmin, not in each endpoint. 21 files resolve an admin through it;
     a check that has to be remembered 21 times is a check that is missing from
     one of them. */
  ok('the check lives in the one function all 21 admin endpoints go through',
    /export async function verifyAdmin[\s\S]{0,1400}aal !== 'aal2'/.test(COMMERCE));
  ok('…so decide() inherits it rather than repeating it',
    /const admin = await verifyAdmin\(env, accessToken\);\s*\n\s*if \(!admin\)/.test(COMMERCE));

  /* The signature is verified by the /auth/v1/user call; decoding an
     already-verified token is reading what the ISSUER said, not trusting the
     caller. Worth pinning, because a claims reader that ran BEFORE the
     verification would be a bypass rather than a check. */
  ok('claims are read only after Supabase has verified the token',
    COMMERCE.indexOf('auth/v1/user') < COMMERCE.indexOf('function jwtClaims'),
    'decoding an unverified JWT would let a caller state its own assurance level');
  ok('…and decoded as bytes, not with a unicode-lossy atob',
    /new TextDecoder\(\)\.decode\(bytes\)/.test(COMMERCE));

  /* No off switch, on purpose. The same reasoning that keeps REFUND_SECRET in
     Cloudflare rather than in the panel: a setting that can disable MFA
     enforcement is a store where MFA enforcement is off. */
  ok('there is no environment variable that turns it off',
    !/REQUIRE_.*MFA|MFA_REQUIRED\s*===|env\.[A-Z_]*MFA/.test(COMMERCE),
    'a control with a bypass is the control it bypasses');

  ok('the refusal says what to do about it',
    /MFA_REQUIRED_REASON/.test(COMMERCE)
    && /two-factor verification/.test(COMMERCE),
    '"not signed in as an admin" to somebody plainly signed in reads as a bug and gets retried');

  /* The one endpoint that answers "are you an admin at all" runs BEFORE the
     panel's MFA step, and has its own auth path. If it ever started importing
     verifyAdmin, a first sign-in could never reach the enrolment screen. */
  const ACCESS = code('functions/api/admin-access.js');
  ok('the pre-MFA bootstrap endpoint does not go through it',
    !/verifyAdmin\s*\(/.test(ACCESS) && !/import[^;]*verifyAdmin/.test(ACCESS),
    '/api/admin-access runs before enrolment — requiring aal2 there is a lockout');
}

console.log('\n  A2 · the log is written by the server, and cannot go quiet');
{
  ok('the panel no longer inserts audit rows itself',
    !/from\('admin_audit_log'\)\.insert/.test(ADMIN),
    'admin_user_id came from the page — the row said whoever the page said');
  ok('…it asks an endpoint, with its token',
    /fetch\('\/api\/admin-audit'/.test(ADMIN)
    && /Authorization: `Bearer \$\{token\}`/.test(ADMIN));
  ok('the endpoint takes the identity from the token it verified',
    /const admin = await verifyAdmin\(env, token\);/.test(AUDIT_EP)
    && /record\(env, admin, \{/.test(AUDIT_EP));
  ok('…and never reads an identity out of the body',
    !/body\.(admin_user_id|adminUserId|admin_email|adminEmail)/.test(AUDIT_EP),
    'the only answer it accepts to "who did this" is the one it proved');
  ok('record() refuses to write a row with no verified identity',
    /if \(!admin \|\| !admin\.id\) \{[\s\S]{0,200}return false;/.test(AUDIT));

  /* The half that does not depend on the interface. */
  ok('decide() logs every sealed authorization answer',
    /await recordDecision\(env, admin, permission, verdict/.test(COMMERCE));
  ok('…awaited, so the row exists before the response does',
    /const logged = await recordDecision/.test(COMMERCE),
    'a row that may or may not have been written is not evidence of anything');
  ok('…including refusals',
    /'authz\.' \+ \(verdict && verdict\.allow \? 'allow' : 'deny'\)/.test(AUDIT),
    '"somebody tried to refund and was stopped" is the line a UI-driven logger can never write');

  /* The latch. One transient failure — including one raised by merely VIEWING
     the audit page on a store whose table was missing — stopped all logging
     for the rest of the session behind a console.warn. */
  ok('the self-disabling latch is gone',
    !/auditTableReady/.test(code('admin-main.js')),
    'a log that stops without saying so reads as "nothing happened"');
  ok('…and a run of failures is put on screen',
    /_auditFailures === 3/.test(ADMIN) && /showToast\(/.test(ADMIN));
  ok('the endpoint answers 200 with logged:false rather than an error',
    /json\(\{ ok: true, logged: ok \}, 200/.test(AUDIT_EP),
    'the change it describes already happened — a 5xx invites a retry of it');

  ok('the migration revokes the client’s INSERT',
    /drop policy if exists "Admins can insert audit log"/.test(MIG)
    && /revoke insert, update, delete on public\.admin_audit_log from authenticated;/.test(MIG));
  ok('…and leaves SELECT alone',
    !/drop policy if exists "Admins can read audit log"/.test(MIG),
    'reading and writing are different questions — they were tangled once already');
}

console.log('\n  A3 · the public endpoints are metered');
{
  /* Named individually. A loop over a directory would pass on an empty
     directory, and the list IS the finding. */
  const WIRED = {
    'validate-promo': 'validate-promo',
    'subscribe': 'subscribe',
    'popup-claim': 'popup-claim',
    'guest-return': 'guest-return',
    'referral': 'referral',
    'notify-restock': 'notify-restock',
    'translate': 'translate',
    'log-error': 'log-error',
    'upload-review-photo': 'upload-review-photo',
    'create-payment-intent': 'create-payment-intent',
    'shippo-rates': 'shippo-rates',
    'csp-report': 'csp-report',
    'c': 'capi-relay',
  };
  for (const [file, name] of Object.entries(WIRED)) {
    const src = read('functions/api/' + file + '.js');
    ok('  ' + file + ' is limited',
      /_ratelimit\.js/.test(src) && new RegExp("limit\\((?:context\\.)?env, (?:context\\.)?request, '" + name + "'").test(src));
    ok('    …and ' + name + ' has an allowance',
      new RegExp("'" + name + "':\\s*\\{").test(RL));
  }

  /* product-questions was on the original list of eleven and does not belong
     here: every action it exposes goes through verifyAdmin, so it is an admin
     endpoint that happens to be about a customer-facing feature. Recorded so
     the correction is not quietly lost. */
  const PQ = read('functions/api/product-questions.js');
  ok('product-questions was miscounted as public and is admin-only',
    /const admin = await verifyAdmin/.test(PQ));

  ok('identity comes from a header a client cannot forge',
    /CF-Connecting-IP/.test(RL) && !/X-Forwarded-For|X-Real-IP/.test(code('functions/api/_ratelimit.js')),
    'X-Forwarded-For is client-supplied — limiting on it limits nobody');
  ok('the counter is atomic, not read-then-write',
    /rpc\/zw_rate_limit/.test(RL)
    && /on conflict \(bucket\) do update/.test(MIG),
    'two requests read 9, both write 10, and a limit of 10 admits eleven');
  ok('…and only the service role may call it',
    /grant execute on function public\.zw_rate_limit\(text, integer, integer\) to service_role;/.test(MIG)
    && /revoke all on function public\.zw_rate_limit\(text, integer, integer\) from authenticated;/.test(MIG),
    'a client that could call it could also reset its own bucket');

  /* Fail-open is right — a late migration must not take checkout down — and it
     is exactly how a control ends up believed while providing nothing. So the
     degraded state is published. */
  ok('a missing RPC degrades rather than blocks',
    /_dbState = 'missing'/.test(RL) && /return null;/.test(RL));
  ok('…and /api/health says which layers are actually running',
    /limiterHealth\(\)/.test(HEALTH) && /out\.protections/.test(HEALTH));
  ok('…distinguishing limited from DURABLY limited',
    /durable: _dbState === 'ok'/.test(RL),
    'without the RPC only the per-isolate counter runs: that stops a loop, not a spread');
  ok('the protections are not part of the uptime verdict',
    /Deliberately not part of `ok`/.test(HEALTH),
    'a monitor should page for a store that cannot serve, not for a pending migration');
}

console.log('\n  A3b · the bot check is something an endpoint can require');
{
  ok('there is one siteverify implementation',
    /challenges\.cloudflare\.com\/turnstile\/v0\/siteverify/.test(TS));
  ok('…and the old route delegates to it rather than keeping a copy',
    /import \{ verifyToken, turnstileConfigured \} from '\.\/_turnstile\.js'/.test(read('functions/api/verify-turnstile.js'))
    && !/siteverify/.test(read('functions/api/verify-turnstile.js')));
  ok('subscribe requires a token',
    /await requireHuman\(env, request, body\.turnstileToken, headers\)/.test(read('functions/api/subscribe.js')));
  ok('…checked after the address, so a typo does not spend one',
    read('functions/api/subscribe.js').indexOf('!validEmail(email)')
      < read('functions/api/subscribe.js').indexOf('await requireHuman'));
  ok('the browser cannot decide it passed',
    /window\.zwHumanToken/.test(read('zw-turnstile.js'))
    && /return '';/.test(read('zw-turnstile.js')),
    'a blocked script resolves to an empty token and the SERVER decides what that means');

  /* One key, two files that cannot import from each other — the admin widget
     loads before anything else could provide it. Held by a test rather than by
     hope, the same way the RBAC mirror is. */
  const adminKey = (ADMIN.match(/ADMIN_TS_KEY = '([^']+)'/) || [])[1];
  const siteKey = (read('zw-turnstile.js').match(/SITEKEY = '([^']+)'/) || [])[1];
  ok('the two copies of the site key agree', !!adminKey && adminKey === siteKey,
    'admin-main.js ' + adminKey + ' vs zw-turnstile.js ' + siteKey);

  ok('and the endpoints it deliberately skips say why',
    /popup-claim/.test(TS) && /sendBeacon/.test(TS) && /create-payment-intent/.test(TS),
    'a check with an undocumented hole is worse than an even limiter');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
