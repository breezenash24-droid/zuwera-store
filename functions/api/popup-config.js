/**
 * Cloudflare Pages Function: GET /api/popup-config   (public)
 *
 * The email popup's configuration, read server-side with the service-role key.
 *
 * WHY THIS EXISTS. The popup originally read site_settings.email_popup straight
 * from Supabase with the anon key. That only works if 'email_popup' has been
 * added to the "Public read content keys" RLS policy — a SQL file someone has to
 * remember to run. It hadn't been, so the anon read returned [] on the live site
 * and the module quietly settled on its defaults, which are `enabled: false`.
 * Result: a popup that could be configured perfectly in the admin and would
 * never once appear, with nothing anywhere saying why.
 *
 * Reading it here removes that trap. Same approach product-page-config.js takes
 * for `product_page`, and for the same reason. The RLS file is still shipped and
 * still worth running — it just isn't load-bearing any more.
 *
 * What's returned is the popup's own presentation and the offer terms, which are
 * printed on the popup itself and therefore public by nature. Knowing them
 * grants nothing: /api/popup-claim reads this same row to decide what to issue,
 * so a shopper editing a request can't change their discount.
 */

import { cors, json } from './_commerce.js';

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestGet({ env }) {
  try {
    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return json({ ok: false, config: null }, 200, cors(env));

    const rows = await fetch(
      `${env.SUPABASE_URL}/rest/v1/site_settings?select=value&key=eq.email_popup&limit=1`,
      { headers: { apikey: key, Authorization: 'Bearer ' + key }, cache: 'no-store' }
    ).then((r) => (r.ok ? r.json() : [])).catch(() => []);

    let value = rows && rows[0] ? rows[0].value : null;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch (_) { value = null; } }

    // Short cache: the popup is on every page, and the config changes about as
    // often as someone edits it in the admin. 60s keeps the origin quiet without
    // making a save feel like it did nothing.
    return json({ ok: true, config: value }, 200, {
      ...cors(env),
      'Cache-Control': 'public, max-age=60',
    });
  } catch (_) {
    // Never fail loudly: a broken config read should leave the storefront
    // exactly as it was, not throw on every page load.
    return json({ ok: false, config: null }, 200, cors(env));
  }
}
