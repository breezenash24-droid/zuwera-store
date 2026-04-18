/**
 * Temporary diagnostic: lists Stripe webhook endpoints so we can verify
 * the correct endpoint + signing secret exists.
 * DELETE this file after setup is confirmed.
 */
export async function onRequestGet({ env }) {
  if (!env.STRIPE_SECRET_KEY) {
    return new Response(JSON.stringify({ error: 'STRIPE_SECRET_KEY not set' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  // List webhook endpoints via Stripe REST API
  const resp = await fetch('https://api.stripe.com/v1/webhook_endpoints?limit=20', {
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY },
  });
  const data = await resp.json();

  const endpoints = (data.data || []).map(ep => ({
    id:     ep.id,
    url:    ep.url,
    status: ep.status,
    events: ep.enabled_events,
    created: new Date(ep.created * 1000).toISOString(),
  }));

  return new Response(JSON.stringify({
    stripe_mode: env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ? 'TEST' : 'LIVE',
    total_endpoints: endpoints.length,
    endpoints,
    looking_for: 'https://zuwera.store/api/stripe-webhook with payment_intent.succeeded',
  }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
