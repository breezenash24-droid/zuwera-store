/**
 * functions/api/apple-pay-validate.js
 * Cloudflare Pages Function — Apple Pay merchant validation
 *
 * POST /api/apple-pay-validate
 * Body: { validationURL: "https://apple-pay-gateway.apple.com/..." }
 *
 * Wrangler bindings required (wrangler.toml):
 *   [[mtls_certificates]]
 *   binding = "APPLE_PAY_CERT"
 *   certificate_id = "<your-cloudflare-mtls-cert-id>"
 *
 *   [vars]
 *   APPLE_MERCHANT_ID  = "merchant.store.zuwera"
 *   APPLE_DOMAIN_NAME  = "zuwera.store"
 *   APPLE_DISPLAY_NAME = "Zuwera Sportswear"
 */

const APPLE_ALLOWED_HOSTS = new Set([
  'apple-pay-gateway.apple.com',
  'cn-apple-pay-gateway.apple.com',
  'apple-pay-gateway-nc-pod1.apple.com',
  'apple-pay-gateway-nc-pod2.apple.com',
  'apple-pay-gateway-nc-pod3.apple.com',
  'apple-pay-gateway-nc-pod4.apple.com',
  'apple-pay-gateway-nc-pod5.apple.com',
  'apple-pay-gateway-pr-pod1.apple.com',
  'apple-pay-gateway-pr-pod2.apple.com',
  'apple-pay-gateway-pr-pod3.apple.com',
  'apple-pay-gateway-pr-pod4.apple.com',
  'apple-pay-gateway-pr-pod5.apple.com',
  'apple-pay-gateway-sandbox.apple.com',
  'cn-apple-pay-gateway-sh-pod1.apple.com',
  'cn-apple-pay-gateway-sh-pod2.apple.com',
  'cn-apple-pay-gateway-sh-pod3.apple.com',
  'cn-apple-pay-gateway-tj-pod1.apple.com',
  'cn-apple-pay-gateway-tj-pod2.apple.com',
  'cn-apple-pay-gateway-tj-pod3.apple.com',
]);

const CORS = {
  'Access-Control-Allow-Origin': 'https://zuwera.store',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function onRequestPost({ request, env }) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Parse body
  let validationURL;
  try {
    ({ validationURL } = await request.json());
  } catch {
    return jsonResp({ error: 'Invalid JSON body' }, 400);
  }

  if (!validationURL) return jsonResp({ error: 'validationURL required' }, 400);

  // SSRF guard
  let parsed;
  try { parsed = new URL(validationURL); }
  catch { return jsonResp({ error: 'Invalid validationURL' }, 400); }

  if (!APPLE_ALLOWED_HOSTS.has(parsed.hostname)) {
    console.error('[apple-pay] Blocked host:', parsed.hostname);
    return jsonResp({ error: 'Invalid validationURL host' }, 400);
  }

  const merchantId   = env.APPLE_MERCHANT_ID  || 'merchant.store.zuwera';
  const domainName   = env.APPLE_DOMAIN_NAME  || 'zuwera.store';
  const displayName  = env.APPLE_DISPLAY_NAME || 'Zuwera Sportswear';

  const fetchOpts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ merchantIdentifier: merchantId, domainName, displayName }),
  };

  // Attach mTLS cert binding so Cloudflare presents it to Apple during TLS handshake
  if (env.APPLE_PAY_CERT) {
    fetchOpts.cf = { mtlsClientCert: env.APPLE_PAY_CERT };
  } else {
    console.warn('[apple-pay] APPLE_PAY_CERT binding missing — mTLS will fail in production');
  }

  let merchantSession;
  try {
    const appleRes = await fetch(validationURL, fetchOpts);
    if (!appleRes.ok) {
      const msg = await appleRes.text();
      console.error('[apple-pay] Apple error', appleRes.status, msg);
      return jsonResp({ error: 'Apple validation failed: ' + appleRes.status }, 502);
    }
    merchantSession = await appleRes.json();
  } catch (err) {
    console.error('[apple-pay] Fetch failed:', err.message);
    return jsonResp({ error: 'Could not reach Apple validation server' }, 502);
  }

  return jsonResp(merchantSession);
}

// Also handle OPTIONS at this route
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
    }
