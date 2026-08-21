/**
 * POST /api/my-stored-value   (signed-in shopper)
 *
 * "What have I got?" — the Gift Cards panel on /account.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM /api/stored-value ───────────────────────
 *
 * The public endpoint answers about ONE code, to whoever is holding it. This
 * one answers "which ones are mine", which is a different question with a
 * different key: a session, not a code. It is the only place in the system that
 * lists anything, and it can only ever list what belongs to the person asking.
 *
 * ── AND WHY IT RETURNS THE CODES ────────────────────────────────────────────
 *
 * Because they are theirs, and because the till takes a code. Store credit
 * issued after a return is spendable only if the customer can find out what to
 * type; a balance with no code is a number that mocks them. The instrument is
 * bearer paper either way — showing somebody their own bearer paper is what a
 * wallet is.
 *
 * ── THE MATCH IS ON USER ID, NEVER ON EMAIL ─────────────────────────────────
 *
 * `stored_value.owner_email` exists so an admin can issue to somebody who has
 * no account yet, and it is deliberately NOT what this searches. Matching on
 * the email in the session would mean anyone who can get a session with a given
 * address inherits the balance attached to it — and "can sign up with an
 * address" is not the same as "owns that address" unless every mail path in the
 * system verifies, forever. So issuance binds the account when there is one to
 * bind (see admin-stored-value.js), and a card issued to an address that has no
 * account travels the way any gift card travels: as a code.
 */

import { cors, json, verifyUser } from './_commerce.js';
import { storedValueEnabled } from './_stored-value.js';

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
}

/* Balance per instrument, from the same function the till uses. Asking the
   database rather than re-summing the entries here means the account page and
   the checkout can never disagree about what a card is worth — including about
   whether an expired hold still counts, which is a rule that lives in exactly
   one place on purpose. */
async function balanceOf(env, id) {
  const key = serviceKey(env);
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/zw_stored_value_balance_cents`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_id: id }),
  });
  if (!resp.ok) return 0;
  const n = await resp.json().catch(() => 0);
  return Number(n) || 0;
}

export async function onRequestPost({ request, env }) {
  const headers = cors(env);

  if (!await storedValueEnabled(env)) {
    /* Same answer the checkout gets: not an error, just nothing to show. The
       account page hides the tab on this. */
    return json({ ok: true, enabled: false, cards: [] }, 200, headers);
  }

  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }

  const user = await verifyUser(env, body.accessToken || request.headers.get('Authorization') || '');
  if (!user || !user.id) return json({ ok: false, error: 'Please sign in.' }, 401, headers);

  const key = serviceKey(env);
  if (!env.SUPABASE_URL || !key) return json({ ok: false, error: 'Not configured.' }, 503, headers);

  try {
    const url = `${env.SUPABASE_URL}/rest/v1/stored_value`
      + `?owner_user_id=eq.${encodeURIComponent(user.id)}`
      + `&status=eq.active`
      + `&select=id,code,kind,initial_cents,expires_at,created_at`
      + `&order=created_at.desc&limit=50`;
    const resp = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (resp.status === 404) return json({ ok: false, error: 'Gift cards need migration 0030.' }, 503, headers);
    if (!resp.ok) throw new Error('lookup failed (' + resp.status + ')');
    const rows = await resp.json().catch(() => []);

    const now = Date.now();
    const cards = [];
    let totalCents = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      const expired = row.expires_at && new Date(row.expires_at).getTime() <= now;
      const cents = expired ? 0 : await balanceOf(env, row.id);
      /* A spent card is not a card any more. It stays in the ledger — that is
         the whole point of a ledger — but a wallet showing five empty cards is
         a wallet nobody reads. */
      if (cents <= 0) continue;
      totalCents += cents;
      cards.push({
        code: row.code,
        kind: row.kind,
        balance: (cents / 100).toFixed(2),
        balanceCents: cents,
        expiresAt: row.expires_at || null,
        issuedAt: row.created_at || null,
      });
    }

    return json({
      ok: true,
      enabled: true,
      cards,
      total: (totalCents / 100).toFixed(2),
      totalCents,
    }, 200, headers);
  } catch (e) {
    console.error('my-stored-value —', e && e.message);
    return json({ ok: false, error: 'We could not load that just now.' }, 503, headers);
  }
}
