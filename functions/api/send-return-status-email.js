/**
 * Cloudflare Pages Function: POST /api/send-return-status-email
 *
 * Admin-protected. Sends a status-update email to the customer for a
 * given return request. Email content automatically adapts to the current
 * status (requested, approved, label_sent, received, refunded, etc.) and
 * includes the admin's "Message to Customer" note, label/tracking links,
 * and a clear explanation of what happens next.
 *
 * Body: { returnId }
 */

import { fetchSiteSettings, resolveSetting } from './_settings.js';
import { cors, json, verifyAdmin, getCommerceBundle } from './_commerce.js';

const LOGO_FALLBACK = 'https://zuwera.store/assets/Zuwera_Wordmark_White.png';

// ─── Status copy ──────────────────────────────────────────────────────────────

function statusHeadline(status, resolution) {
  const res = resolution === 'exchange' ? 'Exchange' : resolution === 'store_credit' ? 'Store Credit' : 'Return';
  switch (status) {
    case 'requested':           return `We Received Your ${res} Request`;
    case 'approved':            return `Your ${res} Has Been Approved`;
    case 'label_sent':          return 'Your Prepaid Return Label Is Ready';
    case 'received':            return `We Received Your ${res}`;
    case 'inspecting':          return 'Your Return Is Being Inspected';
    case 'exchange_in_progress':return 'Your Exchange Is Being Processed';
    case 'refunded':            return 'Your Refund Has Been Issued';
    case 'store_credit_issued': return 'Store Credit Has Been Applied';
    case 'completed':           return `Your ${res} Is Complete`;
    case 'denied':              return 'Return Request Update';
    case 'closed':              return 'Return Request Closed';
    default:                    return 'Return Request Update';
  }
}

function statusBody(status, resolution, r) {
  const resolutionWord = resolution === 'exchange' ? 'exchange' : resolution === 'store_credit' ? 'store credit' : 'refund';
  const hasLabel = Boolean(r.labelUrl || r.trackingNumber);

  switch (status) {
    case 'requested':
      return `We've received your ${resolutionWord} request for <strong>${r.orderLabel || 'your order'}</strong>. Our team will review it within 1–2 business days and follow up with next steps.`;

    case 'approved':
      return hasLabel
        ? `Your return request has been approved. We've generated a prepaid shipping label for you — just print it out and drop your package off at any ${r.carrier || 'carrier'} location.`
        : `Great news — your ${resolutionWord} request for <strong>${r.orderLabel || 'your order'}</strong> has been approved! We're generating your prepaid return shipping label and will send it shortly.`;

    case 'label_sent':
      return `Your return request has been approved and your prepaid shipping label is ready. Print it, attach it to your securely packed item, and drop it off at any ${r.carrier || 'carrier'} location. No postage needed.`;

    case 'received':
      return `Great news — we've received your return for <strong>${r.orderLabel || 'your order'}</strong>. We're processing your ${resolutionWord} now and will update you as soon as it's complete.`;

    case 'inspecting':
      return `We've received your return for <strong>${r.orderLabel || 'your order'}</strong> and our team is currently inspecting the item. We'll update you shortly once the inspection is complete.`;

    case 'exchange_in_progress':
      return `We've received your return and your replacement item is being prepared. We'll send a shipping confirmation with tracking once it's on its way.`;

    case 'refunded':
      return `Your refund${r.orderTotal ? ` of <strong>$${Number(r.orderTotal).toFixed(2)}</strong>` : ''} has been processed back to your original payment method. Depending on your bank, it may take 3–7 business days to appear on your statement.`;

    case 'store_credit_issued':
      return `Your store credit${r.orderTotal ? ` of <strong>$${Number(r.orderTotal).toFixed(2)}</strong>` : ''} has been applied to your Zuwera account. You can use it on any future order.`;

    case 'completed':
      return `Your ${resolutionWord} for <strong>${r.orderLabel || 'your order'}</strong> has been fully processed. Thank you for shopping with us — we hope to see you again soon.`;

    case 'denied':
      return `After reviewing your return request for <strong>${r.orderLabel || 'your order'}</strong>, we're unfortunately unable to process it at this time.${r.customerMessage ? '' : ' If you have questions, please don\'t hesitate to reply to this email.'}`;

    case 'closed':
      return `Your return request for <strong>${r.orderLabel || 'your order'}</strong> has been closed. If you believe this was in error or have additional questions, please reply to this email.`;

    default:
      return `Here's an update on your return request for <strong>${r.orderLabel || 'your order'}</strong>.`;
  }
}

function nextStepsHtml(status, resolution, r) {
  const resolutionWord = resolution === 'exchange' ? 'exchange' : resolution === 'store_credit' ? 'store credit' : 'refund';
  const steps = [];

  switch (status) {
    case 'requested':
      steps.push('Our team reviews your request (1–2 business days)');
      steps.push('If approved, we send you a prepaid shipping label');
      steps.push(`You ship the item back — we process your ${resolutionWord}`);
      break;
    case 'approved':
      if (!r.labelUrl && !r.trackingNumber) {
        steps.push('We\'re generating your prepaid return label');
        steps.push('You\'ll receive another email with the label attached');
        steps.push(`Once we receive the item, we process your ${resolutionWord}`);
      } else {
        steps.push('Print and attach the label to your package');
        steps.push(`Drop it off at any ${r.carrier || 'carrier'} location`);
        steps.push(`We process your ${resolutionWord} within 3–5 business days of receipt`);
      }
      break;
    case 'label_sent':
      steps.push('Print the label and attach it to your package');
      steps.push(`Drop it off at any ${r.carrier || 'carrier'} location`);
      steps.push(`We'll process your ${resolutionWord} within 3–5 business days of receiving the item`);
      break;
    case 'received':
    case 'inspecting':
      steps.push('We inspect the returned item');
      steps.push(`We process your ${resolutionWord}`);
      steps.push('You\'ll receive a confirmation email once it\'s done');
      break;
    case 'exchange_in_progress':
      steps.push('We prepare and ship your replacement item');
      steps.push('You receive a shipping confirmation with tracking');
      break;
    default:
      return '';
  }

  if (!steps.length) return '';
  return `
    <div style="margin:20px 0;background:rgba(244,241,235,.04);border:1px solid rgba(244,241,235,.1);border-radius:8px;padding:18px 20px;">
      <p style="margin:0 0 12px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:rgba(244,241,235,.35);">What Happens Next</p>
      ${steps.map((s, i) => `
        <div style="display:flex;gap:12px;align-items:flex-start;${i < steps.length - 1 ? 'margin-bottom:10px;' : ''}">
          <div style="width:20px;height:20px;border-radius:50%;background:#38bdf8;color:#000;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;">${i + 1}</div>
          <div style="font-size:13px;color:rgba(244,241,235,.7);line-height:1.5;">${s}</div>
        </div>`).join('')}
    </div>`;
}

function labelSectionHtml(r) {
  if (!r.labelUrl && !r.trackingNumber) return '';
  const carrierLabel = [r.carrier, r.service].filter(Boolean).join(' — ');
  return `
    <div style="margin:20px 0;">
      <table width="100%" style="border:1px solid rgba(244,241,235,.1);border-radius:8px;overflow:hidden;border-collapse:collapse;">
        ${r.labelUrl ? `
        <tr><td style="padding:14px 20px;border-bottom:1px solid rgba(244,241,235,.08);">
          <p style="margin:0 0 3px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:rgba(244,241,235,.35);">Return Label</p>
          <a href="${r.labelUrl}" style="color:#38bdf8;font-size:14px;font-weight:600;text-decoration:underline;">Download Label (PDF)</a>
        </td></tr>` : ''}
        ${r.trackingNumber ? `
        <tr><td style="padding:14px 20px;border-bottom:1px solid rgba(244,241,235,.08);">
          <p style="margin:0 0 3px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:rgba(244,241,235,.35);">Tracking Number</p>
          <p style="margin:0;font-size:14px;color:#f4f1eb;font-family:monospace;">${r.trackingNumber}</p>
        </td></tr>` : ''}
        ${carrierLabel ? `
        <tr><td style="padding:14px 20px;border-bottom:1px solid rgba(244,241,235,.08);">
          <p style="margin:0 0 3px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:rgba(244,241,235,.35);">Carrier</p>
          <p style="margin:0;font-size:14px;color:#f4f1eb;">${carrierLabel}</p>
        </td></tr>` : ''}
        ${r.trackingUrl ? `
        <tr><td style="padding:14px 20px;" align="center">
          <a href="${r.trackingUrl}" style="display:inline-block;background:#38bdf8;color:#000;padding:10px 28px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;text-decoration:none;border-radius:6px;">Track Your Return</a>
        </td></tr>` : ''}
      </table>
    </div>`;
}

function buildEmail({ r, status, resolution, fromFirstName, logoUrl }) {
  const headline = statusHeadline(status, resolution);
  const bodyText = statusBody(status, resolution, r);
  const nextSteps = nextStepsHtml(status, resolution, r);
  const labelSec  = labelSectionHtml(r);
  const adminMsg  = (r.customerMessage || '').trim();
  const orderLabel = r.orderLabel || ('#' + String(r.orderId || '').slice(-8).toUpperCase());
  const resolutionDisplay = resolution === 'exchange' ? 'Exchange' : resolution === 'store_credit' ? 'Store Credit' : 'Return / Refund';

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f1eb;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1eb;padding:40px 0">
  <tr><td align="center">
    <table width="100%" style="max-width:560px;background:#09090b;border-collapse:collapse">

      <!-- Header -->
      <tr><td style="padding:24px 36px;text-align:left;background:#09090b;">
        <img src="${logoUrl}" alt="Zuwera" height="36" style="height:36px;width:auto;display:block;border:0"
             onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
        <span style="display:none;font-family:Georgia,serif;font-size:1.5rem;letter-spacing:.12em;color:#f4f1eb;">ZUWERA</span>
      </td></tr>

      <!-- Status bar -->
      <tr><td style="padding:0 36px 0;background:#09090b;">
        <div style="border-top:2px solid #38bdf8;padding-top:20px;">
          <p style="margin:0 0 4px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:rgba(244,241,235,.35);">${orderLabel} · ${resolutionDisplay}</p>
          <h2 style="margin:0 0 6px;font-family:Georgia,serif;font-size:22px;letter-spacing:.04em;color:#f4f1eb;">${headline}</h2>
        </div>
      </td></tr>

      <!-- Body -->
      <tr><td style="padding:20px 36px 0;background:#09090b;font-size:14px;line-height:1.75;color:rgba(244,241,235,.7);">
        <p style="margin:0 0 16px">Hi ${fromFirstName},</p>
        <p style="margin:0 0 16px">${bodyText}</p>

        ${labelSec}
        ${nextSteps}

        ${adminMsg ? `
        <div style="margin:20px 0;padding:16px 20px;border-left:3px solid #38bdf8;background:rgba(56,189,248,.06);">
          <p style="margin:0 0 6px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:rgba(244,241,235,.35);">Message from Zuwera</p>
          <p style="margin:0;font-size:14px;color:rgba(244,241,235,.85);line-height:1.6;">${adminMsg.replace(/\n/g, '<br>')}</p>
        </div>` : ''}

        <p style="margin:20px 0 6px">Questions? Reply to this email or visit <a href="https://zuwera.store/returns.html" style="color:#38bdf8;">your return portal</a>.</p>
        <p style="margin:0 0 4px">Thanks,</p>
        <p style="margin:0 0 28px">The Zuwera Team</p>
      </td></tr>

      <!-- Footer -->
      <tr><td style="padding:18px 36px;background:#0a0a0c;border-top:1px solid rgba(244,241,235,.07);font-size:10px;letter-spacing:.1em;color:rgba(244,241,235,.2);text-transform:uppercase;text-align:center;">
        &copy; ${new Date().getFullYear()} Zuwera &middot;
        <a href="https://zuwera.store" style="color:rgba(244,241,235,.2);text-decoration:none">zuwera.store</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function sendEmail({ to, toName, subject, html, fromEmail, resendKey, brevoKey }) {
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
        sender:    { name: 'Zuwera', email: fromEmail },
        to:        [{ email: to, name: toName }],
        replyTo:   { email: 'orders@zuwera.store' },
        subject,
        htmlContent: html,
      }),
    });
    if (r.ok) return { provider: 'brevo' };
    throw new Error('Brevo send failed: ' + r.status);
  }
  throw new Error('No email provider configured (RESEND_API_KEY or BREVO_API_KEY required).');
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  try {
    const authHeader = request.headers.get('Authorization') || '';
    const body = await request.json().catch(() => ({}));
    const accessToken = String(body.accessToken || authHeader.replace(/^Bearer\s+/i, '') || '').trim();
    const returnId = String(body.returnId || '').trim();

    if (!accessToken) return json({ ok: false, error: 'Missing access token' }, 401, cors(env));
    if (!returnId)    return json({ ok: false, error: 'Missing returnId' }, 400, cors(env));

    const admin = await verifyAdmin(env, accessToken);
    if (!admin) return json({ ok: false, error: 'Admin access required' }, 403, cors(env));

    const bundle = await getCommerceBundle(env);
    const r = (bundle.returnsState?.requests || []).find(x => x.id === returnId);
    if (!r) return json({ ok: false, error: 'Return request not found' }, 404, cors(env));

    // Check every field name the return request might store the email under
    const toEmail = (r.customerEmail || r.userEmail || r.email || r.customer_email || '').trim();
    if (!toEmail) return json({ ok: false, error: 'No customer email found on this return request. Make sure the return was submitted by a signed-in customer.' }, 400, cors(env));

    const cache = await fetchSiteSettings(
      ['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM', 'BRAND_LOGO_URL'], env
    );
    const resendKey = resolveSetting('RESEND_API_KEY', env, cache);
    const brevoKey  = resolveSetting('BREVO_API_KEY',  env, cache);
    if (!resendKey && !brevoKey) {
      return json({ ok: false, error: 'No email provider configured. Add RESEND_API_KEY or BREVO_API_KEY in Admin → APIs.' }, 500, cors(env));
    }
    const fromEmail = resolveSetting('EMAIL_FROM', env, cache) || 'orders@zuwera.store';
    const logoUrl   = resolveSetting('BRAND_LOGO_URL', env, cache) || LOGO_FALLBACK;

    const status     = String(r.status     || 'requested').trim();
    const resolution = String(r.resolution || 'return').trim();
    const toName     = (r.customerName || 'Customer').trim();
    const fromFirstName = toName.split(' ')[0] || 'there';

    const html    = buildEmail({ r, status, resolution, fromFirstName, logoUrl });
    const subject = `${statusHeadline(status, resolution)} — ${r.orderLabel || 'Your Zuwera Return'}`;

    const result = await sendEmail({ to: toEmail, toName, subject, html, fromEmail, resendKey, brevoKey });

    return json({
      ok:       true,
      sentTo:   toEmail,
      subject,
      provider: result.provider,
    }, 200, cors(env));

  } catch (e) {
    console.error('[send-return-status-email]', e.message);
    return json({ ok: false, error: e.message || 'Could not send status email.' }, 500, cors(env));
  }
}
