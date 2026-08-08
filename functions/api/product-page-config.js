/**
 * Cloudflare Pages Function: GET /api/product-page-config   (public, read-only)
 *
 * Which blocks show under a product, and in what order. Set in the Page Builder's
 * Product tab and stored in site_settings.product_page — which isn't in the anon
 * read whitelist, so we read it server-side with the service key and expose only
 * the layout (no secrets).
 *
 * Shape: { sections: [ { id, on, cfg? } ] }  — array order is display order.
 * `cfg` (optional) carries per-block card controls (card_size, show_name, …).
 */

import { cors, json } from './_commerce.js';

// Every block that CAN appear under a product. `more_from_release` is rendered by
// product.html itself and always sits first; the rest are injected by
// storefront-features.js in whatever order the layout says.
export const PDP_BLOCKS = [
  'more_from_release', 'bundle', 'recently_viewed', 'recommendations', 'qa',
  // Optional extras — offered in the builder's gallery, NOT in the default
  // layout, so adding one here can never make a block appear on a live store
  // that didn't ask for it.
  'new_arrivals', 'journal', 'newsletter',
];

// What a store gets before anyone touches the Product tab: the original five.
const DEFAULT_LAYOUT = ['more_from_release', 'bundle', 'recently_viewed', 'recommendations', 'qa'];

const DEFAULTS = { sections: DEFAULT_LAYOUT.map((id) => ({ id, on: true })) };

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}

/**
 * A saved layout is taken literally: a block that isn't in it was removed in the
 * builder and stays gone (it's re-addable from the gallery). Earlier this
 * appended anything missing, which meant "delete" couldn't work — the block
 * reappeared on the next read. Unknown ids are dropped so a retired block can't
 * break the page. No saved layout at all → the default five.
 */
/**
 * Gallery arrangement (Builder → Product → Gallery). Every value is validated
 * against a known set rather than passed through, because these land straight in
 * DOM attributes on the storefront. Anything unrecognised falls back to the
 * current arrangement, so a bad or partial save can never leave the gallery in
 * an unstyled state.
 */
const GALLERY_OPTS = {
  layout:       ['single', 'dual'],
  thumbs:       ['bottom', 'left', 'none'],
  arrows:       ['overlay', 'below', 'none'],
  modal_thumbs: ['bottom', 'left', 'none'],
  modal_arrows: ['overlay', 'below', 'none'],
  // 'product' makes the quick-add modal adopt the product page's type + spacing
  // instead of its own compact scale.
  modal_style:  ['compact', 'product'],
};

export function parseGalleryConfig(g) {
  const out = {};
  for (const [key, allowed] of Object.entries(GALLERY_OPTS)) {
    const val = g && typeof g[key] === 'string' ? g[key] : '';
    out[key] = allowed.includes(val) ? val : allowed[0];
  }
  return out;
}

export function parsePdpConfig(v) {
  const gallery = parseGalleryConfig(v && v.gallery);
  const saved = (v && Array.isArray(v.sections)) ? v.sections : null;
  if (!saved) return { sections: DEFAULTS.sections.map((s) => ({ ...s })), gallery };
  const seen = [];
  const out = [];
  saved.forEach((s) => {
    const id = s && String(s.id || '');
    if (!PDP_BLOCKS.includes(id) || seen.includes(id)) return;
    seen.push(id);
    const block = { id, on: s.on !== false };
    if (s.cfg && typeof s.cfg === 'object') block.cfg = s.cfg;   // per-block card controls
    out.push(block);
  });
  return { sections: out, gallery };
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestGet({ env }) {
  try {
    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return json(parsePdpConfig(null), 200, cors(env));
    const rows = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings?select=value&key=eq.product_page&limit=1`, {
      headers: { apikey: key, Authorization: 'Bearer ' + key }, cache: 'no-store',
    }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    let v = rows && rows[0] && rows[0].value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
    return json(parsePdpConfig(v), 200, cors(env));
  } catch (e) {
    return json(parsePdpConfig(null), 200, cors(env));
  }
}
