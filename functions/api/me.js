/**
 * Cloudflare Pages Function: /api/me
 *
 * One question: "does the server consider this visitor a member?"
 *
 * It exists because the storefront kept guessing. Five different pieces of
 * browser code decided membership independently — a session object being
 * present, a localStorage key existing, an expiry parsed by hand, a cached user
 * — and each one disagreed with the server on a different day. The symptom was
 * always the same shape: the bag showed one price, the summary showed another,
 * and which was right depended on which check happened to be wrong that time.
 *
 * The browser cannot answer this reliably. Token validity is the server's to
 * decide, storage formats change under it (supabase-js moved to base64), and a
 * token can be well-formed and still rejected. So this endpoint gives the ONE
 * answer, from verifyAccessToken — literally the same function quoteCart uses
 * to decide which price to charge. The display and the charge cannot disagree
 * because they are now the same judgement.
 *
 * Deliberately says nothing else. No email, no id, no profile. It is consulted
 * on page load by anyone who happens to be holding a token, so it should reveal
 * nothing beyond the one bit the pricing needs.
 */

import { json } from './_commerce.js';
import { verifyAccessToken } from './_cart-pricing.js';

const CORS = (env) => ({
  'Access-Control-Allow-Origin': env.SITE_URL || 'https://zuwera.store',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  /* Never cached, anywhere. This is per-visitor and changes the moment a token
     expires; an edge cache would hand one shopper's answer to the next. */
  'Cache-Control': 'no-store, private',
});

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: CORS(env) });
}

async function answer(request, env) {
  const headers = CORS(env);
  try {
    let token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      token = String(body?.accessToken || '').trim();
    }
    /* No token is a perfectly ordinary answer, not an error: most visitors are
       signed out, and 200 with member:false keeps the caller's code on one
       path instead of branching on a status. */
    if (!token) return json({ member: false }, 200, headers);

    const user = await verifyAccessToken(token, env);
    return json({ member: Boolean(user?.id) }, 200, headers);
  } catch (e) {
    /* Fail as a GUEST, never as a member. Being wrongly treated as a guest
       shows a shopper the higher price and is visible and complainable; being
       wrongly treated as a member shows a price we will then refuse to honour,
       which is the failure that has been costing sales. */
    console.error('me: ' + ((e && e.message) || e));
    return json({ member: false, error: 'unverified' }, 200, headers);
  }
}

export const onRequestGet = ({ request, env }) => answer(request, env);
export const onRequestPost = ({ request, env }) => answer(request, env);
