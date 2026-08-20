/* ────────────────────────────────────────────────────────────────────────────
   _turnstile.js — the bot check, as something an endpoint can require.

   Turnstile was already here and already worked. What it did not do was guard
   anything a bot would actually go for: /api/verify-turnstile had exactly one
   caller — the admin login screen — and it was called BESIDE the sign-in rather
   than in front of it. Nothing on the server ever asked whether a request had
   passed a challenge, because there was no way for an endpoint to ask.

   This is that way. `requireHuman()` returns null to proceed or a ready-made
   403 to send, the same shape as the rate limiter next door, so a handler reads
   the two checks identically and neither can be half-applied.

   ── WHEN IT APPLIES ─────────────────────────────────────────────────────────

   Only when TURNSTILE_SECRET_KEY is set. That is not a policy switch — it is
   whether the feature is installed. A store with no Turnstile account cannot
   verify a token, and refusing every request on a store that never had the
   integration would be a deployment breaking itself. The distinction that
   matters is that this state is REPORTED: /api/health says whether the check is
   live, so "we have a bot check" can be confirmed rather than assumed.

   ── WHY NOT ON EVERYTHING ───────────────────────────────────────────────────

   Two endpoints are deliberately left to the rate limiter alone:

     popup-claim   its exit-intent path uses navigator.sendBeacon, which fires
                   during unload and cannot await a freshly minted token. A
                   check that the last-chance save path has to skip is a check
                   with a documented hole in it, which is worse than a limiter
                   that covers the whole endpoint evenly.

     create-payment-intent
                   a challenge in front of the pay button costs real orders, and
                   Stripe already applies its own bot defences plus Radar. The
                   limiter caps card testing at 20 attempts per 15 minutes per
                   address, which is the part that was missing.
   ──────────────────────────────────────────────────────────────────────────── */

/** Is the check installed on this deployment? */
export function turnstileConfigured(env) {
  return !!String((env && env.TURNSTILE_SECRET_KEY) || '').trim();
}

/**
 * Ask Cloudflare whether this token is real.
 * Returns { success, error } and never throws.
 */
export async function verifyToken(env, token, ip = '') {
  const secret = String((env && env.TURNSTILE_SECRET_KEY) || '').trim();
  if (!secret) return { success: false, error: 'Turnstile secret key not configured', code: 'TURNSTILE_NOT_CONFIGURED' };
  if (!token) return { success: false, error: 'Missing Turnstile token' };

  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: String(token), remoteip: ip || '' }).toString(),
    });
    if (!resp.ok) return { success: false, error: `Turnstile service error (${resp.status})` };
    const result = await resp.json().catch(() => null);
    if (result && result.success) return { success: true };
    return {
      success: false,
      error: (result && result['error-codes'] && result['error-codes'].join(', ')) || 'Verification failed',
    };
  } catch (e) {
    return { success: false, error: (e && e.message) || 'Turnstile request failed' };
  }
}

/**
 * Gate a handler on a valid token.
 *
 *     const notHuman = await requireHuman(env, request, body.turnstileToken, headers);
 *     if (notHuman) return notHuman;
 *
 * Returns null when the check passes OR when Turnstile is not installed — see
 * the header for why those are the same answer, and where that fact is
 * published so it cannot pass for protection it is not giving.
 */
export async function requireHuman(env, request, token, headers = null) {
  if (!turnstileConfigured(env)) return null;
  const ip = (request && request.headers && request.headers.get('CF-Connecting-IP')) || '';
  const out = await verifyToken(env, token, ip);
  if (out.success) return null;
  return new Response(JSON.stringify({
    ok: false,
    error: 'We could not confirm this came from a browser. Please reload the page and try again.',
    detail: out.error,
  }), {
    status: 403,
    headers: { ...(headers || {}), 'Content-Type': 'application/json' },
  });
}
