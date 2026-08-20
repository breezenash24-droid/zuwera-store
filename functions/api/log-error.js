/**
 * /api/log-error — receives a compact client error record (from error-reporter.js)
 * and stores it in Supabase `error_log` using the service-role key (bypasses RLS).
 * Defensive + size-capped so it can't be abused to flood the table. Always 204 —
 * the client must never be affected by logging.
 *
 * Requires the `error_log` table (supabase/migrations/*_add_error_log_table.sql)
 * and env: SUPABASE_URL (optional; defaults below) + SUPABASE_SERVICE_ROLE_KEY.
 */

import { supabaseUrl } from './_config.js';
import { limit } from './_ratelimit.js';


const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const int = (v) => (Number.isFinite(+v) ? (+v | 0) : null);

export async function onRequestPost({ request, env }) {
  const limited = await limit(env, request, 'log-error');
  if (limited) return limited;

  try {
    const body = await request.json().catch(() => ({}));
    const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
    const url = supabaseUrl(env);
    if (!key) return new Response(null, { status: 204 }); // no store configured — swallow

    const row = {
      message: clip(body.message, 500),
      source: clip(body.source, 40),
      url: clip(body.url, 500),
      line: int(body.line),
      col: int(body.col),
      stack: clip(body.stack, 4000),
      user_agent: clip(body.user_agent, 300),
      release: clip(body.release, 80),
    };
    if (!row.message) return new Response(null, { status: 204 }); // drop empty noise

    await fetch(`${url}/rest/v1/error_log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    }).catch(() => {});

    /* Retention, run from the write path rather than a scheduler.
       A cleanup job somebody has to remember to set up is how this table
       reached 28,000 rows in the first place — the same reasoning as the
       migration runner being a button in the admin rather than a terminal
       command. One write in fifty pays for it, which on this volume is a few
       times a day. */
    if (Math.random() < 0.02) {
      fetch(`${url}/rest/v1/rpc/prune_error_log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
        body: '{}',
      }).catch(() => {});   // absent until 0016 runs, and never worth failing a log write over
    }
  } catch (_) {}
  return new Response(null, { status: 204 });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}
