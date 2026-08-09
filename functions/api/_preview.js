/**
 * Shared helpers for the admin preview link.
 *
 * A preview token is a short-lived, signed statement that "an admin with these
 * permissions asked for a preview". It is signed with an HMAC over the
 * service-role key, which never leaves the server — so a token cannot be forged
 * from the browser, and the key cannot be recovered from a token.
 *
 * It is deliberately NOT a session: it carries no user identity beyond the id
 * that minted it, grants nothing except reading unpublished storefront content,
 * and expires on its own. Someone who is handed the link can look at the draft
 * homepage until it lapses; they cannot act as the admin who created it.
 *
 * Format:  <base64url(payload)>.<base64url(hmac)>
 * Payload: { sub, perms, exp }  — minter, granting permissions, expiry (epoch s)
 */

const LABEL = 'zw-preview-v1';                  // domain separation for the HMAC
/* 30 minutes. This is a bearer link — anyone it is forwarded to can open it, on
   any device, until it lapses — so the window is the main thing limiting a link
   that escapes. Two hours was generous for "look at this and tell me what you
   think"; half an hour still is, and cuts the exposure by four. Minting another
   is one click. */
export const PREVIEW_TTL_SECONDS = 60 * 30;

function signingKeyMaterial(env) {
  // The service key is the only server-only secret every deployment already
  // has. Mixing in a constant label means this HMAC can never collide with any
  // other use of the same key.
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
  return key ? LABEL + '|' + key : '';
}

function b64url(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = str.replace(/-/g, '+').replace(/_/g, '/');
  return atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
}

async function hmac(env, message) {
  const material = signingKeyMaterial(env);
  if (!material) return null;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(material),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig));
}

/* ── Revocation ─────────────────────────────────────────────────────────────
   Every token records the preview-link generation it was minted under. Bumping
   site_settings.preview_token_version — the admin's "Revoke all preview links"
   — moves the generation on, and every token from before it stops verifying at
   once. Without this, a link you regret sending is simply valid until it
   expires and there is nothing you can do but wait.

   Read fresh rather than cached: a revoke that takes effect in a minute is not
   a revoke, and a preview is looked at by one person a handful of times, so the
   extra read costs nothing that matters. Absent key, unset value, or an
   unreachable Supabase all mean generation 0 — the same answer a token minted
   before this existed carries, so nothing breaks on the way in. */
async function currentVersion(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
  if (!env.SUPABASE_URL || !key) return 0;
  try {
    const resp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/site_settings?select=value&key=eq.preview_token_version`,
      { headers: { apikey: key, Authorization: 'Bearer ' + key }, cache: 'no-store' }
    );
    if (!resp.ok) return 0;
    const rows = await resp.json();
    let v = rows && rows[0] ? rows[0].value : 0;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = 0; } }
    return Number(v && typeof v === 'object' ? v.version : v) || 0;
  } catch (_) {
    // Supabase unreachable. Fail open: the storefront is already broken in that
    // case, and locking an admin out of a preview would be the wrong trade.
    return 0;
  }
}

/** Mint a token for an admin. `perms` is the list that granted the preview. */
export async function mintPreviewToken(env, { sub, perms }) {
  const payload = {
    sub: String(sub || ''),
    perms: Array.isArray(perms) ? perms.slice(0, 20) : [],
    v: await currentVersion(env),
    exp: Math.floor(Date.now() / 1000) + PREVIEW_TTL_SECONDS,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = await hmac(env, body);
  if (!sig) return null;
  return body + '.' + sig;
}

/**
 * Verify a token. Returns its payload, or null for anything that isn't a valid,
 * unexpired token. Every failure returns the same null — a caller must not be
 * able to tell "bad signature" from "expired" from "malformed".
 */
export async function verifyPreviewToken(env, token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const expected = await hmac(env, parts[0]);
    if (!expected) return null;

    // Constant-time compare. A length check first is fine — both are fixed-size
    // base64url of a SHA-256, so a length mismatch leaks nothing.
    if (expected.length !== parts[1].length) return null;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts[1].charCodeAt(i);
    if (diff !== 0) return null;

    const payload = JSON.parse(b64urlDecode(parts[0]));
    if (!payload || typeof payload.exp !== 'number') return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    // Revoked: minted before the last "Revoke all preview links".
    if ((Number(payload.v) || 0) !== await currentVersion(env)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}
