/**
 * Cloudflare Pages Function: POST /api/migrate   (admin only)
 *
 * Applies pending database migrations, and reports drift.
 *
 * WHY THIS EXISTS RATHER THAN JUST `supabase db push`. The CLI is the right
 * shape and this keeps its file layout, but the failure this codebase actually
 * suffers is not "the migration was wrong" — it is "nobody ran it". The live
 * RLS policy had drifted from every .sql file in the repository, silently
 * disabling two features for weeks. A step that requires someone to remember a
 * terminal command is the step that gets skipped. This one is a button next to
 * the thing it affects, and the admin can see at a glance whether production
 * matches the repository.
 *
 * Actions:
 *   status  what is applied, what is pending, and whether any applied migration
 *           has been edited since it ran
 *   apply   run every pending migration in version order, stopping at the first
 *           failure
 *
 * SAFETY:
 *   • Migrations run through apply_migration(), which records and executes in
 *     one transaction — a failure leaves nothing half-recorded.
 *   • Already-applied versions are skipped inside that function too, so a
 *     double-click cannot replay one.
 *   • They run in version order and stop at the first error, so a broken
 *     migration cannot let a later one run against a schema it did not expect.
 *   • Nothing here can be reached without an admin session AND apikey_manage.
 */

import { resolvePerms, permsHave } from './_rbac.js';
import { MIGRATIONS } from './_migrations.js';
import { supabaseUrl, supabaseAnonKey } from './_config.js';


function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
}

/** Rows already recorded as applied. null means the tracking table is missing. */
async function appliedRows(env, key) {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/schema_migrations?select=version,name,checksum,applied_at,applied_by&order=version.asc`,
    { headers: { apikey: key, Authorization: 'Bearer ' + key }, cache: 'no-store' }
  );
  if (!r.ok) return null;                       // table not created yet → bootstrap needed
  return await r.json().catch(() => []);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' },
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const accessToken = String(body.accessToken || '').trim();
    const action = body.action === 'apply' ? 'apply' : 'status';
    if (!accessToken) return json({ ok: false, error: 'Please sign in again.' }, 401);

    const key = serviceKey(env);
    if (!key || !env.SUPABASE_URL) {
      return json({ ok: false, error: 'Server not configured — add SUPABASE_SERVICE_ROLE_KEY.' }, 500);
    }

    // Admin, and specifically one trusted with infrastructure. Applying a
    // migration is the most consequential button in the admin.
    const userRes = await fetch(`${supabaseUrl(env)}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey(env), Authorization: 'Bearer ' + accessToken },
    });
    if (!userRes.ok) return json({ ok: false, error: 'Your session expired. Sign in again.' }, 401);
    const authUser = await userRes.json().catch(() => null);
    if (!authUser || !authUser.id) return json({ ok: false, error: 'Your session expired. Sign in again.' }, 401);

    const profRows = await fetch(
      `${supabaseUrl(env)}/rest/v1/profiles?id=eq.${encodeURIComponent(authUser.id)}&select=role,admin_role,admin_permissions&limit=1`,
      { headers: { apikey: key, Authorization: 'Bearer ' + key } }
    ).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const prof = Array.isArray(profRows) ? profRows[0] : null;
    if (!prof || prof.role !== 'admin') return json({ ok: false, error: 'Admins only.' }, 403);
    const perms = resolvePerms({ admin_role: prof.admin_role || 'super_admin', admin_permissions: prof.admin_permissions });
    if (!permsHave(perms, 'apikey_manage')) {
      return json({ ok: false, error: 'Your role cannot run database migrations.' }, 403);
    }

    const applied = await appliedRows(env, key);
    if (applied === null) {
      // Nothing can run until the one bootstrap file has been pasted in once.
      // Hand back the SQL ITSELF, not a path. Telling someone to "run
      // migrations/0001_migration_tracking.sql" invites them to paste that
      // string into the SQL editor, which is a filename and not SQL — it fails
      // with a syntax error that looks like the migration is broken. The panel
      // shows this with a copy button so there is nothing to go and find.
      const boot = MIGRATIONS.find((m) => m.version === '0001');
      return json({
        ok: true,
        bootstrapped: false,
        bootstrapFile: boot ? boot.file : 'migrations/0001_migration_tracking.sql',
        bootstrapSql: boot ? boot.sql : '',
        applied: [],
        pending: MIGRATIONS.filter((m) => m.version !== '0001').map((m) => ({ version: m.version, name: m.name })),
        message: 'Copy the SQL below into the Supabase SQL editor and run it once. Everything after that applies from here.',
      });
    }

    const appliedBy = {};
    applied.forEach((r) => { appliedBy[r.version] = r; });

    // A migration edited after it ran means the repository and production
    // disagree about what that version did — worth surfacing loudly, because it
    // is invisible otherwise.
    const drifted = MIGRATIONS
      .filter((m) => appliedBy[m.version] && appliedBy[m.version].checksum !== 'bootstrap'
        && appliedBy[m.version].checksum !== m.checksum)
      .map((m) => ({ version: m.version, name: m.name, appliedChecksum: appliedBy[m.version].checksum, fileChecksum: m.checksum }));

    const pending = MIGRATIONS.filter((m) => !appliedBy[m.version]);

    if (action === 'status') {
      return json({
        ok: true,
        bootstrapped: true,
        applied: applied.map((r) => ({ version: r.version, name: r.name, applied_at: r.applied_at, applied_by: r.applied_by })),
        pending: pending.map((m) => ({ version: m.version, name: m.name, file: m.file })),
        drifted,
      });
    }

    // ── apply ───────────────────────────────────────────────────────────────
    const ran = [];
    for (const m of pending) {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/apply_migration`, {
        method: 'POST',
        headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          p_version: m.version, p_name: m.name, p_sql: m.sql,
          p_checksum: m.checksum, p_actor: authUser.email || authUser.id,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        // Stop here. Letting later migrations run against a schema the failed
        // one was supposed to produce is how a half-migrated database happens.
        return json({
          ok: false,
          applied: ran,
          failedAt: { version: m.version, name: m.name },
          error: detail.slice(0, 600) || `HTTP ${res.status}`,
        }, 500);
      }
      ran.push({ version: m.version, name: m.name });
    }

    return json({ ok: true, applied: ran, count: ran.length });
  } catch (e) {
    return json({ ok: false, error: (e && e.message) || 'failed' }, 500);
  }
}
