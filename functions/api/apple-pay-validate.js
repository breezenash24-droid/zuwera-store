/**
 * Cloudflare Pages Function: POST /api/apple-pay-validate
 *
 * Handles the Apple Pay Web `onvalidatemerchant` event.
 *
 * Flow:
 *   1. Browser fires ApplePaySession.onvalidatemerchant with a validationURL
 *   2. Frontend POSTs that validationURL to this endpoint
 *   3. This Worker POSTs to Apple's server using mTLS (merchant identity cert)
 *   4. Apple returns an opaque merchantSession object
 *   5. We return it to the browser → browser calls session.completeMerchantValidation()
 *
 * Required env vars (CF Pages Dashboard → Settings → Environment variables):
 *   APPLE_MERCHANT_ID      e.g. merchant.store.zuwera
 *   APPLE_DOMAIN_NAME      zuwera.store
 *   APPLE_DISPLAY_NAME     Zuwera Sportswear
 *
 * Required mTLS binding (CF Pages Dashboard → Settings → mTLS):
 *   Binding name: APPLE_PAY_CERT
 *   (See scripts/setup-apple-pay-cert.sh for how to generate and upload the cert)
 *
 * NOTE: Zuwera currently uses Stripe's paymentRequest() API which handles
 * merchant validation automatically. This endpoint is needed if you ever switch
 * to using raw new ApplePaySession(...) directly for full control.
 */

const ALLOWED_ORIGIN = 'https://zuwera.store';

const CORS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

// Apple's known merchant validation hostnames — whitelist to prevent SSRF attacks
const APPLE_VALIDATION_HOSTS = new Set([
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
  'cn-apple-pay-gateway-sandbox.apple.com',
]);

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  // 1. Parse body
  let validationURL;
  try {
    ({ validationURL } = await request.json());
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!validationURL || typeof validationURL !== 'string') {
    return json({ error: 'Missing validationURL' }, 400);
  }

  // 2. Validate URL host — SSRF protection
  let parsedUrl;
  try { parsedUrl = new URL(validationURL); } catch {
    return json({ error: 'Malformed validationURL' }, 400);
  }
  if (parsedUrl.protocol !== 'https:' || !APPLE_VALIDATION_HOSTS.has(parsedUrl.hostname)) {
    console.warn('apple-pay-validate: blocked SSRF attempt to', parsedUrl.hostname);
    return json({ error: 'Invalid validationURL host' }, 400);
  }

  // 3. Check env vars
  const { APPLE_MERCHANT_ID, APPLE_DOMAIN_NAME, APPLE_DISPLAY_NAME } = env;
  if (!APPLE_MERCHANT_ID || !APPLE_DOMAIN_NAME || !APPLE_DISPLAY_NAME) {
    console.error('apple-pay-validate: missing Apple Pay env vars');
    return json({ error: 'Server misconfiguration' }, 500);
  }

  // 4. POST to Apple with mTLS certificate
  const body = JSON.stringify({
    merchantIdentifier: APPLE_MERCHANT_ID,
    domainName:         APPLE_DOMAIN_NAME,
    displayName:        APPLE_DISPLAY_NAME,
  });

  let appleResponse;
  try {
    const fetchOpts = {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    };
    // Attach the mTLS certificate binding so Cloudflare presents the
    // Apple Merchant Identity Certificate during the TLS handshake
    if (env.APPLE_PAY_CERT) {
      fetchOpts.cf = { mtlsClientCert: env.APPLE_PAY_CERT };
    } else {
      console.warn('apple-pay-validate: APPLE_PAY_CERT not bound — configure mTLS in CF Dashboard');
    }
    appleResponse = await fetch(validationURL, fetchOpts);
  } catch (err) {
    console.error('apple-pay-validate: network error', err.message);
    return json({ error: 'Could not reach Apple validation server', detail: err.message }, 502);
  }

  // 5. Return Apple's merchant session to the browser
  if (!appleResponse.ok) {
    const detail = await appleResponse.text().catch(() => '');
    console.error('apple-pay-validate: Apple returned', appleResponse.status, detail);
    return json({ error: 'Apple merchant validation failed', status: appleResponse.status, detail }, 502);
  }

  const merchantSession = await appleResponse.json();
  return new Response(JSON.stringify(merchantSession), { status: 200, headers: CORS });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}
