/* What an attacker gets with admin access — and what they must not.
 *
 * The line already drawn is blast radius: anything that can SPEND MONEY or SEND
 * MAIL AS THE DOMAIN lives in Cloudflare only, and resolveSetting ignores stored
 * values for it so a leftover database row cannot override the environment.
 *
 * That rule missed two whole categories, because neither looks like a
 * spend-capable secret:
 *
 *   CHANNELS. A webhook URL is where order alerts GO. Change it and you receive
 *   every future order — customer email, items, total — in your own Slack, as it
 *   happens, while the store carries on working normally. A live exfiltration
 *   feed that reads as healthy operation, needing no credential at all.
 *
 *   AUTHORISERS. A cron token authorises SENDING. Set REVIEW_REQUEST_TOKEN to a
 *   value you choose and you can fire that endpoint yourself — mail to the whole
 *   customer list, from the store's verified domain, without ever holding the
 *   Resend key that sends it.
 *
 * And the biggest one was not a key at all: RBAC was enforced in the UI and not
 * in the database.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SQL = fs.readFileSync(path.join(ROOT, 'migrations/0017_rls_respects_permissions.sql'), 'utf8');

(async () => {
  const S = await import(pathToFileURL(ROOT + '/functions/api/_settings.js').href);

  console.log('\n  admin blast radius\n');

  console.log('  channels cannot be repointed from the admin');
  {
    for (const k of ['SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL']) {
      ok(k + ' is env-only', S.ENV_ONLY_KEYS.has(k) && !S.ALLOWED_KEYS.has(k));
    }
    /* The teeth: resolveSetting must IGNORE a stored value, or a row written
       before this change still wins over the environment. */
    ok('…and a stored value cannot override the environment',
      S.resolveSetting('SLACK_WEBHOOK_URL', { SLACK_WEBHOOK_URL: 'https://real' },
        { SLACK_WEBHOOK_URL: 'https://attacker' }) === 'https://real',
      'a leftover database row must not win');
  }

  console.log('\n  cron tokens cannot be chosen by the admin');
  {
    for (const k of ['REVIEW_REQUEST_TOKEN', 'ABANDONED_CART_TOKEN', 'STATUS_WATCH_TOKEN']) {
      ok(k + ' is env-only', S.ENV_ONLY_KEYS.has(k) && !S.ALLOWED_KEYS.has(k));
    }
    ok('…and a stored token cannot override the environment',
      S.resolveSetting('REVIEW_REQUEST_TOKEN', { REVIEW_REQUEST_TOKEN: 'real' },
        { REVIEW_REQUEST_TOKEN: 'chosen-by-attacker' }) === 'real');
  }

  console.log('\n  moving them did not blind the panel');
  {
    /* maskedKeys is built from ALLOWED_KEYS, so removing these from that list
       also removed them from the map the Cron card reads to say "Set / Not
       set". Left alone, the card would report every token missing while they
       sat correctly configured in Cloudflare — a worse lie than the problem the
       move was fixing. */
    const STATUS = fs.readFileSync(path.join(ROOT, 'functions/api/api-status.js'), 'utf8');
    for (const k of ['REVIEW_REQUEST_TOKEN', 'ABANDONED_CART_TOKEN', 'STATUS_WATCH_TOKEN',
                     'SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL']) {
      ok(k + ' still reports set/not-set', new RegExp("'" + k + "'").test(
        STATUS.slice(STATUS.indexOf('Env-only values the panel still needs'), STATUS.indexOf('Both read alongside each other'))));
    }
    /* Reported, never revealed. The panel needs to know a value exists; it has
       never needed to see one. */
    ok('…masked, not in plain text',
      /maskedKeys\[k\] = v \? maskKey\(v\) : null;/.test(STATUS));
    ok('…and none of them sneaked onto the plain-text allowlist',
      !/PLAIN_KEYS = new Set\(\[[\s\S]{0,400}?(WEBHOOK_URL|_TOKEN)/.test(STATUS));
  }

  console.log('\n  the things that were already right stay right');
  {
    /* Regression guard on the original rule. */
    for (const k of ['RESEND_API_KEY', 'SHIPPO_API_KEY', 'VEEQO_API_KEY', 'TWILIO_AUTH_TOKEN', 'LOOPS_API_KEY']) {
      ok(k + ' is still env-only', S.ENV_ONLY_KEYS.has(k) && !S.ALLOWED_KEYS.has(k));
    }
    /* Public by design — the phc_ project key ships in the browser bundle, so
       locking it down protects nothing. The POWERFUL PostHog key
       (POSTHOG_PERSONAL_API_KEY) is env-only by never being listed. */
    ok('POSTHOG_API_KEY stays admin-editable, being the public project key',
      S.ALLOWED_KEYS.has('POSTHOG_API_KEY'));
    ok('…while the personal API key is never admin-editable',
      !S.ALLOWED_KEYS.has('POSTHOG_PERSONAL_API_KEY'));
    ok('…so it resolves from the environment only',
      S.resolveSetting('POSTHOG_PERSONAL_API_KEY', { POSTHOG_PERSONAL_API_KEY: 'env' }, {}) === 'env');
  }

  console.log('\n  the database enforces the permissions the page shows');
  {
    /* The admin panel queries Supabase DIRECTLY, so there is no server in that
       path — RLS is the only enforcement point that exists. The old policy
       asked current_user_is_admin(), which reads profiles.role and ignores
       admin_role and admin_permissions entirely. */
    ok('there is a page-aware check', /create or replace function public\.current_user_can_page/.test(SQL));
    ok('super admins hold every page', /admin_role = 'super_admin'/.test(SQL));
    ok('…an explicit grant of view or edit passes',
      /in \('view', 'edit'\)/.test(SQL));
    ok('…and a missing or "none" entry does not',
      /coalesce\(admin_permissions -> 'pages' ->> p_page, ''\)/.test(SQL));

    ok('the orders policy uses it', /using \(public\.current_user_can_page\('orders'\)\)/.test(SQL));
    ok('…on writes as well as reads', /with check \(public\.current_user_can_page\('orders'\)\)/.test(SQL));
    /* Customers reading their OWN orders is a separate policy and must not be
       touched — dropping it would break every account page. */
    ok('the customer own-orders policy is left alone',
      !/Users manage own orders/.test(SQL),
      'that policy is what lets a customer see their own order');

    /* Deliberately partial, and the reason matters more than the gap. */
    ok('an admin with no explicit map is unchanged, not locked out',
      /admin_permissions -> 'pages' is null/.test(SQL));
    ok('…and the migration says why rather than leaving it looking like an oversight',
      /copy of the permission model in SQL/.test(SQL));
    ok('…and names the complete fix', /store the RESOLVED page list on the profile/.test(SQL));

    /* Every RLS helper here is SECURITY DEFINER reading profiles — it must not
       be shadowable by a search_path trick. */
    ok('the helper pins its search_path', /set search_path to 'public'/.test(SQL));
    ok('…and is stable, so the planner can use it per statement', /^stable$/m.test(SQL));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✗ suite crashed: ' + e.stack); process.exit(1); });
