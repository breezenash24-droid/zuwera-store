/**
 * Cloudflare Pages Function: POST /api/abandoned-cart
 *
 * Called (fire-and-forget) from the checkout when a shopper enters their email but
 * hasn't paid yet. Remembers their email + cart in the abandoned_carts table so
 * /api/send-abandoned-cart-emails can nudge them later. On a successful purchase,
 * stripe-webhook marks the row recovered so no email goes out.
 *
 * Public (no auth — it's a capture), but validated + compacted, and the table is
 * service-role only (RLS blocks anon), so writes go only through this endpoint.
 *
 * Body: { email, cart:[{ productId,title,size,colorName,quantity,price,image }] }
 */

import { cors, json } from './_commerce.js';

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '')); }

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    if (!validEmail(email)) return json({ ok: false, error: 'invalid email' }, 400, cors(env));

    let cart = Array.isArray(body.cart) ? body.cart : [];
    if (!cart.length) return json({ ok: true, skipped: 'empty cart' }, 200, cors(env));
    cart = cart.slice(0, 50).map((i) => ({
      id: i.productId || i.id || '',
      title: String(i.title || i.name || 'Item').slice(0, 200),
      size: String(i.size || '').slice(0, 20),
      color: String(i.colorName || i.color || '').slice(0, 40),
      qty: Math.max(1, Number(i.quantity) || 1),
      price: Number(i.price) || 0,
      image: String(i.image || '').slice(0, 500),
    }));
    const itemCount = cart.reduce((s, i) => s + (i.qty || 1), 0);
    const subtotalCents = Math.round(cart.reduce((s, i) => s + (i.price || 0) * (i.qty || 1), 0) * 100);

    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return json({ ok: false, error: 'not configured' }, 500, cors(env));
    const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
    const base = `${env.SUPABASE_URL}/rest/v1/abandoned_carts`;

    // Manual upsert keyed on email (the unique index is on lower(email); email is
    // already lowercased). Re-capturing resets emailed/recovered so a returning
    // shopper who abandons again is eligible for a fresh nudge.
    const found = await fetch(`${base}?select=id&email=eq.${encodeURIComponent(email)}&limit=1`, { headers: H })
      .then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const patch = {
      cart, subtotal_cents: subtotalCents, item_count: itemCount,
      updated_at: new Date().toISOString(), emailed_at: null, recovered_at: null,
    };
    if (found && found[0]) {
      await fetch(`${base}?id=eq.${found[0].id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    } else {
      await fetch(base, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ email, ...patch }) });
    }
    return json({ ok: true }, 200, cors(env));
  } catch (e) {
    return json({ ok: false, error: (e && e.message) || 'failed' }, 500, cors(env));
  }
}
