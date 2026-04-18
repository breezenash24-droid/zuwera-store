/**
 * Cloudflare Pages Function: /api/stripe-config
 *
 * Returns the Stripe publishable key that matches the active backend mode.
 * Prefer setting STRIPE_PUBLISHABLE_KEY explicitly in Cloudflare Pages.
 */

const FALLBACK_TEST_PUBLISHABLE_KEY = 'pk_test_51T8ct20oFp4PJGitdabh4D80ReyWXbo7QsPltbO3PAChOzSmMDD6CJtOQkZ6Y4fMWCzkDmjAkexZDW6okKjQUf5p00SgMHKK2h';
const FALLBACK_LIVE_PUBLISHABLE_KEY = 'pk_live_51T8ct20oFp4PJGitDcNMSLu9jQMFajtwqib8dTX4WhubBon2Pso2VgkHhTHcbuKNUi9ljfwMX8Bx2uhEp1Fp2VfY00LFKvLEy4';

const CORS = (env) => ({
  'Access-Control-Allow-Origin': env.SITE_URL || '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
});

function modeFromKey(key) {
  if (String(key || '').startsWith('pk_live_') || String(key || '').startsWith('sk_live_')) return 'live';
  if (String(key || '').startsWith('pk_test_') || String(key || '').startsWith('sk_test_')) return 'test';
  return '';
}

function resolvePublishableKey(env) {
  const explicitKey = String(env.STRIPE_PUBLISHABLE_KEY || '').trim();
  if (explicitKey) {
    return {
      publishableKey: explicitKey,
      mode: modeFromKey(explicitKey),
      source: 'STRIPE_PUBLISHABLE_KEY'
    };
  }

  const secretKey = String(env.STRIPE_SECRET_KEY || '').trim();
  const mode = modeFromKey(secretKey);

  if (mode === 'test') {
    const configuredKey = String(env.STRIPE_TEST_PUBLISHABLE_KEY || '').trim();
    return {
      publishableKey: configuredKey || FALLBACK_TEST_PUBLISHABLE_KEY,
      mode,
      source: configuredKey ? 'STRIPE_TEST_PUBLISHABLE_KEY' : 'fallback-test-key'
    };
  }

  if (mode === 'live') {
    const configuredKey = String(env.STRIPE_LIVE_PUBLISHABLE_KEY || '').trim();
    return {
      publishableKey: configuredKey || FALLBACK_LIVE_PUBLISHABLE_KEY,
      mode,
      source: configuredKey ? 'STRIPE_LIVE_PUBLISHABLE_KEY' : 'fallback-live-key'
    };
  }

  return null;
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: CORS(env) });
}

export async function onRequestGet({ env }) {
  const headers = CORS(env);
  const resolved = resolvePublishableKey(env);

  if (!resolved?.publishableKey) {
    return new Response(
      JSON.stringify({ error: 'Stripe publishable key is not configured.' }),
      { status: 500, headers }
    );
  }

  return new Response(
    JSON.stringify({
      publishableKey: resolved.publishableKey,
      mode: resolved.mode || modeFromKey(resolved.publishableKey),
      source: resolved.source
    }),
    { status: 200, headers }
  );
}
