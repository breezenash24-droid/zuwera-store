/**
 * POST /api/stored-value   (public)
 *
 * "What is this gift card worth?" — asked from the checkout page, before the
 * customer commits to using it, so they see a balance rather than discovering
 * at the end that the code was empty.
 *
 * ── WHAT IT WILL NOT TELL YOU ───────────────────────────────────────────────
 *
 * Only what the holder of the full code already knows. There is no listing, no
 * search, no lookup by email, no "does this prefix exist". A code is bearer
 * paper: whoever has it can spend it, so whoever has it may see the balance,
 * and nobody else gets an oracle for guessing at one.
 *
 * That still leaves guessing, which is why this is rate limited — 20 an hour
 * per address. Against a 16-character code from a 28-symbol alphabet that is
 * not a serious attack, but an unmetered endpoint that answers yes-or-no about
 * a secret is a thing that gets scripted eventually.
 *
 * ── AND IT DOES NOT DECIDE ANYTHING ─────────────────────────────────────────
 *
 * The number here is for display. What a card actually covers is decided by the
 * till when the cart is priced, against the balance at that moment — because
 * between this call and that one, the same card can be spent somewhere else.
 * A browser that could tell the server what to deduct is a browser that can
 * tell the server to deduct more.
 */

import { cors, json, getSetting } from './_commerce.js';
import { limit } from './_ratelimit.js';
import { lookup, storedValueEnabled, normalizeCode } from './_stored-value.js';
import { messagesFrom } from './_messages.js';

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

/* One sentence per outcome, written for somebody standing at a checkout with a
   card in their hand. "not_found" and "empty" are deliberately different: the
   first means check the code, the second means the card is real and spent, and
   telling somebody to re-type a code that was right is its own small cruelty. */
/* The ledger's word for what went wrong, mapped to the shopper's. The sentences
   themselves are no longer here: every other refusal a shopper meets at checkout
   has been editable from Settings for months, and a store that can rewrite "out
   of stock" but not "that card has already been used up" has a gap somebody
   finds at the worst possible moment.

   "not_found" and "empty" stay deliberately different — the first means check
   the code, the second means the card is real and spent, and telling somebody to
   re-type a code that was right is its own small cruelty. */
const REASON_KEY = {
  not_found:   'giftCardNotFound',
  empty:       'giftCardSpent',
  expired:     'giftCardExpired',
  void:        'giftCardVoid',
  unavailable: 'giftCardOffline',
  no_code:     'giftCardEmpty',
};

export async function onRequestPost({ request, env }) {
  const headers = cors(env);
  const limited = await limit(env, request, 'stored-value', headers);
  if (limited) return limited;

  if (!await storedValueEnabled(env)) {
    /* Not an error: the feature is not on. The page asks before it shows the
       field, so this is the answer that hides it. */
    return json({ ok: true, enabled: false }, 200, headers);
  }

  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }

  /* One settings read, reused for every answer below. */
  const say = messagesFrom(await getSetting(env, 'commerce_config', {}).catch(() => ({})));

  const code = normalizeCode(body.code);
  if (!code) return json({ ok: false, enabled: true, error: say('giftCardEmpty') }, 400, headers);

  const info = await lookup(env, code);
  if (!info.found || !info.usable) {
    return json({
      ok: false, enabled: true,
      error: say(REASON_KEY[info.reason] || 'giftCardNotFound'),
    }, 200, headers);
  }

  return json({
    ok: true,
    enabled: true,
    code,
    kind: info.kind,
    balance: (info.balanceCents / 100).toFixed(2),
    balanceCents: info.balanceCents,
    expiresAt: info.expiresAt,
  }, 200, headers);
}

/**
 * GET /api/stored-value  —  "is this feature on?"
 *
 * The checkout page has to decide whether to draw a gift-card field before the
 * shopper has typed anything, and the switch lives in a settings row that only
 * the server reads. So it asks here.
 *
 * DELIBERATELY NOT RATE LIMITED, unlike the POST above. That limit exists
 * because the POST answers a question about a SECRET — twenty guesses an hour
 * at a code. This one answers a question the page's own markup gives away the
 * moment the field appears. Metering it would spend a shopper's twenty guesses
 * on page loads and lock them out of checking their own balance, which is the
 * limit protecting nothing and costing the thing it was put there for.
 */
export async function onRequestGet({ env }) {
  const headers = cors(env);
  return json({ ok: true, enabled: await storedValueEnabled(env) }, 200, headers);
}
