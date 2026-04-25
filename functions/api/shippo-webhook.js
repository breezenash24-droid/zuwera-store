/**
 * Cloudflare Pages Function: /api/shippo-webhook
 *
 * Receives tracking update events from Shippo and sends
 * "shipped" / "delivered" emails to customers via Resend → Brevo fallback.
 *
 * Environment variables (set in CF Pages Dashboard > Settings > Environment variables):
 *   SHIPPO_WEBHOOK_SECRET  — signing secret from Shippo Dashboard > Webhooks
 *   SUPABASE_URL           — Supabase project URL
 *   SUPABASE_SERVICE_KEY   — Supabase service role key
 *   RESEND_API_KEY         — primary email sender
 *   BREVO_API_KEY          — fallback email sender
 *   EMAIL_FROM             — from address (e.g. orders@zuwera.store)
 *   BRAND_LOGO_URL         — logo shown in email header
 *
 * Shippo Dashboard > Webhooks > Add endpoint:
 *   URL:    https://zuwera.store/api/shippo-webhook
 *   Events: track_updated
 *
 * After saving, copy the "Signing Secret" and add it as SHIPPO_WEBHOOK_SECRET
 * in Cloudflare Pages > Settings > Environment variables.
 */

import { fetchSiteSettings, resolveSetting } from './_settings.js';

const getSupabaseServiceKey = (env) => env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;

// ─── Shippo webhook signature verification ────────────────────────────────────
async function verifyShippoSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return true; // skip if no secret configured
  try {
    // Shippo format: "t=<timestamp>,v1=<hmac>"
    const parts = {};
    signatureHeader.split(',').forEach(part => {
      const [k, v] = part.split('=');
      parts[k] = v;
    });
    if (!parts.t || !parts.v1) return false;

    const encoder  = new TextEncoder();
    const keyData  = encoder.encode(secret);
    const msgData  = encoder.encode(`${parts.t}.${rawBody}`);
    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
    const computed = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    return computed === parts.v1;
  } catch (e) {
    console.error('Signature verification error:', e);
    return false;
  }
}

// ─── Look up order in Supabase by tracking number ────────────────────────────
async function findOrderByTracking(trackingNumber, env) {
  const url = (env.SUPABASE_URL || '').trim();
  const sk  = getSupabaseServiceKey(env);
  if (!url || !sk || !trackingNumber) return null;
  try {
    const resp = await fetch(
      `${url}/rest/v1/orders?tracking_number=eq.${encodeURIComponent(trackingNumber)}&limit=1`,
      { headers: { apikey: sk, Authorization: `Bearer ${sk}` } }
    );
    if (!resp.ok) return null;
    const rows = await resp.json();
    return rows?.[0] || null;
  } catch (e) {
    console.error('Supabase order lookup failed:', e);
    return null;
  }
}

// ─── Update order status in Supabase ─────────────────────────────────────────
async function updateOrderStatus(orderId, status, env) {
  const url = (env.SUPABASE_URL || '').trim();
  const sk  = getSupabaseServiceKey(env);
  if (!url || !sk || !orderId) return;
  try {
    await fetch(
      `${url}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`,
      {
        method:  'PATCH',
        headers: {
          apikey:          sk,
          Authorization:   `Bearer ${sk}`,
          'Content-Type':  'application/json',
          Prefer:          'return=minimal',
        },
        body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
      }
    );
  } catch (e) {
    console.error('Supabase order status update failed:', e);
  }
}

// ─── Build tracking email HTML ────────────────────────────────────────────────
function buildTrackingEmail({ event, order, trackingData, logoUrl }) {
  const { trackingNumber, trackingUrl, carrier, statusDetails, eta, location } = trackingData;
  const toName   = order.customer_name || 'Customer';
  const orderId  = (order.stripe_payment_intent_id || order.id || '').slice(-8).toUpperCase();
  const etaStr   = eta ? new Date(eta).toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' }) : null;
  const locStr   = location ? [location.city, location.state].filter(Boolean).join(', ') : null;

  const isDelivered = event === 'DELIVERED';
  const headline    = isDelivered ? 'Your order has been delivered 📦' : 'Your order is on its way ✈️';
  const subline     = isDelivered
    ? `Order #${orderId} has been delivered. We hope you love it!`
    : `Order #${orderId} is in transit. Here's the latest update.`;

  const trackingLink = trackingUrl
    ? `<a href="${trackingUrl}" style="display:inline-block;margin-top:16px;padding:12px 28px;background:#09090b;color:#f4f1eb;text-decoration:none;font-size:.8rem;letter-spacing:.12em;text-transform:uppercase;">Track Package ↗</a>`
    : `<p style="margin:8px 0 0;font-size:.85rem;color:#555;"><strong>Tracking #:</strong> ${trackingNumber}</p>`;

  return `
<!DOCTYPE html>
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
        <tr><td style="padding:36px 36px 28px">
          <h2 style="margin:0 0 8px;font-size:1.15rem;font-weight:700">${headline}</h2>
          <p style="margin:0 0 28px;color:#666;font-size:.9rem">${subline}</p>

          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f8f6;border-radius:8px;padding:20px;margin-bottom:24px">
            <tr>
              <td style="padding:6px 20px;vertical-align:top">
                <p style="margin:0 0 4px;font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;color:#999">Carrier</p>
                <p style="margin:0;font-size:.9rem;font-weight:600;text-transform:uppercase">${carrier || 'Carrier'}</p>
              </td>
              ${etaStr ? `<td style="padding:6px 20px;vertical-align:top;border-left:1px solid #eee">
                <p style="margin:0 0 4px;font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;color:#999">${isDelivered ? 'Delivered' : 'Estimated Delivery'}</p>
                <p style="margin:0;font-size:.9rem;font-weight:600">${etaStr}</p>
              </td>` : ''}
              ${locStr ? `<td style="padding:6px 20px;vertical-align:top;border-left:1px solid #eee">
                <p style="margin:0 0 4px;font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;color:#999">Last Location</p>
                <p style="margin:0;font-size:.9rem;font-weight:600">${locStr}</p>
              </td>` : ''}
            </tr>
          </table>

          ${statusDetails ? `<p style="margin:0 0 20px;font-size:.85rem;color:#555;line-height:1.6">${statusDetails}</p>` : ''}

          <div style="text-align:center;padding:4px 0 8px">
            ${trackingLink}
          </div>
        </td></tr>
        <tr><td style="background:#f4f1eb;padding:20px 36px;font-size:.78rem;color:#888;text-align:center">
          Questions? Reply to this email or visit <a href="https://zuwera.store" style="color:#09090b">zuwera.store</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Send email via Resend → Brevo fallback ───────────────────────────────────
async function sendEmail({ to, subject, html, fromEmail, resendKey, brevoKey }) {
  // Try Resend first
  if (resendKey) {
    const resp = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Zuwera <${fromEmail}>`, to: [to], reply_to: fromEmail, subject, html }),
    });
    if (resp.ok) { console.log('Tracking email sent via Resend to', to); return { provider: 'resend' }; }
    console.warn('Resend failed:', resp.status, '— trying Brevo…');
  }

  // Brevo fallback
  if (brevoKey) {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method:  'POST',
      headers: { 'api-key': brevoKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender:   { name: 'Zuwera', email: fromEmail },
        to:       [{ email: to }],
        replyTo:  { email: fromEmail },
        subject,
        htmlContent: html,
      }),
    });
    if (resp.ok) { console.log('Tracking email sent via Brevo to', to); return { provider: 'brevo' }; }
    console.error('Brevo also failed:', resp.status);
  }

  throw new Error('No working email provider available');
}

// ─── Entry point ──────────────────────────────────────────────────────────────
export async function onRequestPost({ request, env }) {
  const rawBody = await request.text();
  const sigHeader = request.headers.get('shippo-signature') || '';

  // Verify signature (non-fatal if secret not configured — logs warning)
  const secret = (env.SHIPPO_WEBHOOK_SECRET || '').trim();
  if (secret) {
    const valid = await verifyShippoSignature(rawBody, sigHeader, secret);
    if (!valid) {
      console.error('Shippo webhook signature invalid — rejected');
      return new Response('Unauthorized', { status: 401 });
    }
  } else {
    console.warn('SHIPPO_WEBHOOK_SECRET not set — skipping signature verification');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return new Response('Bad JSON', { status: 400 });
  }

  // Only handle track_updated events
  if (payload.event !== 'track_updated') {
    return new Response(JSON.stringify({ ok: true, skipped: 'not track_updated' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  const data   = payload.data || {};
  const ts     = data.tracking_status || {};
  const status = ts.status || '';  // TRANSIT, DELIVERED, RETURNED, FAILURE, UNKNOWN, PRE_TRANSIT
  const trackingNumber = data.tracking_number || '';

  console.log(`Shippo tracking update: ${trackingNumber} → ${status}`);

  // Only send emails for meaningful status changes
  const emailStatuses = { TRANSIT: true, DELIVERED: true, FAILURE: true };
  if (!emailStatuses[status]) {
    return new Response(JSON.stringify({ ok: true, skipped: `no email for status ${status}` }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Look up the order
  const order = await findOrderByTracking(trackingNumber, env);
  if (!order) {
    console.warn(`No order found for tracking number: ${trackingNumber}`);
    return new Response(JSON.stringify({ ok: true, skipped: 'order not found' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  const toEmail = (order.customer_email || '').trim();
  if (!toEmail) {
    console.warn('Order found but no customer_email:', order.id);
    return new Response(JSON.stringify({ ok: true, skipped: 'no customer email' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Fetch email settings
  const keyCache = await fetchSiteSettings(
    ['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM', 'BRAND_LOGO_URL'], env
  );
  const resendKey = resolveSetting('RESEND_API_KEY', env, keyCache);
  const brevoKey  = resolveSetting('BREVO_API_KEY',  env, keyCache);
  const fromEmail = resolveSetting('EMAIL_FROM', env, keyCache) || 'orders@zuwera.store';
  const logoUrl   = resolveSetting('BRAND_LOGO_URL', env, keyCache)
    || 'https://zuwera.store/assets/Zuwera_Wordmark_White.png';

  // Build and send email
  const trackingData = {
    trackingNumber,
    trackingUrl:   data.tracking_url_provider || '',
    carrier:       (data.carrier || '').toUpperCase(),
    statusDetails: ts.status_details || '',
    eta:           data.eta || null,
    location:      ts.location || null,
  };

  const subjects = {
    TRANSIT:   `Your Zuwera order is on its way 📦`,
    DELIVERED: `Your Zuwera order has been delivered ✓`,
    FAILURE:   `Delivery update for your Zuwera order`,
  };

  const html = buildTrackingEmail({ event: status, order, trackingData, logoUrl });

  try {
    await sendEmail({ to: toEmail, subject: subjects[status], html, fromEmail, resendKey, brevoKey });
    // Update order status in Supabase
    const newStatus = status === 'DELIVERED' ? 'delivered' : status === 'TRANSIT' ? 'shipped' : 'delivery_issue';
    await updateOrderStatus(order.id, newStatus, env);
  } catch (e) {
    console.error('Email send failed:', e.message);
    // Still return 200 so Shippo doesn't retry — we'll log and investigate
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true, status, to: toEmail }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}
