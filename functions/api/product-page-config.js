/**
 * Cloudflare Pages Function: GET /api/product-page-config   (public, read-only)
 *
 * Which blocks show under a product, and in what order. Set in the Page Builder's
 * Product tab and stored in site_settings.product_page — which isn't in the anon
 * read whitelist, so we read it server-side with the service key and expose only
 * the layout (no secrets).
 *
 * Shape: { sections: [ { id, on } ] }  — array order is display order.
 */

import { cors, json } from './_commerce.js';

// Every block that can appear under a product, in the order they ship by default.
// `more_from_release` is rendered by product.html itself and always sits first;
// the rest are injected by storefront-features.js in this order.
export const PDP_BLOCKS = ['more_from_release', 'bundle', 'recently_viewed', 'recommendations', 'qa'];

const DEFAULTS = { sections: PDP_BLOCKS.map((id) => ({ id, on: true })) };

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}

/** Lenient: unknown ids dropped, missing ones appended, so a stale save can't hide a block forever. */
export function parsePdpConfig(v) {
  const saved = (v && Array.isArray(v.sections)) ? v.sections : null;
  if (!saved) return { sections: DEFAULTS.sections.map((s) => ({ ...s })) };
  const seen = [];
  const out = [];
  saved.forEach((s) => {
    const id = s && String(s.id || '');
    if (!PDP_BLOCKS.includes(id) || seen.includes(id)) return;
    seen.push(id);
    out.push({ id, on: s.on !== false });
  });
  PDP_BLOCKS.forEach((id) => { if (!seen.includes(id)) out.push({ id, on: true }); });
  return { sections: out };
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestGet({ env }) {
  try {
    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return json(DEFAULTS, 200, cors(env));
    const rows = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings?select=value&key=eq.product_page&limit=1`, {
      headers: { apikey: key, Authorization: 'Bearer ' + key }, cache: 'no-store',
    }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    let v = rows && rows[0] && rows[0].value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
    return json(parsePdpConfig(v), 200, cors(env));
  } catch (e) {
    return json(DEFAULTS, 200, cors(env));
  }
}
