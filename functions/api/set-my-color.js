/**
 * POST /api/set-my-color — Cloudflare Pages Function
 *
 * Lets any staff member change THEIR OWN accent color. Color lives inside
 * profiles.admin_permissions ({ pages, color }); we merge just the color and
 * preserve pages, using the service key. RLS blocks users from writing
 * admin_permissions directly (that would let them change their own `pages`),
 * so this endpoint is the only safe path for a self-service color change.
 *
 * Body: { accessToken, color }  (color = #hex)
 */

import { cors, json, verifyAdmin } from './_commerce.js';

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  const h = cors(env);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, 400, h); }

  const color = String(body.color || '').trim();
  if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) return json({ error: 'Invalid color.' }, 400, h);

  // Must be a signed-in staff member (any role). They can only edit their own row.
  const admin = await verifyAdmin(env, body.accessToken);
  if (!admin) return json({ error: 'Unauthorized.' }, 403, h);

  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE;
  if (!serviceKey) return json({ error: 'Server not configured — add SUPABASE_SERVICE_ROLE_KEY.' }, 500, h);
  const sbH = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  // Merge color into existing admin_permissions, preserving any pages override.
  const current = (admin.profile && admin.profile.admin_permissions) || {};
  const merged = { ...current, color };

  const patchRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(admin.id)}`,
    { method: 'PATCH', headers: { ...sbH, Prefer: 'return=minimal' }, body: JSON.stringify({ admin_permissions: merged, updated_at: new Date().toISOString() }) }
  );
  if (!patchRes.ok) {
    const errText = await patchRes.text().catch(() => '');
    return json({ error: `Could not save color: ${errText.slice(0, 160)}` }, patchRes.status, h);
  }
  return json({ success: true, color }, 200, h);
}
