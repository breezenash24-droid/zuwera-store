/**
 * /api/health — lightweight health check for uptime monitors (UptimeRobot, etc.).
 * Returns 200 {ok:true, db:true} when Cloudflare Functions AND Supabase are
 * reachable; 503 if the DB probe fails (e.g. Supabase paused on the free tier).
 * Uses the public anon key for a read-only 1-row probe. Never cached.
 */
const SUPABASE_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
const ANON_FALLBACK =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

export async function onRequest({ env }) {
  const out = { ok: true, db: true, ts: new Date().toISOString() };
  const anon = env.SUPABASE_ANON_KEY || ANON_FALLBACK;
  const url = env.SUPABASE_URL || SUPABASE_URL;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${url}/rest/v1/site_settings?select=key&limit=1`, {
      headers: { apikey: anon, Authorization: `Bearer ${anon}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    out.db = r.ok;
    if (!r.ok) out.ok = false;
  } catch (_) {
    out.db = false;
    out.ok = false;
  }
  return new Response(JSON.stringify(out), {
    status: out.ok ? 200 : 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
