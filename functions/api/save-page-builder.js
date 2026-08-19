/**
 * /api/save-page-builder — Cloudflare Pages Function
 * Saves page builder configs to site_settings using service role key (bypasses RLS).
 * Supports multiple keys: page_builder, builder_theme, builder_nav, builder_history, builder_templates
 */

import { resolvePerms, permsHave } from './_rbac.js';
import { supabaseUrl, supabaseAnonKey } from './_config.js';

// product_page_draft / collection_page_draft are the draft halves added so the
// Product and Collection tabs behave like the Content and Pages tabs: Save keeps
// it private, Publish makes it live. Note the naming is the opposite way round
// from page_builder: the LIVE key keeps its original name so the storefront
// reads exactly what it always did — no fallback logic, and no new key needing
// a change to the anon-read RLS policy.
// theme_modes is here so the builder's Design tab can edit themes in place. It
// is the same list the admin's Appearance → Themes writes; two screens, one key,
// because the alternative is two half-lists that disagree about what a theme is.
// The three *_draft keys below carry text edited on the canvas that no page
// section owns: the nav labels, the announcement bar, and copy baked into a
// page template. They are drafts for the same reason section edits are --
// nothing typed in the builder reaches a shopper until Publish -- and the
// draft halves are deliberately NOT in the site_settings public-read policy
// (migration 0026 says why): the preview receives them over postMessage from
// the builder, never by reading the database.
const ALLOWED_KEYS = ['page_builder','builder_theme','builder_nav','builder_history','builder_templates','builder_layouts','page_builder_published','landing_pages','landing_pages_published','scheduled_publish','product_page','collection_page','product_page_draft','collection_page_draft','theme_modes','nav_menu_draft','announcement_bar_draft','text_overrides_draft','header_layout_draft'];

// Draft key → the live key it publishes to.
const DRAFT_TO_LIVE = {
  product_page_draft: 'product_page',
  collection_page_draft: 'collection_page',
  nav_menu_draft: 'nav_menu',
  announcement_bar_draft: 'announcement_bar',
  text_overrides_draft: 'text_overrides',
  header_layout_draft: 'header_layout',
};

function cors(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { accessToken, published } = body;

    if (!accessToken) return cors({ error: 'No access token' }, 401);

    // Determine which key to save under (default: page_builder)
    const key = body.key || 'page_builder';
    if (!ALLOWED_KEYS.includes(key)) return cors({ error: 'Key not permitted: ' + key }, 403);

    // Verify session
    const userRes = await fetch(`${supabaseUrl(env)}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey(env), Authorization: 'Bearer ' + accessToken },
    });
    if (!userRes.ok) return cors({ error: 'Invalid or expired session' }, 401);
    const authUser = await userRes.json().catch(() => null);
    if (!authUser?.id) return cors({ error: 'Invalid or expired session' }, 401);

    // Get service role key
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE;
    if (!serviceKey) return cors({ error: 'Server not configured — add SUPABASE_SERVICE_ROLE_KEY env var' }, 500);

    // Authorize: must be an admin whose role can edit the builder.
    // (Previously this endpoint only checked the session was valid — any
    // logged-in customer could overwrite the homepage. RBAC closes that.)
    const profRes = await fetch(
      `${supabaseUrl(env)}/rest/v1/profiles?id=eq.${encodeURIComponent(authUser.id)}&select=role,admin_role,admin_permissions&limit=1`,
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    const profRows = profRes.ok ? await profRes.json().catch(() => []) : [];
    const prof = Array.isArray(profRows) ? profRows[0] : null;
    if (!prof || prof.role !== 'admin') {
      return cors({ error: 'Your account does not have admin privileges.' }, 403);
    }
    const perms = resolvePerms({ admin_role: prof.admin_role || 'super_admin', admin_permissions: prof.admin_permissions });
    if (!permsHave(perms, 'builder_edit')) {
      return cors({ error: 'Your role does not have permission to edit pages.' }, 403);
    }

    // Build value from body (strip meta fields).
    // If the body has an explicit 'value' key (used by theme/nav/history/templates saves)
    // use that as the payload so the data isn't double-nested under {value:{...}}.
    const { accessToken: _a, key: _k, published: _p, value: explicitValue, ...rest } = body;
    const payload = explicitValue !== undefined ? explicitValue : rest;
    // Keys whose value IS the data, stored exactly as given.
    //
    // The spread below is wrong for both shapes these keys use. nav_menu is an
    // ARRAY, and { ...['Men','Women'] } is { '0': 'Men', '1': 'Women' } -- an
    // object nav-menu.js would reject outright (it tests Array.isArray). And
    // text_overrides is keyed BY PAGE PATH, so merging updated_at/published
    // into it invents two pages called 'updated_at' and 'published'.
    //
    // The meta fields exist so the builder's own configs can record when they
    // were written; these keys are read by the storefront, which wants the
    // data and nothing else.
    const VERBATIM = new Set([
      'nav_menu', 'nav_menu_draft',
      'announcement_bar', 'announcement_bar_draft',
      'text_overrides', 'text_overrides_draft',
      'header_layout', 'header_layout_draft',
    ]);
    const value = VERBATIM.has(key)
      ? payload
      : { ...payload, updated_at: new Date().toISOString(), published: !!published };

    // Build rows to upsert
    const rows = [{ key, value }];
    if (key === 'page_builder' && published) {
      rows.push({ key: 'page_builder_published', value });
    }
    if (key === 'landing_pages' && published) {
      rows.push({ key: 'landing_pages_published', value });
    }
    // The Product and Collection tabs: a plain save writes only the draft, and
    // publishing copies it onto the live key the storefront reads. Before this,
    // their Save button wrote straight to the live key while the Content and
    // Pages tabs saved drafts — so "Save" meant two different things depending
    // on which tab you were on, and Publish did nothing for two of them.
    if (DRAFT_TO_LIVE[key] && published) {
      rows.push({ key: DRAFT_TO_LIVE[key], value });
    }

    const saveRes = await fetch(`${supabaseUrl(env)}/rest/v1/site_settings?on_conflict=key`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    });

    if (!saveRes.ok) {
      const errText = await saveRes.text();
      return cors({ error: errText }, saveRes.status);
    }

    return cors({ success: true });

  } catch (e) {
    return cors({ error: e.message || String(e) }, 500);
  }
}
