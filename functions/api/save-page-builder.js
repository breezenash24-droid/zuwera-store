/**
 * /api/save-page-builder — Cloudflare Pages Function
 * Saves page builder config to site_settings using the service role key
 * so RLS is bypassed. Validates the caller's Supabase session first.
 */

const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
const SUPABASE_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';

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
    const { accessToken, sections, theme, published } = await request.json();

    if (!accessToken) return cors({ error: 'No access token provided' }, 401);
    if (!sections)    return cors({ error: 'No sections data' }, 400);

    // Verify the session is valid
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: ANON_KEY,
        Authorization: 'Bearer ' + accessToken,
      },
    });
    if (!userRes.ok) return cors({ error: 'Invalid or expired session' }, 401);

    // Get service role key from environment
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE;
    if (!serviceKey) return cors({ error: 'Server not configured — add SUPABASE_SERVICE_ROLE_KEY to Cloudflare environment variables' }, 500);

    // Write using service role (bypasses RLS)
    const value = {
      sections,
      theme,
      updated_at: new Date().toISOString(),
      published: !!published,
    };

    const rows = [
      { key: 'page_builder', value }
    ];
    if (published) {
      rows.push({ key: 'page_builder_published', value });
    }

    const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/site_settings?on_conflict=key`, {
      method: 'POST',
      headers: {
        apikey:           serviceKey,
        Authorization:    'Bearer ' + serviceKey,
        'Content-Type':   'application/json',
        Prefer:           'resolution=merge-duplicates,return=minimal',
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
