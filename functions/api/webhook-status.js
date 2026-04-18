/**
 * Cloudflare Pages Function: /api/webhook-status
 *
 * Diagnostic endpoint — checks which env vars are present and tests connectivity.
 * Returns JSON with presence (not values) of required keys.
 * Safe to leave deployed; no secrets are exposed.
 */

export async function onRequestGet({ env }) {
  const check = (key) => {
    const val = env[key];
    if (!val) return '❌ missing';
    const len = val.length;
    if (val.startsWith('sk_test_')) return '✅ TEST mode sk (len=' + len + ')';
    if (val.startsWith('sk_live_')) return '✅ LIVE mode sk (len=' + len + ')';
    if (val.startsWith('pk_test_')) return '✅ TEST mode pk (len=' + len + ')';
    if (val.startsWith('pk_live_')) return '✅ LIVE mode pk (len=' + len + ')';
    if (val.startsWith('whsec_')) return '✅ webhook secret — first12: ' + val.slice(0, 12) + '... (len=' + len + ')';
    if (val.startsWith('re_')) return '✅ Resend key (len=' + len + ')';
    if (val.startsWith('shippo_')) return '✅ Shippo key (len=' + len + ')';
    if (val.startsWith('eyJ')) return '✅ JWT token (len=' + len + ')';
    return '⚠️  unknown format (len=' + len + ', starts: ' + val.slice(0, 6) + ')';
  };

  const checkSupabase = async () => {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return '❌ missing URL or key';
    const key = env.SUPABASE_SERVICE_KEY;
    if (key.length < 100) return '❌ KEY TOO SHORT (' + key.length + ' chars) — paste the full service_role JWT from Supabase Dashboard → Settings → API';

    // Decode the JWT payload to check role + project ref
    let jwtRole = 'unknown', jwtRef = 'unknown';
    try {
      const parts = key.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        jwtRole = payload.role || 'unknown';
        jwtRef  = payload.ref  || 'unknown';
      }
    } catch (_) {}

    if (jwtRole !== 'service_role') {
      return '❌ JWT role="' + jwtRole + '" — need service_role key (Go to Supabase → Settings → API → copy service_role secret)';
    }

    const expectedRef = (env.SUPABASE_URL || '').split('//')[1]?.split('.')[0] || '';
    if (expectedRef && jwtRef !== expectedRef) {
      return '❌ JWT ref="' + jwtRef + '" does not match project "' + expectedRef + '" — key is from a different Supabase project!';
    }

    // Test the auth endpoint (lighter than REST)
    try {
      const r = await fetch(env.SUPABASE_URL + '/auth/v1/settings', {
        headers: { apikey: key, Authorization: 'Bearer ' + key },
      });
      if (r.ok) return '✅ service_role key valid, project ref=' + jwtRef + ' (auth OK)';
      const txt = await r.text().catch(() => '');
      return '❌ HTTP ' + r.status + ' from Supabase auth — ' + txt.slice(0, 120);
    } catch (e) {
      return '❌ fetch error: ' + e.message;
    }
  };

  const supabaseTest = await checkSupabase();

  const status = {
    timestamp: new Date().toISOString(),
    env_vars: {
      STRIPE_SECRET_KEY:     check('STRIPE_SECRET_KEY'),
      STRIPE_WEBHOOK_SECRET: check('STRIPE_WEBHOOK_SECRET'),
      RESEND_API_KEY:        check('RESEND_API_KEY'),
      RESEND_FROM_EMAIL:     check('RESEND_FROM_EMAIL'),
      SUPABASE_URL:          check('SUPABASE_URL'),
      SUPABASE_SERVICE_KEY:  check('SUPABASE_SERVICE_KEY') + ' | live test: ' + supabaseTest,
      SHIPPO_API_KEY:        check('SHIPPO_API_KEY'),
      SHIPPO_FROM_NAME:      check('SHIPPO_FROM_NAME'),
      SHIPPO_FROM_STREET1:   check('SHIPPO_FROM_STREET1'),
      SHIPPO_FROM_CITY:      check('SHIPPO_FROM_CITY'),
      SHIPPO_FROM_STATE:     check('SHIPPO_FROM_STATE'),
      SHIPPO_FROM_ZIP:       check('SHIPPO_FROM_ZIP'),
      SHIPPO_FROM_COUNTRY:   check('SHIPPO_FROM_COUNTRY'),
    },
    mode_check: (() => {
      const stripe = env.STRIPE_SECRET_KEY || '';
      const webhookSecret = env.STRIPE_WEBHOOK_SECRET || '';
      if (stripe.startsWith('sk_test_')) return '⚠️  Using TEST Stripe key — make sure your webhook signing secret is also from TEST mode in Stripe Dashboard';
      if (stripe.startsWith('sk_live_')) return '⚠️  Using LIVE Stripe key — make sure your webhook signing secret is also from LIVE mode in Stripe Dashboard';
      return '❌ STRIPE_SECRET_KEY not set';
    })(),
    webhook_url: 'https://zuwera.store/api/stripe-webhook',
    instructions: 'Go to https://dashboard.stripe.com/test/webhooks (or /webhooks for live mode) and verify an endpoint exists for the URL above, listening for payment_intent.succeeded events. Copy the signing secret from that endpoint and set it as STRIPE_WEBHOOK_SECRET in Cloudflare Pages → Settings → Environment variables.',
  };

  return new Response(JSON.stringify(status, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
