/**
 * POST /api/admin-stored-value   (admin only, sealed)
 *
 * Issue a gift card, issue store credit, look one up, or void one.
 *
 * ── WHY THIS IS SEALED RATHER THAN ADVISORY ─────────────────────────────────
 *
 * Issuing stored value is creating money. It is not "editing a product with a
 * price on it" — the instrument IS the value, and somebody who can call this
 * can write themselves a card and spend it. So it goes through decide(), which
 * means the browser cannot skip it: the endpoint asks, ABAC narrows, and the
 * answer is recorded by the audit log whether it was allowed or refused.
 *
 * It reuses `pricing_write` rather than inventing a permission, for the same
 * reason wholesale does: deciding what somebody is charged and deciding to hand
 * them $50 are the same decision wearing different clothes. A role that may do
 * one may do the other, and a role that may do neither should not be able to
 * reach this by having "coupons".
 *
 * ── THE CODE IS RETURNED ONCE ───────────────────────────────────────────────
 *
 * Issuing returns the code so it can be given to the customer. Nothing else
 * ever lists codes: a lookup requires the full one. If it is lost before it
 * reaches the customer, it is voided and reissued rather than recovered, which
 * is the same rule any gift card in a shop follows.
 */

import { cors, json, decide, limitResponse, limitError } from './_commerce.js';
import { record } from './_audit.js';
import { issue, voidCode, lookup, normalizeCode, storedValueEnabled } from './_stored-value.js';

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

const KINDS = new Set(['gift_card', 'store_credit']);

export async function onRequestPost({ request, env }) {
  const headers = cors(env);
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();

  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  const action = String(body.action || '').trim();

  /* The amount is part of the question, not just part of the answer, so a rule
     like "nobody may issue more than $200 without approval" has something to
     narrow on. Passing it after the decision would make that rule unwritable. */
  const amountCents = Math.round(Number(body.amountCents) || Math.round(Number(body.amount) * 100) || 0);

  const verdict = await decide(env, token, 'pricing_write', {
    action: 'stored_value.' + (action || 'unknown'),
    amountCents,
    resource: 'stored_value',
    request,
  });
  if (!verdict.allow) {
    if (verdict.limited) return limitResponse(limitError(verdict), headers);
    return json({ ok: false, error: verdict.reason || 'Not allowed.' }, 403, headers);
  }
  const admin = verdict.admin;

  if (!await storedValueEnabled(env)) {
    /* Issuing while the till cannot accept it would hand somebody a card that
       does not work. The switch is one place, so this reads it too rather than
       letting the two halves disagree. */
    return json({
      ok: false,
      error: 'Gift cards and store credit are switched off. Turn them on in Settings before issuing any.',
    }, 409, headers);
  }

  try {
    if (action === 'lookup') {
      const info = await lookup(env, body.code);
      return json({ ok: true, info }, 200, headers);
    }

    if (action === 'issue') {
      const kind = KINDS.has(body.kind) ? body.kind : 'gift_card';
      if (!(amountCents > 0)) return json({ ok: false, error: 'Enter an amount greater than zero.' }, 400, headers);
      /* A cap that is deliberately generous and deliberately present. It is not
         a policy about how big a gift card may be — that belongs in an ABAC
         rule, where it can be per-person and approvable. This is the guard
         against a mistyped amount turning $50 into $50,000. */
      if (amountCents > 500000) return json({ ok: false, error: 'That is over the $5,000 issuing limit.' }, 400, headers);

      const out = await issue(env, {
        kind,
        cents: amountCents,
        ownerUserId: body.ownerUserId || null,
        ownerEmail: body.ownerEmail || '',
        issuedBy: admin.id,
        reason: String(body.reason || '').slice(0, 300),
        sourceRef: String(body.sourceRef || '').slice(0, 120),
        expiresAt: body.expiresAt || null,
      });

      /* Recorded with the amount and the kind, never the code. An audit log that
         carries live gift card codes is a list of spendable money sitting in a
         table that more people can read than can issue. */
      await record(env, admin, {
        action: 'stored_value.issue',
        resource_type: 'stored_value',
        resource_id: out.id,
        metadata: { kind, amountCents, ownerEmail: body.ownerEmail || '', reason: body.reason || '' },
      }, request);

      return json({ ok: true, code: out.code, balance: (out.balanceCents / 100).toFixed(2) }, 200, headers);
    }

    if (action === 'void') {
      const code = normalizeCode(body.code);
      if (!code) return json({ ok: false, error: 'Which code?' }, 400, headers);
      const out = await voidCode(env, code, String(body.reason || '').slice(0, 300));
      await record(env, admin, {
        action: 'stored_value.void',
        resource_type: 'stored_value',
        resource_id: code,
        metadata: { voidedCents: out.voidedCents, reason: body.reason || '' },
      }, request);
      return json({ ok: true, voided: (out.voidedCents / 100).toFixed(2) }, 200, headers);
    }

    return json({ ok: false, error: 'Unknown action.' }, 400, headers);
  } catch (e) {
    console.error('admin-stored-value', action, '—', e && e.message);
    return json({ ok: false, error: e.message || 'That did not work.' }, 500, headers);
  }
}
