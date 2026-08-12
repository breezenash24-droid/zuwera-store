/**
 * /api/upload-image — Cloudflare Pages Function
 *
 * Builder media: the hero images and videos placed from the page builder.
 *
 * These went to Supabase Storage until it became clear that was the whole
 * cached-egress bill. Storage egress there is billed and video is the worst
 * case, because no image CDN proxies it — a hero clip was served at full size
 * on every play. R2 egress is free, and the product uploader was already using
 * it, so there was no reason for a second destination beyond history.
 *
 * The session check is unchanged: a valid Supabase token is still required,
 * same trust model as /api/save-page-builder. Only where the bytes land moved.
 *
 * Request: multipart/form-data { accessToken, file }
 * Response: { url } (public URL) or { error }
 */

import { putR2Object, publicUrlForKey, describedKey } from './upload-product-image.js';
import { DEFAULTS } from './_config.js';

const ANON_KEY = DEFAULTS.supabaseAnonKey;
const SUPABASE_URL = DEFAULTS.supabaseUrl;
const MAX_BYTES = 100 * 1024 * 1024; // 100 MB — a hero video is legitimately large

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

    const name = String(file.name || 'upload').toLowerCase();
    const ext = (name.split('.').pop() || 'bin').replace(/[^a-z0-9]/g, '') || 'bin';
    /* The builder knows which section it is placing into; that is the only
       thing that makes one hero image distinguishable from the next. Falls
       back to the uploaded file's own name, which is at least what the person
       called it. */
    const label = String(form.get('label') || '').trim() || name.replace(/\.[^.]+$/, '');
    const key = describedKey('builder', label, ext);
    const contentType = file.type || 'application/octet-stream';
    const buf = await file.arrayBuffer();

    /* Same helpers the product uploader uses, so there is one R2 path rather
       than two that can drift. A failure here is reported rather than falling
       back to Supabase: silently writing to the expensive store is exactly the
       behaviour this replaced, and it would be invisible until the next bill. */
    try {
      await putR2Object(env, key, buf, contentType);
      return json({ url: publicUrlForKey(env, key) });
    } catch (e) {
      return json({ error: 'Upload failed: ' + ((e && e.message) || String(e)) }, 502);
    }
  } catch (e) {
    return json({ error: (e && e.message) || String(e) }, 500);
  }
}
