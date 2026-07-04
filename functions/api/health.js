/**
 * /api/health — lightweight health check for uptime monitors (UptimeRobot, etc.).
 * Returns 200 {ok:true} when Cloudflare Functions AND the Supabase project are
 * reachable; 503 if Supabase is unreachable (e.g. a paused free-tier project,
 * which stops responding entirely). Probes GoTrue's PUBLIC /auth/v1/health
 * endpoint, so no API key is embedded here. Never cached.
 */
const SUPABASE_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';

export async function onRequest({ env }) {
  const out = { ok: true, backend: true, ts: new Date().toISOString() };
  const url = env.SUPABASE_URL || SUPABASE_URL;
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
