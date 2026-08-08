/**
 * Cloudflare Pages Function: GET /api/storefront-settings   (public)
 *
 * Every site_settings row the storefront needs, in one edge-cached response.
 *
 * TWO PROBLEMS THIS SOLVES.
 *
 * 1. EGRESS. Every page was doing `site_settings?select=*` against Supabase —
 *    40 KB, on every single page load, uncacheable because the call passes
 *    `cache: 'no-store'`. Supabase egress therefore scaled with page views, and
 *    a month of development (2 monthly active users, ~44,000 page loads) put
 *    5.68 GB through a 5 GB free tier. Served from here, Cloudflare answers
 *    almost every request from its edge and Supabase sees one read per cache
 *    window regardless of traffic — egress stops scaling with views and starts
 *    scaling with time.
 *
 * 2. SILENTLY MISSING CONFIG. site_settings public-read is whitelisted per key
 *    by an RLS policy that lives in SQL files somebody has to remember to run,
 *    and the live policy had drifted from all of them. Checked against
 *    production: anon could read 19 keys, and 'fit_finder', 'faq',
 *    'integrations', 'technologies' and 'email_popup' were not among them. Each
 *    of those features was reading nothing and quietly falling back to its
 *    defaults — configured perfectly in the admin, inert on the site, with
 *    nothing anywhere reporting a problem. Reading with the service key here
 *    makes that whole class of bug impossible: the allow-list is this file, and
 *    this file always ships with the code that depends on it.
 *
 * The allow-list below is PUBLIC data only — the same things a visitor can see
 * by reading the rendered page. Anything that must not be public (commerce_config
 * holds promo codes, email_settings, API-key overrides, the *_draft keys holding
 * unpublished work) is absent, and the response is filtered against the list
 * again rather than trusting the query.
 */

import { cors, json } from './_commerce.js';

// Public storefront configuration. Adding a key here publishes it to every
// visitor — it belongs here only if it is already visible in the rendered page.
const PUBLIC_KEYS = [
  'announcement_bar', 'bag_panel', 'brand', 'collection_page', 'faq',
  'feature_flags', 'fit_finder', 'fonts', 'header_behavior', 'hero',
  'image_effects', 'integrations', 'landing_pages_published', 'legal_policies',
  'nav_menu', 'page_builder_published', 'product_card_cta', 'shipping_policy',
  'tax_rate_overrides', 'technologies', 'theme', 'email_popup',
];

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestGet({ env }) {
  try {
    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return json({ ok: false, settings: {} }, 200, cors(env));

    const list = PUBLIC_KEYS.map((k) => `"${k}"`).join(',');
    const rows = await fetch(
      `${env.SUPABASE_URL}/rest/v1/site_settings?select=key,value&key=in.(${encodeURIComponent(list)})`,
      { headers: { apikey: key, Authorization: 'Bearer ' + key } }
    ).then((r) => (r.ok ? r.json() : [])).catch(() => []);

    const settings = {};
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      if (!row || PUBLIC_KEYS.indexOf(row.key) === -1) return;   // never trust the query alone
      let v = row.value;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) {} }
      settings[row.key] = v;
    });

    return json({ ok: true, settings }, 200, {
      ...cors(env),
      // 60s at the browser, 5 min at the edge, and up to 10 more minutes of
      // stale-while-revalidate so a cold cache never blocks a page render on
      // Supabase. An admin save shows up within the window rather than instantly,
      // which is the trade for egress that no longer tracks traffic.
      'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
    });
  } catch (_) {
    // Never fail loudly — a settings read that errors should leave the page as
    // it is, not throw on every load.
    return json({ ok: false, settings: {} }, 200, cors(env));
  }
}
