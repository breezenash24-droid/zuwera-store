/**
 * _email-log.js — records every automated email send into the email_log table
 * (service-role, RLS admin-read) so the admin can see what went out.
 *
 * Best-effort: never throws, never blocks a send. A logging failure must not
 * stop an email from being considered sent.
 */

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}

/**
 * @param {object} env
 * @param {object} entry { type, recipient, subject, status, provider, meta }
 */
export async function logEmail(env, entry) {
  try {
    const key = serviceKey(env);
    if (!env || !env.SUPABASE_URL || !key || !entry) return;
    await fetch(`${env.SUPABASE_URL}/rest/v1/email_log`, {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        type: String(entry.type || 'other').slice(0, 40),
        recipient: entry.recipient ? String(entry.recipient).slice(0, 200) : null,
        subject: entry.subject ? String(entry.subject).slice(0, 300) : null,
        status: entry.status === 'failed' ? 'failed' : 'sent',
        provider: entry.provider ? String(entry.provider).slice(0, 20) : null,
        meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : {},
      }),
    });
  } catch (_) { /* logging is best-effort */ }
}
