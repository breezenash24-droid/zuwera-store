/**
 * Disabled-by-default Stripe webhook diagnostic endpoint.
 *
 * To use temporarily while testing, set WEBHOOK_DIAGNOSTICS_ENABLED=true and
 * WEBHOOK_DIAGNOSTICS_TOKEN, then send x-admin-token with the request.
 */

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function safeEquals(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function requireDiagnostics(request, env) {
  if (String(env.WEBHOOK_DIAGNOSTICS_ENABLED || '').toLowerCase() !== 'true') {
    return json({ error: 'Not found' }, 404);
  }
  const expected = env.WEBHOOK_DIAGNOSTICS_TOKEN;
  const provided = request.headers.get('x-admin-token');
  if (!expected || !safeEquals(provided, expected)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

export async function onRequestGet({ request, env }) {
  const denied = requireDiagnostics(request, env);
  if (denied) return denied;

  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: 'STRIPE_SECRET_KEY not set' }, 500);
  }

  const resp = await fetch('https://api.stripe.com/v1/webhook_endpoints?limit=20', {
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY },
  });
  const data = await resp.json();

  const endpoints = (data.data || []).map((ep) => ({
    id: ep.id,
    url: ep.url,
    status: ep.status,
    events: ep.enabled_events,
    created: new Date(ep.created * 1000).toISOString(),
  }));

  return json({
    stripe_mode: env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ? 'TEST' : 'LIVE',
    total_endpoints: endpoints.length,
    endpoints,
    looking_for: 'https://zuwera.store/api/stripe-webhook with payment_intent.succeeded',
  });
}
