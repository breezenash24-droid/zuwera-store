/**
 * Cloudflare Pages Function: POST /api/admin-audit   (admin only)
 *
 * The admin panel writes most of its own history, because most of what it does
 * is a direct PostgREST call from the browser — archiving a product, editing a
 * review, saving settings. There is no server in that path to notice, so the
 * page has to say what it did.
 *
 * WHAT THIS ENDPOINT REFUSES TO TAKE FROM IT: who did it.
 *
 * The old shape had the browser insert the row itself, with `admin_user_id` and
 * `admin_email` filled in from the page's own state. Here the identity comes
 * from verifyAdmin() — the same token check every other admin endpoint uses,
 * which now also requires a second factor — and the body's `action`,
 * `resource_type`, `resource_id` and `metadata` are the only fields a caller
 * can influence. The IP, country, user agent, role and timestamp are the
 * server's.
 *
 * Paired with migration 0029, which revokes INSERT on admin_audit_log from
 * `authenticated`, this is what makes the table append-only-by-the-server: a
 * client holding an admin token can ask for a row to be written and cannot
 * write one directly, cannot sign it as somebody else, and cannot delete it.
 *
 * IT IS NOT THE WHOLE LOG. The decisions that move money or grant access are
 * recorded by decide() regardless of what the interface says (see _audit.js).
 * This endpoint carries the rest — the changes a UI is the only witness to.
 */

import { json, cors, verifyAdmin, assuranceOf, MFA_REQUIRED_REASON } from './_commerce.js';
import { record } from './_audit.js';

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

/* An allowlist would go stale the moment somebody adds a page; a free-text
   field would let a caller write a novel into a column that is meant to be
   greppable. So: shape, not vocabulary. */
function cleanName(value, max) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, '')
    .slice(0, max);
}

export async function onRequestPost({ request, env }) {
  const headers = cors(env);
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();

  const admin = await verifyAdmin(env, token);
  if (!admin) {
    const aal = assuranceOf(token);
    return json({
      ok: false,
      logged: false,
      error: (aal && aal !== 'aal2') ? MFA_REQUIRED_REASON : 'Please sign in as an admin.',
    }, 401, headers);
  }

  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }

  const action = cleanName(body.action, 80);
  const resourceType = cleanName(body.resource_type || body.resourceType, 60);
  if (!action || !resourceType) {
    return json({ ok: false, logged: false, error: 'action and resource_type are required.' }, 400, headers);
  }

  const ok = await record(env, admin, {
    action,
    resource_type: resourceType,
    resource_id: body.resource_id ?? body.resourceId ?? null,
    source: 'panel',
    metadata: (body.metadata && typeof body.metadata === 'object') ? body.metadata : {},
  }, request);

  /* 200 with logged:false rather than a 5xx. The caller has already made the
     change this row was describing — telling it the request failed would invite
     a retry of something that already happened. What it needs to know is that
     the history is incomplete, which is what the flag says, and the panel
     surfaces that rather than swallowing it. */
  return json({ ok: true, logged: ok }, 200, headers);
}
