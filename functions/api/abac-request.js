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
import { fetchSiteSettings, resolveSetting } from './_settings.js';
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
    const shown = mine.slice(0, KEEP);

    /* Whether each order has already been settled elsewhere. A refund issued
       from Receipts or the returns workspace left the request here looking
       live, and the only way to find out was to approve it and watch it fail.
       Read, not written: closing rows as a side effect of drawing a list means
       a page refresh changes data, which is the sort of thing that goes wrong
       quietly. The queue marks them, and approving one closes it properly. */
    const pendingIds = [...new Set(shown
      .filter((r) => r && r.status === 'pending' && r.resourceId)
      .map((r) => String(r.resourceId)))];
    let settled = {};
    if (pendingIds.length) {
      try {
        const sbKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
        const q = pendingIds.map((x) => `"${x}"`).join(',');
        const res = await fetch(
          `${env.SUPABASE_URL}/rest/v1/orders?id=in.(${encodeURIComponent(q)})&select=id,status`,
          { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } }
        );
        if (res.ok) {
          const rows = await res.json().catch(() => []);
          (rows || []).forEach((o) => {
            const s = String(o.status || '').toLowerCase();
            if (s === 'refunded' || s === 'cancelled' || s === 'canceled') settled[String(o.id)] = s;
          });
        }
      } catch (e) {
        /* Unknown, which shows nothing rather than a wrong claim either way. */
        console.warn('abac: could not check order states —', e && e.message);
      }
    }

    return json({
      requests: shown.map((r) => (r && settled[String(r.resourceId)]
        ? { ...r, alreadySettled: settled[String(r.resourceId)] } : r)),
      mayDecide,
    }, 200, h);
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

    /* APPROVING CAN JUST DO IT. Granting a waiver and telling somebody to go
       back and try again is a worse answer than the one they asked for: they
       have already filled the form in once, and a yes they still have to act
       on is a yes that gets forgotten.

       Done as the APPROVER, under their own authorization code, because that
       is who is actually deciding to move the money — the audit log should say
       so, and the requester should not end up holding an unspent permission.
       Without a code it falls back to the waiver, so the older behaviour is
       still there for anyone who wants to hand the action back. */
    let completed = null;
    let completionError = null;
    const refundKey = String(body.refundKey || '').trim();
    if (approve && refundKey && String(target.action) === 'refund') {
      try {
        const origin = new URL(request.url).origin;
        const r = await fetch(`${origin}/api/admin-refund`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken, action: 'refund', orderId: String(target.resourceId || ''),
            refundKey, reason: 'requested_by_customer',
            /* The amount that was ASKED about, not whatever is on the order
               now. Approving a number and paying a different one is the thing
               the whole request exists to prevent. */
            amountCents: Number.isFinite(Number(target.amount))
              ? Math.round(Number(target.amount) * 100) : undefined,
          }),
        });
        const out = await r.json().catch(() => ({}));
        if (r.ok && out.success) {
          completed = { at, stripeRefundId: out.stripeRefundId || '', amountCents: out.stripeRefundAmount ?? null };
        } else {
          completionError = out.error || `Refund failed (${r.status}).`;
        }
      } catch (e) {
        completionError = (e && e.message) || 'Refund could not be carried out.';
      }
    }

    /* ALREADY DONE IS NOT A FAILURE.
       The refund can be issued from Receipts, or from the returns workspace,
       while a request for it sits here — and then approving it fails, over and
       over, with no clue why. The queue was the only part of the system that
       did not know.
       So an "already refunded" refusal closes the request instead of erroring:
       the thing was asked for, the thing happened, and the only untrue state
       is this row still claiming to be waiting. It is recorded as SUPERSEDED
       rather than approved, because nobody approved it — it was overtaken. */
    if (completionError && /already/i.test(completionError)) {
      await mutateSetting(env, ABAC_REQUESTS_KEY, (cur) =>
        (Array.isArray(cur) ? cur : []).map((r) => (r && String(r.id) === id && r.status === 'pending'
          ? { ...r, status: 'superseded', decidedById: meId, decidedByEmail: meEmail, decidedAt: at,
              note: completionError, usedAt: at }
          : r)));
      await notifyRequester(env, target, { approved: true, completed: true, by: meEmail, note: '' })
        .catch(() => {});
      return json({
        ok: true, status: 'superseded', completed: true,
        message: 'That refund had already gone through, so this request is closed rather than run again.',
      }, 200, h);
    }

    /* Any OTHER failed completion is not an approval. Recording "approved"
       over a refund that did not happen would tell the requester it was done
       and leave a waiver behind for a second attempt — the exact double-refund
       this all exists to avoid. It stays pending, and the approver is told
       what actually went wrong rather than a generic failure. */
    if (completionError) {
      return json({ error: `Not approved — ${completionError} Nothing was changed.` }, 502, h);
    }

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
          /* Carried out already, so there is nothing left to spend. Marking it
             used here is what stops the waiver being a second bite. */
          completedAt: completed ? completed.at : undefined,
          completedBy: completed ? meEmail : undefined,
          stripeRefundId: completed ? completed.stripeRefundId : undefined,
          usedAt: completed ? completed.at : undefined,
          usedBy: completed ? meId : undefined,
          /* Only an unspent approval expires. */
          expiresAt: (approve && !completed) ? new Date(Date.now() + WAIVER_TTL_MS).toISOString() : undefined,
        };
      });
    });

    /* Tell them. An answer nobody sees is the same as no answer, and the
       person who asked has by now moved on to something else. Non-fatal: the
       decision has already been recorded and an email that fails must not
       un-decide it. */
    await notifyRequester(env, target, {
      approved: approve, completed: !!completed, by: meEmail, note: String(body.note || '').trim(),
    }).catch((e) => console.warn('abac: could not notify requester —', e && e.message));

    return json({
      ok: true,
      status: approve ? 'approved' : 'declined',
      completed: !!completed,
      stripeRefundId: completed ? completed.stripeRefundId : '',
    }, 200, h);
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

/* The three outcomes read differently on purpose. "Approved and done" needs no
   action; "approved, go ahead" needs one and says what; "declined" needs a
   conversation, so it names who to have it with rather than ending flat. */
async function notifyRequester(env, req, { approved, completed, by, note }) {
  const to = String(req.byEmail || '').trim();
  if (!to) return;

  const what = String(req.action || 'that') === 'refund'
    ? `the refund on order ${String(req.resourceId || '').slice(-8).toUpperCase()}`
    : `your ${String(req.action || 'request')} request`;
  const amount = Number.isFinite(Number(req.amount)) ? ` ($${Number(req.amount).toFixed(2)})` : '';

  const subject = !approved ? `Not approved — ${what}`
    : completed ? `Done — ${what} has been processed`
    : `Approved — ${what} is yours to finish`;

  const line = !approved
    ? `${by} did not approve ${what}${amount}.${note ? ` They said: “${note}”` : ''} `
      + `If you still think it should go through, talk to them — this message is not the end of it.`
    : completed
    ? `${by} approved ${what}${amount} and carried it out, so there is nothing left for you to do. `
      + `It is already done — please do not run it again.`
    : `${by} approved ${what}${amount}. Go back and run it once more and it will go through this time. `
      + `The approval is good for this one thing and runs out in a day.`;

  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.6;color:#111">
    <p>${escapeHtmlBasic(line)}</p>
    ${note && approved ? `<p style="color:#555">They added: “${escapeHtmlBasic(note)}”</p>` : ''}
  </div>`;

  const { sendTransactional } = await import('./_email.js');
  /* The settings cache matters as much as the address: without it,
     resolveSetting cannot see an EMAIL_FROM saved from the admin panel and
     falls through to the hardcoded default. This call passed neither, so the
     sender came out as "Zuwera <undefined>" and Resend rejected the whole
     message with a 422 nothing surfaced — an approved refund whose requester
     was never told. sendTransactional now defaults the sender itself, so this
     is belt and braces rather than the only thing standing between an
     approval and silence. */
  const cache = await fetchSiteSettings(['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM'], env);
  await sendTransactional({
    env, cache, to, subject, html,
    fromEmail: resolveSetting('EMAIL_FROM', env, cache) || 'alerts@zuwera.store',
  });
}

function escapeHtmlBasic(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
