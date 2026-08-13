/**
 * POST /api/admin-control — guarded settings changes.
 *
 * Two actions today, both behind an authorization code:
 *
 *   tax-engine   which engine prices every future order
 *   pause        stop or resume a non-critical service
 *
 * ONE ENDPOINT rather than two, because they are one idea — a change that is
 * cheap to make, expensive to get wrong, and invisible afterwards. Splitting
 * them would mean two copies of the code check, the audit write and the
 * settings merge, and this codebase has a long history of the second copy being
 * the one that misses a fix.
 *
 * WHY THE TAX ENGINE MOVED HERE AT ALL. The admin page wrote site_settings
 * directly from the browser. That is fine for a colour, and wrong for the thing
 * that decides what every customer is charged in tax: one dropdown, no
 * confirmation, no record of who changed it, and no way afterwards to tell an
 * accident from a decision. The write now needs the code and leaves a row.
 *
 * READS ARE UNCHANGED. Nothing here gates seeing the current engine — only
 * changing it.
 */

import { cors, json, verifyAdmin, mutateSetting } from './_commerce.js';
import { checkControlCode, auditGuarded } from './_guarded.js';
import { PAUSABLE } from './_paused.js';
import { TAX_ENGINES } from './_tax.js';

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  const h = cors(env);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid request body.' }, 400, h); }

  const token = String(body.accessToken || (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')).trim();
  if (!token) return json({ ok: false, error: 'Missing access token' }, 401, h);
  const admin = await verifyAdmin(env, token);
  if (!admin) return json({ ok: false, error: 'Admin access required' }, 403, h);

  /* The second factor, checked before anything is read or written. */
  const gate = checkControlCode(env, body.code);
  if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status, h);

  const adminEmail = String(admin.email || '');
  const adminId    = admin.id || null;
  const ua         = request.headers.get('user-agent') || '';
  const action     = String(body.action || '').trim();

  // ── Which engine prices tax ───────────────────────────────────────────────
  if (action === 'tax-engine') {
    const engine = String(body.engine || '').trim();
    if (!TAX_ENGINES.includes(engine)) {
      return json({ ok: false, error: 'Unknown tax engine: ' + engine, allowed: TAX_ENGINES }, 400, h);
    }
    let before = '';
    /* Compare-and-set, because tax_engine is one JSON blob and a plain
       read-modify-write drops whatever else it holds — the endpoint URL, the
       fallback flag, the per-category codes. */
    await mutateSetting(env, 'tax_engine', (cur) => {
      const cfg = (cur && typeof cur === 'object') ? cur : {};
      before = String(cfg.engine || '');
      return { ...cfg, engine, updatedAt: new Date().toISOString() };
    });
    await auditGuarded(env, {
      action: 'tax.engine_changed', resourceId: 'tax_engine',
      adminEmail, adminId, ua, detail: { from: before || '(unset)', to: engine },
    });
    return json({ ok: true, engine, previous: before || null }, 200, h);
  }

  // ── Pause or resume a service ─────────────────────────────────────────────
  if (action === 'pause') {
    const service = String(body.service || '').trim();
    const paused  = body.paused === true;
    if (!PAUSABLE.includes(service)) {
      /* The refusal that matters. Stripe, Supabase, Resend and Shippo are not
         on this list on purpose — see _paused.js. Answering "unknown service"
         rather than silently doing nothing means a caller cannot believe it
         paused something it did not. */
      return json({ ok: false, error: 'That service cannot be paused.', pausable: PAUSABLE }, 400, h);
    }
    await mutateSetting(env, 'api_paused', (cur) => {
      const cfg = (cur && typeof cur === 'object') ? cur : {};
      return { ...cfg, [service]: paused };
    });
    await auditGuarded(env, {
      action: paused ? 'service.paused' : 'service.resumed', resourceId: service,
      adminEmail, adminId, ua, detail: { service, paused },
    });
    return json({ ok: true, service, paused }, 200, h);
  }

  return json({ ok: false, error: 'Unknown action.', actions: ['tax-engine', 'pause'] }, 400, h);
}

export async function onRequestGet({ env }) {
  return json({ ok: false, error: 'POST with an admin token, an authorization code and an action.' }, 405, cors(env));
}
