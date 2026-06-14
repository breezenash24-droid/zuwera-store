/**
 * Cloudflare Pages Function: /api/meta-status
 *
 * Reports the Meta integration status for the admin dashboard's "Meta / Ads"
 * page. Returns only booleans + the already-public pixel id — never the token
 * value itself.
 */
export function onRequestGet({ env }) {
  return new Response(JSON.stringify({
    pixel_id: env.META_PIXEL_ID || '1695269795093400',
    capi_configured: !!env.META_CAPI_TOKEN,
    test_mode: !!env.META_CAPI_TEST_CODE,
  }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
