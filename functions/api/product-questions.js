/**
 * Cloudflare Pages Function: POST /api/product-questions   (admin-protected)
 *
 * Moderation endpoint for customer product questions (the storefront submits
 * questions straight to the product_questions table as anon, status 'pending';
 * only 'published' rows are publicly readable). This lets the admin list every
 * question and answer / publish / hide / delete them, using the service-role key
 * (bypasses RLS) after verifyAdmin.
 *
 * Body: { accessToken, action, id?, answer? }
 *   action: 'list' | 'answer' | 'publish' | 'hide' | 'delete'
 */

import { cors, json, verifyAdmin } from './_commerce.js';

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

    const action = String(body.action || 'list');

    if (action === 'list') {
      const url = `${env.SUPABASE_URL}/rest/v1/product_questions`
        + `?select=id,product_id,question,answer,asker_name,status,created_at,answered_at,products(title)`
        + `&order=created_at.desc&limit=500`;
      const r = await fetch(url, { headers: H, cache: 'no-store' });
      const rows = r.ok ? await r.json() : [];
      return json({ ok: true, questions: rows }, 200, cors(env));
    }

    const id = String(body.id || '').trim();
    if (!id) return json({ ok: false, error: 'Missing question id' }, 400, cors(env));
    const target = `${env.SUPABASE_URL}/rest/v1/product_questions?id=eq.${encodeURIComponent(id)}`;

    if (action === 'delete') {
      const r = await fetch(target, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } });
      return json({ ok: r.ok }, r.ok ? 200 : 500, cors(env));
    }

    let patch;
    if (action === 'answer') {
      const answer = String(body.answer || '').trim();
      if (!answer) return json({ ok: false, error: 'Missing answer text' }, 400, cors(env));
      patch = { answer, status: 'published', answered_at: new Date().toISOString() };
    } else if (action === 'publish') {
      patch = { status: 'published', answered_at: new Date().toISOString() };
    } else if (action === 'hide') {
      patch = { status: 'hidden' };
    } else {
      return json({ ok: false, error: 'Unknown action' }, 400, cors(env));
    }

    const r = await fetch(target, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    return json({ ok: r.ok }, r.ok ? 200 : 500, cors(env));
  } catch (e) {
    console.error('[product-questions]', e && e.message);
    return json({ ok: false, error: (e && e.message) || 'product-questions failed' }, 500, cors(env));
  }
}
