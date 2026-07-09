/**
 * /api/save-page-builder — Cloudflare Pages Function
 * Saves page builder configs to site_settings using service role key (bypasses RLS).
 * Supports multiple keys: page_builder, builder_theme, builder_nav, builder_history, builder_templates
 */

import { resolvePerms, permsHave } from './_rbac.js';

const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
const SUPABASE_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
const ALLOWED_KEYS = ['page_builder','builder_theme','builder_nav','builder_history','builder_templates','builder_layouts','page_builder_published','landing_pages','landing_pages_published','scheduled_publish'];

function cors(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { accessToken, published } = body;

    if (!accessToken) return cors({ error: 'No access token' }, 401);

    // Determine which key to save under (default: page_builder)
    const key = body.key || 'page_builder';
    if (!ALLOWED_KEYS.includes(key)) return cors({ error: 'Key not permitted: ' + key }, 403);

    // Verify session
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + accessToken },
    });
    if (!userRes.ok) return cors({ error: 'Invalid or expired session' }, 401);
    const authUser = await userRes.json().catch(() => null);
    if (!authUser?.id) return cors({ error: 'Invalid or expired session' }, 401);

    // Get service role key
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE;
    if (!serviceKey) return cors({ error: 'Server not configured — add SUPABASE_SERVICE_ROLE_KEY env var' }, 500);

    // Authorize: must be an admin whose role can edit the builder.
    // (Previously this endpoint only checked the session was valid — any
    // logged-in customer could overwrite the homepage. RBAC closes that.)
    const profRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(authUser.id)}&select=role,admin_role,admin_permissions&limit=1`,
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    const profRows = profRes.ok ? await profRes.json().catch(() => []) : [];
    const prof = Array.isArray(profRows) ? profRows[0] : null;
    if (!prof || prof.role !== 'admin') {
      return cors({ error: 'Your account does not have admin privileges.' }, 403);
    }
    const perms = resolvePerms({ admin_role: prof.admin_role || 'super_admin', admin_permissions: prof.admin_permissions });
    if (!permsHave(perms, 'builder_edit')) {
      return cors({ error: 'Your role does not have permission to edit pages.' }, 403);
    }

    // Build value from body (strip meta fields).
    // If the body has an explicit 'value' key (used by theme/nav/history/templates saves)
    // use that as the payload so the data isn't double-nested under {value:{...}}.
    const { accessToken: _a, key: _k, published: _p, value: explicitValue, ...rest } = body;
    const payload = explicitValue !== undefined ? explicitValue : rest;
    const value = { ...payload, updated_at: new Date().toISOString(), published: !!published };

    // Build rows to upsert
    const rows = [{ key, value }];
    if (key === 'page_builder' && published) {
      rows.push({ key: 'page_builder_published', value });
    }
    if (key === 'landing_pages' && published) {
      rows.push({ key: 'landing_pages_published', value });
    }

    const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/site_settings?on_conflict=key`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    });

    if (!saveRes.ok) {
      const errText = await saveRes.text();
      return cors({ error: errText }, saveRes.status);
    }

    return cors({ success: true });

  } catch (e) {
    return cors({ error: e.message || String(e) }, 500);
  }
}
