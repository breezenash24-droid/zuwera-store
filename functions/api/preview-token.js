/**
 * Cloudflare Pages Function: POST /api/preview-token   (admin only)
 *
 * Mints a short-lived preview link so an admin can look at unpublished
 * storefront changes on the real site before pressing Publish.
 *
 * Body: { accessToken }  →  { ok, token, expiresAt, ttlSeconds }
 *
 * Authorisation is the same two-step every admin endpoint here uses: the
 * Supabase session must be valid, the profile must be an admin, and the role
 * must actually carry builder_edit. Staff whose role cannot edit pages cannot
 * mint a preview of unpublished pages either — and the admin UI hides the
 * button for them, so the link is never even offered.
 */

import { resolvePerms, permsHave } from './_rbac.js';
import { mintPreviewToken, PREVIEW_TTL_SECONDS } from './_preview.js';

const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
const SUPABASE_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
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
    const body = await request.json().catch(() => ({}));
    const accessToken = String(body.accessToken || '').trim();
    if (!accessToken) return json({ ok: false, error: 'Please sign in again.' }, 401);

    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
    if (!serviceKey) return json({ ok: false, error: 'Server not configured — add SUPABASE_SERVICE_ROLE_KEY.' }, 500);

    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + accessToken },
    });
    if (!userRes.ok) return json({ ok: false, error: 'Your session expired. Sign in again.' }, 401);
    const authUser = await userRes.json().catch(() => null);
    if (!authUser || !authUser.id) return json({ ok: false, error: 'Your session expired. Sign in again.' }, 401);

    const profRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(authUser.id)}&select=role,admin_role,admin_permissions&limit=1`,
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    const rows = profRes.ok ? await profRes.json().catch(() => []) : [];
    const prof = Array.isArray(rows) ? rows[0] : null;
    if (!prof || prof.role !== 'admin') {
      return json({ ok: false, error: 'Your account does not have admin privileges.' }, 403);
    }

    const perms = resolvePerms({
      admin_role: prof.admin_role || 'super_admin',
      admin_permissions: prof.admin_permissions,
    });
    if (!permsHave(perms, 'builder_edit')) {
      return json({ ok: false, error: 'Your role cannot preview unpublished pages.' }, 403);
    }

    const token = await mintPreviewToken(env, { sub: authUser.id, perms: ['builder_edit'] });
    if (!token) return json({ ok: false, error: 'Could not create a preview link.' }, 500);

    return json({
      ok: true,
      token,
      ttlSeconds: PREVIEW_TTL_SECONDS,
      expiresAt: new Date(Date.now() + PREVIEW_TTL_SECONDS * 1000).toISOString(),
    });
  } catch (e) {
    return json({ ok: false, error: (e && e.message) || 'failed' }, 500);
  }
}
