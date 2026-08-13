/**
 * Shared helper: read API keys from Supabase `site_settings` (admin overrides),
 * falling back to Cloudflare env vars.
 *
 * TWO TIERS, and the line between them is blast radius:
 *
 *   ALLOWED_KEYS (below)  — admin-editable. Stored in site_settings, take
 *                           effect immediately, no redeploy. This is a feature:
 *                           it is what lets someone set the store up without
 *                           Cloudflare access.
 *   ENV_ONLY_KEYS (further down) — Cloudflare environment variables only.
 *                           Anything that can move money, buy something, or
 *                           send mail as your domain.
 *
 * NOTE: All API-key overrides are stored in the same `site_settings` table as
 * the commerce data (commerce_config, commerce_returns, etc.).  There is no
 * separate `api_key_overrides` table — that table never existed.
 */

const ALLOWED_KEYS = new Set([
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  // NOTE: STRIPE_SECRET_KEY is intentionally NOT here. It's a crown-jewel secret that
  // every payment path reads straight from env.STRIPE_SECRET_KEY (Cloudflare), so it's
  // locked to Cloudflare env vars — it can't be overridden/hijacked from the admin, and
  // any attempt to write it is rejected + fires a security alert. (SUPABASE_SERVICE_ROLE_KEY
  // and STRIPE_WEBHOOK_SECRET are likewise deliberately absent / env-only.)
  /* Where the store ships from. SHIP_FROM_*, because it is the business's
     address rather than a courier's setting — the tax engines need the same
     address to know whether a sale is interstate, and were reading a variable
     named after a shipping provider to get it. See _ship-from.js.

     SHIP_FROM_EMAIL is NOT EMAIL_FROM further down. This one is the contact
     printed on a shipping label; that one is the address customer email is sent
     from. They were briefly named FROM_EMAIL and EMAIL_FROM, six characters
     apart in a different order, which is how the support address ends up on a
     parcel.

     The older FROM_* and SHIPPO_FROM_* spellings are still read when the
     preferred name is unset, so an environment can be migrated whenever it
     suits rather than before the next deploy. */
  'SHIP_FROM_NAME',
  'SHIP_FROM_STREET1',
  'SHIP_FROM_STREET2',
  'SHIP_FROM_CITY',
  'SHIP_FROM_STATE',
  'SHIP_FROM_ZIP',
  'SHIP_FROM_COUNTRY',
  'SHIP_FROM_EMAIL',
  'SHIP_FROM_PHONE',
  'FROM_NAME',
  'FROM_STREET1',
  'FROM_STREET2',
  'FROM_CITY',
  'FROM_STATE',
  'FROM_ZIP',
  'FROM_COUNTRY',
  'FROM_EMAIL',
  'FROM_PHONE',
  'SHIPPO_FROM_NAME',
  'SHIPPO_FROM_STREET1',
  'SHIPPO_FROM_STREET2',
  'SHIPPO_FROM_CITY',
  'SHIPPO_FROM_STATE',
  'SHIPPO_FROM_ZIP',
  'SHIPPO_FROM_COUNTRY',
  'SHIPPO_FROM_EMAIL',
  'SHIPPO_FROM_PHONE',
  'SHIPPO_WEBHOOK_SECRET',
  // How many Shippo labels before rate-shopping switches to Veeqo. A threshold,
  // not a credential — both providers' API keys are env-only.
  'SHIPPO_FREE_LIMIT',
  'DEEPL_API_KEY',
  'CLOUDFLARE_GRAPHQL_TOKEN',
  'CLOUDFLARE_ZONE_ID',
  // Email branding
  'EMAIL_FROM',
  'BRAND_LOGO_URL',
  // A Loops template id, not a credential — LOOPS_API_KEY itself is env-only.
  'LOOPS_TRANSACTIONAL_ID',
  // PostHog (analytics)
  'POSTHOG_API_KEY',
  /* Translation: which provider, and Google's key. Editable here so a store
     whose DeepL allowance has run out can move to Google — or switch
     translation off entirely — without waiting for a build. */
  'TRANSLATE_PROVIDER',
  'GOOGLE_TRANSLATE_API_KEY',
]);

export { ALLOWED_KEYS };

/**
 * Mask a key value for safe display: show first 4 + last 4, dots in between.
 */
export function maskKey(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (s.length <= 8) return '••••••••';
  return s.slice(0, 4) + '•'.repeat(Math.max(6, s.length - 8)) + s.slice(-4);
}

/**
 * Fetch multiple keys from Supabase `site_settings` in one request.
 * Returns a plain object { KEY_NAME: 'value', ... } for keys that exist.
 */
export async function fetchSiteSettings(keys, env) {
  const url = (env.SUPABASE_URL || env.SUPABASE_PROJECT_URL || '').trim();
  const sk  = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !sk || !keys.length) return {};
  try {
    const list = keys.map(k => encodeURIComponent(k)).join(',');
    const resp = await fetch(
      `${url}/rest/v1/site_settings?key=in.(${list})&select=key,value`,
      { headers: { apikey: sk, Authorization: `Bearer ${sk}` } }
    );
    if (!resp.ok) return {};
    const rows = await resp.json();
    const map  = {};
    for (const row of (rows || [])) map[row.key] = row.value;
    return map;
  } catch (_) { return {}; }
}

/**
 * Credentials that can SPEND MONEY or SEND MAIL AS YOUR DOMAIN. These live in
 * Cloudflare environment variables only — never in the database, never editable
 * from the admin.
 *
 * The rest of the list above is admin-editable on purpose: that is what lets
 * someone set this store up without Cloudflare access, and it is a real feature.
 * The line is blast radius. A leaked Cloudinary key costs you image bandwidth.
 * A leaked Resend key lets someone send mail FROM your domain — that is
 * phishing your own customers and burning your sending reputation, and no
 * amount of rotation un-sends it. Shippo buys labels on your account. Twilio
 * sends SMS at your cost and can read replies.
 *
 * These are excluded from ALLOWED_KEYS above, so the admin cannot write them,
 * AND resolveSetting ignores any stored value for them — otherwise a copy left
 * in the database from before this split would still silently win over the
 * environment variable, which is the whole thing this is meant to prevent.
 */
export const ENV_ONLY_KEYS = new Set([
  'RESEND_API_KEY',
  'SENDGRID_API_KEY',
  'BREVO_API_KEY',
  'LOOPS_API_KEY',
  'SHIPPO_API_KEY',
  'VEEQO_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',

  /* ── Not credentials. CHANNELS. ──────────────────────────────────────────
     These were admin-editable, and the blast-radius rule above missed them
     because neither looks like a spend-capable secret. Both are worse than
     they look.

     A webhook URL is where your order alerts GO. Anyone who can change it
     receives every future order — customer email, items, total — in their own
     Slack or Discord, as it happens, while the store carries on working
     normally. That is a live exfiltration feed that reads as healthy
     operation, and it needs no key at all.

     A cron token AUTHORISES SENDING. Set REVIEW_REQUEST_TOKEN or
     ABANDONED_CART_TOKEN to a value you choose and you can fire those
     endpoints yourself — mail to the whole customer list, from the store's own
     verified domain, without ever holding the Resend key that sends it.

     The cost of moving them is that turning one on now needs a redeploy. For
     two webhook URLs and three tokens that are set once, that is a fair
     trade. */
  'SLACK_WEBHOOK_URL',
  'DISCORD_WEBHOOK_URL',
  'REVIEW_REQUEST_TOKEN',
  'ABANDONED_CART_TOKEN',
  'STATUS_WATCH_TOKEN',
]);

/**
 * Get a single setting value.
 *
 * Supabase first, env fallback — except for ENV_ONLY_KEYS, which are read from
 * the environment and nowhere else.
 *
 * Pass a pre-fetched `cache` object to avoid re-querying Supabase.
 */
export function resolveSetting(key, env, cache = {}) {
  if (!ENV_ONLY_KEYS.has(key) && cache[key]) return cache[key];
  return (env[key] || '').trim().replace(/,$/, '');
}
