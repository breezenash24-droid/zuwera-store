/**
 * Cloudflare Pages Function: POST /api/update-api-key
 *
 * Admin-protected endpoint to upsert an API key into Supabase site_settings.
 * Values saved here override the corresponding Cloudflare env vars on every
 * subsequent request — no redeploy required.
 *
 * Body: { accessToken: string, keyName: string, keyValue: string }
 */

import { ALLOWED_KEYS } from './_settings.js';

const ADMIN_EMAILS = ['breezenash24@gmail.com', 'nasirubreeze@zuwera.store'];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function validateAdmin(accessToken, env) {
  const url     = (env.SUPABASE_URL || env.SUPABASE_PROJECT_URL || '').trim();
  const anonKey = (env.SUPABASE_ANON_KEY || '').trim();
  const svcKey  = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  const apiKey  = anonKey || svcKey;

  const resp = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: apiKey, Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error('Session invalid or expired');

  const user   = await resp.json();
  const emails = [
    user?.email,
    ...(Array.isArray(user?.identities)
      ? user.identities.map(i => i?.identity_data?.email || i?.email)
      : []),
  ]
    .filter(Boolean)
    .map(e => String(e).toLowerCase().trim());

  if (!emails.some(e => ADMIN_EMAILS.includes(e))) {
    throw new Error('Account does not have admin privileges');
  }
  return user;
}

export async function onRequestPost({ request, env }) {
  try {
    const body      = await request.json().catch(() => ({}));
    const { accessToken, keyName, keyValue } = body;

    if (!accessToken) return json({ ok: false, error: 'Missing access token' }, 401);

    await validateAdmin(accessToken, env);

    if (!keyName || !ALLOWED_KEYS.has(keyName)) {
      return json({ ok: false, error: `"${keyName}" is not an editable key` }, 400);
    }
    if (!keyValue || String(keyValue).includes('•')) {
      return json({ ok: false, error: 'Invalid value — do not paste the masked preview' }, 400);
    }

    const url = (env.SUPABASE_URL || env.SUPABASE_PROJECT_URL || '').trim();
    const sk  = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
    if (!url || !sk) return json({ ok: false, error: 'Supabase not configured' }, 500);

    const resp = await fetch(`${url}/rest/v1/api_key_overrides?on_conflict=key`, {
      method:  'POST',
      headers: {
        apikey:          sk,
        Authorization:   `Bearer ${sk}`,
        'Content-Type':  'application/json',
        Prefer:          'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        key:        keyName,
        value:      keyValue.trim(),
        updated_at: new Date().toISOString(),
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.status);
      return json({ ok: false, error: `Supabase error: ${errText}` }, 500);
    }

    console.log(`[update-api-key] Admin updated ${keyName}`);
    return json({ ok: true, keyName, message: `${keyName} saved successfully` });
  } catch (e) {
    return json({ ok: false, error: e.message || 'Unknown error' }, 500);
  }
}
