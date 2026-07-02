/**
 * POST /api/set-admin-role — Cloudflare Pages Function
 *
 * Lets a super_admin assign / revoke a staff member's granular admin_role.
 * Only callers whose role holds the `role_manage` permission (super_admin) may
 * use this. Every change is written to admin_audit_log.
 *
 * Body: { accessToken, targetUserId, adminRole }
 *   adminRole = one of STAFF_ROLES  -> grants staff access (role forced to 'admin')
 *   adminRole = null | ''           -> revokes staff access (role reset to 'customer')
 */

import { cors, json, verifyAdmin } from './_commerce.js';
import { roleCan, STAFF_ROLES } from './_rbac.js';

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  const h = cors(env);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, 400, h); }

  const { accessToken, targetUserId } = body;
  const nextRole = body.adminRole ? String(body.adminRole).trim() : null;

  const admin = await verifyAdmin(env, accessToken);
  if (!admin) return json({ error: 'Unauthorized.' }, 403, h);
  if (!roleCan(admin.admin_role, 'role_manage')) {
    return json({ error: 'Only a Super Admin can change staff roles.' }, 403, h);
  }

  if (!targetUserId) return json({ error: 'targetUserId is required.' }, 400, h);
  if (nextRole && !STAFF_ROLES.includes(nextRole)) {
    return json({ error: `Invalid role "${nextRole}".` }, 400, h);
  }

  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE;
  if (!serviceKey) return json({ error: 'Server not configured — add SUPABASE_SERVICE_ROLE_KEY.' }, 500, h);
  const sbH = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  // Guard: don't let the last super_admin be demoted (env owners are the safety net,
  // but this prevents an accidental full lockout of the DB-managed super admins).
  if (nextRole !== 'super_admin') {
    const superRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?admin_role=eq.super_admin&select=id`, { headers: sbH }
    );
    const supers = superRes.ok ? await superRes.json().catch(() => []) : [];
    const targetIsSuper = supers.some((p) => String(p.id) === String(targetUserId));
    if (targetIsSuper && supers.length <= 1) {
      return json({ error: 'Cannot demote the last Super Admin.' }, 400, h);
    }
  }

  const patch = {
    admin_role: nextRole,
    role: nextRole ? 'admin' : 'customer',
    updated_at: new Date().toISOString(),
  };

  const patchRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(targetUserId)}`,
    { method: 'PATCH', headers: { ...sbH, Prefer: 'return=representation' }, body: JSON.stringify(patch) }
  );
  if (!patchRes.ok) {
    const errText = await patchRes.text();
    return json({ error: `Could not update role: ${errText}` }, patchRes.status, h);
  }
  const updated = (await patchRes.json().catch(() => []))?.[0] || null;

  // Audit trail (best-effort — never block the role change on logging failure).
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/admin_audit_log`, {
      method: 'POST',
      headers: { ...sbH, Prefer: 'return=minimal' },
      body: JSON.stringify({
        admin_user_id: admin.id,
        admin_email: admin.email || admin.profile?.email || '',
        action: nextRole ? 'assign_role' : 'revoke_role',
        resource_type: 'profile',
        resource_id: String(targetUserId),
        metadata: { new_admin_role: nextRole, target_email: updated?.email || '' },
        user_agent: request.headers.get('user-agent') || '',
      }),
    });
  } catch { /* logging is best-effort */ }

  return json({ success: true, profile: updated }, 200, h);
}
