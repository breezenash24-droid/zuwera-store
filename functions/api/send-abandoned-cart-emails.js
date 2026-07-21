/**
 * Cloudflare Pages Function: POST /api/send-abandoned-cart-emails
 *
 * Scheduled job (trigger it hourly from an external cron, same pattern as
 * backup-export). Finds carts abandoned > 1h ago that weren't recovered or already
 * emailed, sends a "you left something behind" email, and marks them emailed.
 *
 * Auth: shared secret in the `x-cron-token` header (or ?token=) compared to the
 * ABANDONED_CART_TOKEN function secret. With no secret set, it rejects everything.
 * Respects the feature_abandoned_cart flag (off → no sends). Reuses the same email
 * providers (Resend → Brevo → Loops) as the other transactional emails.
 */

import { json } from './_commerce.js';
import { fetchSiteSettings, resolveSetting } from './_settings.js';
import { loopsFallback } from './_email.js';
import { logEmail } from './_email-log.js';
import { getEmailAppearance, getEmailContent, fillTemplate, renderEmailShell } from './_email-theme.js';

const LOGO_FALLBACK = 'https://zuwera.store/assets/Zuwera_Wordmark_White.png';

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}
function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function money(cents) { const n = (Number(cents) || 0) / 100; return '$' + (Number.isInteger(n) ? n : n.toFixed(2)); }

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

function buildEmail({ items, url, appearance, content }) {
  const a = appearance;
  const rows = (items || []).slice(0, 8).map((i) => {
    const variant = [i.color, i.size].filter(Boolean).join(' · ');
    const img = i.image
      ? `<td width="64" style="padding:0 12px 0 0"><img src="${esc(i.image)}" width="56" style="width:56px;border-radius:4px;display:block"></td>` : '';
    return `<tr>${img}<td style="padding:8px 0;font-family:${a.fontBody};color:${a.text};font-size:14px;vertical-align:middle">
        <strong>${esc(i.title)}</strong>${variant ? `<br><span style="color:${a.muted};font-size:12px">${esc(variant)}</span>` : ''}${i.qty > 1 ? ` <span style="color:${a.muted}">× ${i.qty}</span>` : ''}
      </td><td align="right" style="font-family:${a.fontBody};color:${a.muted};font-size:14px;white-space:nowrap;vertical-align:middle">${money((i.price || 0) * 100)}</td></tr>`;
  }).join('');
  const bodyHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${a.border};border-bottom:1px solid ${a.border}">${rows}</table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:26px 0 4px"><a href="${esc(url)}" style="display:inline-block;background:${a.accent};color:#0b0b0d;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:.14em;text-transform:uppercase;padding:14px 36px;border-radius:3px;font-family:${a.fontMono}">Return to your bag</a></td></tr></table>`;
  return renderEmailShell(a, {
    kicker:  content.kicker,
    heading: content.heading,
    intro:   content.intro,
    bodyHtml,
    footer:  content.footer,
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const url = new URL(request.url);
    const provided = request.headers.get('x-cron-token') || url.searchParams.get('token') || '';
    // Token can be set in Admin → APIs (site_settings, no redeploy) or as a CF env var.
    const tokenCache = await fetchSiteSettings(['ABANDONED_CART_TOKEN'], env);
    const expected = resolveSetting('ABANDONED_CART_TOKEN', env, tokenCache);
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
    const flag = flags.feature_abandoned_cart;
    if (flag && flag.enabled === false) return json({ ok: true, sent: 0, disabled: true }, 200);

    // Delay before nudging (minutes). Admin setting → env → default 60.
    const delayMin = Math.max(15, parseInt(emailSettings.abandonedCartDelayMin, 10) || parseInt(env.ABANDONED_CART_DELAY_MIN, 10) || 60);
    const cutoff = new Date(Date.now() - delayMin * 60 * 1000).toISOString();
    const rows = await fetch(`${env.SUPABASE_URL}/rest/v1/abandoned_carts`
      + `?select=id,email,cart,item_count&recovered_at=is.null&emailed_at=is.null&item_count=gt.0`
      + `&updated_at=lt.${encodeURIComponent(cutoff)}&order=updated_at.asc&limit=100`, { headers: H })
      .then((r) => (r.ok ? r.json() : [])).catch(() => []);
    if (!rows.length) return json({ ok: true, sent: 0 }, 200);

    const cache = await fetchSiteSettings(['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM', 'BRAND_LOGO_URL', 'LOOPS_API_KEY', 'LOOPS_TRANSACTIONAL_ID', 'fonts', 'brand', 'email_theme', 'email_settings'], env);
    const resendKey = resolveSetting('RESEND_API_KEY', env, cache);
    const brevoKey = resolveSetting('BREVO_API_KEY', env, cache);
    if (!resendKey && !brevoKey && !resolveSetting('LOOPS_API_KEY', env, cache)) {
      return json({ ok: false, error: 'No email provider configured (RESEND_API_KEY or BREVO_API_KEY).' }, 500);
    }
    const fromEmail = resolveSetting('EMAIL_FROM', env, cache) || 'orders@zuwera.store';
    const logoUrl = resolveSetting('BRAND_LOGO_URL', env, cache) || LOGO_FALLBACK;
    const appearance = getEmailAppearance(cache); appearance.logo = logoUrl;
    const content = getEmailContent(cache, 'abandoned_cart');

    const SUBJECT = fillTemplate(content.subject, {});
    const sent = [];
    for (const row of rows) {
      try {
        const html = buildEmail({ items: row.cart || [], url: 'https://zuwera.store/bag.html', appearance, content });
        const res = await sendEmail({ to: row.email, subject: SUBJECT, html, fromEmail, resendKey, brevoKey, env, cache });
        await logEmail(env, { type: 'abandoned_cart', recipient: row.email, subject: SUBJECT, status: 'sent', provider: res && res.provider, meta: { cart_id: row.id } });
        sent.push(row.id);
      } catch (_) {
        await logEmail(env, { type: 'abandoned_cart', recipient: row.email, subject: SUBJECT, status: 'failed', meta: { cart_id: row.id } });
      }
    }
    if (sent.length) {
      const list = sent.map((id) => encodeURIComponent(id)).join(',');
      await fetch(`${env.SUPABASE_URL}/rest/v1/abandoned_carts?id=in.(${list})`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ emailed_at: new Date().toISOString() }),
      });
    }
    return json({ ok: true, sent: sent.length, of: rows.length }, 200);
  } catch (e) {
    console.error('[send-abandoned-cart-emails]', e && e.message);
    return json({ ok: false, error: (e && e.message) || 'failed' }, 500);
  }
}
