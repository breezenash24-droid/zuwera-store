/**
 * Disabled-by-default one-time Stripe webhook rotation helper.
 *
 * To use temporarily while testing, set WEBHOOK_DIAGNOSTICS_ENABLED=true and
 * WEBHOOK_DIAGNOSTICS_TOKEN, then send x-admin-token with the request.
 * Disable/remove it immediately after use.
 */

const WEBHOOK_URL = 'https://zuwera.store/api/stripe-webhook';
const WEBHOOK_EVENTS = ['payment_intent.succeeded', 'payment_intent.payment_failed'];

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
  if (String(env.WEBHOOK_DIAGNOSTICS_ENABLED || '').toLowerCase() !== 'true') return json({ error: 'Not found' }, 404);
  if (!env.WEBHOOK_DIAGNOSTICS_TOKEN || !safeEquals(request.headers.get('x-admin-token'), env.WEBHOOK_DIAGNOSTICS_TOKEN)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

async function stripeRequest(path, method, bodyParts, secretKey) {
  let bodyStr;
  if (bodyParts) {
    bodyStr = bodyParts.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  }
  const resp = await fetch('https://api.stripe.com/v1' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + secretKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: bodyStr,
  });
  return resp.json();
}

export async function onRequestGet({ request, env }) {
  const denied = requireDiagnostics(request, env);
  if (denied) return denied;
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'STRIPE_SECRET_KEY missing' }, 500);

  const data = await stripeRequest('/webhook_endpoints?limit=20', 'GET', undefined, env.STRIPE_SECRET_KEY);
  const endpoints = (data.data || []).filter((ep) => ep.url === WEBHOOK_URL);
  return json({
    info: 'POST this URL with x-admin-token to rotate the signing secret.',
    matching_endpoints: endpoints.map((ep) => ({ id: ep.id, url: ep.url, status: ep.status })),
  });
}

export async function onRequestPost({ request, env }) {
  const denied = requireDiagnostics(request, env);
  if (denied) return denied;

  const key = env.STRIPE_SECRET_KEY;
  if (!key) return json({ error: 'STRIPE_SECRET_KEY missing' }, 500);

  const list = await stripeRequest('/webhook_endpoints?limit=20', 'GET', null, key);
  const existing = (list.data || []).filter((ep) => ep.url === WEBHOOK_URL);

  for (const ep of existing) {
    await stripeRequest('/webhook_endpoints/' + ep.id, 'DELETE', null, key);
  }

  const createBody = [
    ['url', WEBHOOK_URL],
    ...WEBHOOK_EVENTS.map((eventName) => ['enabled_events[]', eventName]),
  ];
  const created = await stripeRequest('/webhook_endpoints', 'POST', createBody, key);

  if (created.error) return json({ error: created.error }, 500);

  return json({
    success: true,
    endpoint_id: created.id,
    url: created.url,
    status: created.status,
    new_signing_secret: created.secret,
    next_step: 'Copy new_signing_secret into STRIPE_WEBHOOK_SECRET, redeploy, then disable WEBHOOK_DIAGNOSTICS_ENABLED.',
  });
}
