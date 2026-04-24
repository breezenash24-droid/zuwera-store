/**
 * Cloudflare Pages Function: POST /api/generate-return-label
 *
 * Admin-protected. Given an approved return request:
 *   1. Fetches the original order (for the customer's shipping address)
 *   2. Creates a Shippo shipment (customer → store, i.e. a return)
 *   3. Purchases the cheapest available rate
 *   4. Emails the prepaid label PDF to the customer
 *   5. Updates the commerce_returns site_setting with the label URL + tracking
 *
 * Body: { accessToken, returnId, orderId }
 */

import { fetchSiteSettings, resolveSetting } from './_settings.js';

const ADMIN_EMAILS = ['breezenash24@gmail.com', 'nasirubreeze@zuwera.store'];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function validateAdmin(accessToken, env) {
  const url    = (env.SUPABASE_URL || env.SUPABASE_PROJECT_URL || '').trim();
  const anonKey = (env.SUPABASE_ANON_KEY || '').trim();
  const svcKey  = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  const apiKey  = anonKey || svcKey;
  const resp = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: apiKey, Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error('Session invalid or expired');
  const user = await resp.json();
  const emails = [user?.email, ...(Array.isArray(user?.identities)
    ? user.identities.map(i => i?.identity_data?.email || i?.email) : [])]
    .filter(Boolean).map(e => String(e).toLowerCase().trim());
  if (!emails.some(e => ADMIN_EMAILS.includes(e))) throw new Error('Not authorized');
  return user;
}

async function fetchOrder(orderId, env) {
  const url = (env.SUPABASE_URL || env.SUPABASE_PROJECT_URL || '').trim();
  const sk  = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  const resp = await fetch(
    `${url}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&select=*&limit=1`,
    { headers: { apikey: sk, Authorization: `Bearer ${sk}` } }
  );
  if (!resp.ok) throw new Error('Could not fetch order');
  const rows = await resp.json();
  if (!rows?.length) throw new Error('Order not found');
  return rows[0];
}

async function createShippoLabel(order, env, cache) {
  const shippoKey = resolveSetting('SHIPPO_API_KEY', env, cache);
  if (!shippoKey) throw new Error('SHIPPO_API_KEY not configured');

  // FROM = customer (they're shipping it back), TO = store
  const addressFrom = {
    name:    order.customer_name || 'Customer',
    street1: order.ship_line1   || '',
    street2: order.ship_line2   || '',
    city:    order.ship_city    || '',
    state:   order.ship_state   || '',
    zip:     order.ship_zip     || '',
    country: order.ship_country || 'US',
    email:   order.email        || order.customer_email || '',
  };

  const addressTo = {
    name:    env.SHIPPO_FROM_NAME    || 'Zuwera Returns',
    street1: env.SHIPPO_FROM_STREET1 || '',
    street2: env.SHIPPO_FROM_STREET2 || '',
    city:    env.SHIPPO_FROM_CITY    || '',
    state:   env.SHIPPO_FROM_STATE   || '',
    zip:     env.SHIPPO_FROM_ZIP     || '',
    country: env.SHIPPO_FROM_COUNTRY || 'US',
    email:   env.SHIPPO_FROM_EMAIL   || 'orders@zuwera.store',
  };

  // Standard parcel for returns (clothing — light package)
  const parcel = {
    length: '12', width: '10', height: '3',
    distance_unit: 'in',
    weight: '1.5', mass_unit: 'lb',
  };

  // 1. Create shipment
  const shipResp = await fetch('https://api.goshippo.com/shipments/', {
    method: 'POST',
    headers: { Authorization: `ShippoToken ${shippoKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ address_from: addressFrom, address_to: addressTo, parcels: [parcel], async: false }),
  });
  if (!shipResp.ok) {
    const detail = await shipResp.text().catch(() => shipResp.status);
    throw new Error(`Shippo shipment error: ${detail}`);
  }
  const shipment = await shipResp.json();

  // 2. Pick cheapest rate — prefer USPS, then any carrier
  const rates = (shipment.rates || []).sort((a, b) => {
    const aUsps = /usps/i.test(a.provider) ? 0 : 1;
    const bUsps = /usps/i.test(b.provider) ? 0 : 1;
    if (aUsps !== bUsps) return aUsps - bUsps;
    return parseFloat(a.amount) - parseFloat(b.amount);
  });
  if (!rates.length) throw new Error('No shipping rates available from Shippo');
  const chosenRate = rates[0];

  // 3. Purchase label
  const txResp = await fetch('https://api.goshippo.com/transactions/', {
    method: 'POST',
    headers: { Authorization: `ShippoToken ${shippoKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rate: chosenRate.object_id, label_file_type: 'PDF', async: false }),
  });
  if (!txResp.ok) {
    const detail = await txResp.text().catch(() => txResp.status);
    throw new Error(`Shippo transaction error: ${detail}`);
  }
  const tx = await txResp.json();

  if (tx.status !== 'SUCCESS') {
    const msg = tx.messages?.map(m => m.text).join('; ') || tx.status;
    throw new Error(`Label purchase failed: ${msg}`);
  }

  return {
    labelUrl:       tx.label_url,
    trackingNumber: tx.tracking_number,
    trackingUrl:    tx.tracking_url_provider,
    carrier:        chosenRate.provider,
    service:        chosenRate.servicelevel?.name || '',
    amount:         chosenRate.amount,
    currency:       chosenRate.currency,
  };
}

async function sendLabelEmail(order, label, returnRequest, env, cache) {
  const resendKey  = resolveSetting('RESEND_API_KEY',  env, cache);
  const brevoKey   = resolveSetting('BREVO_API_KEY',   env, cache);
  const fromEmail  = resolveSetting('EMAIL_FROM',      env, cache) || 'orders@zuwera.store';
  const logoUrl    = resolveSetting('BRAND_LOGO_URL',  env, cache) || 'https://zuwera.store/assets/Zuwera_Wordmark_White.png';
  const toEmail    = (order.email || order.customer_email || '').trim();
  const toName     = order.customer_name || 'Customer';
  if (!toEmail) return;

  const orderLabel = '#' + String(order.id || '').slice(-8).toUpperCase();
  const resolution = returnRequest?.resolution || 'return';
  const resolutionLabel = resolution === 'exchange' ? 'exchange'
    : resolution === 'store_credit' ? 'store credit' : 'refund';
  const storeAddress = [
    env.SHIPPO_FROM_NAME || 'Zuwera',
    env.SHIPPO_FROM_STREET1,
    env.SHIPPO_FROM_CITY && env.SHIPPO_FROM_STATE
      ? `${env.SHIPPO_FROM_CITY}, ${env.SHIPPO_FROM_STATE} ${env.SHIPPO_FROM_ZIP || ''}`
      : '',
    env.SHIPPO_FROM_COUNTRY || 'US',
  ].filter(Boolean).join('\n');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f1eb;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1eb;padding:40px 0">
  <tr><td align="center">
    <table width="100%" style="max-width:560px;background:#09090b;border-collapse:collapse">
      <tr><td style="background:#09090b;padding:24px 36px;text-align:left">
        <img src="${logoUrl}" alt="Zuwera" height="36" style="height:36px;width:auto;display:block;border:0"
             onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
        <span style="display:none;font-family:Georgia,serif;font-size:1.5rem;letter-spacing:.12em;color:#f4f1eb;font-weight:normal">ZUWERA</span>
      </td></tr>
      <tr><td style="padding:36px 36px 12px;background:#09090b">
        <p style="margin:0 0 6px;font-family:Georgia,serif;font-size:22px;letter-spacing:.06em;color:#f4f1eb">Your Return Label Is Ready</p>
        <p style="margin:0;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:rgba(244,241,235,.35)">Order ${orderLabel}</p>
      </td></tr>
      <tr><td style="padding:20px 36px 28px;background:#09090b;font-size:14px;line-height:1.75;color:rgba(244,241,235,.7)">
        <p style="margin:0 0 18px">Hi ${toName.split(' ')[0]},</p>
        <p style="margin:0 0 18px">Your return request has been approved. We've generated a prepaid shipping label for you — just print it, attach it to your package, and drop it off at any ${label.carrier} location.</p>
        <table width="100%" style="border:1px solid rgba(244,241,235,.1);margin-bottom:24px">
          <tr><td style="padding:16px 20px">
            <p style="margin:0 0 4px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:rgba(244,241,235,.35)">Carrier</p>
            <p style="margin:0;font-size:14px;color:#f4f1eb">${label.carrier} — ${label.service}</p>
          </td></tr>
          <tr><td style="padding:4px 20px 16px">
            <p style="margin:0 0 4px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:rgba(244,241,235,.35)">Tracking</p>
            <p style="margin:0;font-size:14px;color:#f4f1eb">${label.trackingNumber}</p>
          </td></tr>
          <tr><td style="padding:4px 20px 16px">
            <p style="margin:0 0 4px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:rgba(244,241,235,.35)">Return To</p>
            <p style="margin:0;font-size:13px;color:rgba(244,241,235,.65);white-space:pre-line">${storeAddress}</p>
          </td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
          <tr><td align="center">
            <a href="${label.labelUrl}" style="display:inline-block;background:#f4f1eb;color:#09090b;padding:14px 36px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;text-decoration:none;font-weight:700">Download Label (PDF)</a>
          </td></tr>
        </table>
        ${label.trackingUrl ? `<p style="margin:0 0 18px">You can <a href="${label.trackingUrl}" style="color:rgba(244,241,235,.6)">track your return</a> once it's been picked up.</p>` : ''}
        <p style="margin:0 0 18px">Once we receive your return, we'll process your ${resolutionLabel} within 3–5 business days. We'll send you a confirmation email when it's done.</p>
        <p style="margin:0 0 4px">Thanks,</p>
        <p style="margin:0">The Zuwera Team</p>
      </td></tr>
      <tr><td style="padding:20px 36px;background:#0a0a0c;border-top:1px solid rgba(244,241,235,.07);font-size:10px;letter-spacing:.1em;color:rgba(244,241,235,.2);text-transform:uppercase;text-align:center">
        &copy; ${new Date().getFullYear()} Zuwera &middot; <a href="https://zuwera.store" style="color:rgba(244,241,235,.2);text-decoration:none">zuwera.store</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  const subject = `Your return label for ${orderLabel}`;

  // Try Resend first
  if (resendKey) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Zuwera <${fromEmail}>`, to: [toEmail], reply_to: 'orders@zuwera.store', subject, html }),
    });
    if (r.ok) return;
  }
  // Brevo fallback
  if (brevoKey) {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Zuwera', email: fromEmail },
        to: [{ email: toEmail, name: toName }],
        replyTo: { email: 'orders@zuwera.store' },
        subject, htmlContent: html,
      }),
    });
  }
}

async function updateReturnRequest(returnId, labelData, env) {
  const url = (env.SUPABASE_URL || env.SUPABASE_PROJECT_URL || '').trim();
  const sk  = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();

  // Fetch existing commerce_returns
  const fetchResp = await fetch(
    `${url}/rest/v1/site_settings?key=eq.commerce_returns&select=value&limit=1`,
    { headers: { apikey: sk, Authorization: `Bearer ${sk}` } }
  );
  const rows = await fetchResp.json().catch(() => []);
  const existing = rows?.[0]?.value || { requests: [] };
  const requests = Array.isArray(existing.requests) ? existing.requests : [];

  // Update the matching request
  const updated = requests.map(r => r.id === returnId ? {
    ...r,
    status:         'label_sent',
    labelUrl:       labelData.labelUrl,
    trackingNumber: labelData.trackingNumber,
    trackingUrl:    labelData.trackingUrl,
    carrier:        labelData.carrier,
    labelSentAt:    new Date().toISOString(),
  } : r);

  await fetch(`${url}/rest/v1/site_settings?key=eq.commerce_returns`, {
    method: 'PATCH',
    headers: {
      apikey: sk, Authorization: `Bearer ${sk}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify({ value: { ...existing, requests: updated }, updated_at: new Date().toISOString() }),
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const { accessToken, returnId, orderId } = body;

    if (!accessToken) return json({ ok: false, error: 'Missing access token' }, 401);
    if (!returnId || !orderId) return json({ ok: false, error: 'Missing returnId or orderId' }, 400);

    await validateAdmin(accessToken, env);

    // Pre-fetch Supabase key overrides (Resend, Brevo, Shippo, branding)
    const cache = await fetchSiteSettings(
      ['SHIPPO_API_KEY', 'RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM', 'BRAND_LOGO_URL'], env
    );

    const order = await fetchOrder(orderId, env);
    const label = await createShippoLabel(order, env, cache);

    // Fire email and DB update in parallel
    await Promise.allSettled([
      sendLabelEmail(order, label, body.returnRequest || {}, env, cache),
      updateReturnRequest(returnId, label, env),
    ]);

    console.log(`[return-label] Label generated for return ${returnId}, order ${orderId}`);
    return json({
      ok: true,
      labelUrl:       label.labelUrl,
      trackingNumber: label.trackingNumber,
      trackingUrl:    label.trackingUrl,
      carrier:        label.carrier,
      service:        label.service,
    });
  } catch (e) {
    console.error('[return-label] Error:', e.message);
    return json({ ok: false, error: e.message || 'Unknown error' }, 500);
  }
}
