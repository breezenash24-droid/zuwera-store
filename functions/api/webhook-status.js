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
    if (val.startsWith('sk_test_')) return '✅ present (TEST mode)';
    if (val.startsWith('sk_live_')) return '✅ present (LIVE mode)';
    if (val.startsWith('pk_test_')) return '✅ present (TEST mode)';
    if (val.startsWith('pk_live_')) return '✅ present (LIVE mode)';
    if (val.startsWith('whsec_')) return '✅ present (webhook secret)';
    if (val.startsWith('re_')) return '✅ present (Resend key)';
    if (val.startsWith('shippo_')) return '✅ present (Shippo key)';
    return '✅ present (' + val.length + ' chars)';
  };

  const status = {
    timestamp: new Date().toISOString(),
    env_vars: {
      STRIPE_SECRET_KEY:     check('STRIPE_SECRET_KEY'),
      STRIPE_WEBHOOK_SECRET: check('STRIPE_WEBHOOK_SECRET'),
      RESEND_API_KEY:        check('RESEND_API_KEY'),
      RESEND_FROM_EMAIL:     check('RESEND_FROM_EMAIL'),
      SUPABASE_URL:          check('SUPABASE_URL'),
      SUPABASE_SERVICE_KEY:  check('SUPABASE_SERVICE_KEY'),
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
