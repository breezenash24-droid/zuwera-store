/**
 * Cloudflare Pages Function — POST /api/verify-turnstile
 * Verifies a Cloudflare Turnstile token server-side.
 *
 * Expected body: { token: "<cf-turnstile-response>" }
 * Returns: { success: true } or { success: false, error: "..." }
 *
 * Set TURNSTILE_SECRET_KEY in Cloudflare Pages → Settings → Environment Variables
 */
export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const secret = env.TURNSTILE_SECRET_KEY;

    if (!secret) {
      return new Response(
        JSON.stringify({ success: false, error: 'Turnstile secret key not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const body = await request.json();
    const token = body?.token;

    if (!token) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing Turnstile token' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Get real client IP for extra validation
    const ip = request.headers.get('CF-Connecting-IP') || '';

    const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }).toString()
    });

    const result = await verifyRes.json();

    if (result.success) {
      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    } else {
      return new Response(
        JSON.stringify({ success: false, error: result['error-codes']?.join(', ') || 'Verification failed' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
