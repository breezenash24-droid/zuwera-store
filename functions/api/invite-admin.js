/**
 * POST /api/invite-admin — Cloudflare Pages Function
 *
 * Super-admin-only (role_manage). Invites a person by email and assigns a staff
 * role in one step — they don't need to already be a customer.
 *
 *  - New email  -> Supabase sends an invite email; we create/merge their profile
 *                  with role='admin' + the chosen admin_role.
 *  - Existing   -> we just set their role (same as the Users role dropdown).
 *
 * Body: { accessToken, email, adminRole }
 */

import { cors, json, verifyAdminCan } from './_commerce.js';
import { STAFF_ROLES, ROLE_LABELS } from './_rbac.js';

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  const h = cors(env);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, 400, h); }

  const { accessToken } = body;
  const email = String(body.email || '').trim().toLowerCase();
  const adminRole = String(body.adminRole || '').trim();

  const admin = await verifyAdminCan(env, accessToken, 'role_manage');
  if (!admin) return json({ error: 'Only a Super Admin can invite team members.' }, 403, h);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Enter a valid email address.' }, 400, h);
  if (!STAFF_ROLES.includes(adminRole)) return json({ error: `Invalid role "${adminRole}".` }, 400, h);

  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE;
  if (!serviceKey) return json({ error: 'Server not configured — add SUPABASE_SERVICE_ROLE_KEY.' }, 500, h);
  const base = env.SUPABASE_URL;
  const sbH = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const site = (env.SITE_URL || 'https://zuwera.store').replace(/\/$/, '');

  // 1. Try to invite. GoTrue creates the auth user and emails an invite link.
  let userId = null;
  let alreadyExisted = false;
  const inviteRes = await fetch(`${base}/auth/v1/invite?redirect_to=${encodeURIComponent(site + '/admin')}`, {
    method: 'POST',
    headers: sbH,
    body: JSON.stringify({ email, data: { invited_role: adminRole } }),
  });

  if (inviteRes.ok) {
    const invited = await inviteRes.json().catch(() => null);
    userId = invited?.id || invited?.user?.id || null;
  } else {
    // Already registered (or invite blocked) — fall back to assigning the role
    // to the existing account. Find them by profile email (service key bypasses RLS).
    alreadyExisted = true;
    const profRes = await fetch(
      `${base}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=id&limit=1`, { headers: sbH }
    );
    const rows = profRes.ok ? await profRes.json().catch(() => []) : [];
    userId = Array.isArray(rows) ? (rows[0]?.id || null) : null;
    if (!userId) {
      const errText = await inviteRes.text().catch(() => '');
      return json({ error: `Could not invite ${email}. It may already have an account without a profile — ask them to sign in once, then set their role. (${errText.slice(0, 140)})` }, inviteRes.status, h);
    }
  }

  if (!userId) return json({ error: 'Invite succeeded but no user id was returned.' }, 502, h);

  // 2. Upsert the profile with role='admin' + the chosen staff role.
  //    (A new invite may fire a handle_new_user trigger that inserts role='customer';
  //    the merge below overrides it.)
  const upsertRes = await fetch(`${base}/rest/v1/profiles?on_conflict=id`, {
    method: 'POST',
    headers: { ...sbH, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: userId, email, role: 'admin', admin_role: adminRole, updated_at: new Date().toISOString() }),
  });
  if (!upsertRes.ok) {
    const errText = await upsertRes.text().catch(() => '');
    return json({ error: `Invite sent but role assignment failed: ${errText.slice(0, 160)}` }, upsertRes.status, h);
  }

  // 3. Audit trail (best-effort).
  try {
    await fetch(`${base}/rest/v1/admin_audit_log`, {
      method: 'POST',
      headers: { ...sbH, Prefer: 'return=minimal' },
      body: JSON.stringify({
        admin_user_id: admin.id,
        admin_email: admin.email || admin.profile?.email || '',
        action: alreadyExisted ? 'assign_role' : 'invite_admin',
        resource_type: 'profile',
        resource_id: String(userId),
        metadata: { email, admin_role: adminRole, role_label: ROLE_LABELS[adminRole] || adminRole, already_existed: alreadyExisted },
        user_agent: request.headers.get('user-agent') || '',
      }),
    });
  } catch { /* logging best-effort */ }

  return json({ success: true, alreadyExisted, userId }, 200, h);
}
