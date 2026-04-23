/**
 * Disabled-by-default webhook environment status endpoint.
 * Requires WEBHOOK_DIAGNOSTICS_ENABLED=true and x-admin-token.
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
  if (String(env.WEBHOOK_DIAGNOSTICS_ENABLED || '').toLowerCase() !== 'true') return json({ error: 'Not found' }, 404);
  if (!env.WEBHOOK_DIAGNOSTICS_TOKEN || !safeEquals(request.headers.get('x-admin-token'), env.WEBHOOK_DIAGNOSTICS_TOKEN)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

function decodeJwtPayload(jwt) {
  try {
    const parts = String(jwt || '').split('.');
    if (parts.length !== 3) return null;
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    return JSON.parse(atob(padded));
  } catch (_) {
    return null;
  }
}

export async function onRequestGet({ request, env }) {
  const denied = requireDiagnostics(request, env);
  if (denied) return denied;

  const check = (key) => {
    const val = env[key];
    if (!val) return 'missing';
    const text = String(val);
    if (text.startsWith('sk_test_')) return `present TEST secret key (len=${text.length})`;
    if (text.startsWith('sk_live_')) return `present LIVE secret key (len=${text.length})`;
    if (text.startsWith('pk_test_')) return `present TEST publishable key (len=${text.length})`;
    if (text.startsWith('pk_live_')) return `present LIVE publishable key (len=${text.length})`;
    if (text.startsWith('whsec_')) return `present webhook secret prefix=${text.slice(0, 12)}... (len=${text.length})`;
    if (text.startsWith('re_')) return `present Resend key (len=${text.length})`;
    if (text.startsWith('shippo_')) return `present Shippo key (len=${text.length})`;
    if (text.startsWith('eyJ')) return `present JWT token (len=${text.length})`;
    return `present unknown format (len=${text.length}, starts=${text.slice(0, 6)})`;
  };

  const checkSupabase = async () => {
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
    if (!env.SUPABASE_URL || !serviceKey) return 'missing URL or service role key';
    if (serviceKey.length < 100) return `key too short (${serviceKey.length} chars); paste the full service_role JWT`;

    const payload = decodeJwtPayload(serviceKey) || {};
    const jwtRole = payload.role || 'unknown';
    const jwtRef = payload.ref || 'unknown';
    if (jwtRole !== 'service_role') return `JWT role is ${jwtRole}; expected service_role`;

    const expectedRef = (env.SUPABASE_URL || '').split('//')[1]?.split('.')[0] || '';
    if (expectedRef && jwtRef !== expectedRef) return `JWT ref ${jwtRef} does not match project ${expectedRef}`;

    try {
      const resp = await fetch(env.SUPABASE_URL + '/auth/v1/settings', {
        headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
      });
      if (resp.ok) return `service_role key valid, project ref=${jwtRef}`;
      const detail = await resp.text().catch(() => '');
      return `Supabase auth HTTP ${resp.status}: ${detail.slice(0, 120)}`;
    } catch (e) {
      return `fetch error: ${e.message}`;
    }
  };

  const stripe = env.STRIPE_SECRET_KEY || '';
  const supabaseTest = await checkSupabase();

  return json({
    timestamp: new Date().toISOString(),
    env_vars: {
      STRIPE_SECRET_KEY: check('STRIPE_SECRET_KEY'),
      STRIPE_WEBHOOK_SECRET: check('STRIPE_WEBHOOK_SECRET'),
      RESEND_API_KEY: check('RESEND_API_KEY'),
      RESEND_FROM_EMAIL: check('RESEND_FROM_EMAIL'),
      SUPABASE_URL: check('SUPABASE_URL'),
      SUPABASE_SERVICE_KEY: check('SUPABASE_SERVICE_KEY'),
      SUPABASE_SERVICE_ROLE_KEY: check('SUPABASE_SERVICE_ROLE_KEY'),
      SUPABASE_LIVE_TEST: supabaseTest,
      SHIPPO_API_KEY: check('SHIPPO_API_KEY'),
      SHIPPO_FROM_NAME: check('SHIPPO_FROM_NAME'),
      SHIPPO_FROM_STREET1: check('SHIPPO_FROM_STREET1'),
      SHIPPO_FROM_CITY: check('SHIPPO_FROM_CITY'),
      SHIPPO_FROM_STATE: check('SHIPPO_FROM_STATE'),
      SHIPPO_FROM_ZIP: check('SHIPPO_FROM_ZIP'),
      SHIPPO_FROM_COUNTRY: check('SHIPPO_FROM_COUNTRY'),
    },
    stripe_mode: stripe.startsWith('sk_test_') ? 'TEST' : (stripe.startsWith('sk_live_') ? 'LIVE' : 'unknown'),
    webhook_url: 'https://zuwera.store/api/stripe-webhook',
    instructions: 'Make sure the Stripe webhook endpoint exists in the same test/live mode as STRIPE_SECRET_KEY and listens for payment_intent.succeeded and payment_intent.payment_failed.',
  });
}