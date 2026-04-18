/**
 * One-time helper: deletes the existing Stripe webhook endpoint and creates a
 * fresh one, returning the new signing secret so you can paste it into Cloudflare.
 * DELETE this file after you've updated STRIPE_WEBHOOK_SECRET in Cloudflare.
 *
 * GET  /api/webhook-reset  → shows current endpoint info
 * POST /api/webhook-reset  → rotates the endpoint (delete + recreate) and returns new secret
 */

const WEBHOOK_URL    = 'https://zuwera.store/api/stripe-webhook';
const WEBHOOK_EVENTS = ['payment_intent.succeeded', 'payment_intent.canceled'];

async function stripeRequest(path, method, bodyParts, secretKey) {
  // bodyParts is an array of [key, value] pairs to support repeated keys
  let bodyStr;
  if (bodyParts) {
    bodyStr = bodyParts.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  }
  const resp = await fetch('https://api.stripe.com/v1' + path, {
    method,
    headers: {
      Authorization:  'Bearer ' + secretKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: bodyStr,
  });
  return resp.json();
}

export async function onRequestGet({ env }) {
  const data = await stripeRequest('/webhook_endpoints?limit=20', 'GET', undefined, env.STRIPE_SECRET_KEY);
  const endpoints = (data.data || []).filter(ep => ep.url === WEBHOOK_URL);
  return new Response(JSON.stringify({
    info: 'POST this URL to rotate the signing secret',
    matching_endpoints: endpoints.map(ep => ({ id: ep.id, url: ep.url, status: ep.status })),
  }, null, 2), { headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ env }) {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) return new Response(JSON.stringify({ error: 'STRIPE_SECRET_KEY missing' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  // 1. Find existing endpoint(s) for this URL
  const list = await stripeRequest('/webhook_endpoints?limit=20', 'GET', null, key);
  const existing = (list.data || []).filter(ep => ep.url === WEBHOOK_URL);

  // 2. Delete them
  for (const ep of existing) {
    await stripeRequest('/webhook_endpoints/' + ep.id, 'DELETE', null, key);
  }

  // 3. Create a fresh one — the response includes the signing secret (only shown once)
  const createBody = [
    ['url', WEBHOOK_URL],
    ...WEBHOOK_EVENTS.map(e => ['enabled_events[]', e]),
  ];
  const created = await stripeRequest('/webhook_endpoints', 'POST', createBody, key);

  if (created.error) {
    return new Response(JSON.stringify({ error: created.error }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({
    success: true,
    endpoint_id:   created.id,
    url:           created.url,
    status:        created.status,
    NEW_SIGNING_SECRET: created.secret,
    next_step: 'Copy NEW_SIGNING_SECRET above → paste it as STRIPE_WEBHOOK_SECRET in Cloudflare Pages → Settings → Environment variables → then redeploy',
  }, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
