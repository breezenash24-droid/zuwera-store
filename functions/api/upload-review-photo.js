/**
 * /api/upload-review-photo — Cloudflare Pages Function
 *
 * Lets a signed-in shopper attach a photo to their review. Uploads to the public
 * `product-images` bucket (reviews/ folder) with the service-role key. A valid
 * Supabase session is required (reviews themselves require auth), and uploads are
 * image-only and size-limited so the endpoint can't be abused as open storage.
 *
 * Request: multipart/form-data { accessToken, file }
 * Response: { url } or { error }
 */

const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
const SUPABASE_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
const BUCKET = 'product-images';
const MAX_BYTES = 6 * 1024 * 1024; // 6 MB per photo
const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

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

    if (!accessToken) return json({ error: 'Please sign in to add a photo.' }, 401);
    if (!file || typeof file === 'string') return json({ error: 'No file provided' }, 400);

    const ct = String(file.type || '').toLowerCase();
    if (!ALLOWED[ct]) return json({ error: 'Please upload a JPG, PNG, WEBP or GIF image.' }, 415);
    if (file.size > MAX_BYTES) return json({ error: 'Image is too large (max 6 MB).' }, 413);

    // A valid session is required (reviews require auth anyway).
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + accessToken },
    });
    if (!userRes.ok) return json({ error: 'Invalid or expired session' }, 401);

    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE;
    if (!serviceKey) return json({ error: 'Server not configured — add SUPABASE_SERVICE_ROLE_KEY env var' }, 500);

    const ext = ALLOWED[ct];
    const path = 'reviews/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;

    const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(path)}`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': ct,
        'x-upsert': 'true',
      },
      body: await file.arrayBuffer(),
    });
    if (!upRes.ok) {
      const t = await upRes.text().catch(() => '');
      return json({ error: t || ('Upload failed (' + upRes.status + ')') }, upRes.status);
    }

    return json({ url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}` });
  } catch (e) {
    return json({ error: (e && e.message) || String(e) }, 500);
  }
}
