/**
 * POST /api/abac-request — asking, and answering, when a limit says no.
 *
 * The gap this fills: a refusal somebody can do nothing about gets escalated
 * by turning the limit off. That is how limits stop being used — not because
 * they are wrong, but because the only available response to one is to delete
 * it. This gives the smaller answer: yes, for this case, once.
 *
 * Three operations on ONE list (see ABAC_REQUESTS_KEY in _commerce.js — a
 * request and an approval are the same record at different points in its
 * life, and two lists would eventually disagree about whether something was
 * approved, with the authorization system reading one of them).
 *
 *   create   any admin, about a refusal that was theirs
 *   list     your own; a super admin sees everybody's
 *   decide   approve or decline — super admin only
 *
 * WHAT AN APPROVAL IS. Not a permission and not a role change: a one-time
 * waiver of ONE limit, for ONE order, up to the amount that was asked about,
 * expiring in a day. It is checked in _abac.js only after RBAC already said
 * yes, so the most it can restore is what the role granted. Approving one
 * cannot hand out anything a person could not otherwise do.
 */

import { cors, json, verifyAdmin, mutateSetting, getSetting, ABAC_REQUESTS_KEY } from './_commerce.js';
import { permsHave } from './_rbac.js';

/* Long enough to walk over and ask, short enough that a forgotten yes is not
   a standing exemption. An approval nobody remembers granting is the failure
   mode this whole thing is meant to avoid. */
const WAIVER_TTL_MS = 24 * 60 * 60 * 1000;
const KEEP = 200;

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  const h = cors(env);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, 400, h); }

  const { accessToken, op } = body || {};
  const admin = await verifyAdmin(env, accessToken);
  if (!admin) return json({ error: 'Not signed in as an admin.' }, 401, h);

  /* The same gate as changing somebody's role, and deliberately so: waiving a
     limit and raising a limit are the same power, and splitting them across
     two permissions would mean the smaller-sounding one was the way round the
     bigger one. */
  const mayDecide = permsHave(admin.permissions, 'role_manage');
  const meId = String(admin.id || '');
  const meEmail = String(admin.email || '');

  const all = await readList(env);

  // ── list ───────────────────────────────────────────────────────────────────
  if (op === 'list') {
    const mine = mayDecide ? all : all.filter((r) => samePerson(r, meId, meEmail));
    return json({ requests: mine.slice(0, KEEP), mayDecide }, 200, h);
  }

  // ── create ─────────────────────────────────────────────────────────────────
  if (op === 'create') {
    const action = String(body.action || '').trim();
    const ruleId = String(body.ruleId || '').trim();
    const resourceId = String(body.resourceId || '').trim();
    if (!action || !ruleId || !resourceId) {
      return json({ error: 'A request has to name what was refused and what it was about.' }, 400, h);
    }

    /* Built here from whitelisted fields, never from the body wholesale. A
       requester who could set `status` could approve themselves, which is the
       entire feature backwards. */
    const now = Date.now();
    const rec = {
      id: crypto.randomUUID(),
      at: new Date(now).toISOString(),
      byId: meId,
      byEmail: meEmail,
      byName: String(admin.full_name || '').trim(),
      action,
      ruleId,
      resourceId,
      amount: numOrNull(body.amount),
      itemCount: numOrNull(body.itemCount),
      reason: String(body.reason || '').slice(0, 500),
      refusedWith: String(body.refusedWith || '').slice(0, 300),
      status: 'pending',
    };

    await mutateSetting(env, ABAC_REQUESTS_KEY, (cur) => {
      const list = Array.isArray(cur) ? cur : [];
      /* Asking twice is one ask. Without this, clicking the button again
         because nothing visibly happened leaves two rows for a super admin to
         answer, and answering one of them looks like it did not work. */
      const dupe = list.findIndex((r) => r && r.status === 'pending'
        && samePerson(r, meId, meEmail)
        && String(r.action) === action && String(r.resourceId) === resourceId
        && String(r.ruleId) === ruleId);
      if (dupe !== -1) {
        const merged = { ...list[dupe], at: rec.at, amount: rec.amount, itemCount: rec.itemCount };
        if (rec.reason) merged.reason = rec.reason;
        const next = list.slice();
        next[dupe] = merged;
        return next.slice(0, KEEP);
      }
      return [rec, ...list].slice(0, KEEP);
    });

    return json({ ok: true, id: rec.id, status: 'pending' }, 200, h);
  }

  // ── decide ─────────────────────────────────────────────────────────────────
  if (op === 'decide') {
    if (!mayDecide) {
      return json({ error: 'Only a super admin can answer these.' }, 403, h);
    }
    const id = String(body.id || '');
    const approve = body.approve === true;
    const target = all.find((r) => r && String(r.id) === id);
    if (!target) return json({ error: 'That request no longer exists.' }, 404, h);
    if (target.status !== 'pending') {
      return json({ error: `That was already ${target.status}.` }, 409, h);
    }
    /* A person cannot answer their own ask. A super admin bound by a limit
       set to "notify" is told they may change the limit — that is the route
       for them, and it is a deliberate, visible edit rather than a
       self-approval that reads in the log exactly like somebody else's. */
    if (samePerson(target, meId, meEmail)) {
      return json({ error: 'You cannot approve your own request. Change the limit instead — it is yours to change.' }, 403, h);
    }

    const at = new Date().toISOString();
    await mutateSetting(env, ABAC_REQUESTS_KEY, (cur) => {
      const list = Array.isArray(cur) ? cur : [];
      return list.map((r) => {
        if (!r || String(r.id) !== id || r.status !== 'pending') return r;
        return {
          ...r,
          status: approve ? 'approved' : 'declined',
          decidedById: meId,
          decidedByEmail: meEmail,
          decidedAt: at,
          note: String(body.note || '').slice(0, 500),
          /* Only an approval expires. A decline has nothing to run out. */
          expiresAt: approve ? new Date(Date.now() + WAIVER_TTL_MS).toISOString() : undefined,
        };
      });
    });

    return json({ ok: true, status: approve ? 'approved' : 'declined' }, 200, h);
  }

  return json({ error: 'Unknown operation.' }, 400, h);
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function readList(env) {
  try {
    const cur = await getSetting(env, ABAC_REQUESTS_KEY, null);
    return Array.isArray(cur) ? cur : [];
  } catch { return []; }
}

/* Id or email, because the panel knows people by email and the session knows
   them by id — matching on only one of those is a silent no-match. */
function samePerson(rec, id, email) {
  if (!rec) return false;
  const a = String(rec.byId || '').toLowerCase();
  const b = String(rec.byEmail || '').toLowerCase();
  return (a && a === String(id || '').toLowerCase())
      || (b && b === String(email || '').toLowerCase());
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
