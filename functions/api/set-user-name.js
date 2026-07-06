/**
 * POST /api/set-user-name — Cloudflare Pages Function
 *
 * Lets an admin with `user_manage` set another user's display name (full_name).
 * Name-only on purpose: it can never touch role/admin_role/admin_permissions,
 * so it can't be used to escalate. Uses the service key (bypasses RLS, which is
 * now locked to super_admins for profile management).
 *
 * Body: { accessToken, targetUserId, fullName }
 */

import { cors, json, verifyAdminCan } from './_commerce.js';

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  const h = cors(env);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, 400, h); }

  const { accessToken, targetUserId } = body;
  const fullName = String(body.fullName || '').trim().slice(0, 120);

  const admin = await verifyAdminCan(env, accessToken, 'user_manage');
  if (!admin) return json({ error: 'You do not have permission to edit names.' }, 403, h);
  if (!targetUserId) return json({ error: 'targetUserId is required.' }, 400, h);
  if (!fullName) return json({ error: 'Name cannot be empty.' }, 400, h);

  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE;
  if (!serviceKey) return json({ error: 'Server not configured — add SUPABASE_SERVICE_ROLE_KEY.' }, 500, h);
  const sbH = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  const patchRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(targetUserId)}`,
    { method: 'PATCH', headers: { ...sbH, Prefer: 'return=minimal' }, body: JSON.stringify({ full_name: fullName, updated_at: new Date().toISOString() }) }
  );
  if (!patchRes.ok) {
    const errText = await patchRes.text().catch(() => '');
    return json({ error: `Could not save name: ${errText.slice(0, 160)}` }, patchRes.status, h);
  }

  // Audit (best-effort).
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/admin_audit_log`, {
      method: 'POST', headers: { ...sbH, Prefer: 'return=minimal' },
      body: JSON.stringify({
        admin_user_id: admin.id, admin_email: admin.email || '',
        action: 'edit_name', resource_type: 'profile', resource_id: String(targetUserId),
        metadata: { full_name: fullName }, user_agent: request.headers.get('user-agent') || ''
      })
    });
  } catch { /* best-effort */ }

  return json({ success: true, fullName }, 200, h);
}
