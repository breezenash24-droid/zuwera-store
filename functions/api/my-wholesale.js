/**
 * /api/my-wholesale — a shopper's own trade terms, and the way to ask for them.
 *
 * Two things the storefront could not previously find out, both about the
 * person already signed in:
 *
 *   WHAT ARE MY TERMS?  The order minimum was enforced at the till and nowhere
 *   else. A trade buyer filled a bag, went to pay, and was refused — after
 *   choosing everything. The refusal was correct and arrived at the worst
 *   possible moment, which is the difference between a rule and an ambush.
 *
 *   HOW DO I APPLY?  profiles.wholesale carries a status of 'applied', and
 *   nothing in the store could ever write it. Every account was one an admin
 *   created by hand, so the status meant nothing and no buyer could start the
 *   conversation.
 *
 * ── WHY AN ENDPOINT AND NOT A TABLE READ ────────────────────────────────────
 *
 * Migration 0024 puts a trigger on profiles.wholesale precisely so a shopper
 * cannot grant themselves a trade account from a browser console. That trigger
 * is doing its job, and it is why applying has to come through here: this runs
 * with the service key, which the trigger exempts, and it is therefore the only
 * place that can decide what a customer is allowed to change about their own
 * pricing. The answer is "almost nothing".
 *
 * ── WHAT AN APPLICANT MAY NOT DO ────────────────────────────────────────────
 *
 * Status is never taken from the request. It is always 'applied', because the
 * one thing a body must never be able to say is 'approved'.
 *
 * And an application never overwrites an existing decision. Re-applying while
 * approved would demote a live trade account to a pending one — a self-inflicted
 * price rise nobody asked for. Re-applying while SUSPENDED would be worse: a
 * suspension is a decision somebody took, and letting the suspended party clear
 * it by filling in a form again is not an application, it is an undo button on
 * somebody else's judgement. Both are refused, and both say so.
 */

import { cors, json, verifyUser } from './_commerce.js';
import { isWholesaleBuyer, wholesaleMinimumCents } from './_price-resolution.js';

function H(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!env.SUPABASE_URL || !key) return null;
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}

const token = (request) => (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/* The caller's own profile, read with the service key and keyed by the id the
   auth server returned — never by an id from the body, which is how one
   customer comes to read another's terms. */
async function ownProfile(env, userId) {
  const h = H(env);
  if (!h) return null;
  const rows = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?select=id,email,wholesale&id=eq.${encodeURIComponent(userId)}&limit=1`,
    { headers: h, cache: 'no-store' },
  ).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function onRequestGet({ request, env }) {
  try {
    const user = await verifyUser(env, token(request));
    /* Not an error. A signed-out shopper asking about trade terms has none,
       and answering 401 would make every bag page log a failure for the normal
       case. */
    if (!user?.id) return json({ ok: true, signedIn: false, status: '', minOrderCents: 0 }, 200, cors(env));

    const profile = await ownProfile(env, user.id);
    const w = (profile && profile.wholesale && typeof profile.wholesale === 'object') ? profile.wholesale : {};

    return json({
      ok: true,
      signedIn: true,
      status: String(w.status || ''),
      /* Read through the same helper the till uses, so the figure the bag
         promises and the figure checkout enforces cannot come apart. It
         answers 0 for anything but an approved account, which is correct:
         an applicant has no minimum because they have no trade pricing yet. */
      minOrderCents: wholesaleMinimumCents(profile || {}),
      isWholesale: isWholesaleBuyer(profile || {}),
      terms: String(w.terms || ''),
      company: String(w.company || ''),
    }, 200, cors(env));
  } catch (e) {
    return json({ ok: false, error: e?.message || 'Could not read your account.' }, 400, cors(env));
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const user = await verifyUser(env, token(request));
    if (!user?.id) return json({ ok: false, error: 'Sign in first, then apply.' }, 401, cors(env));

    const h = H(env);
    if (!h) return json({ ok: false, error: 'Not configured.' }, 503, cors(env));

    const profile = await ownProfile(env, user.id);
    if (!profile) return json({ ok: false, error: 'No account found.' }, 404, cors(env));

    const prev = (profile.wholesale && typeof profile.wholesale === 'object') ? profile.wholesale : null;
    const prevStatus = String((prev && prev.status) || '');

    if (prevStatus === 'approved') {
      return json({ ok: false, status: prevStatus,
        error: 'Your trade account is already open — there is nothing to apply for.' }, 409, cors(env));
    }
    if (prevStatus === 'suspended') {
      return json({ ok: false, status: prevStatus,
        error: 'This account is suspended. Please get in touch rather than re-applying.' }, 409, cors(env));
    }

    const body = await request.json().catch(() => ({}));
    const company = text(body.company, 120);
    if (!company) return json({ ok: false, error: 'Tell us the business name.' }, 400, cors(env));

    /* Built here, field by field, exactly as the admin endpoint does. The
       status is a constant in this file and appears nowhere in the request. */
    const record = {
      status: 'applied',
      company,
      tax_id: text(body.taxId, 60),
      /* An applicant does not set their own minimum or terms — those are the
         store's side of the deal and are decided at approval. Carried over if
         a previous application had them so a re-submission does not blank
         something an admin had already typed. */
      min_order_cents: prev && Number.isFinite(Number(prev.min_order_cents)) ? Number(prev.min_order_cents) : 0,
      terms: (prev && prev.terms) || 'prepaid',
      notes: text(body.notes, 1000),
      applied_at: (prev && prev.applied_at) || new Date().toISOString(),
    };

    const upd = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, {
      method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({ wholesale: record }),
    });
    if (!upd.ok) {
      const detail = await upd.text().catch(() => '');
      return json({ ok: false, error: 'Could not send that application. ' + detail.slice(0, 200) }, 502, cors(env));
    }

    return json({ ok: true, status: 'applied' }, 200, cors(env));
  } catch (e) {
    return json({ ok: false, error: e?.message || 'Could not send that application.' }, 400, cors(env));
  }
}

export function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}
