/**
 * Cloudflare Pages Function: /api/apple-pay-merchant-session
 *
 * Creates an Apple Pay merchant session object for ApplePaySession.
 *
 * Required environment variables:
 *   APPLE_PAY_MERCHANT_IDENTIFIER
 * Optional:
 *   APPLE_PAY_DISPLAY_NAME
 *   APPLE_PAY_INITIATIVE_CONTEXT
 *
 * Required binding for direct Apple gateway calls:
 *   APPLE_PAY_MTLS (mTLS binding configured in Cloudflare)
 */

const CORS = (env) => ({
  'Access-Control-Allow-Origin': env.SITE_URL || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
});

function isAppleValidationURL(urlValue) {
  try {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host.includes('apple-pay-gateway') && host.endsWith('.apple.com');
  } catch {
    return false;
  }
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: CORS(env) });
}

export async function onRequestPost({ request, env }) {
  const headers = CORS(env);
  try {
    const { validationURL, initiativeContext } = await request.json();
    if (!validationURL) {
      return new Response(JSON.stringify({ error: 'Missing validationURL' }), { status: 400, headers });
    }
    if (!isAppleValidationURL(validationURL)) {
      return new Response(JSON.stringify({ error: 'Invalid Apple validation URL' }), { status: 400, headers });
    }

    const merchantIdentifier = env.APPLE_PAY_MERCHANT_IDENTIFIER;
    if (!merchantIdentifier) {
      return new Response(JSON.stringify({ error: 'Missing APPLE_PAY_MERCHANT_IDENTIFIER' }), { status: 500, headers });
    }

    const hostHeader = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
    const fallbackHost = hostHeader.split(':')[0];
    const validatedContext = String(
      initiativeContext ||
      env.APPLE_PAY_INITIATIVE_CONTEXT ||
      fallbackHost
    ).trim().toLowerCase();

    if (!validatedContext) {
      return new Response(JSON.stringify({ error: 'Missing initiative context (domain)' }), { status: 400, headers });
    }

    if (!env.APPLE_PAY_MTLS || typeof env.APPLE_PAY_MTLS.fetch !== 'function') {
      return new Response(JSON.stringify({
        error: 'Missing APPLE_PAY_MTLS binding. Configure outbound mTLS for Apple Pay gateway.',
      }), { status: 500, headers });
    }

    const appleResp = await env.APPLE_PAY_MTLS.fetch(validationURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantIdentifier,
        displayName: env.APPLE_PAY_DISPLAY_NAME || 'Zuwera',
        initiative: 'web',
        initiativeContext: validatedContext,
      }),
    });

    const raw = await appleResp.text();
    if (!appleResp.ok) {
      return new Response(JSON.stringify({
        error: 'Apple merchant validation failed',
        details: raw.slice(0, 700),
      }), { status: 502, headers });
    }

    return new Response(raw, { status: 200, headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: error?.message || 'Merchant validation failed' }), { status: 500, headers });
  }
}

