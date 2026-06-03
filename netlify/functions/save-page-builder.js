/**
 * /api/save-page-builder — Netlify Function
 * Saves page builder config to site_settings using the service role key
 * so RLS is bypassed. Validates the caller's Supabase session first.
 */

const { ok, err, preflight } = require('./_shared');

const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
const SUPABASE_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST')    return err(405, 'Method not allowed');

  try {
    const { accessToken, sections, published } = JSON.parse(event.body);

    if (!accessToken) return err(401, 'No access token provided');
    if (!sections)    return err(400, 'No sections data');

    // Verify the session is valid
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: ANON_KEY,
        Authorization: 'Bearer ' + accessToken,
      },
    });
    if (!userRes.ok) return err(401, 'Invalid or expired session');

    // Get service role key from environment
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE;
    if (!serviceKey) return err(500, 'Server not configured — add SUPABASE_SERVICE_ROLE_KEY to environment variables');

    // Write using service role (bypasses RLS)
    const value = {
      sections,
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
      return err(saveRes.status, errText);
    }

    return ok({ success: true });

  } catch (e) {
    return err(500, e.message || String(e));
  }
};
