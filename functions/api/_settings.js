/**
 * Shared helper: read API keys from Supabase site_settings (admin overrides),
 * falling back to Cloudflare env vars.
 *
 * Keys stored in site_settings take effect immediately on every request — no
 * Cloudflare redeploy needed.  Env vars remain as the bootstrap fallback.
 */

const ALLOWED_KEYS = new Set([
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'RESEND_API_KEY',
  'BREVO_API_KEY',
  'STRIPE_SECRET_KEY',
  'SHIPPO_API_KEY',
  'SHIPPO_FROM_NAME',
  'SHIPPO_FROM_STREET1',
  'SHIPPO_FROM_STREET2',
  'SHIPPO_FROM_CITY',
  'SHIPPO_FROM_STATE',
  'SHIPPO_FROM_ZIP',
  'SHIPPO_FROM_COUNTRY',
  'SHIPPO_FROM_EMAIL',
  'SHIPPO_WEBHOOK_SECRET',
  'DEEPL_API_KEY',
  'CLOUDFLARE_GRAPHQL_TOKEN',
  'CLOUDFLARE_ZONE_ID',
  // Email branding
  'EMAIL_FROM',
  'BRAND_LOGO_URL',
  // Loops (marketing email)
  'LOOPS_API_KEY',
  // Twilio (SMS)
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  // PostHog (analytics)
  'POSTHOG_API_KEY',
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
 * Fetch multiple keys from Supabase site_settings in one request.
 * Returns a plain object { KEY_NAME: 'value', ... } for keys that exist.
 */
export async function fetchSiteSettings(keys, env) {
  const url = (env.SUPABASE_URL || env.SUPABASE_PROJECT_URL || '').trim();
  const sk  = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !sk || !keys.length) return {};
  try {
    const list = keys.map(k => encodeURIComponent(k)).join(',');
    const resp = await fetch(
      `${url}/rest/v1/api_key_overrides?key=in.(${list})&select=key,value`,
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
 * Get a single setting value (Supabase first, env fallback).
 * Pass a pre-fetched `cache` object to avoid re-querying Supabase.
 */
export function resolveSetting(key, env, cache = {}) {
  if (cache[key]) return cache[key];
  return (env[key] || '').trim().replace(/,$/, '');
}
