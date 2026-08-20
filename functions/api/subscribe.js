/**
 * Cloudflare Pages Function: POST /api/subscribe   (public)
 *
 * Captures a newsletter signup into newsletter_subscribers with the service-role
 * key (the table is admin-only under RLS, so anon can't write directly — this
 * is why the old client-side upsert silently did nothing). Dedupes by email and
 * re-subscribes anyone who had previously unsubscribed.
 *
 * Body: { email, source? }
 */

import { cors, json } from './_commerce.js';
import { limit } from './_ratelimit.js';
import { requireHuman } from './_turnstile.js';

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}
function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  const headers = cors(env);
  /* Five in ten minutes per address. Nobody subscribes to a newsletter twice;
     a list-bombing script does it as fast as the network allows. */
  const limited = await limit(env, request, 'subscribe', headers);
  if (limited) return limited;

  try {
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const source = String(body.source || 'footer').slice(0, 60);
    if (!validEmail(email)) return json({ ok: false, error: 'Please enter a valid email.' }, 400, cors(env));

    /* AFTER the address is checked, so a typo does not spend a token, and
       before anything is written. Returns null when Turnstile is not installed
       on this deployment — /api/health is where that fact is published, so it
       cannot pass for protection that is not there. */
    const notHuman = await requireHuman(env, request, body.turnstileToken, headers);
    if (notHuman) return notHuman;

    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return json({ ok: false, error: 'not configured' }, 500, cors(env));
    const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
    const base = `${env.SUPABASE_URL}/rest/v1/newsletter_subscribers`;

    const existing = await fetch(`${base}?select=id,status&email=eq.${encodeURIComponent(email)}&limit=1`, { headers: H, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : [])).catch(() => []);
    if (existing && existing[0]) {
      if (existing[0].status === 'unsubscribed') {
        await fetch(`${base}?id=eq.${existing[0].id}`, {
          method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'subscribed', unsubscribed_at: null }),
        });
      }
      return json({ ok: true, already: true }, 200, cors(env));
    }

    const r = await fetch(base, {
      method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ email, source }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      if (/duplicate|unique/i.test(txt)) return json({ ok: true, already: true }, 200, cors(env));
      return json({ ok: false, error: 'Could not subscribe. Try again.' }, 500, cors(env));
    }
    return json({ ok: true }, 200, cors(env));
  } catch (e) {
    return json({ ok: false, error: (e && e.message) || 'failed' }, 500, cors(env));
  }
}
