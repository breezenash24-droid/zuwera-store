/**
 * Cloudflare Pages Function: GET /api/unsubscribe?token=…   (public)
 *
 * One-click unsubscribe from the newsletter emails. Each subscriber has a random
 * unsub_token; the journal emails link here. Marks the row unsubscribed and
 * returns a small confirmation page.
 */

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}

function page(message) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribe — Zuwera</title></head>
<body style="margin:0;background:#09090b;color:#f4f1eb;font-family:Arial,Helvetica,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center">
<div style="max-width:440px;padding:44px 24px">
  <div style="font-size:22px;font-weight:800;font-style:italic;text-transform:uppercase;letter-spacing:.04em;margin-bottom:18px">ZUWERA</div>
  <p style="font-size:15px;line-height:1.65;color:#cfcbc2;margin:0">${message}</p>
  <a href="https://zuwera.store" style="display:inline-block;margin-top:26px;color:#f4f1eb;font-size:11px;letter-spacing:.14em;text-transform:uppercase;text-decoration:none;border-bottom:1px solid rgba(244,241,235,.4);padding-bottom:3px">Back to zuwera.store</a>
</div></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const token = (url.searchParams.get('token') || '').trim();
    if (!token) return page('This unsubscribe link is invalid.');

    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return page('Unsubscribe is temporarily unavailable. Please try again later.');
    const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };

    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/newsletter_subscribers?unsub_token=eq.${encodeURIComponent(token)}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'unsubscribed', unsubscribed_at: new Date().toISOString() }),
    });
    const rows = r.ok ? await r.json().catch(() => []) : [];
    if (rows && rows.length) {
      return page("You've been unsubscribed. You won't receive any more emails from the Zuwera journal.");
    }
    return page('This unsubscribe link is invalid or has already been used.');
  } catch (e) {
    return page('Something went wrong. Please try again later.');
  }
}
