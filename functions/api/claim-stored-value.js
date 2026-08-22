/**
 * POST /api/claim-stored-value   (signed-in shopper)
 *
 * "Keep this card on my account so I don't have to find the email again."
 *
 * ── IT IS A LOCK NOW, NOT JUST A BOOKMARK ───────────────────────────────────
 *
 * The first version of this set owner_user_id and nothing else, so the card
 * appeared in the account's Gift Cards panel and remained spendable by anyone
 * holding the code. That was worth having and was honestly described as a
 * wallet, but it left the actual exposure untouched: a gift card arrives by
 * email, and whoever finds that email can spend it.
 *
 * Migration 0034 adds locked_to_owner, and this is the only thing that ever
 * sets it true. From then on the card can be spent only while signed in as its
 * owner — which is what makes the email worthless to anybody else, and is the
 * standard answer to "someone could steal the code".
 *
 * ── WHY THE LOCK IS A SEPARATE FLAG FROM OWNERSHIP ──────────────────────────
 *
 * Because owner_user_id is ALREADY set on cards nobody deliberately claimed:
 * store credit issued after a return binds to the account it was issued to, and
 * an admin issuing to a known address binds it the same way. Both exist so the
 * balance is LISTED on an account. Neither was a promise about who may spend it.
 *
 * If ownership alone meant "only this account", every one of those customers
 * would be refused their own credit the moment they checked out as a guest —
 * which is most of them, because a return does not require signing in. So
 * ownership says where a balance is listed, and locking says who may spend it.
 *
 * ── AND IT DEGRADES RATHER THAN BREAKS ──────────────────────────────────────
 *
 * PostgREST rejects a PATCH that names a column the table does not have, so on
 * a store that has not run 0034 the write is retried without the flag. Claiming
 * still works as the wallet it was; it simply does not lock until the migration
 * lands. The alternative is a feature that returns 400 to every customer on
 * every store that is one migration behind.
 *
 * ── WHY IT IS RATE LIMITED ON THE SAME BUCKET AS THE BALANCE CHECK ──────────
 *
 * Because it answers the same question. "Did the claim succeed?" is "does this
 * code exist?", and an endpoint that answers yes-or-no about a secret is an
 * oracle whether or not that was the intention. Sharing the bucket also means
 * twenty attempts an hour total, not twenty each — otherwise adding this
 * endpoint would have doubled the guessing budget that already existed.
 *
 * ── AND WHY THE WRITE IS CONDITIONAL ────────────────────────────────────────
 *
 * The PATCH carries `owner_user_id=is.null` in its own filter rather than
 * trusting the SELECT that ran a moment earlier. Two people claiming the same
 * code at the same time both read NULL; only one may write. Postgres decides,
 * not the order the requests happened to arrive in.
 */

import { cors, json, getSetting, verifyUser } from './_commerce.js';
import { limit } from './_ratelimit.js';
import { lookup, storedValueEnabled, normalizeCode } from './_stored-value.js';
import { messagesFrom } from './_messages.js';

/* The ledger's word for what went wrong, mapped to the shopper's — the same
   table the checkout box uses, so a card refused here and refused at the till
   are refused in the same words. */
const REASON_KEY = {
  not_found:   'giftCardNotFound',
  empty:       'giftCardSpent',
  expired:     'giftCardExpired',
  void:        'giftCardVoid',
  locked:      'giftCardLocked',
  unavailable: 'giftCardOffline',
  no_code:     'giftCardEmpty',
};

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
}

export async function onRequestPost({ request, env }) {
  const headers = cors(env);
  const limited = await limit(env, request, 'stored-value', headers);
  if (limited) return limited;

  if (!await storedValueEnabled(env)) {
    return json({ ok: false, enabled: false, error: 'Gift cards are not switched on.' }, 200, headers);
  }

  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }

  const user = await verifyUser(env, body.accessToken || request.headers.get('Authorization') || '');
  if (!user || !user.id) return json({ ok: false, error: 'Please sign in to save a card to your account.' }, 401, headers);

  const say = messagesFrom(await getSetting(env, 'commerce_config', {}).catch(() => ({})));

  const code = normalizeCode(body.code);
  if (!code) return json({ ok: false, error: say('giftCardEmpty') }, 400, headers);

  const info = await lookup(env, code);
  if (!info.found || !info.usable) {
    return json({ ok: false, error: say(REASON_KEY[info.reason] || 'giftCardNotFound') }, 200, headers);
  }

  const key = serviceKey(env);
  if (!env.SUPABASE_URL || !key) return json({ ok: false, error: 'Not configured.' }, 503, headers);
  const h = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };

  /* Already yours: say so and stop. Not an error — somebody re-entering a code
     they added last month has done nothing wrong, and an error would send them
     looking for a problem that is not there. */
  if (info.ownerUserId && String(info.ownerUserId) === String(user.id)) {
    return json({
      ok: true, already: true, code,
      balance: (info.balanceCents / 100).toFixed(2), balanceCents: info.balanceCents,
    }, 200, headers);
  }

  /* Somebody else's. The wording is deliberately the same whether the card
     belongs to another account or has been locked by an admin — the person
     typing has no business learning which, and the difference is only useful
     to somebody who should not be typing it. */
  if (info.ownerUserId) {
    return json({
      ok: false,
      error: 'That card is already saved to another account. If it was given to you, whoever holds the account can still spend it at checkout.',
    }, 200, headers);
  }

  try {
    const url = `${env.SUPABASE_URL}/rest/v1/stored_value`
      + `?code=eq.${encodeURIComponent(code)}`
      + `&owner_user_id=is.null`               // the race, decided by Postgres
      + `&status=eq.active`;
    const patch = (fields) => fetch(url, {
      method: 'PATCH',
      headers: { ...h, Prefer: 'return=representation' },
      body: JSON.stringify(fields),
    });

    /* The lock first, the wallet as a fallback. A store one migration behind
       should still be able to save a card to an account — it just does not get
       the protection until 0034 is applied. Reported back either way, so the
       page can tell the customer which of the two they actually got. */
    let locked = true;
    let resp = await patch({ owner_user_id: user.id, locked_to_owner: true });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      if (/locked_to_owner/.test(detail)) {
        console.warn('claim: locked_to_owner missing — migration 0034 has not been run');
        locked = false;
        resp = await patch({ owner_user_id: user.id });
      }
    }
    if (!resp.ok) throw new Error('claim failed (' + resp.status + ')');
    const rows = await resp.json().catch(() => []);

    /* Zero rows means the filter matched nothing — somebody else claimed it in
       between. Reported as the same refusal as any other already-owned card. */
    if (!Array.isArray(rows) || !rows.length) {
      return json({
        ok: false,
        error: 'That card was just saved to another account. If it was given to you, whoever holds the account can still spend it at checkout.',
      }, 200, headers);
    }

    return json({
      ok: true, claimed: true, code,
      kind: info.kind,
      /* Whether the card is now protected or merely listed. The page says two
         different things depending on this, because promising a lock that is
         not there is worse than not having one. */
      locked,
      balance: (info.balanceCents / 100).toFixed(2),
      balanceCents: info.balanceCents,
      expiresAt: info.expiresAt || null,
    }, 200, headers);
  } catch (e) {
    console.error('claim-stored-value —', e && e.message);
    return json({ ok: false, error: 'We could not save that just now. Please try again in a moment.' }, 503, headers);
  }
}
