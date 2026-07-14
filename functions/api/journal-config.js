/**
 * Cloudflare Pages Function: GET /api/journal-config   (public, read-only)
 *
 * Returns the Journal hero config (label / title / subtitle / heading font) so
 * the public /journal page can render it. The config lives in
 * site_settings.journal_settings, which is NOT in the anon read whitelist, so
 * we read it server-side with the service-role key and expose ONLY these
 * display strings — no secrets.
 */

import { cors, json } from './_commerce.js';

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}

const DEFAULTS = {
  label: 'The Journal',
  title: 'Field Notes',
  subtitle: 'Stories, drops, and the thinking behind Zuwera.',
  heading_font: '',
  body_font: '',
  aspect: '',
};

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestGet({ env }) {
  try {
    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return json(DEFAULTS, 200, cors(env));

    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/site_settings?select=value&key=eq.journal_settings&limit=1`,
      { headers: { apikey: key, Authorization: 'Bearer ' + key }, cache: 'no-store' }
    );
    const rows = r.ok ? await r.json() : [];
    if (!rows || !rows.length) return json(DEFAULTS, 200, cors(env));

    let v = rows[0] && rows[0].value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = {}; } }
    v = v || {};

    // Use the saved value when the field is present; fall back to defaults for
    // anything the admin never set. (An admin who blanks a field on purpose
    // gets the empty string, which the page hides.)
    return json({
      label: v.label != null ? String(v.label) : DEFAULTS.label,
      title: (v.title != null && String(v.title).trim()) ? String(v.title) : DEFAULTS.title,
      subtitle: v.subtitle != null ? String(v.subtitle) : DEFAULTS.subtitle,
      heading_font: String(v.heading_font || ''),
      body_font: String(v.body_font || ''),
      aspect: String(v.aspect || ''),
    }, 200, cors(env));
  } catch (e) {
    return json(DEFAULTS, 200, cors(env));
  }
}
