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
 *  3. Add RESEND_API_KEY + RESEND_FROM_EMAIL env vars
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

    // Create label first so tracking number is available in the confirmation email
    let labelData = null;
    try {
      labelData = await createShippingLabel(pi, meta);
    } catch (e) {
      console.error('Label creation failed:', e);
    }

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
// Send confirmation email via Resend
// ─────────────────────────────────────────────────────────────────
async function sendConfirmationEmail(pi, meta) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping confirmation email');
    return null;
  }

  const toEmail    = meta.customer_email;
  const toName     = meta.customer_name || 'Customer';
  const firstName  = toName.split(' ')[0];
  const orderId    = pi.id.slice(-8).toUpperCase();

  const shippingAmountCents = parseInt(meta.shipping_amount_cents || '0');
  const subtotalCents       = pi.amount - shippingAmountCents;
  const subtotalDollars     = (subtotalCents / 100).toFixed(2);
  const shippingDollars     = (shippingAmountCents / 100).toFixed(2);
  const totalDollars        = (pi.amount / 100).toFixed(2);

  const shippingLine = meta.shipping_provider && meta.shipping_service
    ? `${meta.shipping_provider} — ${meta.shipping_service}` : 'Standard Shipping';

  let items = [];
  try { items = JSON.parse(meta.items || '[]'); } catch (_) {}

  let itemsHtml = '';
  if (items.length > 0) {
    itemsHtml = items.map(i => {
      const lineTotal = ((i.amount * i.quantity) / 100).toFixed(2);
      return `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #1e1e1e;color:#f4f1eb;font-size:14px;">${i.name}</td>
          <td style="padding:12px 0;border-bottom:1px solid #1e1e1e;color:#9b9b9b;font-size:14px;text-align:center;">×${i.quantity}</td>
          <td style="padding:12px 0;border-bottom:1px solid #1e1e1e;color:#f4f1eb;font-size:14px;text-align:right;">$${lineTotal}</td>
        </tr>`;
    }).join('');
  } else {
    itemsHtml = `<tr><td colspan="3" style="padding:12px 0;color:#f4f1eb;font-size:14px;">Your Zuwera order</td></tr>`;
  }

  const hasAddress = meta.ship_line1 && meta.ship_city;
  const addressHtml = hasAddress
    ? `${meta.ship_line1}${meta.ship_line2 ? '<br>' + meta.ship_line2 : ''}<br>${meta.ship_city}, ${meta.ship_state} ${meta.ship_zip}<br>${meta.ship_country || 'US'}`
    : 'Address on file';

  const trackingHtml = meta.tracking_number ? `
    <tr>
      <td style="padding:0 32px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border-radius:8px;">
          <tr>
            <td style="padding:20px 24px;">
              <p style="margin:0 0 4px;color:#9b9b9b;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">Tracking</p>
              <p style="margin:0;color:#f4f1eb;font-size:14px;">${meta.tracking_number}</p>
              ${meta.tracking_url ? `<a href="${meta.tracking_url}" style="display:inline-block;margin-top:10px;padding:8px 16px;background:#F891A5;color:#09090b;font-size:12px;font-weight:700;text-decoration:none;border-radius:4px;">Track Package</a>` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>` : '';

  const emailHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Order Confirmed — #${orderId}</title></head>
<body style="margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#000;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#09090b;border-radius:12px;overflow:hidden;" cellpadding="0" cellspacing="0">

        <!-- Header -->
        <tr>
          <td style="padding:40px 32px 32px;border-bottom:1px solid #1e1e1e;text-align:center;">
            <p style="margin:0 0 24px;font-size:22px;font-weight:800;letter-spacing:0.12em;color:#f4f1eb;text-transform:uppercase;">ZUWERA</p>
            <div style="width:48px;height:48px;background:#F891A5;border-radius:50%;margin:0 auto 16px;text-align:center;line-height:48px;font-size:22px;">✓</div>
            <p style="margin:0 0 6px;font-size:20px;font-weight:700;color:#f4f1eb;">Order Confirmed</p>
            <p style="margin:0;font-size:13px;color:#9b9b9b;letter-spacing:0.06em;">ORDER #${orderId}</p>
          </td>
        </tr>

        <!-- Greeting -->
        <tr>
          <td style="padding:28px 32px 0;">
            <p style="margin:0;font-size:15px;color:#f4f1eb;">Hey ${firstName},</p>
            <p style="margin:12px 0 0;font-size:14px;color:#9b9b9b;line-height:1.7;">Your order is confirmed and we're getting it ready. We'll send you a tracking number as soon as it ships.</p>
          </td>
        </tr>

        <!-- Items -->
        <tr>
          <td style="padding:24px 32px 0;">
            <p style="margin:0 0 12px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#9b9b9b;">Items</p>
            <table width="100%" cellpadding="0" cellspacing="0">
              <thead>
                <tr>
                  <th style="padding-bottom:8px;text-align:left;font-size:11px;color:#555;font-weight:500;letter-spacing:0.06em;text-transform:uppercase;">Product</th>
                  <th style="padding-bottom:8px;text-align:center;font-size:11px;color:#555;font-weight:500;letter-spacing:0.06em;text-transform:uppercase;">Qty</th>
                  <th style="padding-bottom:8px;text-align:right;font-size:11px;color:#555;font-weight:500;letter-spacing:0.06em;text-transform:uppercase;">Price</th>
                </tr>
              </thead>
              <tbody>${itemsHtml}</tbody>
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

        <!-- Address + method -->
        <tr>
          <td style="padding:28px 32px 0;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="width:50%;vertical-align:top;padding-right:12px;">
                  <p style="margin:0 0 10px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#9b9b9b;">Ship to</p>
                  <p style="margin:0;color:#f4f1eb;font-size:14px;line-height:1.6;">${addressHtml}</p>
                </td>
                <td style="width:50%;vertical-align:top;padding-left:12px;">
                  <p style="margin:0 0 10px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#9b9b9b;">Method</p>
                  <p style="margin:0;color:#f4f1eb;font-size:14px;line-height:1.6;">${shippingLine}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Tracking (only if available) -->
        ${trackingHtml}

        <!-- Footer -->
        <tr>
          <td style="padding:32px;border-top:1px solid #1e1e1e;margin-top:28px;">
            <p style="margin:0 0 8px;font-size:12px;color:#555;line-height:1.7;">Questions? Reply to this email or reach us at <a href="mailto:nasirubreeze@zuwera.store" style="color:#F891A5;text-decoration:none;">nasirubreeze@zuwera.store</a></p>
            <p style="margin:0;font-size:11px;color:#333;">© ${new Date().getFullYear()} Zuwera. All rights reserved.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:     `Zuwera <${process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'}>`,
      to:       [toEmail],
      reply_to: 'nasirubreeze@zuwera.store',
      subject:  `Order Confirmed — #${orderId}`,
      html:     emailHtml,
    }),
  });

  if (!resp.ok) throw new Error(`Resend error ${resp.status}: ${await resp.text()}`);
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
