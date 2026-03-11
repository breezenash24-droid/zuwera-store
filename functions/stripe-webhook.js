/**
 * Cloudflare Pages Function: /api/stripe-webhook
 *
 * Runs on Cloudflare's edge network (Workers runtime).
 * Uses stripe.webhooks.constructEventAsync() — the edge-compatible
 * signature verification method (no Node.js crypto module needed).
 *
 * Environment variables (set in CF Pages Dashboard → Settings → Environment variables):
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 *   SENDGRID_API_KEY, SENDGRID_FROM_EMAIL,
 *   SHIPPO_API_KEY, SHIPPO_FROM_*, SHIPPO_CARRIER_ACCOUNT,
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *
 * Stripe Dashboard → Webhooks → Add endpoint:
 *   URL:    https://zuwera.store/api/stripe-webhook
 *   Events: payment_intent.succeeded, payment_intent.payment_failed
 *
 * Note: Uses Stripe SDK v10+ which supports the Workers/edge runtime.
 *       Run `npm install stripe` in your project root before deploying.
 */

import Stripe from 'stripe';

const SERVICE_TOKEN_MAP = {
  'Priority Mail':         'usps_priority',
  'Ground Advantage':      'usps_ground_advantage',
  'Priority Mail Express': 'usps_priority_express',
  'UPS Ground':            'ups_ground',
  'UPS 2nd Day Air':       'ups_second_day_air',
  'FedEx Ground':          'fedex_ground',
  'FedEx 2Day':            'fedex_2_day',
};
const getServicelevelToken = (name) => SERVICE_TOKEN_MAP[name] || 'usps_priority';

export async function onRequestPost({ request, env }) {
  const stripe  = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
  const rawBody = await request.text();
  const sig     = request.headers.get('stripe-signature');

  let stripeEvent;
  try {
    // constructEventAsync is the edge-compatible version (no Node.js crypto)
    stripeEvent = await stripe.webhooks.constructEventAsync(
      rawBody, sig, env.STRIPE_WEBHOOK_SECRET
    );
  } catch (e) {
    console.error('Webhook signature verification failed:', e.message);
    return new Response(`Webhook Error: ${e.message}`, { status: 400 });
  }

  if (stripeEvent.type === 'payment_intent.succeeded') {
    const pi   = stripeEvent.data.object;
    const meta = pi.metadata || {};
    console.log(`✅ PaymentIntent succeeded: ${pi.id}`);

    const [labelResult, emailResult, orderResult] = await Promise.allSettled([
      createShippingLabel(pi, meta, env, stripe),
      sendConfirmationEmail(pi, meta, env),
      saveOrderToSupabase(pi, meta, env),
    ]);

    if (labelResult.status === 'rejected') console.error('Label failed:',   labelResult.reason);
    if (emailResult.status === 'rejected') console.error('Email failed:',   emailResult.reason);
    if (orderResult.status === 'rejected') console.error('DB save failed:', orderResult.reason);
  }

  if (stripeEvent.type === 'payment_intent.payment_failed') {
    const pi = stripeEvent.data.object;
    console.warn(`❌ Payment failed: ${pi.id} — ${pi.last_payment_error?.message}`);
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function createShippingLabel(pi, meta, env, stripe) {
  if (!env.SHIPPO_API_KEY) return null;

  const fromAddress = {
    name:    env.SHIPPO_FROM_NAME    || 'Zuwera',
    street1: env.SHIPPO_FROM_STREET1 || '123 Brand St',
    city:    env.SHIPPO_FROM_CITY    || 'Los Angeles',
    state:   env.SHIPPO_FROM_STATE   || 'CA',
    zip:     env.SHIPPO_FROM_ZIP     || '90001',
    country: env.SHIPPO_FROM_COUNTRY || 'US',
    email:   env.SHIPPO_FROM_EMAIL   || 'orders@zuwera.store',
  };

  const resp = await fetch('https://api.goshippo.com/transactions/', {
    method: 'POST',
    headers: { Authorization: `ShippoToken ${env.SHIPPO_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shipment: {
        address_from: fromAddress,
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
        parcels: [{ length: '14', width: '10', height: '4', distance_unit: 'in', weight: '2', mass_unit: 'lb' }],
      },
      carrier_account:    env.SHIPPO_CARRIER_ACCOUNT || undefined,
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

async function sendConfirmationEmail(pi, meta, env) {
  if (!env.SENDGRID_API_KEY) return null;

  const orderId      = pi.id.slice(-8).toUpperCase();
  const totalDollars = (pi.amount / 100).toFixed(2);
  const toEmail      = meta.customer_email;
  const toName       = meta.customer_name || 'Customer';
  const shippingLine = meta.shipping_provider && meta.shipping_service
    ? `${meta.shipping_provider} ${meta.shipping_service}` : 'Standard Shipping';

  let itemsHtml = '';
  try {
    itemsHtml = JSON.parse(meta.items || '[]').map(i =>
      `<tr><td>${i.name}</td><td>${i.quantity}x $${(i.amount/100).toFixed(2)}</td></tr>`
    ).join('');
  } catch (_) { itemsHtml = '<tr><td colspan="2">Your Zuwera order</td></tr>'; }

  const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: toEmail, name: toName }] }],
      from:     { email: env.SENDGRID_FROM_EMAIL || 'orders@zuwera.store', name: 'Zuwera' },
      reply_to: { email: 'nasirubreeze@zuwera.store', name: 'Zuwera Support' },
      subject:  `Order Confirmed — #${orderId}`,
      content:  [{ type: 'text/html', value: `<p>Order #${orderId} confirmed for ${toName}. Total: $${totalDollars}. Shipping via ${shippingLine}.</p>` }],
    }),
  });

  if (!resp.ok) throw new Error(`SendGrid error ${resp.status}`);
  return true;
}

async function saveOrderToSupabase(pi, meta, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;

  const items = (() => { try { return JSON.parse(meta.items || '[]'); } catch { return []; } })();

  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/orders`, {
    method: 'POST',
    headers: {
      apikey:         env.SUPABASE_SERVICE_KEY,
      Authorization:  `Bearer ${env.SUPABASE_SERVICE_KEY}`,
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
