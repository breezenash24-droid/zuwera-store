/**
 * Cloudflare Pages Function: /api/shippo-webhook
 *
 * Receives Shippo track_updated webhook events and sends
 * "Your order shipped!" / "Your order was delivered!" emails
 * plus optional SMS via Twilio (if customer opted in).
 *
 * Required env vars (set in CF Pages > Settings > Variables & Secrets):
 *   SHIPPO_WEBHOOK_SECRET    — from Shippo Dashboard > Webhooks > your endpoint > Secret Token
 *   RESEND_API_KEY           — primary email
 *   BREVO_API_KEY            — email fallback
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)
 *
 * Optional:
 *   TWILIO_ACCOUNT_SID       — for SMS notifications
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER       — your Twilio phone number e.g. +15551234567
 *   EMAIL_FROM               — sender address (default: orders@zuwera.store)
 *   BRAND_LOGO_URL
 *
 * Register in Shippo Dashboard > Webhooks:
 *   URL:    https://zuwera.store/api/shippo-webhook
 *   Events: track_updated
 */

import { fetchSiteSettings, resolveSetting } from './_settings.js';

const LOGO_FALLBACK = 'https://zuwera.store/assets/Zuwera_Wordmark_White.png';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ─── Signature verification ────────────────────────────────────────────────────
// Shippo sends HMAC-SHA256(rawBody, secret) in the X-Shippo-Signature header.

async function verifyShippoSignature(rawBody, signature, secret) {
  if (!secret || !signature) return !secret; // no secret configured → skip verification
  try {
    const enc      = new TextEncoder();
    const key      = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sigBytes = hexToBytes(signature);
    return await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(rawBody));
  } catch (_) { return false; }
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

// ─── Supabase helpers ──────────────────────────────────────────────────────────

function sbKey(env) { return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || ''; }

async function fetchOrderByTracking(trackingNumber, env) {
  const key = sbKey(env);
  if (!env.SUPABASE_URL || !key || !trackingNumber) return null;
  try {
    const resp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/orders?tracking_number=eq.${encodeURIComponent(trackingNumber)}&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!resp.ok) return null;
    const rows = await resp.json();
    return rows?.[0] || null;
  } catch (_) { return null; }
}

async function markOrderStatus(orderId, fulfillmentStatus, env) {
  const key = sbKey(env);
  if (!env.SUPABASE_URL || !key || !orderId) return;
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}`, {
      method:  'PATCH',
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({ fulfillment_status: fulfillmentStatus }),
    });
  } catch (_) { /* non-fatal */ }
}

// ─── Email sending (Resend → Brevo fallback) ───────────────────────────────────

async function sendEmail({ to, toName, subject, html, fromEmail, resendKey, brevoKey }) {
  const resendResp = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:     `Zuwera <${fromEmail}>`,
      to:       [to],
      reply_to: 'orders@zuwera.store',
      subject,
      html,
    }),
  });
  if (resendResp.ok) { console.log('Email sent via Resend to', to); return 'resend'; }

  const resendErr = resendResp.status + ': ' + await resendResp.text().catch(() => '');
  console.warn('Resend failed (' + resendErr + '), trying Brevo…');

  if (!brevoKey) throw new Error('Resend error ' + resendErr + ' — no BREVO_API_KEY for fallback');

  const brevoResp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method:  'POST',
    headers: { 'api-key': brevoKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender:      { name: 'Zuwera', email: fromEmail },
      to:          [{ email: to, name: toName }],
      replyTo:     { email: 'orders@zuwera.store' },
      subject,
      htmlContent: html,
    }),
  });
  if (!brevoResp.ok) {
    const brevoErr = brevoResp.status + ': ' + await brevoResp.text().catch(() => '');
    throw new Error('Both providers failed. Resend: ' + resendErr + ' | Brevo: ' + brevoErr);
  }
  console.log('Email sent via Brevo to', to);
  return 'brevo';
}

// ─── SMS via Twilio ────────────────────────────────────────────────────────────

async function sendSms({ to, body, accountSid, authToken, fromNumber }) {
  if (!accountSid || !authToken || !fromNumber || !to) return;
  try {
    const creds = btoa(`${accountSid}:${authToken}`);
    const resp  = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method:  'POST',
        headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({ To: to, From: fromNumber, Body: body }).toString(),
      }
    );
    if (resp.ok) { console.log('SMS sent via Twilio to', to); }
    else { console.warn('Twilio SMS failed:', resp.status, await resp.text().catch(() => '')); }
  } catch (e) { console.warn('Twilio SMS error:', e.message); }
}

// ─── Email templates ───────────────────────────────────────────────────────────

function shippedEmail({ orderId, customerName, carrier, trackingNumber, trackingUrl, eta, logoUrl }) {
  const etaLine = eta
    ? `<p style="margin:12px 0 0;font-size:.85rem;color:#666">Estimated delivery: <strong>${new Date(eta).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</strong></p>`
    : '';
  const trackingBlock = trackingNumber
    ? `<div style="margin:20px 0;padding:16px;background:#f4f1eb;border-radius:8px;font-size:.9rem">
        <div style="font-weight:700;margin-bottom:6px">📦 Track Your Order</div>
        <div>Carrier: <strong>${carrier}</strong></div>
        <div style="margin-top:4px">Tracking #: ${trackingUrl
          ? `<a href="${trackingUrl}" style="color:#F891A5">${trackingNumber}</a>`
          : `<strong>${trackingNumber}</strong>`}</div>
       </div>`
    : '';

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f1eb;font-family:'DM Sans',Helvetica,Arial,sans-serif;color:#09090b">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:100%">
        <tr><td style="background:#09090b;padding:24px 36px;text-align:left">
          <img src="${logoUrl}" alt="Zuwera" height="36" style="height:36px;width:auto;display:block;border:0;"
               onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
          <span style="display:none;font-family:Georgia,serif;font-size:1.5rem;letter-spacing:.12em;color:#f4f1eb;font-weight:normal">ZUWERA</span>
        </td></tr>
        <tr><td style="padding:32px 36px">
          <h2 style="margin:0 0 8px;font-size:1.3rem">🚀 Your order is on its way!</h2>
          <p style="margin:0 0 20px;color:#666;font-size:.9rem">Order #${orderId} — Hey ${customerName}, your Zuwera order has shipped!</p>
          ${trackingBlock}
          ${etaLine}
        </td></tr>
        <tr><td style="background:#f4f1eb;padding:20px 36px;font-size:.78rem;color:#888;text-align:center">
          Questions? Reply to this email or visit <a href="https://zuwera.store" style="color:#F891A5">zuwera.store</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function deliveredEmail({ orderId, customerName, logoUrl }) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f1eb;font-family:'DM Sans',Helvetica,Arial,sans-serif;color:#09090b">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:100%">
        <tr><td style="background:#09090b;padding:24px 36px;text-align:left">
          <img src="${logoUrl}" alt="Zuwera" height="36" style="height:36px;width:auto;display:block;border:0;"
               onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
          <span style="display:none;font-family:Georgia,serif;font-size:1.5rem;letter-spacing:.12em;color:#f4f1eb;font-weight:normal">ZUWERA</span>
        </td></tr>
        <tr><td style="padding:32px 36px">
          <h2 style="margin:0 0 8px;font-size:1.3rem">✅ Delivered!</h2>
          <p style="margin:0 0 20px;color:#666;font-size:.9rem">Order #${orderId} — Great news, ${customerName}! Your Zuwera order has been delivered.</p>
          <p style="margin:0 0 24px;font-size:.9rem;color:#444">We hope you love it. If anything is off, we've got you — head to your account to start a return or exchange.</p>
          <a href="https://zuwera.store/account.html" style="display:inline-block;padding:12px 24px;background:#09090b;color:#f4f1eb;text-decoration:none;border-radius:6px;font-size:.85rem;letter-spacing:.06em;text-transform:uppercase">My Account</a>
        </td></tr>
        <tr><td style="background:#f4f1eb;padding:20px 36px;font-size:.78rem;color:#888;text-align:center">
          Loving Zuwera? Leave a review — it means the world to us.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Entry point ───────────────────────────────────────────────────────────────

export async function onRequestPost({ request, env }) {
  const rawBody = await request.text();
  const sig     = request.headers.get('X-Shippo-Signature') || '';
  const cache   = await fetchSiteSettings(
    ['RESEND_API_KEY', 'BREVO_API_KEY', 'SHIPPO_WEBHOOK_SECRET', 'EMAIL_FROM', 'BRAND_LOGO_URL',
     'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'], env
  );

  const webhookSecret = resolveSetting('SHIPPO_WEBHOOK_SECRET', env, cache);

  // Verify signature if secret is configured
  if (webhookSecret) {
    const valid = await verifyShippoSignature(rawBody, sig, webhookSecret);
    if (!valid) {
      console.error('Shippo webhook signature invalid');
      return json({ error: 'Invalid signature' }, 401);
    }
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch (_) { return json({ error: 'Invalid JSON' }, 400); }

  const event   = payload.event;
  const data    = payload.data || {};
  const status  = data.tracking_status?.status || '';  // TRANSIT, DELIVERED, etc.
  const trackNo = data.tracking_number || '';
  const carrier = data.carrier_name || data.carrier || 'your carrier';
  const eta     = data.eta || null;

  // Only handle shipping tracking events
  if (event !== 'track_updated') {
    return json({ received: true, skipped: 'not track_updated' });
  }

  // Only act on first TRANSIT (= shipped) and DELIVERED
  if (status !== 'TRANSIT' && status !== 'DELIVERED') {
    console.log('Ignoring non-actionable status:', status);
    return json({ received: true, skipped: `status ${status} not actionable` });
  }

  // Look up order in Supabase by tracking number
  const order = await fetchOrderByTracking(trackNo, env);
  if (!order) {
    console.warn('No order found for tracking number:', trackNo);
    return json({ received: true, skipped: 'order not found' });
  }

  // Deduplicate — don't send same notification twice
  const alreadyDone =
    (status === 'TRANSIT'   && order.fulfillment_status === 'shipped')   ||
    (status === 'DELIVERED' && order.fulfillment_status === 'delivered');
  if (alreadyDone) {
    return json({ received: true, skipped: 'notification already sent' });
  }

  const customerEmail = order.customer_email || '';
  const customerName  = order.customer_name  || 'Customer';
  const orderId       = (order.id || '').toString().slice(-8).toUpperCase() || 'ZUWERA';
  const trackingUrl   = data.tracking_url_provider || data.tracking_status?.tracking_url || '';
  const smsPhone      = order.sms_phone || order.phone || '';
  const smsConsent    = order.sms_consent === true || order.sms_consent === 'true';

  const resendKey  = resolveSetting('RESEND_API_KEY',       env, cache);
  const brevoKey   = resolveSetting('BREVO_API_KEY',        env, cache);
  const fromEmail  = resolveSetting('EMAIL_FROM',           env, cache) || 'orders@zuwera.store';
  const logoUrl    = resolveSetting('BRAND_LOGO_URL',       env, cache) || LOGO_FALLBACK;
  const twilioSid  = resolveSetting('TWILIO_ACCOUNT_SID',   env, cache);
  const twilioAuth = resolveSetting('TWILIO_AUTH_TOKEN',    env, cache);
  const twilioFrom = resolveSetting('TWILIO_FROM_NUMBER',   env, cache);

  // ── Shipped ────────────────────────────────────────────────────────────────
  if (status === 'TRANSIT') {
    const subject = `Your Zuwera order #${orderId} is on its way! 🚀`;
    const html    = shippedEmail({ orderId, customerName, carrier, trackingNumber: trackNo, trackingUrl, eta, logoUrl });

    const [emailR, smsR] = await Promise.allSettled([
      customerEmail && resendKey
        ? sendEmail({ to: customerEmail, toName: customerName, subject, html, fromEmail, resendKey, brevoKey })
        : Promise.resolve('skipped — no email or key'),

      smsConsent && smsPhone
        ? sendSms({
            to: smsPhone,
            body: `Zuwera: Order #${orderId} shipped via ${carrier}! Track: ${trackingUrl || trackNo}`,
            accountSid: twilioSid, authToken: twilioAuth, fromNumber: twilioFrom,
          })
        : Promise.resolve('skipped — no consent/phone'),
    ]);

    await markOrderStatus(order.id, 'shipped', env);

    if (emailR.status === 'rejected') console.error('Shipped email failed:', emailR.reason?.message);
    if (smsR.status   === 'rejected') console.error('Shipped SMS failed:',   smsR.reason?.message);

    return json({ received: true, action: 'shipped_notification', orderId });
  }

  // ── Delivered ──────────────────────────────────────────────────────────────
  if (status === 'DELIVERED') {
    const subject = `Your Zuwera order #${orderId} has been delivered ✅`;
    const html    = deliveredEmail({ orderId, customerName, logoUrl });

    const [emailR, smsR] = await Promise.allSettled([
      customerEmail && resendKey
        ? sendEmail({ to: customerEmail, toName: customerName, subject, html, fromEmail, resendKey, brevoKey })
        : Promise.resolve('skipped'),

      smsConsent && smsPhone
        ? sendSms({
            to: smsPhone,
            body: `Zuwera: Order #${orderId} delivered! Hope you love it 🎉 zuwera.store`,
            accountSid: twilioSid, authToken: twilioAuth, fromNumber: twilioFrom,
          })
        : Promise.resolve('skipped'),
    ]);

    await markOrderStatus(order.id, 'delivered', env);

    if (emailR.status === 'rejected') console.error('Delivered email failed:', emailR.reason?.message);
    if (smsR.status   === 'rejected') console.error('Delivered SMS failed:',   smsR.reason?.message);

    return json({ received: true, action: 'delivered_notification', orderId });
  }

  return json({ received: true });
}
