/**
 * Cloudflare Pages Function: /api/tax-config
 *
 * Returns admin-saved tax rate overrides from site_settings.
 * Used by checkout-tax.js on the frontend to merge any rate changes
 * the admin has saved without requiring a code redeploy.
 *
 * Returns an empty object {} if no overrides are stored — callers
 * fall back to their hardcoded defaults.
 */

import { fetchSiteSettings } from './_settings.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=300', // 5-minute CDN cache
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
}

export async function onRequestGet({ env }) {
  try {
    const settings = await fetchSiteSettings(['tax_rate_overrides'], env);
    const raw = settings.tax_rate_overrides;
    const overrides = raw
      ? (typeof raw === 'object' ? raw : JSON.parse(raw))
      : {};
    // Strip the internal metadata before returning to the browser
    const { updatedAt: _u, editedKeys: _e, ...ratesOnly } = overrides;
    return new Response(JSON.stringify(ratesOnly), { status: 200, headers: CORS_HEADERS });
  } catch (_) {
    return new Response('{}', { status: 200, headers: CORS_HEADERS });
  }
}
