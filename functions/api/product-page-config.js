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
import { verifyPreviewToken } from './_preview.js';

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
  modal_thumbs: ['none', 'bottom', 'left'],
  modal_arrows: ['below', 'overlay', 'none'],
  // 'product' makes the quick-add modal adopt the product page's type + spacing
  // instead of its own compact scale.
  modal_style:  ['product', 'compact'],
  modal_layout: ['dual', 'single'],
  /* What fills the space beside a photo that does not fill its pane.
     'auto' extends the photo's own edge, but ONLY where doing so is safe —
     see zwEdgeStrips in image-utils.js, which measures whether the photo has a
     backdrop touching all four corners and whether that backdrop is light.
     Extending a detail crop smears the garment sideways; extending a dark
     backdrop puts a slab of colour against the modal. 'edge' always extends,
     'matte' never does. First entry is the default, as everywhere here. */
  modal_fill:   ['auto', 'edge', 'matte'],
};

export function parseGalleryConfig(g) {
  const out = {};
  for (const [key, allowed] of Object.entries(GALLERY_OPTS)) {
    const val = g && typeof g[key] === 'string' ? g[key] : '';
    out[key] = allowed.includes(val) ? val : allowed[0];
  }
  return out;
}

/**
 * How the price reads (Builder → Product → Price).
 *
 * Only the MEMBER part is arranged here, because it is the only part of the
 * price whose right answer depends on the store: what you pay, what it was and
 * how much less is the same three things everywhere, but a badge saying "member
 * price" can be the whole point of the tier or a distraction beside it.
 *
 * FIRST ENTRY IS THE DEFAULT, and each first entry is what the page does today
 * — so a store that never opens this tab is not redesigned by upgrading.
 */
const PRICE_OPTS = {
  member_position: ['inline', 'below', 'hidden'],
  member_style: ['pill', 'plain', 'solid'],
};

/* The label is free text rather than a list, because "Member price", "Members",
   "Insider" and "Crew price" are all reasonable and none of them is ours to
   choose. Sanitised rather than trusted: it lands in the DOM on a public page.
   Angle brackets and control characters are removed here AND the value is
   escaped where it is inserted — the second is what actually protects the page,
   the first stops a stored value that looks like markup from ever existing. */
export function sanitizePriceLabel(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(new RegExp('[\\u0000-\\u001f\\u007f<>]', 'g'), '')
    .trim()
    .slice(0, 24);
}

export function parsePriceConfig(p) {
  const out = {};
  for (const [key, allowed] of Object.entries(PRICE_OPTS)) {
    const val = p && typeof p[key] === 'string' ? p[key] : '';
    out[key] = allowed.includes(val) ? val : allowed[0];
  }
  /* Empty means "use the wording we ship" rather than an empty badge — a label
     the merchant cleared should read as "I did not choose one", not as a blank
     pill nobody can see the point of. */
  out.member_label = sanitizePriceLabel(p && p.member_label);
  return out;
}

export function parsePdpConfig(v) {
  const gallery = parseGalleryConfig(v && v.gallery);
  const price = parsePriceConfig(v && v.price);
  const saved = (v && Array.isArray(v.sections)) ? v.sections : null;
  if (!saved) return { sections: DEFAULTS.sections.map((s) => ({ ...s })), gallery, price };
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
  return { sections: out, gallery, price };
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestGet({ request, env }) {
  try {
    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return json(parsePdpConfig(null), 200, cors(env));

    // Under a valid admin preview token, serve the DRAFT instead of the live
    // config — otherwise a preview of the product page would show what is
    // already published, which is the one thing a preview must not do.
    let wanted = 'product_page';
    const token = new URL(request.url).searchParams.get('zwpreview');
    if (token && await verifyPreviewToken(env, token)) wanted = 'product_page_draft';

    const rows = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings?select=value&key=eq.${wanted}&limit=1`, {
      headers: { apikey: key, Authorization: 'Bearer ' + key }, cache: 'no-store',
    }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    let v = rows && rows[0] && rows[0].value;
    // A preview with no draft saved yet falls back to live rather than showing
    // defaults, which would look like the preview had broken the page.
    if (wanted === 'product_page_draft' && (v === undefined || v === null)) {
      const live = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings?select=value&key=eq.product_page&limit=1`, {
        headers: { apikey: key, Authorization: 'Bearer ' + key }, cache: 'no-store',
      }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
      v = live && live[0] && live[0].value;
    }
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
    return json(parsePdpConfig(v), 200, cors(env));
  } catch (e) {
    return json(parsePdpConfig(null), 200, cors(env));
  }
}
