/* The two-tier API key split.
 *
 * Admin-editable is the default and it is a feature: it is what lets someone
 * stand this store up without Cloudflare access. The exceptions are credentials
 * that can SPEND MONEY or SEND MAIL AS YOUR DOMAIN, which live in the
 * environment only.
 *
 * The subtle half is the READ path. Removing a key from the writable list stops
 * the admin saving it, but any copy already in the database would still have
 * been preferred over the environment variable — so the "move to env-only"
 * would have changed nothing for exactly the deployments that had already used
 * the admin editor. These tests pin both halves.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const settings = fs.readFileSync(ROOT + '/functions/api/_settings.js', 'utf8');
const admin = fs.readFileSync(ROOT + '/admin-main.js', 'utf8');
const updater = fs.readFileSync(ROOT + '/functions/api/update-api-key.js', 'utf8');

const setOf = (name, src) => {
  const i = src.indexOf(name);
  const body = src.slice(i, src.indexOf(']', i));
  return (body.match(/'[A-Z_]+'/g) || []).map((s) => s.slice(1, -1));
};
const ALLOWED = setOf('const ALLOWED_KEYS = new Set([', settings);
const ENV_ONLY = setOf('ENV_ONLY_KEYS = new Set([', settings);

const SPENDERS = ['RESEND_API_KEY', 'BREVO_API_KEY', 'LOOPS_API_KEY', 'SHIPPO_API_KEY',
  'VEEQO_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'];

console.log('\n  API key tiers\n');

console.log('  the split');
{
  ok(ALLOWED.length + ' admin-editable, ' + ENV_ONLY.length + ' env-only', ALLOWED.length > 0 && ENV_ONLY.length > 0);
  const overlap = ALLOWED.filter((k) => ENV_ONLY.includes(k));
  ok('nothing is in both tiers', overlap.length === 0, overlap.join(', '));

  SPENDERS.forEach((k) => {
    ok(k + ' is env-only', ENV_ONLY.includes(k) && !ALLOWED.includes(k));
  });

  // The crown jewels were never in either list and must stay that way.
  ['STRIPE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_WEBHOOK_SECRET'].forEach((k) => {
    ok(k + ' is in no list at all — read straight from env', !ALLOWED.includes(k) && !ENV_ONLY.includes(k));
  });

  // Low-blast-radius keys stay editable; that is the point of the tier.
  ['CLOUDINARY_CLOUD_NAME', 'POSTHOG_API_KEY', 'DEEPL_API_KEY'].forEach((k) => {
    ok(k + ' stays admin-editable', ALLOWED.includes(k));
  });
  ok('a Loops template id is not treated as a credential', ALLOWED.includes('LOOPS_TRANSACTIONAL_ID'));
  ok('…while the Loops API key is', ENV_ONLY.includes('LOOPS_API_KEY'));
}

console.log('\n  the read path (the half that is easy to miss)');
{
  ok('env-only keys ignore any stored value',
    /if \(!ENV_ONLY_KEYS\.has\(key\) && cache\[key\]\) return cache\[key\];/.test(settings));
  ok('…so a row left over from the old editor cannot win over the env var',
    settings.indexOf('ENV_ONLY_KEYS.has(key)') < settings.indexOf('return (env[key]'));
}

console.log('\n  the write path');
{
  ok('the endpoint only writes keys on the allowed list', /ALLOWED_KEYS\.has\(keyName\)/.test(updater));
  SPENDERS.forEach((k) => {
    const m = admin.match(new RegExp("\\{ name: '" + k + "'[^}]*\\}"));
    ok(k + ' renders as locked in the admin editor', !!m && /locked: true/.test(m[0]));
  });
  // The actual property that matters: the locked branch emits no <input>, so
  // there is nothing for the save loop to read even if it tried.
  {
    const i = admin.indexOf('if (k.locked) {');
    const branch = admin.slice(i, admin.indexOf('}', admin.indexOf('</div>`;', i)));
    ok('the locked branch emits no input for the save loop to find',
      i > -1 && !/<input/.test(branch) && /api-key-warn/.test(branch));
  }
  ok('the save loop reads inputs by id, which locked fields do not have',
    /getElementById\('akf-' \+ k\.name\)/.test(admin));
  ok('the lock note says where to set them instead', /Environment variables/.test(admin));
}

console.log('\n  the leftovers are cleaned up');
{
  const mig = fs.readFileSync(ROOT + '/migrations/0003_purge_env_only_secrets.sql', 'utf8');
  ok('a migration deletes any stored copies', /delete from public\.site_settings/.test(mig));
  SPENDERS.forEach((k) => {
    ok('…including ' + k, new RegExp("'" + k + "'").test(mig));
  });
  ok('it warns to set the env vars first', /BEFORE APPLYING/.test(mig));
  ok('…and it is safe to run twice', /Safe to run more than once/.test(mig));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
