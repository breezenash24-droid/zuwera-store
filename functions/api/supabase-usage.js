/**
 * Cloudflare Pages Function: POST /api/supabase-usage   (admin only)
 *
 * How much of the Supabase free tier is left, read live.
 *
 * TWO SOURCES, because they answer different questions and only one of them
 * needs a token:
 *
 *   MEASURED (always available, service key). Row counts and storage bytes,
 *   read straight from the project. Tells you how big things are.
 *
 *   BILLING (needs SUPABASE_ACCESS_TOKEN, a Personal Access Token from
 *   supabase.com/dashboard/account/tokens). Egress, database size and MAU as
 *   Supabase itself bills them. Egress in particular is billing-side telemetry
 *   — there is no way to compute it from the database, so without the token
 *   this endpoint says so rather than inventing a figure.
 *
 * The Management API's usage routes are not part of the documented stable
 * surface, so several shapes are tried and whichever answers is used. If none
 * do, that is reported as "not available" — a usage panel that quietly shows a
 * made-up number is worse than one that admits it cannot see.
 */

import { resolvePerms, permsHave } from './_rbac.js';
import { DEFAULTS } from './_config.js';

const ANON_KEY = DEFAULTS.supabaseAnonKey;
const SUPABASE_URL = DEFAULTS.supabaseUrl;

// Free-tier allowances, so the panel can show "x of y" rather than a bare
// number nobody can act on.
const FREE_TIER = {
  egress_gb: 5,
  cached_egress_gb: 5,
  db_size_gb: 0.5,
  storage_gb: 1,
  mau: 50000,
  edge_invocations: 500000,
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** Exact row count without transferring any rows. */
async function countRows(env, key, table) {
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?select=id&limit=1`, {
      headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'count=exact', Range: '0-0' },
    });
    const range = r.headers.get('content-range') || '';      // "0-0/1234"
    const total = Number(String(range).split('/')[1]);
    return Number.isFinite(total) ? total : null;
  } catch (_) { return null; }
}

/** Total bytes held in Storage, summed across buckets. */
async function storageBytes(env, key) {
  try {
    const buckets = await fetch(`${env.SUPABASE_URL}/storage/v1/bucket`, {
      headers: { apikey: key, Authorization: 'Bearer ' + key },
    }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    if (!Array.isArray(buckets) || !buckets.length) return { bytes: 0, objects: 0, buckets: 0 };

    let bytes = 0, objects = 0;
    for (const b of buckets) {
      const list = await fetch(`${env.SUPABASE_URL}/storage/v1/object/list/${encodeURIComponent(b.name)}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 1000, offset: 0, prefix: '' }),
      }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
      (Array.isArray(list) ? list : []).forEach((o) => {
        objects++;
        const size = o && o.metadata && Number(o.metadata.size);
        if (Number.isFinite(size)) bytes += size;
      });
    }
    return { bytes, objects, buckets: buckets.length };
  } catch (_) { return { bytes: 0, objects: 0, buckets: 0 }; }
}

/**
 * Billing usage from the Management API. Undocumented surface, so try the
 * shapes it has used and take the first that answers.
 */
async function billingUsage(env) {
  const pat = env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_PAT || '';
  if (!pat) return { available: false, reason: 'no_token' };

  const ref = String(env.SUPABASE_PROJECT_REF || (SUPABASE_URL.split('//')[1] || '').split('.')[0]);
  const H = { Authorization: 'Bearer ' + pat, 'Content-Type': 'application/json' };

  // Organisation slug first — the usage routes are org-scoped.
  let orgs = [];
  try {
    orgs = await fetch('https://api.supabase.com/v1/organizations', { headers: H })
      .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  } catch (_) {}
  const slug = Array.isArray(orgs) && orgs[0] && (orgs[0].slug || orgs[0].id);

  /* Supabase's dashboard clearly HAS these numbers — cached egress, database
     size, MAU, edge invocations — so a route exists. It is not in the
     documented stable API, which is why this is a list rather than a call: the
     org-scoped v1 routes, the project-scoped one, and the `platform/` prefix
     the dashboard itself uses. Whichever answers wins.

     The previous version tried three and, when none worked, said only
     "no_endpoint" — which is indistinguishable from a bad token, an expired
     token, a wrong org, and a route that has simply moved. Four different
     problems reported as one word, so there was nothing to act on. Each attempt
     now records its status, and the panel can say WHICH failure this is. */
  const candidates = [
    slug ? `https://api.supabase.com/v1/organizations/${encodeURIComponent(slug)}/usage` : null,
    slug ? `https://api.supabase.com/platform/organizations/${encodeURIComponent(slug)}/usage` : null,
    slug ? `https://api.supabase.com/v1/organizations/${encodeURIComponent(slug)}/billing/usage` : null,
    slug ? `https://api.supabase.com/platform/organizations/${encodeURIComponent(slug)}/billing/usage` : null,
    `https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/usage`,
    `https://api.supabase.com/platform/projects/${encodeURIComponent(ref)}/usage`,
    `https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/billing/usage`,
  ].filter(Boolean);

  const attempts = [];
  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers: H });
      // Recorded whether it worked or not — the failures are the diagnosis.
      attempts.push({ url: url.replace('https://api.supabase.com', ''), status: r.status });
      if (!r.ok) continue;
      const data = await r.json().catch(() => null);
      if (data) return { available: true, source: url, data, attempts };
    } catch (e) {
      attempts.push({ url: url.replace('https://api.supabase.com', ''), status: 'threw: ' + (e && e.message) });
    }
  }
  /* 401 everywhere means the token; 404 everywhere means the routes moved; a
     mix means the org slug is wrong. Naming which of those it is turns "did not
     answer" into something someone can actually fix. */
  const codes = attempts.map((a) => a.status);
  const reason =
    codes.every((c) => c === 401 || c === 403) ? 'token_rejected'
    : codes.every((c) => c === 404)            ? 'routes_moved'
    : !slug                                    ? 'no_org_found'
    : 'no_endpoint';
  return { available: false, reason, org: slug || null, attempts };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const accessToken = String(body.accessToken || '').trim();
    if (!accessToken) return json({ ok: false, error: 'Please sign in again.' }, 401);

    const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
    if (!key) return json({ ok: false, error: 'Server not configured — add SUPABASE_SERVICE_ROLE_KEY.' }, 500);

    // Admin, and specifically one allowed to see infrastructure state.
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + accessToken },
    });
    if (!userRes.ok) return json({ ok: false, error: 'Your session expired. Sign in again.' }, 401);
    const authUser = await userRes.json().catch(() => null);
    if (!authUser || !authUser.id) return json({ ok: false, error: 'Your session expired. Sign in again.' }, 401);

    const rows = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(authUser.id)}&select=role,admin_role,admin_permissions&limit=1`,
      { headers: { apikey: key, Authorization: 'Bearer ' + key } }
    ).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const prof = Array.isArray(rows) ? rows[0] : null;
    if (!prof || prof.role !== 'admin') return json({ ok: false, error: 'Admins only.' }, 403);
    const perms = resolvePerms({ admin_role: prof.admin_role || 'super_admin', admin_permissions: prof.admin_permissions });
    if (!permsHave(perms, 'apikey_manage')) {
      return json({ ok: false, error: 'Your role cannot view infrastructure usage.' }, 403);
    }

    const [products, images, orders, subs, store, billing] = await Promise.all([
      countRows(env, key, 'products'),
      countRows(env, key, 'product_images'),
      countRows(env, key, 'orders'),
      countRows(env, key, 'newsletter_subscribers'),
      storageBytes(env, key),
      billingUsage(env),
    ]);

    return json({
      ok: true,
      freeTier: FREE_TIER,
      measured: {
        rows: { products, product_images: images, orders, newsletter_subscribers: subs },
        storage: store,
      },
      billing,
      checkedAt: new Date().toISOString(),
    });
  } catch (e) {
    return json({ ok: false, error: (e && e.message) || 'failed' }, 500);
  }
}
