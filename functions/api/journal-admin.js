/**
 * Cloudflare Pages Function: POST /api/journal-admin   (admin-protected)
 *
 * CRUD for journal_posts. Public reads go straight to Supabase (RLS: only
 * 'published' rows are readable by anon). Admin writes go through here with the
 * service-role key after verifyAdmin.
 *
 * Body: { accessToken, action, post?, id? }
 *   action: 'list' | 'save' | 'delete'
 */

import { cors, json, verifyAdmin } from './_commerce.js';
import { permsHave } from './_rbac.js';

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || ('post-' + Date.now());
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
    const base = `${env.SUPABASE_URL}/rest/v1/journal_posts`;

    const action = String(body.action || 'list');

    // Reads need journal page access; writes (save/delete) need builder_edit —
    // mirrors the UI's per-role gating so a limited role can't mutate posts by
    // calling the API directly.
    const needed = (action === 'save' || action === 'delete') ? 'builder_edit' : 'journal';
    if (!permsHave(admin.permissions, needed)) {
      return json({ ok: false, error: 'Your role does not have access to the journal.' }, 403, cors(env));
    }

    if (action === 'list') {
      const r = await fetch(`${base}?select=*&order=created_at.desc&limit=500`, { headers: H, cache: 'no-store' });
      const rows = r.ok ? await r.json() : [];
      return json({ ok: true, posts: rows }, 200, cors(env));
    }

    if (action === 'delete') {
      const id = String(body.id || '').trim();
      if (!id) return json({ ok: false, error: 'Missing id' }, 400, cors(env));
      const r = await fetch(`${base}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } });
      return json({ ok: r.ok }, r.ok ? 200 : 500, cors(env));
    }

    if (action === 'save') {
      const p = body.post || {};
      const title = String(p.title || '').trim();
      if (!title) return json({ ok: false, error: 'Title is required' }, 400, cors(env));
      const status = p.status === 'published' ? 'published' : 'draft';
      const record = {
        title,
        slug: (String(p.slug || '').trim() ? slugify(p.slug) : slugify(title)),
        excerpt: String(p.excerpt || '').slice(0, 500) || null,
        body: String(p.body || '') || null,
        cover_image: String(p.cover_image || '').trim() || null,
        status,
        updated_at: new Date().toISOString(),
      };

      if (p.id) {
        // Preserve published_at once set; stamp it on first publish.
        if (status === 'published') record.published_at = p.published_at || new Date().toISOString();
        const r = await fetch(`${base}?id=eq.${encodeURIComponent(p.id)}`, {
          method: 'PATCH', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(record),
        });
        if (!r.ok) return json({ ok: false, error: await r.text() }, 500, cors(env));
        const rows = await r.json();
        return json({ ok: true, post: rows && rows[0] }, 200, cors(env));
      }

      if (status === 'published') record.published_at = new Date().toISOString();
      const r = await fetch(base, { method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(record) });
      if (!r.ok) {
        const txt = await r.text();
        // Slug collision → append a suffix and retry once.
        if (/duplicate key|unique/i.test(txt)) {
          record.slug = record.slug + '-' + Math.random().toString(36).slice(2, 6);
          const r2 = await fetch(base, { method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(record) });
          if (r2.ok) { const rows2 = await r2.json(); return json({ ok: true, post: rows2 && rows2[0] }, 200, cors(env)); }
        }
        return json({ ok: false, error: txt }, 500, cors(env));
      }
      const rows = await r.json();
      return json({ ok: true, post: rows && rows[0] }, 200, cors(env));
    }

    return json({ ok: false, error: 'Unknown action' }, 400, cors(env));
  } catch (e) {
    console.error('[journal-admin]', e && e.message);
    return json({ ok: false, error: (e && e.message) || 'journal-admin failed' }, 500, cors(env));
  }
}
