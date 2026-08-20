/**
 * /api/health — lightweight health check for uptime monitors (UptimeRobot, etc.).
 * Returns 200 {ok:true} when Cloudflare Functions AND the Supabase project are
 * reachable; 503 if Supabase is unreachable (e.g. a paused free-tier project,
 * which stops responding entirely). Probes GoTrue's PUBLIC /auth/v1/health
 * endpoint, so no API key is embedded here. Never cached.
 */

import { supabaseUrl } from './_config.js';
import { limiterHealth } from './_ratelimit.js';
import { turnstileConfigured } from './_turnstile.js';


export async function onRequest({ env }) {
  const out = { ok: true, backend: true, ts: new Date().toISOString() };

  /* ── THE PROTECTIONS SAY WHETHER THEY ARE ACTUALLY ON ──────────────────────
     Both of these fail open by design: the rate limiter allows requests when
     its RPC is missing, and the bot check passes when Turnstile is not
     installed. Both are the right behaviour — a late migration must not take
     the storefront down — and both are exactly how a control ends up being
     believed while providing nothing.

     So they are published. "We have rate limiting" becomes a thing that can be
     checked rather than assumed, and the difference between limiting and
     DURABLE limiting is stated rather than blurred: without the RPC only the
     per-isolate counter is running, which stops a loop and not a spread.

     Deliberately not part of `ok`. An uptime monitor should page for a store
     that cannot serve, not for a migration that has not been run yet. */
  out.protections = {
    rateLimit: limiterHealth(),
    botCheck: turnstileConfigured(env) ? 'on' : 'not-configured',
  };
  const url = supabaseUrl(env);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${url}/auth/v1/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    // Any HTTP response < 500 means the project is up and answering; a paused
    // project times out (throws) or returns 5xx.
    out.backend = r.status < 500;
    if (!out.backend) out.ok = false;
  } catch (_) {
    out.backend = false;
    out.ok = false;
  }
  return new Response(JSON.stringify(out), {
    status: out.ok ? 200 : 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
