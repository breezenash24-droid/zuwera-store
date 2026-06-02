/**
 * save-page-builder.js
 * Saves page builder config to site_settings using the service role key,
 * bypassing Row Level Security. Validates the caller has a live Supabase
 * session before writing.
 */

const SUPABASE_URL  = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
const ANON_KEY      = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type':                 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { accessToken, sections, published } = JSON.parse(event.body || '{}');

    if (!accessToken) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'No access token' }) };
    if (!sections)    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No sections data' }) };

    // ── Verify the session is valid ───────────────────────────────────
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + accessToken }
    });
    if (!userRes.ok) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid session' }) };

    // ── Write using service role key (bypasses RLS) ───────────────────
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE;
    if (!serviceKey) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server not configured (missing SUPABASE_SERVICE_ROLE env var)' }) };

    const value = { sections, updated_at: new Date().toISOString(), published: !!published };

    const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/site_settings`, {
      method: 'POST',
      headers: {
        apikey:          serviceKey,
        Authorization:   'Bearer ' + serviceKey,
        'Content-Type':  'application/json',
        Prefer:          'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ key: 'page_builder', value })
    });

    if (!saveRes.ok) {
      const errText = await saveRes.text();
      return { statusCode: saveRes.status, headers: CORS, body: JSON.stringify({ error: errText }) };
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };

  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
