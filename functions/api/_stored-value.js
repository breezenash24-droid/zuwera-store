/* ────────────────────────────────────────────────────────────────────────────
   _stored-value.js — gift cards and store credit, which are the same thing.

   The audit listed them separately (B1 and A5) and they are one mechanism: a
   code, a balance, a way to spend it at the till, and a history. Building them
   twice would put two redemption paths in the one place where a bug means
   money. See migration 0030 for the ledger and why the balance is a sum rather
   than a column.

   ── EVERYTHING HERE RUNS ON THE SERVER, AND THAT IS THE POINT ───────────────

   The browser never learns a balance it did not ask for by code, never decides
   how much to apply, and never tells the till what to charge. It sends a code;
   the server prices the cart, decides what the card can cover, and returns a
   number the customer is shown. The same rule the tax quote follows, for the
   same reason: money the browser computes is money the browser can change.

   ── OFF UNTIL SOMEBODY TURNS IT ON ──────────────────────────────────────────

   `stored_value.enabled` in site_settings, read HERE rather than in the page.
   The existing feature-flag system buckets by visitor and is read in the
   browser, which is right for a homepage strip and wrong for tender: a flag the
   client evaluates is a flag the client can set. This is one boolean, read
   server-side, defaulting to off — so the ledger can be deployed, the migration
   run, and a card issued and tested before a single shopper sees a field.
   ──────────────────────────────────────────────────────────────────────────── */

import { getSetting } from './_commerce.js';

/* No vowels, so it cannot spell anything; no 0/O/1/I/L, because this gets read
   down a phone line and typed by somebody who is already annoyed. 16 characters
   from a 26-symbol alphabet is ~75 bits — brute-forcing one is not the attack
   to worry about, and /api/stored-value is rate limited besides. */
const ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ';

export function generateCode(prefix = 'ZW') {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i && i % 4 === 0) out += '-';
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return prefix + '-' + out;
}

/* One spelling. A customer types lower case, pastes a trailing space, or leaves
   the hyphens out; all three are the same card. */
export function normalizeCode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

export async function storedValueEnabled(env) {
  try {
    const cfg = await getSetting(env, 'stored_value', null);
    return !!(cfg && cfg.enabled === true);
  } catch (_) {
    /* Unreadable settings means OFF. The direction that cannot go wrong: a
       shopper sees no redemption field, which is exactly what they saw
       yesterday, rather than a till that cannot verify what it is accepting. */
    return false;
  }
}

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
}

async function rpc(env, fn, args) {
  const key = serviceKey(env);
  if (!env.SUPABASE_URL || !key) throw new Error('Stored value is not configured.');
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (resp.status === 404) throw new Error('Stored value needs migration 0030.');
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`${fn} failed (${resp.status}): ${detail.slice(0, 200)}`);
  }
  return resp.json().catch(() => null);
}

/** What this code is worth, or why it is worth nothing. Never throws. */
export async function lookup(env, code) {
  const c = normalizeCode(code);
  if (!c) return { found: false, reason: 'no_code' };
  try {
    const out = await rpc(env, 'zw_stored_value_lookup', { p_code: c });
    if (!out || !out.found) return { found: false, reason: 'not_found' };
    if (out.status !== 'active') return { found: true, usable: false, reason: 'void', balanceCents: 0 };
    if (out.expired) return { found: true, usable: false, reason: 'expired', balanceCents: 0, expiresAt: out.expires_at };
    return {
      found: true,
      usable: Number(out.balance_cents) > 0,
      reason: Number(out.balance_cents) > 0 ? '' : 'empty',
      kind: out.kind,
      balanceCents: Number(out.balance_cents) || 0,
      initialCents: Number(out.initial_cents) || 0,
      expiresAt: out.expires_at || null,
      ownerUserId: out.owner_user_id || null,
      ownerEmail: out.owner_email || null,
      /* Set only when a signed-in customer deliberately claimed this card. NOT
         the same as having an owner — returns and admin issuance both bind an
         owner so the balance is listed on an account, and neither is a lock.
         See migration 0034. */
      lockedToOwner: out.locked_to_owner === true,
    };
  } catch (e) {
    console.error('stored value lookup —', e && e.message);
    return { found: false, reason: 'unavailable' };
  }
}

/** Reserve up to `cents`. Returns what was actually held, which may be less. */
export async function hold(env, code, cents, ref, seconds = 1800, userId = null) {
  try {
    const out = await rpc(env, 'zw_stored_value_hold', {
      p_code: normalizeCode(code), p_cents: Math.max(0, Math.round(cents) || 0),
      p_ref: String(ref || ''), p_seconds: seconds,
      /* Who is spending it. A locked card is refused in the SQL when this does
         not match the owner — checked there rather than only in the quote,
         because the hold is where money stops being spendable and it is the one
         gate no future caller can forget to go through. */
      p_user: userId || null,
    });
    return { ok: !!(out && out.ok), heldCents: Number(out?.held_cents) || 0, reason: out?.reason || '' };
  } catch (e) {
    console.error('stored value hold —', e && e.message);
    return { ok: false, heldCents: 0, reason: 'unavailable' };
  }
}

/** Turn a hold into a payment. Safe to call more than once for one order. */
export async function capture(env, ref, orderRef) {
  try {
    const out = await rpc(env, 'zw_stored_value_capture', { p_ref: String(ref || ''), p_order_ref: String(orderRef || '') });
    return { ok: !!(out && out.ok), capturedCents: Number(out?.captured_cents) || 0, already: !!out?.already, reason: out?.reason || '' };
  } catch (e) {
    console.error('stored value capture —', e && e.message);
    return { ok: false, capturedCents: 0, reason: 'unavailable' };
  }
}

export async function release(env, ref) {
  try {
    const out = await rpc(env, 'zw_stored_value_release', { p_ref: String(ref || '') });
    return { ok: true, releasedCents: Number(out?.released_cents) || 0 };
  } catch (e) {
    console.error('stored value release —', e && e.message);
    return { ok: false, releasedCents: 0 };
  }
}

/**
 * ── TWO CARDS MAY NEVER SHARE A CODE ────────────────────────────────────────
 *
 * `stored_value.code` is `text not null unique`, and that constraint is the
 * whole guarantee. Not a SELECT-then-INSERT in this file — two issues racing
 * would both find the code free and both proceed, which is the same
 * lost-update shape already fixed in promo counts, stock and the balance. The
 * database is the only place uniqueness cannot be raced, so it decides.
 *
 * Collisions are not the threat model. Sixteen characters from a 28-symbol
 * alphabet is about 1.4 × 10²³ codes (~2⁷⁷); a million cards in the ledger puts
 * the chance of the next draw colliding at roughly 7 × 10⁻¹⁸, and an even
 * chance of ANY collision needs a few hundred billion cards.
 *
 * WHICH IS EXACTLY WHY A COLLISION IS WORTH SHOUTING ABOUT. At those odds it is
 * not bad luck — it means the generator has stopped being random: a broken
 * crypto.getRandomValues, a polyfill, a seeded stub left in a test harness. The
 * retry keeps one unlucky customer from meeting an error; the console.error is
 * the point, because the second time it happens somebody needs to know the
 * codes are becoming guessable.
 *
 * A CALLER-SUPPLIED CODE IS NEVER RETRIED. Re-rolling it would hand back a
 * different code than the one asked for, silently. That is a genuine conflict
 * and gets reported as one.
 */
export async function issue(env, { kind, cents, ownerUserId = null, ownerEmail = '', issuedBy = null, reason = '', sourceRef = '', expiresAt = null, code = '' }) {
  const supplied = !!code;
  const MAX_TRIES = supplied ? 1 : 3;

  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    const c = supplied ? normalizeCode(code) : generateCode(kind === 'store_credit' ? 'ZWC' : 'ZWG');
    try {
      const out = await rpc(env, 'zw_stored_value_issue', {
        p_code: c, p_kind: kind, p_cents: Math.round(cents),
        p_owner: ownerUserId, p_email: ownerEmail || null, p_by: issuedBy,
        p_reason: reason || null, p_source: sourceRef || null, p_expires: expiresAt,
      });
      if (!out || !out.ok) throw new Error(out?.reason || 'Could not issue that.');
      return { code: c, id: out.id, balanceCents: Number(out.balance_cents) || 0 };
    } catch (e) {
      /* 23505 is Postgres for unique_violation; PostgREST passes the SQLSTATE
         through in the body, which rpc() has already put in the message. */
      const isDuplicate = /23505|duplicate key|already exists/i.test((e && e.message) || '');
      if (!isDuplicate || attempt === MAX_TRIES) throw e;
      console.error(
        'STORED VALUE CODE COLLISION on attempt ' + attempt + ' — this should be impossible at ~2^77 '
        + 'of entropy. Check that crypto.getRandomValues is real in this runtime; if this repeats, '
        + 'the codes are becoming guessable.'
      );
    }
  }
  /* Unreachable: the loop either returns or throws. Here so a reader does not
     have to prove that to themselves. */
  throw new Error('Could not issue that.');
}

export async function voidCode(env, code, reason = '') {
  const out = await rpc(env, 'zw_stored_value_void', { p_code: normalizeCode(code), p_reason: reason || null });
  if (!out || !out.ok) throw new Error(out?.reason || 'Could not void that.');
  return { voidedCents: Number(out.voided_cents) || 0 };
}

/**
 * How much of THIS total this code can cover, without reserving anything.
 *
 * Used while the customer is still looking at the page, so it must not take a
 * hold — a shopper who types a code and then changes their mind would otherwise
 * leave their own money reserved against a checkout that never happened.
 *
 * Applied AFTER tax and shipping, on purpose. Stored value is tender, not a
 * discount: it pays a bill rather than reducing one. Treating it as a discount
 * would shrink the taxable amount, which is somebody else's money to decide
 * about, and would under-collect tax the store still owes.
 */
export async function quoteAgainst(env, code, totalCents, userId = null) {
  const info = await lookup(env, code);
  if (!info.found || !info.usable) {
    return { applied: 0, remaining: totalCents, info };
  }
  /* Refused at quote time as well as at the hold, and not for its own sake:
     without this the card is accepted by the box, priced into the summary, and
     then fails at the moment of payment with nothing useful to say. The shopper
     gets the sentence before they reach for a card; the hold stays the gate
     that cannot be bypassed. */
  if (info.lockedToOwner && (!userId || String(userId) !== String(info.ownerUserId))) {
    return { applied: 0, remaining: totalCents, info: { ...info, usable: false, reason: 'locked' } };
  }
  const applied = Math.max(0, Math.min(info.balanceCents, Math.max(0, totalCents)));
  return { applied, remaining: Math.max(0, totalCents - applied), info };
}
