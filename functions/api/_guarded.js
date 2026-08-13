/**
 * _guarded.js — a second factor for changes that are not money, but are not
 * "one click and carry on" either.
 *
 * REFUNDS ALREADY HAVE ONE. REFUND_SECRET must exist in Cloudflare AND be typed
 * per action, so admin access alone cannot move money. That is the right shape
 * and this reuses it for a second class of change: settings where being wrong is
 * expensive or quiet.
 *
 *   Changing the tax engine   — every order from that moment is priced by
 *   something else. Get it wrong and you either under-collect tax you still owe,
 *   or charge customers a rate you cannot justify. Nothing looks broken either
 *   way, which is exactly why it should take a deliberate act.
 *
 *   Pausing a service         — the attack this closes is specific. Somebody
 *   with admin access pauses your Slack order alerts, and every order after that
 *   arrives in silence. The store keeps working. You stop being told. A pause
 *   button with no second factor is a way to turn off the thing that would tell
 *   you about everything else.
 *
 * WHY A SEPARATE SECRET FROM REFUND_SECRET. Blast radius again. A refund moves
 * money out of the business and REFUND_SECRET should be held by whoever is
 * accountable for that. Changing a tax engine or muting an alert is operational.
 * Folding them into one secret means either handing the refund key to whoever
 * manages settings, or refusing settings changes to everyone without it. Two
 * secrets, two audiences.
 *
 * NOT SET means these actions are UNAVAILABLE, exactly as refunds are. Falling
 * back to "allow it" would make the guard decorative, and a guard that quietly
 * stops guarding is worse than no guard: the panel still says the action is
 * protected.
 */

/* Compared without leaking where two values first differ. Not a password — a
   shared secret typed by a person — but constant-time is free here. */
function constantTimeEqual(a, b) {
  const l = String(a || ''), r = String(b || '');
  if (l.length !== r.length) return false;
  let diff = 0;
  for (let i = 0; i < l.length; i += 1) diff |= l.charCodeAt(i) ^ r.charCodeAt(i);
  return diff === 0;
}

/**
 * Check the typed control code.
 *
 * @returns {{ok: true}} or {{ok: false, status, error}} ready to return.
 */
export function checkControlCode(env, given) {
  const secret = String(env.CONTROL_SECRET || '').trim();
  if (!secret) {
    return {
      ok: false, status: 503,
      error: 'This change needs an authorization code, and CONTROL_SECRET is not set. '
        + 'Add it in Cloudflare → Settings → Variables and Secrets, then redeploy.',
    };
  }
  if (!given || !constantTimeEqual(String(given).trim(), secret)) {
    return { ok: false, status: 403, error: 'That authorization code is not right.' };
  }
  return { ok: true };
}

/**
 * Record a guarded change, so "who turned this off, and when" has an answer
 * that is not somebody's memory.
 *
 * Best-effort: the change has already been made and refusing to report it would
 * not undo it. Failing the request here would tell the caller their change did
 * not happen when it did, which is worse than a missing row.
 */
export async function auditGuarded(env, { action, resourceId, adminEmail, adminId, ua, detail }) {
  const url = (env.SUPABASE_URL || env.SUPABASE_PROJECT_URL || '').trim();
  const sk  = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !sk) return;
  try {
    await fetch(`${url}/rest/v1/admin_audit_log`, {
      method: 'POST',
      headers: {
        apikey: sk, Authorization: `Bearer ${sk}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        action,
        resource_type: 'setting',
        resource_id: String(resourceId || '').slice(0, 120),
        admin_user_id: adminId || null,
        admin_email: adminEmail || null,
        user_agent: String(ua || '').slice(0, 300),
        metadata: detail || {},
      }),
    });
  } catch (_) { /* the change stands; the log is the best-effort part */ }
}
