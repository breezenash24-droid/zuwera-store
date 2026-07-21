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

import { cors, json, verifyAdminCan } from './_commerce.js';
import { fetchSiteSettings, resolveSetting } from './_settings.js';
import { loopsFallback } from './_email.js';
import { getEmailAppearance, getEmailContent, renderEmailShell, fillTemplate } from './_email-theme.js';

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

// Themed via the shared shell (fonts/colours/logo/light-dark + editable copy from
// site_settings), so it matches the site and the admin Emails editor controls it.
function buildEmail({ productTitle, size, colorName, url, image, appearance, content }) {
  const a = appearance;
  const variant = [colorName, size].filter(Boolean).join(' · ');
  const imgBlock = image
    ? `<tr><td style="padding:2px 0 20px"><a href="${esc(url)}"><img src="${esc(image)}" alt="${esc(productTitle)}" width="240" style="max-width:240px;width:100%;border-radius:6px;display:block;margin:0 auto"></a></td></tr>`
    : '';
  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="text-align:center">
    ${variant ? `<tr><td style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:${a.muted};padding:0 0 16px">${esc(variant)}</td></tr>` : '<tr><td style="height:4px"></td></tr>'}
    ${imgBlock}
    <tr><td style="padding:4px 0 8px"><a href="${esc(url)}" style="display:inline-block;background:${a.text};color:${a.bg};text-decoration:none;font-weight:700;font-size:13px;letter-spacing:.14em;text-transform:uppercase;padding:14px 34px;border-radius:3px">Shop now</a></td></tr>
  </table>`;
  return renderEmailShell(a, {
    kicker: content.kicker,
    heading: fillTemplate(content.heading, { product: productTitle }),
    intro: content.intro,
    bodyHtml: body,
    footer: content.footer,
  });
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

    // Sending restock notifications is a product/inventory action — gate on product_write.
    const admin = await verifyAdminCan(env, accessToken, 'product_write');
    if (!admin) return json({ ok: false, error: 'Your role does not have permission to manage products.' }, 403, cors(env));

    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return json({ ok: false, error: 'Supabase not configured' }, 500, cors(env));

    // Master switch: skip sending when Back in Stock is explicitly turned off in
    // Admin → Feature Flags (feature_back_in_stock). Permissive — only an explicit
    // enabled:false suppresses it, so the feature keeps working by default.
    try {
      const ffRows = await sbSelect(env, key, `site_settings?select=value&key=eq.feature_flags&limit=1`);
      let flags = ffRows && ffRows[0] && ffRows[0].value;
      if (typeof flags === 'string') { try { flags = JSON.parse(flags); } catch (_) { flags = null; } }
      const bis = flags && flags.feature_back_in_stock;
      if (bis && bis.enabled === false) return json({ ok: true, notified: 0, disabled: true }, 200, cors(env));
    } catch (_) { /* on any error, fall through and send (fail-open) */ }

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
    const prodRows = await sbSelect(env, key, `products?select=title,image_url,product_images(image_url,sort_order)&id=eq.${pid}&limit=1`);
    const product = (prodRows || [])[0] || {};
    const productTitle = product.title || 'Your item';
    const productUrl = `https://zuwera.store/product.html?id=${pid}`;

    const cache = await fetchSiteSettings(
      ['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM', 'BRAND_LOGO_URL', 'LOOPS_API_KEY', 'LOOPS_TRANSACTIONAL_ID',
       'fonts', 'brand', 'email_theme', 'email_settings'],
      env
    );
    const appearance = getEmailAppearance(cache);
    const content = getEmailContent(cache, 'back_in_stock');
    const resendKey = resolveSetting('RESEND_API_KEY', env, cache);
    const brevoKey  = resolveSetting('BREVO_API_KEY', env, cache);
    const loopsKey  = resolveSetting('LOOPS_API_KEY', env, cache);
    if (!resendKey && !brevoKey && !loopsKey) {
      return json({ ok: false, error: 'No email provider configured. Add RESEND_API_KEY or BREVO_API_KEY in Admin → APIs.' }, 500, cors(env));
    }
    const fromEmail = resolveSetting('EMAIL_FROM', env, cache) || 'orders@zuwera.store';
    const logoUrl   = resolveSetting('BRAND_LOGO_URL', env, cache) || LOGO_FALLBACK;
    appearance.logo = logoUrl;   // resolveSetting also covers an env-var logo, which the helper can't see
    // Match the storefront card: prefer the first gallery photo (product_images),
    // fall back to the main image_url. Using image_url alone can surface a
    // placeholder/emblem when the real photos live in product_images.
    const gallery = Array.isArray(product.product_images)
      ? product.product_images.slice().sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
      : [];
    const image = (gallery[0] && gallery[0].image_url) || product.image_url || '';

    // 4. Send, collecting the ids that went out so we only delete those.
    const sentIds = [];
    for (const r of pending) {
      try {
        const html = buildEmail({ productTitle, size: r.size, colorName: r.color_name, url: productUrl, image, appearance, content });
        await sendEmail({
          to: r.email, toName: '', subject: fillTemplate(content.subject, { product: productTitle, size: r.size }),
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
