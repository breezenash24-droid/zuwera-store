/**
 * Cloudflare Pages Function: POST /api/newsletter-admin   (admin-protected)
 *
 * Manage the newsletter list. Reads/writes go through the service-role key after
 * verifyAdmin.
 *
 * Body: { accessToken, action, id? }
 *   action: 'list' | 'delete'
 */

import { cors, json, verifyAdmin } from './_commerce.js';
import { permsHave } from './_rbac.js';

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  try {
    const authHeader = request.headers.get('Authorization') || '';
    const body = await request.json().catch(() => ({}));
    const accessToken = String(body.accessToken || authHeader.replace(/^Bearer\s+/i, '') || '').trim();
    if (!accessToken) return json({ ok: false, error: 'Missing access token' }, 401, cors(env));

    const admin = await verifyAdmin(env, accessToken);
    if (!admin) return json({ ok: false, error: 'Admin access required' }, 403, cors(env));

    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return json({ ok: false, error: 'Supabase not configured' }, 500, cors(env));
    const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
    const base = `${env.SUPABASE_URL}/rest/v1/newsletter_subscribers`;
    const action = String(body.action || 'list');

    // Reads need subscribers page access; writes (delete) need builder_edit —
    // mirrors the UI's per-role gating so a limited role can't mutate the list
    // by calling the API directly.
    const needed = (action === 'delete') ? 'builder_edit' : 'subscribers';
    if (!permsHave(admin.permissions, needed)) {
      return json({ ok: false, error: 'Your role does not have access to subscribers.' }, 403, cors(env));
    }

    if (action === 'list') {
      const r = await fetch(`${base}?select=id,email,status,source,created_at,unsubscribed_at&order=created_at.desc&limit=5000`, { headers: H, cache: 'no-store' });
      const rows = r.ok ? await r.json() : [];
      const subscribed = rows.filter((x) => x.status === 'subscribed').length;
      return json({ ok: true, subscribers: rows, total: rows.length, subscribed }, 200, cors(env));
    }

    if (action === 'delete') {
      const id = String(body.id || '').trim();
      if (!id) return json({ ok: false, error: 'Missing id' }, 400, cors(env));
      const r = await fetch(`${base}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } });
      return json({ ok: r.ok }, r.ok ? 200 : 500, cors(env));
    }

    return json({ ok: false, error: 'Unknown action' }, 400, cors(env));
  } catch (e) {
    console.error('[newsletter-admin]', e && e.message);
    return json({ ok: false, error: (e && e.message) || 'failed' }, 500, cors(env));
  }
}
