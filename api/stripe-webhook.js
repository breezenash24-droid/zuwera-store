/**
 * Vercel Serverless Function: /api/stripe-webhook
 *
 * Handles Stripe webhook events.
 * bodyParser must be disabled so Stripe can verify the raw request body.
 *
 * Environment variables (set in Vercel Dashboard → Settings → Environment):
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 *   SENDGRID_API_KEY, SENDGRID_FROM_EMAIL,
 *   SHIPPO_API_KEY, SHIPPO_FROM_*, SHIPPO_CARRIER_ACCOUNT,
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *
 * Stripe Dashboard → Webhooks → Add endpoint:
 *   URL:    https://zuwera.store/api/stripe-webhook
 *   Events: payment_intent.succeeded, payment_intent.payment_failed
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Disable Vercel's automatic body parsing — Stripe needs the raw body
// to verify the webhook signature.
export const config = { api: { bodyParser: false } };

// Read raw body from the Node.js request stream
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end',  () => resolve(data));
    req.on('error', reject);
  });
}

function getFromAddress() {
  return {
    name:    process.env.SHIPPO_FROM_NAME    || 'Zuwera',
    street1: process.env.SHIPPO_FROM_STREET1 || '123 Brand St',
    city:    process.env.SHIPPO_FROM_CITY    || 'Los Angeles',
    state:   process.env.SHIPPO_FROM_STATE   || 'CA',
    zip:     process.env.SHIPPO_FROM_ZIP     || '90001',
    country: process.env.SHIPPO_FROM_COUNTRY || 'US',
    email:   process.env.SHIPPO_FROM_EMAIL   || 'orders@zuwera.store',
  };
}

const SERVICE_TOKEN_MAP = {
  'Priority Mail':         'usps_priority',
  'Ground Advantage':      'usps_ground_advantage',
  'Priority Mail Express': 'usps_priority_express',
  'UPS Ground':            'ups_ground',
  'UPS 2nd Day Air':       'ups_second_day_air',
  'FedEx Ground':          'fedex_ground',
  'FedEx 2Day':            'fedex_2_day',
};
function getServicelevelToken(name) { return SERVICE_TOKEN_MAP[name] || 'usps_priority'; }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('Method not allowed');

  const rawBody = await getRawBody(req);
  const sig     = req.headers['stripe-signature'];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Webhook signature verification failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  if (stripeEvent.type === 'payment_intent.succeeded') {
    const pi   = stripeEvent.data.object;
    const meta = pi.metadata || {};
    console.log(`✅ PaymentIntent succeeded: ${pi.id}`);

    // Create shipping label first so tracking info can be included in the confirmation email
    let labelData = null;
    try {
      labelData = await createShippingLabel(pi, meta);
    } catch (e) {
      console.error('Label failed:', e);
    }

    // Merge any tracking info returned from Shippo into meta so the email can use it
    if (labelData) {
      meta = {
        ...meta,
        tracking_number: labelData.tracking_number || meta.tracking_number || '',
        tracking_url:    labelData.tracking_url_provider || meta.tracking_url || '',
        label_url:       labelData.label_url || meta.label_url || '',
      };
    }

    const [emailResult, orderResult] = await Promise.allSettled([
      sendConfirmationEmail(pi, meta),
      saveOrderToSupabase(pi, meta),
    ]);

    if (emailResult.status === 'rejected') console.error('Email failed:',  emailResult.reason);
    if (orderResult.status === 'rejected') console.error('DB save failed:', orderResult.reason);
  }

  if (stripeEvent.type === 'payment_intent.payment_failed') {
    const pi = stripeEvent.data.object;
    console.warn(`❌ Payment failed: ${pi.id} — ${pi.last_payment_error?.message}`);
  }

  return res.status(200).json({ received: true });
};

async function createShippingLabel(pi, meta) {
  if (!process.env.SHIPPO_API_KEY) return null;

  const resp = await fetch('https://api.goshippo.com/transactions/', {
    method: 'POST',
    headers: { Authorization: `ShippoToken ${process.env.SHIPPO_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shipment: {
        address_from: getFromAddress(),
        address_to: {
          name: meta.customer_name || 'Customer', street1: meta.ship_line1 || '',
          street2: meta.ship_line2 || '', city: meta.ship_city || '',
          state: meta.ship_state || '', zip: meta.ship_zip || '',
          country: meta.ship_country || 'US', email: meta.customer_email || '',
        },
        parcels: [{ length: '14', width: '10', height: '4', distance_unit: 'in', weight: '2', mass_unit: 'lb' }],
      },
      carrier_account:    process.env.SHIPPO_CARRIER_ACCOUNT || undefined,
      servicelevel_token: getServicelevelToken(meta.shipping_service),
      label_file_type:    'PDF',
      async: false,
    }),
  });

  const data = await resp.json();
  if (data.status !== 'SUCCESS') throw new Error(`Shippo label failed: ${JSON.stringify(data.messages)}`);

  await stripe.paymentIntents.update(pi.id, {
    metadata: { tracking_number: data.tracking_number, tracking_url: data.tracking_url_provider, label_url: data.label_url },
  });
  return data;
}

async function sendConfirmationEmail(pi, meta) {
  if (!process.env.SENDGRID_API_KEY) return null;

  const orderId        = pi.id.slice(-8).toUpperCase();
  const toEmail        = meta.customer_email;
  const toName         = meta.customer_name || 'Customer';
  const firstName      = toName.split(' ')[0];

  const shippingAmountCents = parseInt(meta.shipping_amount_cents || '0');
  const subtotalCents       = pi.amount - shippingAmountCents;
  const subtotalDollars     = (subtotalCents / 100).toFixed(2);
  const shippingDollars     = (shippingAmountCents / 100).toFixed(2);
  const totalDollars        = (pi.amount / 100).toFixed(2);

  const shippingLine = meta.shipping_provider && meta.shipping_service
    ? `${meta.shipping_provider} — ${meta.shipping_service}` : 'Standard Shipping';

  // Build items rows
  let itemsHtml = '';
  let items = [];
  try { items = JSON.parse(meta.items || '[]'); } catch (_) {}

  if (items.length > 0) {
    itemsHtml = items.map(i => {
      const unitPrice = (i.amount / 100).toFixed(2);
      const lineTotal = ((i.amount * i.quantity) / 100).toFixed(2);
      return `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #1e1e1e;color:#f4f1eb;font-size:14px;">${i.name}</td>
          <td style="padding:12px 0;border-bottom:1px solid #1e1e1e;color:#9b9b9b;font-size:14px;text-align:center;">×${i.quantity}</td>
          <td style="padding:12px 0;border-bottom:1px solid #1e1e1e;color:#f4f1eb;font-size:14px;text-align:right;">$${lineTotal}</td>
        </tr>`;
    }).join('');
  } else {
    itemsHtml = `<tr><td colspan="3" style="padding:12px 0;border-bottom:1px solid #1e1e1e;color:#f4f1eb;font-size:14px;">Your Zuwera order</td></tr>`;
  }

  // Shipping address block
  const hasAddress = meta.ship_line1 && meta.ship_city;
  const addressHtml = hasAddress ? `
    <p style="margin:0;color:#f4f1eb;font-size:14px;line-height:1.6;">
      ${meta.ship_line1}${meta.ship_line2 ? '<br>' + meta.ship_line2 : ''}<br>
      ${meta.ship_city}, ${meta.ship_state} ${meta.ship_zip}<br>
      ${meta.ship_country || 'US'}
    </p>` : `<p style="margin:0;color:#9b9b9b;font-size:14px;">Address on file</p>`;

  // Tracking block (only shown if tracking info exists in metadata)
  const trackingHtml = meta.tracking_number ? `
    <tr>
      <td style="padding:24px 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border-radius:8px;">
          <tr>
            <td style="padding:20px 24px;">
              <p style="margin:0 0 4px;color:#9b9b9b;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">Tracking</p>
              <p style="margin:0;color:#f4f1eb;font-size:14px;">${meta.tracking_number}</p>
              ${meta.tracking_url ? `<a href="${meta.tracking_url}" style="display:inline-block;margin-top:10px;padding:8px 16px;background:#F891A5;color:#09090b;font-size:12px;font-weight:700;text-decoration:none;border-radius:4px;letter-spacing:0.04em;">Track Package</a>` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Order Confirmed — #${orderId}</title>
</head>
<body style="margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#000;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width:560px;background:#09090b;border-radius:12px;overflow:hidden;" cellpadding="0" cellspacing="0">

          <!-- Header -->
          <tr>
            <td style="padding:40px 32px 32px;border-bottom:1px solid #1e1e1e;text-align:center;">
              <p style="margin:0 0 24px;font-size:22px;font-weight:800;letter-spacing:0.12em;color:#f4f1eb;text-transform:uppercase;">ZUWERA</p>
              <div style="width:48px;height:48px;background:#F891A5;border-radius:50%;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;">
                <span style="font-size:22px;line-height:48px;display:block;text-align:center;">✓</span>
              </div>
              <p style="margin:0 0 6px;font-size:20px;font-weight:700;color:#f4f1eb;">Order Confirmed</p>
              <p style="margin:0;font-size:13px;color:#9b9b9b;letter-spacing:0.06em;">ORDER #${orderId}</p>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding:28px 32px 0;">
              <p style="margin:0;font-size:15px;color:#f4f1eb;line-height:1.6;">Hey ${firstName},</p>
              <p style="margin:12px 0 0;font-size:14px;color:#9b9b9b;line-height:1.7;">
                Your order is confirmed and we're getting it ready. We'll send you a tracking number as soon as it ships.
              </p>
            </td>
          </tr>

          <!-- Items -->
          <tr>
            <td style="padding:24px 32px 0;">
              <p style="margin:0 0 12px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#9b9b9b;">Items</p>
              <table width="100%" cellpadding="0" cellspacing="0">
                <thead>
                  <tr>
                    <th style="padding-bottom:8px;text-align:left;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#555;font-weight:500;">Product</th>
                    <th style="padding-bottom:8px;text-align:center;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#555;font-weight:500;">Qty</th>
                    <th style="padding-bottom:8px;text-align:right;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#555;font-weight:500;">Price</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemsHtml}
                </tbody>
              </table>
            </td>
          </tr>

          <!-- Cost breakdown -->
          <tr>
            <td style="padding:20px 32px 0;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:6px 0;font-size:13px;color:#9b9b9b;">Subtotal</td>
                  <td style="padding:6px 0;font-size:13px;color:#9b9b9b;text-align:right;">$${subtotalDollars}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;font-size:13px;color:#9b9b9b;">Shipping</td>
                  <td style="padding:6px 0;font-size:13px;color:#9b9b9b;text-align:right;">$${shippingDollars}</td>
                </tr>
                <tr>
                  <td style="padding:12px 0 0;font-size:15px;font-weight:700;color:#f4f1eb;border-top:1px solid #1e1e1e;">Total</td>
                  <td style="padding:12px 0 0;font-size:15px;font-weight:700;color:#F891A5;text-align:right;border-top:1px solid #1e1e1e;">$${totalDollars}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Shipping address + method -->
          <tr>
            <td style="padding:28px 32px 0;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width:50%;vertical-align:top;padding-right:12px;">
                    <p style="margin:0 0 10px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#9b9b9b;">Ship to</p>
                    ${addressHtml}
                  </td>
                  <td style="width:50%;vertical-align:top;padding-left:12px;">
                    <p style="margin:0 0 10px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#9b9b9b;">Method</p>
                    <p style="margin:0;color:#f4f1eb;font-size:14px;line-height:1.6;">${shippingLine}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Tracking (conditional) -->
          ${trackingHtml}

          <!-- Footer -->
          <tr>
            <td style="padding:32px;border-top:1px solid #1e1e1e;margin-top:28px;">
              <p style="margin:0 0 8px;font-size:12px;color:#555;line-height:1.7;">
                Questions? Reply to this email or reach us at
                <a href="mailto:nasirubreeze@zuwera.store" style="color:#F891A5;text-decoration:none;">nasirubreeze@zuwera.store</a>
              </p>
              <p style="margin:0;font-size:11px;color:#333;">© ${new Date().getFullYear()} Zuwera. All rights reserved.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: toEmail, name: toName }] }],
      from:     { email: process.env.SENDGRID_FROM_EMAIL || 'orders@zuwera.store', name: 'Zuwera' },
      reply_to: { email: 'nasirubreeze@zuwera.store', name: 'Zuwera Support' },
      subject:  `Order Confirmed — #${orderId}`,
      content:  [{ type: 'text/html', value: html }],
    }),
  });

  if (!resp.ok) throw new Error(`SendGrid error ${resp.status}: ${await resp.text()}`);
  return true;
}

async function saveOrderToSupabase(pi, meta) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;

  const items = (() => { try { return JSON.parse(meta.items || '[]'); } catch { return []; } })();

  const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/orders`, {
    method: 'POST',
    headers: {
      apikey:         process.env.SUPABASE_SERVICE_KEY,
      Authorization:  `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer:         'return=minimal',
    },
    body: JSON.stringify({
      stripe_payment_intent_id: pi.id,
      email: meta.customer_email, customer_name: meta.customer_name,
      items: JSON.stringify(items),
      subtotal: (pi.amount / 100).toFixed(2),
      shipping: (parseInt(meta.shipping_amount_cents || '0') / 100).toFixed(2),
      tax: '0.00', total: (pi.amount / 100).toFixed(2),
      ship_line1: meta.ship_line1, ship_line2: meta.ship_line2 || '',
      ship_city: meta.ship_city, ship_state: meta.ship_state,
      ship_zip: meta.ship_zip, ship_country: meta.ship_country || 'US',
      shipping_provider: meta.shipping_provider || '', shipping_service: meta.shipping_service || '',
      tracking_number: meta.tracking_number || '', tracking_url: meta.tracking_url || '',
      label_url: meta.label_url || '', status: 'confirmed',
    }),
  });

  if (!resp.ok) throw new Error(`Supabase insert failed (${resp.status}): ${await resp.text()}`);
  return true;
}
