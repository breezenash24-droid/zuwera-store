/**
 * Shared Meta Conversions API (server-side) helper for Cloudflare Pages Functions.
 *
 * Used by:
 *   - functions/api/c.js              (first-party relay for browser events)
 *   - functions/api/stripe-webhook.js (server-side Purchase)
 *
 * Sends events to the Graph API events endpoint for the pixel. PII is SHA-256
 * hashed per Meta's requirements; fbp / fbc / IP / user-agent are sent raw.
 * No-ops cleanly when META_CAPI_TOKEN is unset, so the site keeps working
 * before the token is added in the Cloudflare dashboard.
 *
 * Env (CF Pages → Settings → Environment variables):
 *   META_CAPI_TOKEN      — System User access token (Events Manager → dataset →
 *                          Settings → Conversions API → Generate access token)
 *   META_PIXEL_ID        — optional override (defaults to the hard-coded id)
 *   META_CAPI_TEST_CODE  — optional; set temporarily to surface events in the
 *                          Events Manager "Test events" tab, then remove
 */

const DEFAULT_PIXEL_ID = '1695269795093400';
const GRAPH_VERSION = 'v21.0';

export async function sha256Hex(value) {
  const norm = String(value == null ? '' : value).trim().toLowerCase();
  if (!norm) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build a Meta user_data object. PII fields are hashed; match keys
 * (fbp/fbc/ip/ua) pass through raw. Only keys with values are included.
 */
export async function buildUserData(input = {}) {
  const ud = {};
  const setHashed = async (key, value) => {
    const out = await sha256Hex(value);
    if (out) ud[key] = [out];
  };
  await setHashed('em', input.email);
  await setHashed('fn', input.firstName);
  await setHashed('ln', input.lastName);
  if (input.phone) await setHashed('ph', String(input.phone).replace(/[^0-9]/g, ''));
  if (input.city) await setHashed('ct', String(input.city).replace(/\s+/g, ''));
  await setHashed('st', input.state);
  await setHashed('zp', input.zip);
  await setHashed('country', input.country);
  // Raw (un-hashed) identifiers
  if (input.fbp) ud.fbp = String(input.fbp);
  if (input.fbc) ud.fbc = String(input.fbc);
  if (input.ip) ud.client_ip_address = String(input.ip);
  if (input.userAgent) ud.client_user_agent = String(input.userAgent);
  return ud;
}

/**
 * POST events to the Conversions API. Returns {skipped:true} when no token is
 * set. Never throws — logs and returns {ok:false} on failure.
 */
export async function sendCapiEvents(env, events, opts = {}) {
  const token = env && env.META_CAPI_TOKEN;
  if (!token) return { skipped: true, reason: 'no_token' };
  if (!Array.isArray(events) || !events.length) return { skipped: true, reason: 'no_events' };

  const pixelId = env.META_PIXEL_ID || DEFAULT_PIXEL_ID;
  const body = { data: events };
  const testCode = opts.testCode || env.META_CAPI_TEST_CODE;
  if (testCode) body.test_event_code = testCode;

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(token)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!res.ok) {
      console.error('CAPI send failed', res.status, await res.text().catch(() => ''));
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (e) {
    console.error('CAPI fetch error:', e.message);
    return { ok: false, error: e.message };
  }
}
