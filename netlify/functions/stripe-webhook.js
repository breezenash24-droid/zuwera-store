/**
 * Netlify Function: stripe-webhook
 *
 * Listens for Stripe webhook events. On payment_intent.succeeded:
 *  1. Creates a Shippo shipping label automatically
 *  2. Sends an order confirmation email via SendGrid
 *  3. Saves the order to Supabase directly (no internal HTTP round-trip)
 *
 * Setup:
 *  1. Stripe Dashboard → Webhooks → Add endpoint
 *     URL: https://zuwera.store/api/stripe-webhook
 *     Events: payment_intent.succeeded, payment_intent.payment_failed
 *  2. Copy the webhook signing secret → STRIPE_WEBHOOK_SECRET env var
 *  3. Add SENDGRID_API_KEY + SENDGRID_FROM_EMAIL env vars
 *  4. Add SHIPPO_API_KEY + SHIPPO_FROM_* env vars
 *  5. Add SUPABASE_URL + SUPABASE_SERVICE_KEY env vars
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getFromAddress, getServicelevelToken } = require('./_shared');

exports.handler = async (event) => {
  // ── Verify Stripe signature ───────────────────────────────────
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (e) {
    console.error('Webhook signature verification failed:', e.message);
    return { statusCode: 400, body: `Webhook Error: ${e.message}` };
  }

  // ── payment_intent.succeeded ──────────────────────────────────
  if (stripeEvent.type === 'payment_intent.succeeded') {
    const pi   = stripeEvent.data.object;
    const meta = pi.metadata || {};
    console.log(`✅ PaymentIntent succeeded: ${pi.id}`);

    const [labelResult, emailResult, orderResult] = await Promise.allSettled([
      createShippingLabel(pi, meta),
      sendConfirmationEmail(pi, meta),
      saveOrderToSupabase(pi, meta),
    ]);

    if (labelResult.status === 'rejected') console.error('Label creation failed:',    labelResult.reason);
    if (emailResult.status === 'rejected') console.error('Confirmation email failed:', emailResult.reason);
    if (orderResult.status === 'rejected') console.error('Order save failed:',         orderResult.reason);
  }

  if (stripeEvent.type === 'payment_intent.payment_failed') {
    const pi = stripeEvent.data.object;
    console.warn(`❌ Payment failed: ${pi.id} — ${pi.last_payment_error?.message}`);
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

// ─────────────────────────────────────────────────────────────────
// Create Shippo label
// ─────────────────────────────────────────────────────────────────
async function createShippingLabel(pi, meta) {
  if (!process.env.SHIPPO_API_KEY) {
    console.warn('SHIPPO_API_KEY not set — skipping label creation');
    return null;
  }

  const resp = await fetch('https://api.goshippo.com/transactions/', {
    method: 'POST',
    headers: {
      Authorization:  `ShippoToken ${process.env.SHIPPO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      shipment: {
        address_from: getFromAddress(),
        address_to: {
          name:    meta.customer_name  || 'Customer',
          street1: meta.ship_line1     || '',
          street2: meta.ship_line2     || '',
          city:    meta.ship_city      || '',
          state:   meta.ship_state     || '',
          zip:     meta.ship_zip       || '',
          country: meta.ship_country   || 'US',
          email:   meta.customer_email || '',
        },
        parcels: [{
          length: '14', width: '10', height: '4', distance_unit: 'in',
          weight: '2',  mass_unit: 'lb',
        }],
      },
      carrier_account:    process.env.SHIPPO_CARRIER_ACCOUNT || undefined,
      servicelevel_token: getServicelevelToken(meta.shipping_service),
      label_file_type:    'PDF',
      async: false,
    }),
  });

  const data = await resp.json();
  if (data.status !== 'SUCCESS')
    throw new Error(`Shippo label failed: ${JSON.stringify(data.messages)}`);

  console.log(`📦 Label created: ${data.label_url} | Tracking: ${data.tracking_number}`);

  await stripe.paymentIntents.update(pi.id, {
    metadata: {
      tracking_number: data.tracking_number,
      tracking_url:    data.tracking_url_provider,
      label_url:       data.label_url,
    },
  });

  return data;
}

// ─────────────────────────────────────────────────────────────────
// Send confirmation email via SendGrid
// ─────────────────────────────────────────────────────────────────
async function sendConfirmationEmail(pi, meta) {
  if (!process.env.SENDGRID_API_KEY) {
    console.warn('SENDGRID_API_KEY not set — skipping confirmation email');
    return null;
  }

  const toEmail      = meta.customer_email;
  const toName       = meta.customer_name || 'Customer';
  const orderId      = pi.id.slice(-8).toUpperCase();
  const totalDollars = (pi.amount / 100).toFixed(2);

  let itemsHtml = '';
  try {
    itemsHtml = JSON.parse(meta.items || '[]').map(item => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #222;">${item.name}</td>
        <td style="padding:8px 0;border-bottom:1px solid #222;text-align:right;">
          ${item.quantity}x &nbsp; $${(item.amount / 100).toFixed(2)}
        </td>
      </tr>`).join('');
  } catch (_) {
    itemsHtml = '<tr><td colspan="2">Your Zuwera order</td></tr>';
  }

  const shippingLine = meta.shipping_provider && meta.shipping_service
    ? `${meta.shipping_provider} ${meta.shipping_service}`
    : 'Standard Shipping';

  const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'DM Sans',Helvetica,Arial,sans-serif;color:#f5f5f0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="500" cellpadding="0" cellspacing="0" style="max-width:500px;width:100%;background:#141414;border:1px solid #222;">
        <tr>
          <td style="padding:32px;border-bottom:1px solid #222;text-align:center;">
            <p style="font-family:Georgia,serif;font-size:28px;letter-spacing:0.3em;text-transform:uppercase;margin:0;">ZUWERA</p>
            <p style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(245,245,240,0.4);margin:8px 0 0;">For Those Who Dream</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="font-size:22px;font-weight:500;margin:0 0 6px;">Order Confirmed ✓</p>
            <p style="font-size:13px;color:rgba(245,245,240,0.5);margin:0 0 24px;">Order #${orderId}</p>
            <p style="font-size:14px;color:rgba(245,245,240,0.7);margin:0 0 20px;">
              Hi ${toName},<br><br>Thank you for your Zuwera order. We're getting it ready for you.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
              <tr>
                <th style="text-align:left;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:rgba(245,245,240,0.4);padding-bottom:8px;border-bottom:1px solid #222;">Item</th>
                <th style="text-align:right;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:rgba(245,245,240,0.4);padding-bottom:8px;border-bottom:1px solid #222;">Price</th>
              </tr>
              ${itemsHtml}
              <tr>
                <td style="padding:12px 0 4px;font-size:13px;color:rgba(245,245,240,0.5);">Shipping (${shippingLine})</td>
                <td style="padding:12px 0 4px;text-align:right;font-size:13px;color:rgba(245,245,240,0.5);">
                  $${(parseInt(meta.shipping_amount_cents || '0') / 100).toFixed(2)}
                </td>
              </tr>
              <tr>
                <td style="padding:12px 0 0;font-size:15px;font-weight:600;">Total</td>
                <td style="padding:12px 0 0;text-align:right;font-size:15px;font-weight:600;">$${totalDollars}</td>
              </tr>
            </table>
            <div style="background:#0a0a0a;border:1px solid #222;padding:16px;margin-bottom:24px;">
              <p style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:rgba(245,245,240,0.4);margin:0 0 8px;">Shipping To</p>
              <p style="font-size:13px;margin:0;line-height:1.6;color:rgba(245,245,240,0.8);">
                ${meta.customer_name}<br>
                ${meta.ship_line1}${meta.ship_line2 ? ', ' + meta.ship_line2 : ''}<br>
                ${meta.ship_city}, ${meta.ship_state} ${meta.ship_zip}<br>
                ${meta.ship_country}
              </p>
            </div>
            <p style="font-size:13px;color:rgba(245,245,240,0.5);margin:0;">
              We'll send a separate email with your tracking number once your order ships.
              Questions? <a href="mailto:nasirubreeze@zuwera.store" style="color:#f5f5f0;">nasirubreeze@zuwera.store</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px;border-top:1px solid #222;text-align:center;">
            <p style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(245,245,240,0.2);margin:0;">© 2026 Zuwera. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: toEmail, name: toName }] }],
      from:     { email: process.env.SENDGRID_FROM_EMAIL || 'orders@zuwera.store', name: 'Zuwera' },
      reply_to: { email: 'nasirubreeze@zuwera.store', name: 'Zuwera Support' },
      subject:  `Order Confirmed — #${orderId}`,
      content:  [{ type: 'text/html', value: emailHtml }],
    }),
  });

  if (!resp.ok) throw new Error(`SendGrid error ${resp.status}: ${await resp.text()}`);
  console.log(`📧 Confirmation email sent to ${toEmail}`);
  return true;
}

// ─────────────────────────────────────────────────────────────────
// Save order to Supabase — direct REST API call
// ─────────────────────────────────────────────────────────────────
async function saveOrderToSupabase(pi, meta) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.warn('SUPABASE_URL / SUPABASE_SERVICE_KEY not set — skipping order save');
    return null;
  }

  const items = (() => { try { return JSON.parse(meta.items || '[]'); } catch { return []; } })();

  const row = {
    stripe_payment_intent_id: pi.id,
    email:           meta.customer_email,
    customer_name:   meta.customer_name,
    items:           JSON.stringify(items),
    subtotal:        (pi.amount / 100).toFixed(2),
    shipping:        (parseInt(meta.shipping_amount_cents || '0') / 100).toFixed(2),
    tax:             '0.00',
    total:           (pi.amount / 100).toFixed(2),
    ship_line1:      meta.ship_line1,
    ship_line2:      meta.ship_line2  || '',
    ship_city:       meta.ship_city,
    ship_state:      meta.ship_state,
    ship_zip:        meta.ship_zip,
    ship_country:    meta.ship_country || 'US',
    shipping_provider: meta.shipping_provider || '',
    shipping_service:  meta.shipping_service  || '',
    tracking_number:   meta.tracking_number   || '',
    tracking_url:      meta.tracking_url      || '',
    label_url:         meta.label_url         || '',
    status:            'confirmed',
  };

  const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/orders`, {
    method: 'POST',
    headers: {
      apikey:         process.env.SUPABASE_SERVICE_KEY,
      Authorization:  `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer:         'return=minimal',
    },
    body: JSON.stringify(row),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Supabase insert failed (${resp.status}): ${detail}`);
  }

  console.log(`🗄️  Order saved to Supabase: ${pi.id}`);
  return true;
}
