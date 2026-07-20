/**
 * Cloudflare Pages Function: POST /api/send-review-requests
 *
 * Scheduled job (trigger hourly/daily from an external cron, same pattern as
 * send-abandoned-cart-emails / backup-export). Finds orders placed a few days
 * ago that haven't had a review request yet, emails the customer asking them to
 * review what they bought (with a direct link per product), and marks the order.
 *
 * Auth: shared secret in the `x-cron-token` header (or ?token=) vs the
 * REVIEW_REQUEST_TOKEN function secret. No secret set → rejects everything.
 * Respects the feature_review_requests flag (off → no sends). Reuses the same
 * Resend → Brevo → Loops providers as the other transactional emails.
 */

import { json } from './_commerce.js';
import { fetchSiteSettings, resolveSetting } from './_settings.js';
import { loopsFallback } from './_email.js';
import { logEmail } from './_email-log.js';

const SITE = 'https://zuwera.store';
const LOGO_FALLBACK = 'https://zuwera.store/assets/Zuwera_Wordmark_White.png';

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}
function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function productSlug(title) {
  return String(title || 'product')
    .replace(/^zuwera\s+/i, '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'product';
}
function reviewUrl(item) {
  const id = item.productId || item.product_id || item.id || '';
  const name = item.name || item.title || 'product';
  return `${SITE}/product/${productSlug(name)}?id=${encodeURIComponent(id)}&review=1`;
}

async function sendEmail({ to, subject, html, fromEmail, resendKey, brevoKey, env, cache }) {
  if (resendKey) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Zuwera <${fromEmail}>`, to: [to], reply_to: 'orders@zuwera.store', subject, html }),
    });
    if (r.ok) return { provider: 'resend' };
  }
  if (brevoKey) {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: { name: 'Zuwera', email: fromEmail }, to: [{ email: to }], replyTo: { email: 'orders@zuwera.store' }, subject, htmlContent: html }),
    });
    if (r.ok) return { provider: 'brevo' };
  }
  const loops = await loopsFallback({ env, cache, to, subject, html });
  if (loops.ok) return { provider: 'loops' };
  throw new Error('No email provider configured.');
}

function buildEmail({ items, name, logoUrl }) {
  const rows = (items || []).slice(0, 8).map((i) => {
    const img = i.image
      ? `<td width="64" style="padding:0 12px 0 0"><img src="${esc(i.image)}" width="56" style="width:56px;border-radius:4px;display:block"></td>`
      : '<td width="64"></td>';
    return `<tr>${img}<td style="padding:10px 0;font-family:Arial,sans-serif;color:#f4f1eb;font-size:14px;vertical-align:middle">
        <strong>${esc(i.name || i.title || 'Your item')}</strong>
      </td><td align="right" style="vertical-align:middle"><a href="${esc(reviewUrl(i))}" style="display:inline-block;background:#f4f1eb;color:#0b0b0d;text-decoration:none;font-weight:700;font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:9px 16px;border-radius:3px;white-space:nowrap">Review</a></td></tr>`;
  }).join('');
  const hi = name ? `${esc(String(name).split(' ')[0])}, ` : '';
  return `<!doctype html><html><body style="margin:0;background:#0b0b0d;font-family:Arial,Helvetica,sans-serif;color:#f4f1eb">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0d"><tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%">
        <tr><td align="center" style="padding:0 0 26px"><img src="${esc(logoUrl)}" alt="ZUWERA" width="120" style="max-width:120px"></td></tr>
        <tr><td style="font-size:24px;font-weight:800;font-style:italic;text-transform:uppercase;letter-spacing:.02em;text-align:center;padding:0 0 8px">How did we do?</td></tr>
        <tr><td style="font-size:15px;line-height:1.6;color:#cfcbc2;text-align:center;padding:0 8px 24px">${hi}your order has had a few days to settle in. A quick review (a line or two, and a photo if you've got one) helps other athletes shop with confidence.</td></tr>
        <tr><td style="padding:0 0 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid rgba(244,241,235,.12);border-bottom:1px solid rgba(244,241,235,.12)">${rows}</table></td></tr>
        <tr><td style="font-size:11px;color:#726e66;line-height:1.6;text-align:center;border-top:1px solid rgba(244,241,235,.1);padding:20px 0 0;margin-top:20px">You're receiving this because you ordered from zuwera.store. Thanks for being part of it.</td></tr>
      </table>
    </td></tr></table></body></html>`;
}

export async function onRequestPost({ request, env }) {
  try {
    const expected = env.REVIEW_REQUEST_TOKEN || '';
    const url = new URL(request.url);
    const provided = request.headers.get('x-cron-token') || url.searchParams.get('token') || '';
    if (!expected || provided !== expected) return json({ ok: false, error: 'unauthorized' }, 401);

    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return json({ ok: false, error: 'not configured' }, 500);
    const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };

    // Settings: master flag + admin-set delay (site_settings.email_settings).
    const cfg = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings?select=key,value&key=in.(feature_flags,email_settings)`, { headers: H })
      .then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const readVal = (k) => { let v = (cfg.find((x) => x.key === k) || {}).value; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } } return v; };
    const flags = readVal('feature_flags') || {};
    const emailSettings = readVal('email_settings') || {};
    const flag = flags.feature_review_requests;
    if (!flag || flag.enabled === false) return json({ ok: true, sent: 0, disabled: true }, 200);

    // Days to wait after the order before asking. Admin setting → env → default 5.
    const delayDays = Math.max(1, parseInt(emailSettings.reviewRequestDelayDays, 10) || parseInt(env.REVIEW_REQUEST_DELAY_DAYS, 10) || 5);
    const cutoff = new Date(Date.now() - delayDays * 86400 * 1000).toISOString();
    const rows = await fetch(`${env.SUPABASE_URL}/rest/v1/orders`
      + `?select=id,email,customer_name,items,created_at,status,review_requested_at`
      + `&review_requested_at=is.null&email=not.is.null&status=neq.cancelled`
      + `&created_at=lt.${encodeURIComponent(cutoff)}&order=created_at.asc&limit=100`, { headers: H })
      .then((r) => (r.ok ? r.json() : [])).catch(() => []);
    if (!rows.length) return json({ ok: true, sent: 0 }, 200);

    const cache = await fetchSiteSettings(['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM', 'BRAND_LOGO_URL', 'LOOPS_API_KEY', 'LOOPS_TRANSACTIONAL_ID'], env);
    const resendKey = resolveSetting('RESEND_API_KEY', env, cache);
    const brevoKey = resolveSetting('BREVO_API_KEY', env, cache);
    if (!resendKey && !brevoKey && !resolveSetting('LOOPS_API_KEY', env, cache)) {
      return json({ ok: false, error: 'No email provider configured (RESEND_API_KEY or BREVO_API_KEY).' }, 500);
    }
    const fromEmail = resolveSetting('EMAIL_FROM', env, cache) || 'orders@zuwera.store';
    const logoUrl = resolveSetting('BRAND_LOGO_URL', env, cache) || LOGO_FALLBACK;

    const SUBJECT = 'How was your Zuwera order?';
    const done = [];
    for (const row of rows) {
      try {
        let items = row.items;
        if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_) { items = []; } }
        if (!Array.isArray(items) || !items.length) { done.push(row.id); continue; } // nothing to review, but don't retry
        const html = buildEmail({ items, name: row.customer_name, logoUrl });
        const res = await sendEmail({ to: row.email, subject: SUBJECT, html, fromEmail, resendKey, brevoKey, env, cache });
        await logEmail(env, { type: 'review_request', recipient: row.email, subject: SUBJECT, status: 'sent', provider: res && res.provider, meta: { order_id: row.id } });
        done.push(row.id);
      } catch (_) {
        await logEmail(env, { type: 'review_request', recipient: row.email, subject: SUBJECT, status: 'failed', meta: { order_id: row.id } });
      }
    }
    if (done.length) {
      const list = done.map((id) => encodeURIComponent(id)).join(',');
      await fetch(`${env.SUPABASE_URL}/rest/v1/orders?id=in.(${list})`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ review_requested_at: new Date().toISOString() }),
      });
    }
    return json({ ok: true, sent: done.length, of: rows.length }, 200);
  } catch (e) {
    console.error('[send-review-requests]', e && e.message);
    return json({ ok: false, error: (e && e.message) || 'failed' }, 500);
  }
}
