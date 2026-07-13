/**
 * Cloudflare Pages Function: POST /api/notify-restock   (admin-protected)
 *
 * Completes the existing back-in-stock feature. The product page already lets a
 * shopper tap a sold-out size and join a waitlist (rows in `restock_requests`).
 * This endpoint sends the "it's back" email: given a productId, it finds every
 * pending request whose requested size is now in stock, emails those shoppers,
 * and deletes the fulfilled requests so nobody is emailed twice.
 *
 * The admin calls it (best-effort) right after saving a product's stock, so a
 * restock automatically notifies the waitlist. Reuses the same service-role key
 * and email providers (Resend → Brevo → Loops) as the return-status emails, so
 * no new configuration is required.
 *
 * Body: { productId, accessToken }
 */

import { cors, json, verifyAdmin } from './_commerce.js';
import { fetchSiteSettings, resolveSetting } from './_settings.js';
import { loopsFallback } from './_email.js';

const LOGO_FALLBACK = 'https://zuwera.store/assets/Zuwera_Wordmark_White.png';

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
async function sbSelect(env, key, path) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  return resp.ok ? resp.json() : [];
}

// Same provider ladder as send-return-status-email.js: Resend → Brevo → Loops.
async function sendEmail({ to, toName, subject, html, fromEmail, resendKey, brevoKey, env, cache }) {
  if (resendKey) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Zuwera <${fromEmail}>`, to: [to], reply_to: 'orders@zuwera.store', subject, html }),
    });
    if (r.ok) return { provider: 'resend' };
  }
  if (brevoKey) {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Zuwera', email: fromEmail },
        to: [{ email: to, name: toName || '' }],
        replyTo: { email: 'orders@zuwera.store' },
        subject, htmlContent: html,
      }),
    });
    if (r.ok) return { provider: 'brevo' };
    const loops = await loopsFallback({ env, cache, to, subject, html });
    if (loops.ok) return { provider: 'loops' };
    throw new Error('Brevo send failed: ' + r.status);
  }
  const loops = await loopsFallback({ env, cache, to, subject, html });
  if (loops.ok) return { provider: 'loops' };
  throw new Error('No email provider configured (RESEND_API_KEY or BREVO_API_KEY required).');
}

function buildEmail({ productTitle, size, colorName, url, image, logoUrl }) {
  const variant = [colorName, size].filter(Boolean).join(' · ');
  const imgBlock = image
    ? `<tr><td style="padding:0 0 24px"><a href="${esc(url)}"><img src="${esc(image)}" alt="${esc(productTitle)}" width="240" style="max-width:240px;width:100%;border-radius:6px;display:block;margin:0 auto"></a></td></tr>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#0b0b0d;font-family:Arial,Helvetica,sans-serif;color:#f4f1eb">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0d">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="440" cellpadding="0" cellspacing="0" style="max-width:440px;width:100%;text-align:center">
        <tr><td style="padding:0 0 28px"><img src="${esc(logoUrl)}" alt="ZUWERA" width="120" style="max-width:120px"></td></tr>
        <tr><td style="font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#e05252;padding:0 0 8px">Back in stock</td></tr>
        <tr><td style="font-size:26px;font-weight:800;font-style:italic;text-transform:uppercase;letter-spacing:.02em;line-height:1.15;padding:0 0 6px">${esc(productTitle)}</td></tr>
        ${variant ? `<tr><td style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#9c988f;padding:0 0 22px">${esc(variant)}</td></tr>` : '<tr><td style="height:22px"></td></tr>'}
        ${imgBlock}
        <tr><td style="font-size:15px;line-height:1.6;color:#cfcbc2;padding:0 8px 26px">The size you wanted is available again — but it may not last. Grab it before it sells out.</td></tr>
        <tr><td style="padding:0 0 30px"><a href="${esc(url)}" style="display:inline-block;background:#f4f1eb;color:#0b0b0d;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:.14em;text-transform:uppercase;padding:14px 34px;border-radius:3px">Shop now</a></td></tr>
        <tr><td style="font-size:11px;color:#726e66;line-height:1.6;border-top:1px solid rgba(244,241,235,.1);padding:20px 0 0">You're receiving this because you asked to be notified when this item came back in stock. This is a one-time alert — no further action needed.</td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  try {
    const authHeader = request.headers.get('Authorization') || '';
    const body = await request.json().catch(() => ({}));
    const accessToken = String(body.accessToken || authHeader.replace(/^Bearer\s+/i, '') || '').trim();
    const productId = String(body.productId || '').trim();

    if (!accessToken) return json({ ok: false, error: 'Missing access token' }, 401, cors(env));
    if (!productId)   return json({ ok: false, error: 'Missing productId' }, 400, cors(env));

    const admin = await verifyAdmin(env, accessToken);
    if (!admin) return json({ ok: false, error: 'Admin access required' }, 403, cors(env));

    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return json({ ok: false, error: 'Supabase not configured' }, 500, cors(env));

    const pid = encodeURIComponent(productId);

    // 1. Which sizes are back in stock now?
    const sizeRows = await sbSelect(env, key, `product_sizes?select=size,stock_quantity&product_id=eq.${pid}`);
    const inStock = new Set((sizeRows || [])
      .filter((s) => (Number(s.stock_quantity) || 0) > 0)
      .map((s) => String(s.size)));
    if (!inStock.size) return json({ ok: true, notified: 0, note: 'No sizes in stock' }, 200, cors(env));

    // 2. Pending waitlist requests for those sizes.
    const reqRows = await sbSelect(env, key, `restock_requests?select=id,email,size,color_name&product_id=eq.${pid}`);
    const pending = (reqRows || []).filter((r) => r.email && inStock.has(String(r.size)));
    if (!pending.length) return json({ ok: true, notified: 0 }, 200, cors(env));

    // 3. Product + email config.
    const prodRows = await sbSelect(env, key, `products?select=title,image_url&id=eq.${pid}&limit=1`);
    const product = (prodRows || [])[0] || {};
    const productTitle = product.title || 'Your item';
    const productUrl = `https://zuwera.store/product.html?id=${pid}`;

    const cache = await fetchSiteSettings(
      ['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM', 'BRAND_LOGO_URL', 'LOOPS_API_KEY', 'LOOPS_TRANSACTIONAL_ID'],
      env
    );
    const resendKey = resolveSetting('RESEND_API_KEY', env, cache);
    const brevoKey  = resolveSetting('BREVO_API_KEY', env, cache);
    const loopsKey  = resolveSetting('LOOPS_API_KEY', env, cache);
    if (!resendKey && !brevoKey && !loopsKey) {
      return json({ ok: false, error: 'No email provider configured. Add RESEND_API_KEY or BREVO_API_KEY in Admin → APIs.' }, 500, cors(env));
    }
    const fromEmail = resolveSetting('EMAIL_FROM', env, cache) || 'orders@zuwera.store';
    const logoUrl   = resolveSetting('BRAND_LOGO_URL', env, cache) || LOGO_FALLBACK;
    const image     = product.image_url || '';

    // 4. Send, collecting the ids that went out so we only delete those.
    const sentIds = [];
    for (const r of pending) {
      try {
        const html = buildEmail({ productTitle, size: r.size, colorName: r.color_name, url: productUrl, image, logoUrl });
        await sendEmail({
          to: r.email, toName: '', subject: `Back in stock: ${productTitle} (${r.size})`,
          html, fromEmail, resendKey, brevoKey, env, cache,
        });
        sentIds.push(r.id);
      } catch (_) { /* leave this request in place for a later retry */ }
    }

    // 5. Delete fulfilled requests (prevents re-notifying; no schema change needed).
    if (sentIds.length) {
      const list = sentIds.map((id) => encodeURIComponent(id)).join(',');
      await fetch(`${env.SUPABASE_URL}/rest/v1/restock_requests?id=in.(${list})`, {
        method: 'DELETE',
        headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=minimal' },
      });
    }

    return json({ ok: true, notified: sentIds.length, of: pending.length }, 200, cors(env));
  } catch (e) {
    console.error('[notify-restock]', e && e.message);
    return json({ ok: false, error: (e && e.message) || 'notify-restock failed' }, 500, cors(env));
  }
}
