/**
 * Cloudflare Pages Function: GET /api/preview-config?token=…   (token gated)
 *
 * Returns the UNPUBLISHED storefront config for a valid preview token: the
 * builder's draft homepage and its draft landing pages, read with the service
 * key. preview-mode.js on the storefront hands these to the normal render path,
 * so a preview is the real site drawing real draft data — not a mock of it.
 *
 * Only draft keys, and only ones that are storefront content. A preview token
 * is not a skeleton key for site_settings: nothing here reads orders, profiles,
 * API keys or anything else, and the allow-list below is the whole of it.
 */

import { verifyPreviewToken } from './_preview.js';

// The draft halves of the two published/draft pairs. Everything else in the
// admin applies the moment it is saved and has no draft to preview.
const DRAFT_KEYS = [
  'page_builder', 'landing_pages', 'builder_theme', 'builder_nav',
  'product_page_draft', 'collection_page_draft',
  // Text edited on the canvas. Without these three, "Preview live" showed the
  // PUBLISHED nav, bar and page copy while showing draft sections beside them --
  // so the one button whose whole job is "show me what I have saved but not
  // published" was the one place those edits never appeared.
  'nav_menu_draft', 'announcement_bar_draft', 'text_overrides_draft',
];

// Draft keys whose value the storefront expects to find under a different name.
// The preview hands back the live key's name holding the draft's contents, so
// the page renders through its normal path without knowing it is a preview.
const DRAFT_ALIAS = {
  product_page_draft: 'product_page',
  collection_page_draft: 'collection_page',
  // Handed back under the live names so nav-menu.js, announcement-bar.js and
  // zw-copy.js render a preview through the path they always use, without any
  // of them needing to know a preview is what they are looking at.
  nav_menu_draft: 'nav_menu',
  announcement_bar_draft: 'announcement_bar',
  text_overrides_draft: 'text_overrides',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Never cached: a draft changes every time the admin saves, and a shared
      // cache must not hold unpublished content.
      'Cache-Control': 'no-store, private',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
  });
}

export async function onRequestGet({ request, env }) {
  try {
    const token = new URL(request.url).searchParams.get('token') || '';
    const claims = await verifyPreviewToken(env, token);
    // One shape for every rejection — expired, forged and malformed are
    // indistinguishable from the outside.
    if (!claims) return json({ ok: false, error: 'This preview link is not valid or has expired.' }, 403);

    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
    if (!env.SUPABASE_URL || !serviceKey) return json({ ok: false, error: 'not configured' }, 500);

    const list = DRAFT_KEYS.map((k) => `"${k}"`).join(',');
    const rows = await fetch(
      `${env.SUPABASE_URL}/rest/v1/site_settings?select=key,value&key=in.(${encodeURIComponent(list)})`,
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey }, cache: 'no-store' }
    ).then((r) => (r.ok ? r.json() : [])).catch(() => []);

    const settings = {};
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      if (!row || DRAFT_KEYS.indexOf(row.key) === -1) return;   // belt and braces
      let v = row.value;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) {} }
      settings[DRAFT_ALIAS[row.key] || row.key] = v;
    });

    return json({ ok: true, settings, expiresAt: new Date(claims.exp * 1000).toISOString() });
  } catch (e) {
    return json({ ok: false, error: (e && e.message) || 'failed' }, 500);
  }
}
