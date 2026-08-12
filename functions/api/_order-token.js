/**
 * _order-token.js — a signed link to ONE order, for someone with no session.
 *
 * WHY THIS IS SHARED RATHER THAN COPIED. The minting and reading lived inside
 * guest-return.js as private helpers. The order confirmation email needs to
 * mint one too, and so does the shipped/delivered notice — three callers, and
 * the version of this codebase that copies a crypto helper twice is the version
 * that ends up with two definitions of what a valid token is. One of them then
 * gets a fix and the other does not. So: one implementation, three importers.
 *
 * WHAT A TOKEN IS FOR. A guest has no account and no session, so there is
 * nothing to check them against. What we can check is that they can read the
 * mailbox the order was sent to — and a link delivered to that mailbox proves
 * exactly that, which is the same thing a login proves and no more.
 *
 * WHAT IT IS NOT. Not a login. It names one order and grants what that order's
 * own receipt already shows: what was bought, where it went, and the ability to
 * send it back. It cannot read a profile, list other orders, change an address,
 * or move a refund anywhere but the card that paid.
 *
 * ── The two purposes, and why the TTLs differ ────────────────────────────────
 *
 *   'guest-return'  — someone typed an order number and email into the returns
 *                     page and asked for a link. One hour: long enough to read
 *                     an email and fill a form, short enough that a forwarded
 *                     message is not a standing key to someone's order.
 *
 *   'order-status'  — the link inside the order confirmation itself, which
 *                     nobody requested and which has to still work whenever the
 *                     customer next opens their receipt. An hour is useless
 *                     here: receipts get opened a week later, which is the
 *                     entire point of keeping one.
 *
 * The receipt token is the longer-lived of the two AND the one issued without
 * anyone asking, so it is worth being explicit about why that is acceptable.
 * It went to the address on the order and nowhere else, so holding it means
 * holding the receipt — and the receipt already lists the items, the total and
 * the shipping address. The one thing the token adds is starting a return, and
 * a return ships to the address on the order with the refund going back to the
 * card that paid it. There is nothing in that for a stranger.
 *
 * Expiry degrades rather than breaks: returns.html answers a dead token with
 * "that link has expired" and a button to the ordinary lookup, which is the
 * flow that existed before any of this. Nobody is stranded by a stale link.
 */

/* Sixty days, against a thirty-day return window. Deliberately longer than the
   window rather than equal to it: a link that dies the same day the right to
   return does turns the last day of the window into a support email. */
export const TTL = {
  'guest-return': 60 * 60 * 1000,
  'order-status': 60 * 24 * 60 * 60 * 1000,
};

export const PURPOSES = Object.keys(TTL);

const b64uEncodeBytes = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};
const b64uEncode = (str) => btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const b64uDecode = (v) => {
  const s = String(v || '').replace(/-/g, '+').replace(/_/g, '/');
  return atob(s.padEnd(Math.ceil(s.length / 4) * 4, '='));
};

async function hmac(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return b64uEncodeBytes(new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)),
  ));
}

/* Compared without leaking where two signatures first differ. */
function constantTimeEqual(a, b) {
  const l = String(a || ''), r = String(b || '');
  if (l.length !== r.length) return false;
  let diff = 0;
  for (let i = 0; i < l.length; i += 1) diff |= l.charCodeAt(i) ^ r.charCodeAt(i);
  return diff === 0;
}

/* Its own secret where one is configured, falling back to the checkout rate
   secret so the feature works on a store that has not set a new variable.
   The `p` (purpose) field is what makes that sharing safe: a rate token, a
   return token and a receipt token are signed by the same key but can never be
   mistaken for one another, because the purpose is inside the signed body. */
export const secretFor = (env) => env.RETURN_TOKEN_SECRET || env.CHECKOUT_RATE_SECRET || '';

/**
 * Mint a link token for one order.
 *
 * Identify the order by `orderId` where it is known, and by `paymentIntentId`
 * where it is not — which is the ordinary case for a confirmation email. The
 * email is composed in parallel with the row being written and the insert uses
 * `Prefer: return=minimal`, so at that moment there IS no order id to put in a
 * token. The PaymentIntent id exists before either, and the row is already
 * queried by it elsewhere.
 *
 * Not the order NUMBER, which looks like the obvious choice and is not: it is
 * generated from the first item's category and comes out null whenever that
 * category is missing, which is why live receipts currently read "#TMWKGY60" —
 * a slice of the PaymentIntent id, not an order number at all.
 *
 * @returns {Promise<string>} the token, or '' when no secret is configured
 *          (callers fall back to the ordinary lookup link).
 */
export async function mintOrderToken(env, { purpose = 'guest-return', orderId, paymentIntentId, email } = {}) {
  const secret = secretFor(env);
  if (!secret) return '';
  if (!TTL[purpose]) return '';
  if (!orderId && !paymentIntentId) return '';
  const claim = { p: purpose, exp: Date.now() + TTL[purpose] };
  if (orderId) claim.o = String(orderId);
  if (paymentIntentId) claim.pi = String(paymentIntentId);
  if (email) claim.e = String(email).trim().toLowerCase();
  const body = b64uEncode(JSON.stringify(claim));
  return body + '.' + await hmac(body, secret);
}

/**
 * Verify a token and return its claim, or null.
 *
 * `accept` lists the purposes the CALLER is willing to honour, so a route can
 * narrow if it ever needs to. It defaults to both, because both prove the same
 * thing — control of the mailbox the order was sent to — and so grant the same
 * thing. A purpose outside the list is rejected even with a valid signature.
 */
export async function readOrderToken(env, token, { accept = PURPOSES } = {}) {
  const secret = secretFor(env);
  if (!secret) return null;
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  if (!constantTimeEqual(await hmac(body, secret), sig)) return null;
  let claim;
  try { claim = JSON.parse(b64uDecode(body)); } catch (_) { return null; }
  if (!accept.includes(claim.p)) return null;
  if (!claim.exp || Date.now() > claim.exp) return null;
  /* A signature over a body naming no order is valid and useless — refuse it
     here rather than letting a caller query for `undefined`. */
  if (!claim.o && !claim.pi) return null;
  return claim;
}
