/**
 * _paypal.js — talking to PayPal, and nothing else.
 *
 * Credentials live in the environment, never in site_settings. A settings row
 * is readable by anything holding an admin session and is carried in database
 * backups; a client secret in one is a credential in the database. The admin
 * panel gets to choose WHETHER PayPal is offered. It never gets to hold the key.
 *
 * Sandbox vs live is decided by PAYPAL_ENV, and it defaults to sandbox. The
 * default matters: an environment variable that is missing, misspelled, or
 * dropped during a migration must not silently start taking real money.
 */

const HOSTS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

export function paypalConfig(env) {
  const mode = String(env.PAYPAL_ENV || '').trim().toLowerCase() === 'live' ? 'live' : 'sandbox';
  const clientId = String(env.PAYPAL_CLIENT_ID || '').trim();
  const secret = String(env.PAYPAL_CLIENT_SECRET || env.PAYPAL_SECRET || '').trim();
  return { mode, clientId, secret, host: HOSTS[mode], configured: Boolean(clientId && secret) };
}

/* One token per worker instance, reused until shortly before it expires.
 *
 * The 60-second haircut is the point of the field: a token that is valid when
 * we check and expired when PayPal reads it fails the request it was fetched
 * for, and at capture time that is a customer watching a spinner after they
 * have already approved the payment. Renewing a minute early costs nothing.
 *
 * Module scope is per-isolate, so this is a cache and never a source of truth —
 * a cold isolate simply fetches one. */
let tokenCache = { value: '', expiresAt: 0, key: '' };

export async function paypalToken(env) {
  const cfg = paypalConfig(env);
  if (!cfg.configured) throw new Error('PayPal is not configured.');

  /* Keyed by which credentials produced it. Without this, flipping PAYPAL_ENV
     could serve a sandbox token to the live host from a warm isolate. */
  const key = cfg.mode + ':' + cfg.clientId;
  const now = Date.now();
  if (tokenCache.value && tokenCache.key === key && tokenCache.expiresAt > now) return tokenCache.value;

  const resp = await fetch(cfg.host + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(cfg.clientId + ':' + cfg.secret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data?.access_token) {
    /* Deliberately vague to the caller and specific to the log. A 401 here means
       our credentials are wrong, which is our problem and not something to
       describe to whoever is standing at the checkout. */
    console.error('PayPal token failed:', resp.status, JSON.stringify(data || {}).slice(0, 300));
    throw new Error('Could not reach PayPal.');
  }

  tokenCache = {
    value: data.access_token,
    key,
    expiresAt: now + Math.max(0, (Number(data.expires_in) || 0) - 60) * 1000,
  };
  return tokenCache.value;
}

/**
 * A PayPal REST call that always resolves to a readable shape.
 *
 * Returns { ok, status, data } rather than throwing on a 4xx, because PayPal's
 * error bodies are the useful part — an INSTRUMENT_DECLINED and a malformed
 * request arrive as the same HTTP status class and only the body separates
 * them. A caller that wants to throw still can; one that needs to read the
 * reason no longer has to catch to do it.
 */
export async function paypalFetch(env, path, { method = 'GET', body, requestId } = {}) {
  const cfg = paypalConfig(env);
  const token = await paypalToken(env);
  const headers = {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
  };
  /* PayPal's idempotency header. Same id + same body returns the original
     result instead of creating a second order, which is what makes a retried
     or double-clicked request safe. */
  if (requestId) headers['PayPal-Request-Id'] = String(requestId).slice(0, 108);

  const resp = await fetch(cfg.host + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* handled by caller via ok/status */ }
  if (!resp.ok) {
    console.error('PayPal ' + method + ' ' + path + ' → ' + resp.status + ': ' + String(text).slice(0, 400));
  }
  return { ok: resp.ok, status: resp.status, data };
}

/* PayPal wants decimal strings, and it wants them to add up exactly. Money is
   held in cents everywhere else in this codebase for that reason — converting
   once, here, at the boundary, is what keeps a rounding error from becoming a
   rejected order or an eight-cent discrepancy nobody can trace. */
export function centsToAmount(cents) {
  return (Math.round(Number(cents) || 0) / 100).toFixed(2);
}

/* ── Refunds ────────────────────────────────────────────────────────────────
 *
 * The Stripe path answers two questions before it moves anything: how much has
 * already gone back, and is this request within what remains. It refuses
 * locally rather than letting the processor refuse, because a local refusal can
 * say what already happened and who did it, while a raw API error hands an
 * admin a number they cannot see.
 *
 * PayPal has to answer the same two questions, and it answers them differently.
 * There is no "list the refunds on this capture" call. What there is:
 *
 *   GET /v2/payments/captures/{id}  →  status: COMPLETED | PARTIALLY_REFUNDED |
 *                                      REFUNDED, plus the captured amount.
 *
 * So a full refund is knowable exactly (status REFUNDED) and a partial one is
 * knowable only as "some, amount unspecified". That is an honest gap and it is
 * reported as one: known:false rather than a confident zero. A confident zero
 * would be the worst possible answer — it reads as "nothing refunded yet" and
 * permits precisely the double refund this exists to prevent.
 *
 * Where the amount cannot be established, PayPal's own ceiling is the backstop:
 * it refuses to refund past the captured total, and that refusal is surfaced
 * rather than swallowed.
 */

/** What PayPal knows about a capture. Never throws; unknown is a valid answer. */
export async function paypalCaptureState(env, captureId) {
  if (!captureId) return { known: false, fullyRefunded: false, chargedCents: 0 };
  try {
    const res = await paypalFetch(env, '/v2/payments/captures/' + encodeURIComponent(captureId));
    if (!res.ok || !res.data) return { known: false, fullyRefunded: false, chargedCents: 0 };
    const status = String(res.data.status || '').toUpperCase();
    const value = res.data.amount && res.data.amount.value;
    const chargedCents = Math.round(Number(value) * 100) || 0;
    return {
      /* Only the fully-refunded case is a number we can stand behind. A
         PARTIALLY_REFUNDED capture is real information — it stops a blind full
         refund — but not an amount, so the caller must not treat it as one. */
      known: status === 'REFUNDED' || status === 'COMPLETED',
      fullyRefunded: status === 'REFUNDED',
      partiallyRefunded: status === 'PARTIALLY_REFUNDED',
      status,
      chargedCents,
    };
  } catch (e) {
    console.warn('paypalCaptureState failed for', captureId, e && e.message);
    return { known: false, fullyRefunded: false, chargedCents: 0 };
  }
}

/**
 * Send money back. Omitting the amount refunds the lot, which is PayPal's own
 * convention and avoids a rounding disagreement on a full refund.
 *
 * Idempotent on the caller's key: PayPal returns the ORIGINAL refund for a
 * repeated PayPal-Request-Id rather than issuing a second one. That matters
 * more here than at capture — a double refund is money leaving twice, and the
 * obvious trigger is an admin clicking again because the first click looked
 * like it did nothing.
 */
export async function refundPayPalCapture(env, { captureId, amountCents, note, requestId }) {
  const cfg = paypalConfig(env);
  if (!cfg.configured) return { ok: false, error: 'PayPal is not configured.' };
  if (!captureId) return { ok: false, error: 'No PayPal capture id on this order.' };

  const body = {};
  if (Number.isFinite(Number(amountCents)) && Number(amountCents) > 0) {
    body.amount = { value: centsToAmount(amountCents), currency_code: 'USD' };
  }
  if (note) body.note_to_payer = String(note).slice(0, 255);

  const res = await paypalFetch(env, '/v2/payments/captures/' + encodeURIComponent(captureId) + '/refund', {
    method: 'POST',
    requestId: requestId || undefined,
    body,
  });

  if (!res.ok || !res.data || !res.data.id) {
    /* PayPal's issue codes are the useful part and its prose is written for an
       integrator. Translate the two an admin will actually hit; pass anything
       else through so nothing is hidden. */
    const issue = (res.data && res.data.details && res.data.details[0] && res.data.details[0].issue) || '';
    const detail = (res.data && res.data.details && res.data.details[0] && res.data.details[0].description)
      || (res.data && res.data.message) || ('HTTP ' + res.status);
    if (issue === 'CAPTURE_FULLY_REFUNDED') {
      return { ok: false, alreadyRefunded: true, error: 'PayPal reports this capture has already been fully refunded.' };
    }
    if (issue === 'REFUND_AMOUNT_EXCEEDED') {
      return { ok: false, error: 'That is more than is left to refund on this PayPal payment.' };
    }
    return { ok: false, error: 'PayPal refused the refund: ' + detail, issue };
  }

  const refunded = res.data.amount && res.data.amount.value;
  return {
    ok: true,
    id: String(res.data.id),
    amountCents: Math.round(Number(refunded) * 100) || 0,
    status: String(res.data.status || ''),
  };
}

/**
 * How much of a PayPal capture has already been refunded.
 *
 * Pulled out as a pure function because the alternative is asserting that the
 * code exists. It was written inline first, and a test that regex-matched the
 * source passed just as happily with the credibility check deleted and with the
 * outside-this-panel branch replaced by `if (false)`. Both mutations moved real
 * money and neither turned anything red. This is money; it has to be run.
 *
 * ── WHY IT TAKES TWO SOURCES ────────────────────────────────────────────────
 *
 * PayPal has no "list the refunds on this capture" call. Its status says
 * COMPLETED, PARTIALLY_REFUNDED or REFUNDED — so a full refund is knowable
 * exactly and a partial one is knowable only as "some, amount unspecified".
 *
 * The panel records every refund it issues, with its amount. Trusting that
 * alone would be the second ledger the refund route warns about — "the day they
 * disagree is the day it matters". So neither is trusted alone: they are
 * reconciled, and a disagreement is reported rather than resolved.
 *
 *   REFUNDED                      → fully refunded. From the processor, exact.
 *   COMPLETED + no local rows     → nothing refunded. Both agree, exact.
 *   PARTIALLY_REFUNDED + rows     → our sum. Both agree some went back.
 *   PARTIALLY_REFUNDED + no rows  → refunded in PayPal's dashboard. Amount
 *                                   unknowable here; say so and refuse.
 *
 * The ledger is never believed over the processor. It is our record of an
 * intent; PayPal's is the record of the money. A ledger claiming more than was
 * captured, or claiming anything while PayPal still says COMPLETED, is the side
 * that is wrong.
 *
 * @param captureState  what paypalCaptureState returned
 * @param ledgerCents   sum of refunds this panel recorded for this order
 * @param ledgerCount   how many of them
 */
export function reconcilePayPalRefunds(captureState, ledgerCents, ledgerCount) {
  const st = captureState || {};
  const charged = Math.max(0, Math.round(Number(st.chargedCents) || 0));
  const cents = Math.max(0, Math.round(Number(ledgerCents) || 0));
  const count = Math.max(0, Math.round(Number(ledgerCount) || 0));

  if (st.fullyRefunded) {
    return { refundedCents: charged, chargedCents: charged, count: Math.max(1, count), known: true };
  }

  const credible = cents > 0 && cents <= charged && st.status !== 'COMPLETED';
  if (credible) {
    return { refundedCents: cents, chargedCents: charged, count, known: true };
  }

  return {
    refundedCents: 0,
    chargedCents: charged,
    count: 0,
    /* Only when BOTH agree nothing has gone back is "nothing refunded" a fact
       rather than an assumption. Anything else is unknown, and unknown must not
       be spelled zero — a zero reads as "nothing refunded yet" and permits the
       double refund this exists to stop. */
    known: st.status === 'COMPLETED' && count === 0,
    partiallyRefunded: !!st.partiallyRefunded,
    /* PayPal says some went back and this panel did not do it. Refusing is the
       only honest move: a full refund would send back money that has partly
       gone already, and PayPal's own ceiling catches the total but not a
       partial that happens to fit under it. */
    refundedOutsideThisPanel: !!st.partiallyRefunded && count === 0,
  };
}
