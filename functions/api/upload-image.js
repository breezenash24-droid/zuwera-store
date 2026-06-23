/**
 * /api/upload-image — Cloudflare Pages Function
 * Uploads a builder media file (image/video) to the public `product-images`
 * bucket using the service-role key, bypassing storage RLS. Mirrors the trust
 * model of /api/save-page-builder: a valid Supabase session token is required.
 *
 * Request: multipart/form-data { accessToken, file }
 * Response: { url } (public URL) or { error }
 */

const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
const SUPABASE_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
const BUCKET = 'product-images';
const MAX_BYTES = 30 * 1024 * 1024; // 30 MB

function json(body, status = 200) {
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
    const form = await request.formData();
    const accessToken = form.get('accessToken');
    const file = form.get('file');

    if (!accessToken) return json({ error: 'No access token' }, 401);
    if (!file || typeof file === 'string') return json({ error: 'No file provided' }, 400);
    if (file.size > MAX_BYTES) return json({ error: 'File too large (max 30 MB). Compress it and try again.' }, 413);

    // Verify the session is valid (same posture as save-page-builder).
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + accessToken },
    });
    if (!userRes.ok) return json({ error: 'Invalid or expired session' }, 401);

    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE;
    if (!serviceKey) return json({ error: 'Server not configured — add SUPABASE_SERVICE_ROLE_KEY env var' }, 500);

    const name = String(file.name || 'upload').toLowerCase();
    const ext = (name.split('.').pop() || 'bin').replace(/[^a-z0-9]/g, '') || 'bin';
    const path = 'builder/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    const contentType = file.type || 'application/octet-stream';
    const buf = await file.arrayBuffer();

    const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(path)}`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': contentType,
        'x-upsert': 'true',
      },
      body: buf,
    });
    if (!upRes.ok) {
      const t = await upRes.text();
      return json({ error: t || ('Storage upload failed (' + upRes.status + ')') }, upRes.status);
    }

    return json({ url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}` });
  } catch (e) {
    return json({ error: (e && e.message) || String(e) }, 500);
  }
}
