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

import { cors, json, decide, limitResponse, limitError, mutateSetting, getSetting } from './_commerce.js';
import {
  checkMoneySecret, ISSUE_LEDGER_KEY, dailyCapCents, todayKey, pruneLedger,
} from './_money-secret.js';
import { record } from './_audit.js';
import { issue, voidCode, lookup, normalizeCode, storedValueEnabled } from './_stored-value.js';

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

const KINDS = new Set(['gift_card', 'store_credit']);

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
}

/**
 * The account an email belongs to, if it belongs to one yet.
 *
 * ── WHY THE BINDING HAPPENS HERE AND NOT AT READ TIME ───────────────────────
 *
 * Store credit is nearly always issued from an email address — it is what the
 * admin has in front of them on the return. But /api/my-stored-value matches on
 * `owner_user_id` and deliberately never on email, because "signed up with an
 * address" is not "owns that address". If nothing resolved the one to the other
 * at issue time, every credit ever issued would be invisible on the account it
 * was issued to, and the customer would be told they had credit with no way to
 * find it.
 *
 * So it resolves ONCE, here, where an admin is already asserting who this is
 * for — and the answer is written down rather than re-derived on every read by
 * whoever happens to be holding a session with that address.
 *
 * Not finding one is not a failure. A gift card bought for somebody who has no
 * account is the ordinary case; it keeps the email for the record and travels
 * as a code, which is how gift cards have always travelled.
 */
async function accountForEmail(env, email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || clean.indexOf('@') < 0) return null;
  const key = serviceKey(env);
  if (!env.SUPABASE_URL || !key) return null;
  try {
    const resp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?email=ilike.${encodeURIComponent(clean)}&select=id&limit=2`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!resp.ok) return null;
    const rows = await resp.json().catch(() => []);
    /* Two accounts on one address should not happen and is not worth guessing
       between — the card still issues, it just stays unbound. */
    return Array.isArray(rows) && rows.length === 1 ? rows[0].id || null : null;
  } catch (_) {
    return null;
  }
}

/**
 * What is outstanding, without naming a single code.
 *
 * Unspent gift cards are a LIABILITY — money taken for goods not yet handed
 * over — and it is the one number about this system an owner genuinely has to
 * be able to see. Every other question ("which cards exist", "who has one")
 * would need a list, and a list of codes is a list of spendable money sitting
 * where more people can read it than can issue it.
 *
 * So this returns counts and totals and nothing else. It is summed in the
 * Worker rather than in SQL so it needs no second migration; the row cap keeps
 * that honest, and reports itself when it bites rather than quietly under-
 * counting what the store owes.
 */
const SUMMARY_CAP = 2000;

async function summarize(env) {
  const key = serviceKey(env);
  if (!env.SUPABASE_URL || !key) throw new Error('Not configured.');
  const head = { apikey: key, Authorization: `Bearer ${key}` };

  const vResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/stored_value?status=eq.active&select=id,kind,expires_at&limit=${SUMMARY_CAP + 1}`,
    { headers: head }
  );
  if (vResp.status === 404) throw new Error('Gift cards need migration 0030.');
  if (!vResp.ok) throw new Error('Could not read the ledger (' + vResp.status + ').');
  const values = await vResp.json().catch(() => []);
  const capped = values.length > SUMMARY_CAP;
  const rows = capped ? values.slice(0, SUMMARY_CAP) : values;

  const byId = new Map();
  const now = Date.now();
  for (const r of rows) {
    if (r.expires_at && new Date(r.expires_at).getTime() <= now) continue;
    byId.set(r.id, { kind: r.kind, cents: 0 });
  }

  /* One read of the entries rather than one RPC per card. The same expiry rule
     the balance function applies: an expired hold has stopped counting. */
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const eResp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/stored_value_entries?select=stored_value_id,cents,kind,expires_at`
      + `&order=id.asc&offset=${from}&limit=${PAGE}`,
      { headers: head }
    );
    if (!eResp.ok) throw new Error('Could not read the entries (' + eResp.status + ').');
    const batch = await eResp.json().catch(() => []);
    for (const e of batch) {
      const bucket = byId.get(e.stored_value_id);
      if (!bucket) continue;
      if (e.kind === 'hold' && e.expires_at && new Date(e.expires_at).getTime() <= now) continue;
      bucket.cents += Number(e.cents) || 0;
    }
    if (batch.length < PAGE) break;
    from += PAGE;
    if (from > 50000) break;
  }

  const out = {
    gift_card: { count: 0, cents: 0 },
    store_credit: { count: 0, cents: 0 },
  };
  for (const b of byId.values()) {
    if (b.cents <= 0) continue;
    const slot = out[b.kind] || out.gift_card;
    slot.count += 1;
    slot.cents += b.cents;
  }
  return {
    capped,
    cap: SUMMARY_CAP,
    giftCards: out.gift_card,
    storeCredit: out.store_credit,
    outstandingCents: out.gift_card.cents + out.store_credit.cents,
  };
}

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

    if (action === 'summary') {
      return json({ ok: true, summary: await summarize(env) }, 200, headers);
    }

    if (action === 'issue') {
      const kind = KINDS.has(body.kind) ? body.kind : 'gift_card';
      if (!(amountCents > 0)) return json({ ok: false, error: 'Enter an amount greater than zero.' }, 400, headers);
      /* A cap that is deliberately generous and deliberately present. It is not
         a policy about how big a gift card may be — that belongs in an ABAC
         rule, where it can be per-person and approvable. This is the guard
         against a mistyped amount turning $50 into $50,000. */
      if (amountCents > 500000) return json({ ok: false, error: 'That is over the $5,000 issuing limit.' }, 400, headers);

      /* ── THE FACTOR ADMIN ACCESS ALONE DOES NOT GIVE YOU ──────────────────
         Refunding money has always required this. Issuing it required only a
         permission, which meant a stolen session could write itself the
         per-call maximum and the audit log — which records the amount and
         deliberately never the code — could not even say which card to cancel.

         Checked for `issue` only. A lookup and a void both need to stay
         reachable in a hurry: void is how you CANCEL a card that should not
         exist, and putting the mint's lock on the fire exit would mean a stolen
         code could not be killed by whoever noticed. */
      const secret = await checkMoneySecret(env, {
        key: body.authKey || body.refundKey,
        adminId: admin.id,
        rateLimitKey: 'stored_value_rate_limit',
      });
      if (!secret.ok) {
        await record(env, admin, {
          action: 'stored_value.issue_refused',
          resource_type: 'stored_value',
          metadata: { amountCents, reason: secret.locked ? 'locked' : 'bad_key' },
        }, request);
        return json({ ok: false, error: secret.error, needsAuthKey: true }, secret.status, headers);
      }

      const ownerEmail = String(body.ownerEmail || '').trim();
      const ownerUserId = body.ownerUserId || await accountForEmail(env, ownerEmail);

      /* ── NOBODY ISSUES TO THEMSELVES ──────────────────────────────────────
         The plainest theft on this system is issuing to your own address and
         spending it. Refused outright rather than reported afterwards — a rule
         that fires before the money exists beats a row in a log that describes
         money which already does.

         Said honestly: somebody determined can use a second address they
         control. What this removes is the INVISIBLE case, and it forces the
         record to name a recipient who is not the person who signed the
         request. A store owner who wants a card for testing can issue to
         another address of their own; that is ten seconds, and it leaves a
         trail that reads correctly. */
      const mine = String(admin.email || '').trim().toLowerCase();
      if ((ownerUserId && String(ownerUserId) === String(admin.id))
        || (mine && ownerEmail.toLowerCase() === mine)) {
        await record(env, admin, {
          action: 'stored_value.issue_refused',
          resource_type: 'stored_value',
          metadata: { amountCents, reason: 'self_issue', ownerEmail },
        }, request);
        return json({
          ok: false,
          error: 'You cannot issue stored value to your own account. Ask another admin, '
            + 'or issue it to the address it is actually for.',
        }, 403, headers);
      }

      /* ── AND A DAY HAS A CEILING ──────────────────────────────────────────
         The $5,000 below is per CALL, which stops a mistyped amount and nothing
         else: a hundred calls of $4,999 were a hundred separate decisions each
         of which passed. A ceiling that resets every request is not a ceiling.

         Per admin, per UTC day, claimed through mutateSetting so two issues at
         once cannot both read the same total and both be allowed. Per admin
         rather than per store on purpose — the point is to bound what ONE
         compromised session does before somebody notices, and a shared budget
         lets the busiest person's ordinary work hide somebody else's theft. */
      const cfg = await getSetting(env, 'stored_value', {}).catch(() => ({}));
      const cap = dailyCapCents(cfg);
      const day = todayKey();
      let overBy = 0;
      await mutateSetting(env, ISSUE_LEDGER_KEY, (cur) => {
        const ledger = pruneLedger(cur, day);
        const mineToday = ledger[admin.id] && ledger[admin.id].day === day ? ledger[admin.id].cents : 0;
        if (mineToday + amountCents > cap) { overBy = mineToday + amountCents - cap; return ledger; }
        return { ...ledger, [admin.id]: { day, cents: mineToday + amountCents } };
      });
      if (overBy > 0) {
        await record(env, admin, {
          action: 'stored_value.issue_refused',
          resource_type: 'stored_value',
          metadata: { amountCents, reason: 'daily_cap', capCents: cap },
        }, request);
        return json({
          ok: false,
          error: `That would put you $${(overBy / 100).toFixed(2)} over the $${(cap / 100).toFixed(2)} `
            + 'you can issue in a day. It resets at midnight UTC, and the limit is on the Gift Cards settings.',
        }, 429, headers);
      }

      const out = await issue(env, {
        kind,
        cents: amountCents,
        ownerUserId: ownerUserId || null,
        ownerEmail,
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
        metadata: { kind, amountCents, ownerEmail, bound: !!ownerUserId, reason: body.reason || '' },
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
