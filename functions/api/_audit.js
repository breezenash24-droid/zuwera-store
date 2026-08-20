/* ────────────────────────────────────────────────────────────────────────────
   _audit.js — the admin audit log, written by the server.

   WHAT IT WAS. Every one of the 48 audit rows was inserted by the browser:

       admin-main.js:394   logAdminAudit(action, resourceType, …)
       admin-main.js:411   sb.from('admin_audit_log').insert([payload])

   with `admin_user_id` and `admin_email` taken from the page's own idea of who
   it was. Three separate problems, and the third is the worst:

     1. THE "WHO" WAS SELF-REPORTED. The RLS policy checked
        `admin_user_id = auth.uid()`, which stops one admin signing a row as
        another — but everything else in the row, including the action and the
        resource, was whatever the client chose to send.

     2. ANYTHING DONE OUTSIDE THE UI LEFT NO ROW. The admin panel talks to
        PostgREST directly, so the same token in a console or a curl call does
        the same writes and logs nothing. The log recorded what the interface
        chose to record, which is not what an audit log is for.

     3. ONE FAILURE SILENCED THE SESSION. The catch block set
        `auditTableReady = false`, so a single transient error stopped all
        logging until the page was reloaded — with a console.warn nobody was
        reading. A log that can go quiet without saying so is worse than no log,
        because the absence of rows gets read as the absence of activity.

   WHAT IT IS NOW. Two writers, both here, both server-side with the service
   role:

     record()      called by an endpoint that just did something. The identity
                   comes from the token the endpoint already verified, never
                   from the request body.

     recordDecision()  called by decide() in _commerce.js for every sealed
                   authorization answer, allow and deny alike. This is the half
                   that does not depend on the interface: refunds, deletions,
                   role grants and exports log themselves whether they were
                   asked for by the panel, by a script, or by somebody probing.

   Denials are logged too, on purpose. "Somebody tried to refund and was
   stopped" is the single most useful line in an audit log and it is the one a
   UI-driven logger can never write, because the UI does not get that far.

   FAILURE IS LOUD BUT NEVER FATAL. A logging error must not roll back the
   action that was already performed — that would make the log a second thing
   that can break the store. So writes here return a boolean and never throw,
   and the failure is surfaced twice: console.error for the tail, and the
   `logged` flag on the response so the panel can tell somebody. What it must
   never do again is turn itself off.
   ──────────────────────────────────────────────────────────────────────────── */

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
}

/* Keep a row small enough to be worth keeping. A 4KB blob of product JSON in
   `metadata` costs storage on every save and tells a reader nothing they could
   not get from the resource itself. */
function trim(value, max = 900) {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
    return text.length > max ? text.slice(0, max) + '…' : text;
  } catch (_) {
    return '[unserializable]';
  }
}

function requestFacts(request) {
  if (!request || !request.headers) return {};
  const h = request.headers;
  return {
    ip: h.get('CF-Connecting-IP') || h.get('X-Forwarded-For') || '',
    country: h.get('CF-IPCountry') || '',
    user_agent: (h.get('User-Agent') || '').slice(0, 400),
  };
}

/**
 * Write one row. Returns true when it landed.
 *
 * `admin` must be the object returned by verifyAdmin — i.e. an identity the
 * server resolved from a token it verified. There is deliberately no parameter
 * for "who did this": the only answer this function will accept is the one the
 * caller already proved.
 */
export async function record(env, admin, entry = {}, request = null) {
  const key = serviceKey(env);
  if (!env.SUPABASE_URL || !key) {
    console.error('audit: cannot write — Supabase service credentials are not configured');
    return false;
  }
  if (!admin || !admin.id) {
    console.error('audit: refused to write a row with no verified identity —', entry.action);
    return false;
  }

  const facts = requestFacts(request);
  const row = {
    admin_user_id: admin.id,
    admin_email: admin.email || admin.profile?.email || null,
    action: String(entry.action || 'unknown'),
    resource_type: String(entry.resource_type || 'unknown'),
    resource_id: entry.resource_id == null ? null : String(entry.resource_id),
    metadata: {
      ...(entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {}),
      /* Recorded here rather than accepted from the caller: the role and the
         route are facts the server holds, and a row that took them from the
         request would be describing itself. */
      admin_role: admin.admin_role || null,
      source: entry.source || 'endpoint',
      ip: facts.ip,
      country: facts.country,
      summary: trim(entry.metadata),
    },
    user_agent: facts.user_agent,
  };

  try {
    const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/admin_audit_log`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify([row]),
    });
    if (!resp.ok) {
      const details = await resp.text().catch(() => '');
      console.error('audit: write failed', resp.status, details.slice(0, 300), '—', row.action);
      return false;
    }
    return true;
  } catch (e) {
    console.error('audit: write threw —', e && e.message, '—', row.action);
    return false;
  }
}

/* Which permissions are worth a row on their own, regardless of what the
   interface did. The test for being on this list is not "is it important" but
   "would you want to know it was ATTEMPTED" — which is why refusals are
   recorded for exactly these and nothing else. Everything else that succeeds
   still logs through record(), from the endpoint that performed it. */
const SEALED = new Set([
  'refund',
  'product_write',
  'user_manage',
  'role_manage',
  'apikey_manage',
  'pricing_write',
  'tax_write',
  'order_write',
  'return_process',
  'settings_write',
  'customer_export',
]);

/**
 * Log an authorization answer. Called from decide() for every sealed action.
 *
 * A DENIAL IS THE POINT. An allow is usually also recorded by the endpoint that
 * went on to do the work, so this can look like duplication — it is not. The
 * pair is what tells you whether the thing that was authorized actually
 * happened, and a decision with no matching action is exactly the shape of a
 * request that failed halfway.
 */
export async function recordDecision(env, admin, permission, verdict, request = null) {
  if (!SEALED.has(String(permission || ''))) return false;
  if (!admin || !admin.id) return false;
  return record(env, admin, {
    action: 'authz.' + (verdict && verdict.allow ? 'allow' : 'deny') + '.' + permission,
    resource_type: 'authorization',
    resource_id: null,
    source: 'decide',
    metadata: {
      permission,
      allow: !!(verdict && verdict.allow),
      reason: verdict && verdict.reason ? String(verdict.reason).slice(0, 240) : '',
      rule: (verdict && verdict.rule) || '',
      limited: !!(verdict && verdict.limited),
    },
  }, request);
}

export const AUDIT_SEALED_PERMISSIONS = SEALED;
