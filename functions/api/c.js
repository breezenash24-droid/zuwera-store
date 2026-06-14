/**
 * Cloudflare Pages Function: /api/c
 *
 * First-party relay for Meta browser events. meta-pixel.js POSTs each event
 * here — same origin, so it survives the ad blockers that kill requests to
 * connect.facebook.net — and this forwards it to the Conversions API
 * server-side. Each event carries the same event_id the browser pixel used, so
 * Meta de-duplicates the browser and server copies into a single event.
 *
 * Deliberately terse path + no PII in the URL. No-ops (200) when
 * META_CAPI_TOKEN is unset.
 */

import { buildUserData, sendCapiEvents } from './_capi.js';

const ALLOWED = new Set([
  'PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout',
  'AddPaymentInfo', 'Purchase', 'Lead', 'CompleteRegistration', 'Search',
]);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const ok = () => new Response(JSON.stringify({ ok: true }), {
  status: 200,
  headers: { 'Content-Type': 'application/json', ...CORS },
});

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// Visiting the URL in a browser is a GET — answer with a small "alive" payload
// so it doesn't look broken. Real events arrive via POST.
export function onRequestGet() {
  return new Response(JSON.stringify({ ok: true, endpoint: 'capi-relay', accepts: 'POST' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function onRequestPost({ request, env }) {
  let payload;
  try { payload = await request.json(); } catch { payload = null; }

  // Unknown / missing event → acknowledge and drop (keeps the client quiet).
  if (!payload || !ALLOWED.has(payload.event_name)) return ok();

  const user_data = await buildUserData({
    fbp: payload.fbp,
    fbc: payload.fbc,
    email: payload.email, // usually absent for browse events
    ip: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '',
    userAgent: request.headers.get('User-Agent') || '',
  });

  const event = {
    event_name: payload.event_name,
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'website',
    user_data,
  };
  if (payload.event_id) event.event_id = String(payload.event_id);
  if (payload.event_source_url) event.event_source_url = String(payload.event_source_url);
  if (payload.custom_data && typeof payload.custom_data === 'object') event.custom_data = payload.custom_data;

  await sendCapiEvents(env, [event]);
  return ok();
}
