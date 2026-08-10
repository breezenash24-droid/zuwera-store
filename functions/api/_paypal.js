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
