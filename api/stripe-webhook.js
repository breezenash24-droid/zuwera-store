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

    const [labelResult, emailResult, orderResult] = await Promise.allSettled([
      createShippingLabel(pi, meta),
      sendConfirmationEmail(pi, meta),
      saveOrderToSupabase(pi, meta),
    ]);

    if (labelResult.status === 'rejected') console.error('Label failed:',  labelResult.reason);
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

  const orderId      = pi.id.slice(-8).toUpperCase();
  const totalDollars = (pi.amount / 100).toFixed(2);
  const toEmail      = meta.customer_email;
  const toName       = meta.customer_name || 'Customer';

  let itemsHtml = '';
  try {
    itemsHtml = JSON.parse(meta.items || '[]').map(i => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #222;">${i.name}</td>
        <td style="padding:8px 0;border-bottom:1px solid #222;text-align:right;">${i.quantity}x $${(i.amount/100).toFixed(2)}</td>
      </tr>`).join('');
  } catch (_) { itemsHtml = '<tr><td colspan="2">Your Zuwera order</td></tr>'; }

  const shippingLine = meta.shipping_provider && meta.shipping_service
    ? `${meta.shipping_provider} ${meta.shipping_service}` : 'Standard Shipping';

  const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: toEmail, name: toName }] }],
      from:     { email: process.env.SENDGRID_FROM_EMAIL || 'orders@zuwera.store', name: 'Zuwera' },
      reply_to: { email: 'nasirubreeze@zuwera.store', name: 'Zuwera Support' },
      subject:  `Order Confirmed — #${orderId}`,
      content:  [{ type: 'text/html', value: `<p>Order #${orderId} confirmed for ${toName}. Total: $${totalDollars}. Shipping via ${shippingLine}.</p>` }],
    }),
  });

  if (!resp.ok) throw new Error(`SendGrid error ${resp.status}`);
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
