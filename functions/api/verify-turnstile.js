/**
 * Cloudflare Pages Function — POST /api/verify-turnstile
 * Verifies a Cloudflare Turnstile token server-side.
 *
 * Expected body: { token: "<cf-turnstile-response>" }
 * Returns: { success: true } or { success: false, error: "..." }
 *
 * Set TURNSTILE_SECRET_KEY in Cloudflare Pages → Settings → Environment Variables
 *
 * THE SITEVERIFY CALL ITSELF LIVES IN _turnstile.js. It used to live here, and
 * here was the only place anything could ask — which is how a bot check ended
 * up guarding one login form while eleven public endpoints had none. Endpoints
 * now call requireHuman() directly rather than routing a second HTTP request
 * through this one; this route stays because the admin sign-in screen calls it,
 * and it delegates so there is one implementation to get right.
 */
import { verifyToken, turnstileConfigured } from './_turnstile.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const h = { 'Content-Type': 'application/json' };

  if (!turnstileConfigured(env)) {
    return new Response(JSON.stringify({
      success: false,
      code: 'TURNSTILE_NOT_CONFIGURED',
      error: 'Turnstile secret key not configured',
    }), { status: 500, headers: h });
  }

  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  const token = body && body.token;
  if (!token) {
    return new Response(JSON.stringify({ success: false, error: 'Missing Turnstile token' }), { status: 400, headers: h });
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const result = await verifyToken(env, token, ip);
  return new Response(JSON.stringify(result), { status: result.success ? 200 : 403, headers: h });
}
