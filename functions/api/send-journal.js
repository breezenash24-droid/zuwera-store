/**
 * Cloudflare Pages Function: POST /api/send-journal   (admin-protected)
 *
 * Emails a published journal post to every subscribed newsletter subscriber,
 * as a formatted HTML email, using the same Resend → Brevo → Loops ladder as the
 * other transactional emails. Each email carries a one-click unsubscribe link.
 *
 * Body: { accessToken, postId }
 */

import { cors, json, verifyAdmin } from './_commerce.js';
import { fetchSiteSettings, resolveSetting } from './_settings.js';
import { loopsFallback } from './_email.js';

const SITE = 'https://zuwera.store';
const LOGO_FALLBACK = 'https://zuwera.store/assets/Zuwera_Wordmark_White.png';
const MAX_RECIPIENTS = 500; // stay well under the platform subrequest ceiling

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}
function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function bodyToParagraphs(body) {
  return String(body || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#d7d3ca">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

async function sendEmail({ to, subject, html, fromEmail, replyTo, resendKey, brevoKey, env, cache }) {
  if (resendKey) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Zuwera Journal <${fromEmail}>`, to: [to], reply_to: replyTo, subject, html }),
    });
    if (r.ok) return { provider: 'resend' };
  }
  if (brevoKey) {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: { name: 'Zuwera Journal', email: fromEmail }, to: [{ email: to }], replyTo: { email: replyTo }, subject, htmlContent: html }),
    });
    if (r.ok) return { provider: 'brevo' };
  }
  const loops = await loopsFallback({ env, cache, to, subject, html });
  if (loops.ok) return { provider: 'loops' };
  throw new Error('No email provider configured.');
}

function buildJournalEmail({ post, label, logoUrl, unsubUrl }) {
  const url = `${SITE}/journal.html?slug=${encodeURIComponent(post.slug)}`;
  const date = (post.published_at || post.created_at)
    ? new Date(post.published_at || post.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : '';
  const cover = post.cover_image
    ? `<tr><td style="padding:0 0 26px"><img src="${esc(post.cover_image)}" alt="" width="520" style="width:100%;max-width:520px;border-radius:6px;display:block"></td></tr>` : '';
  return `<!doctype html><html><body style="margin:0;background:#09090b;font-family:Arial,Helvetica,sans-serif;color:#f4f1eb">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#09090b"><tr><td align="center" style="padding:36px 16px">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%">
        <tr><td align="center" style="padding:0 0 28px"><img src="${esc(logoUrl)}" alt="ZUWERA" width="128" style="max-width:128px"></td></tr>
        <tr><td align="center" style="font-size:11px;letter-spacing:.26em;text-transform:uppercase;color:#8b877e;padding:0 0 14px">${esc(label || 'The Journal')}</td></tr>
        ${cover}
        <tr><td style="font-size:30px;line-height:1.05;font-weight:800;font-style:italic;text-transform:uppercase;letter-spacing:.01em;padding:0 0 8px">${esc(post.title)}</td></tr>
        ${date ? `<tr><td style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#8b877e;padding:0 0 26px">${esc(date)}</td></tr>` : '<tr><td style="height:18px"></td></tr>'}
        <tr><td style="padding:0 0 8px">${bodyToParagraphs(post.body)}</td></tr>
        <tr><td align="left" style="padding:16px 0 34px"><a href="${esc(url)}" style="display:inline-block;background:#f4f1eb;color:#09090b;text-decoration:none;font-weight:700;font-size:12px;letter-spacing:.14em;text-transform:uppercase;padding:14px 34px;border-radius:3px">Read on the site</a></td></tr>
        <tr><td style="font-size:11px;color:#6f6b63;line-height:1.7;text-align:center;border-top:1px solid rgba(244,241,235,.1);padding:20px 0 0">
          You're receiving this because you subscribed to the Zuwera journal.<br>
          <a href="${esc(unsubUrl)}" style="color:#8b877e;text-decoration:underline">Unsubscribe</a>
        </td></tr>
      </table>
    </td></tr></table></body></html>`;
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  try {
    const authHeader = request.headers.get('Authorization') || '';
    const body = await request.json().catch(() => ({}));
    const accessToken = String(body.accessToken || authHeader.replace(/^Bearer\s+/i, '') || '').trim();
    if (!accessToken) return json({ ok: false, error: 'Missing access token' }, 401, cors(env));

    const admin = await verifyAdmin(env, accessToken);
    if (!admin) return json({ ok: false, error: 'Admin access required' }, 403, cors(env));

    const postId = String(body.postId || '').trim();
    if (!postId) return json({ ok: false, error: 'Missing postId' }, 400, cors(env));

    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return json({ ok: false, error: 'Supabase not configured' }, 500, cors(env));
    const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };

    // The post (must be published).
    const postRows = await fetch(`${env.SUPABASE_URL}/rest/v1/journal_posts?select=*&id=eq.${encodeURIComponent(postId)}&limit=1`, { headers: H, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const post = postRows && postRows[0];
    if (!post) return json({ ok: false, error: 'Post not found' }, 404, cors(env));
    if (post.status !== 'published') return json({ ok: false, error: 'Publish the post before emailing it.' }, 400, cors(env));

    // Subscribers.
    const subs = await fetch(`${env.SUPABASE_URL}/rest/v1/newsletter_subscribers?select=email,unsub_token&status=eq.subscribed&order=created_at.asc&limit=${MAX_RECIPIENTS}`, { headers: H, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : [])).catch(() => []);
    if (!subs.length) return json({ ok: true, sent: 0, of: 0, note: 'No subscribers yet.' }, 200, cors(env));

    // Email config + journal label.
    const cache = await fetchSiteSettings(['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM', 'BRAND_LOGO_URL', 'LOOPS_API_KEY', 'LOOPS_TRANSACTIONAL_ID', 'journal_settings'], env);
    const resendKey = resolveSetting('RESEND_API_KEY', env, cache);
    const brevoKey = resolveSetting('BREVO_API_KEY', env, cache);
    if (!resendKey && !brevoKey && !resolveSetting('LOOPS_API_KEY', env, cache)) {
      return json({ ok: false, error: 'No email provider configured (set RESEND_API_KEY or BREVO_API_KEY in Admin → APIs).' }, 500, cors(env));
    }
    const fromEmail = resolveSetting('EMAIL_FROM', env, cache) || 'orders@zuwera.store';
    const logoUrl = resolveSetting('BRAND_LOGO_URL', env, cache) || LOGO_FALLBACK;
    let js = resolveSetting('journal_settings', env, cache);
    if (typeof js === 'string') { try { js = JSON.parse(js); } catch (_) { js = null; } }
    const label = (js && js.label) || 'The Journal';
    const subject = post.title || 'From the Zuwera journal';

    let sent = 0;
    for (const sub of subs) {
      try {
        const unsubUrl = `${SITE}/api/unsubscribe?token=${encodeURIComponent(sub.unsub_token)}`;
        const html = buildJournalEmail({ post, label, logoUrl, unsubUrl });
        await sendEmail({ to: sub.email, subject, html, fromEmail, replyTo: fromEmail, resendKey, brevoKey, env, cache });
        sent += 1;
      } catch (_) { /* skip failures, keep going */ }
    }

    return json({ ok: true, sent, of: subs.length }, 200, cors(env));
  } catch (e) {
    console.error('[send-journal]', e && e.message);
    return json({ ok: false, error: (e && e.message) || 'failed' }, 500, cors(env));
  }
}
