/**
 * Cloudflare Pages Function: GET /api/get-return-address
 *
 * Admin-protected. Returns the actual (unmasked) Shippo return address
 * values from api_key_overrides (or env var fallbacks).
 * These are non-secret address fields, safe to display in the admin UI.
 */

import { fetchSiteSettings, resolveSetting } from './_settings.js';
import { json, verifyAdmin } from './_commerce.js';

const ADDRESS_KEYS = [
  'SHIPPO_FROM_NAME',
  'SHIPPO_FROM_STREET1',
  'SHIPPO_FROM_STREET2',
  'SHIPPO_FROM_CITY',
  'SHIPPO_FROM_STATE',
  'SHIPPO_FROM_ZIP',
  'SHIPPO_FROM_COUNTRY',
  'SHIPPO_FROM_EMAIL',
];

export async function onRequestOptions({ env }) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': env.SITE_URL || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export async function onRequestGet({ request, env }) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ ok: false, error: 'Missing auth token' }, 401);

  const admin = await verifyAdmin(env, token);
  if (!admin) return json({ ok: false, error: 'Admin access required' }, 403);

  const cache = await fetchSiteSettings(ADDRESS_KEYS, env);

  const address = {};
  for (const key of ADDRESS_KEYS) {
    address[key] = resolveSetting(key, env, cache) || '';
  }

  return json({ ok: true, address });
}
