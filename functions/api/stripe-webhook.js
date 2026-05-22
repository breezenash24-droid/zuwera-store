/**
 * Cloudflare Pages Function: /api/stripe-webhook
 *
 * Runs on Cloudflare's edge network (Workers runtime).
 * Uses stripe.webhooks.constructEventAsync() — edge-compatible signature verification.
 *
 * Environment variables (set in CF Pages Dashboard > Settings > Environment variables):
 *   STRIPE_SECRET_KEY        — Stripe secret key
 *   STRIPE_WEBHOOK_SECRET    — from Stripe Dashboard > Webhooks > your endpoint > Signing secret
 *   SHIPPO_API_KEY           — Shippo API key
 *   SHIPPO_FROM_NAME/STREET1/CITY/STATE/ZIP/COUNTRY/EMAIL — sender address
 *   RESEND_API_KEY           — for confirmation emails (optional)
 *   RESEND_FROM_EMAIL        — sender address for emails (optional)
 *   SUPABASE_URL             — Supabase project URL
 *   SUPABASE_SERVICE_KEY     — Supabase service role key (bypasses RLS)
 *
 * Stripe Dashboard > Webhooks > Add endpoint:
 *   URL:    https://zuwera.store/api/stripe-webhook
 *   Events: payment_intent.succeeded, payment_intent.payment_failed
 */

import Stripe from 'stripe';
import { fetchSiteSettings, resolveSetting } from './_settings.js';

// Fallback service-level token map if rate object ID is unavailable
const SERVICE_TOKEN_MAP = {
  'Priority Mail':         'usps_priority',
  'Ground Advantage':      'usps_ground_advantage',
  'Priority Mail Express': 'usps_priority_express',
  'First-Class Mail':      'usps_first',
  'UPS Ground':            'ups_ground',
  'UPS 2nd Day Air':       'ups_second_day_air',
  'FedEx Ground':          'fedex_ground',
  'FedEx 2Day':            'fedex_2_day',
};
const getServicelevelToken = (name) => SERVICE_TOKEN_MAP[name] || 'usps_ground_advantage';
const getSupabaseServiceKey = (env) => env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function onRequestPost({ request, env }) {
  // Guard: catch missing env vars early with clear log messages
  if (!env.STRIPE_SECRET_KEY)    console.error('MISSING ENV: STRIPE_SECRET_KEY not set in Cloudflare');
  if (!env.STRIPE_WEBHOOK_SECRET) console.error('MISSING ENV: STRIPE_WEBHOOK_SECRET not set in Cloudflare');
  if (!env.RESEND_API_KEY)        console.warn('MISSING ENV: RESEND_API_KEY not set — emails will be skipped');
  if (!env.SUPABASE_URL)          console.warn('MISSING ENV: SUPABASE_URL not set — orders will not be saved');

  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    return new Response(
      JSON.stringify({ error: 'Stripe webhook handler is not configured.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const stripe  = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
  const rawBody = await request.text();
  const sig     = request.headers.get('stripe-signature');

  // Verify webhook signature
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Webhook signature verification failed:', e.message);
    console.error('  → Check that STRIPE_WEBHOOK_SECRET in Cloudflare matches the signing secret');
    console.error('    from Stripe Dashboard > Webhooks > your endpoint for zuwera.store/api/stripe-webhook');
    console.error('  → Also make sure test/live mode matches: test payments need a TEST webhook secret');
    return new Response('Webhook Error: ' + e.message, { status: 400 });
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi   = event.data.object;
    const meta = pi.metadata || {};
    console.log('PaymentIntent succeeded:', pi.id);

    // Log receipt immediately — even if everything downstream fails, this confirms
    // Stripe is reaching the webhook and the signature is valid.
    logWebhookEvent(env, {
      event_type:     event.type,
      payment_intent: pi.id,
      customer_email: meta.customer_email || '',
      amount_cents:   pi.amount || 0,
      sig_verified:   true,
      raw_status:     'received',
    }).catch(e => console.warn('webhook_events log failed (non-fatal):', e.message));

    try {
      await handleSuccessfulPayment(pi, meta, env, stripe);
    } catch (e) {
      console.error('handleSuccessfulPayment failed:', e.message);
      logWebhookEvent(env, {
        event_type:     event.type,
        payment_intent: pi.id,
        sig_verified:   true,
        raw_status:     'handler_error',
        error_message:  e.message,
      }).catch(() => {});
      return new Response(
        JSON.stringify({ received: false, error: 'Fulfillment failed. Stripe should retry this event.' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    console.warn('Payment failed:', pi.id, pi.last_payment_error?.message || '');
    logWebhookEvent(env, {
      event_type:     event.type,
      payment_intent: pi.id,
      sig_verified:   true,
      raw_status:     'payment_failed',
      error_message:  pi.last_payment_error?.message || '',
    }).catch(() => {});
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Webhook event logger ──────────────────────────────────────────────────────
// Writes a lightweight row to webhook_events so we can verify Stripe is reaching
// this endpoint and the signature is passing. Non-fatal — never throws.

async function logWebhookEvent(env, fields) {
  const serviceKey = getSupabaseServiceKey(env);
  if (!env.SUPABASE_URL || !serviceKey) return;
  try {
    await fetch(env.SUPABASE_URL + '/rest/v1/webhook_events', {
      method:  'POST',
      headers: {
        apikey:         serviceKey,
        Authorization:  'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        Prefer:         'return=minimal',
      },
      body: JSON.stringify(fields),
    });
  } catch (_) { /* intentionally swallowed */ }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

async function handleSuccessfulPayment(pi, meta, env, stripe) {
  // Pre-fetch email keys + branding from Supabase api_key_overrides (admin overrides take priority)
  const emailKeyCache = await fetchSiteSettings(
    ['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM', 'BRAND_LOGO_URL'], env
  );

  // Step 1: Purchase the shipping label → gets tracking number
  let labelData = null;
  try {
    labelData = await createShippingLabel(pi, meta, env);
    console.log('Label created:', labelData?.tracking_number);
  } catch (e) {
    console.error('Label creation failed:', e.message);
    // Continue — still save the order and send email without tracking
  }

  const tracking = {
    number: labelData?.tracking_number || '',
    url:    labelData?.tracking_url_provider || '',
    label:  labelData?.label_url || '',
  };

  await saveOrderToSupabase(pi, meta, tracking, env);

  const [stripeUpdateResult, emailResult, invResult] = await Promise.allSettled([
    tracking.number
      ? stripe.paymentIntents.update(pi.id, {
          metadata: {
            tracking_number: tracking.number,
            tracking_url:    tracking.url,
            label_url:       tracking.label,
          },
        })
      : Promise.resolve(null),

    sendConfirmationEmail(pi, meta, tracking, env, emailKeyCache),

    // Decrement product_sizes stock_quantity for each purchased item
    decrementInventory(meta, env),
  ]);

  if (stripeUpdateResult.status === 'rejected') console.error('Stripe metadata update failed:', stripeUpdateResult.reason);
  if (emailResult.status     === 'rejected') console.error('Email failed:',                   emailResult.reason);
  if (invResult.status       === 'rejected') console.error('Inventory decrement failed:',     invResult.reason);
}

// ─── Create shipping label ─────────────────────────────────────────────────────

async function createShippingLabel(pi, meta, env) {
  if (!env.SHIPPO_API_KEY) throw new Error('SHIPPO_API_KEY not set');

  const rateObjectId = meta.shipping_rate_object_id;

  let body;

  if (rateObjectId) {
    // ✅ Fast path: use the exact rate fetched/shown at checkout
    body = {
      rate:            rateObjectId,
      label_file_type: 'PDF',
      async:           false,
    };
  } else {
    // Fallback: create a brand-new shipment (rate ID wasn't stored — rare)
    const fromAddress = {
      name:    env.SHIPPO_FROM_NAME    || 'Zuwera',
      street1: env.SHIPPO_FROM_STREET1 || '',
      city:    env.SHIPPO_FROM_CITY    || '',
      state:   env.SHIPPO_FROM_STATE   || '',
      zip:     env.SHIPPO_FROM_ZIP     || '',
      country: env.SHIPPO_FROM_COUNTRY || 'US',
      email:   env.SHIPPO_FROM_EMAIL   || 'orders@zuwera.store',
      phone:   env.SHIPPO_FROM_PHONE   || '',
    };
    // Scale parcel weight/size by total item quantity
    const _labelItems   = (() => { try { return JSON.parse(meta.items || '[]'); } catch { return []; } })();
    const _totalQty     = Math.max(1, _labelItems.reduce((s, i) => s + (i.quantity || 1), 0));
    const _weightLb     = (0.5 + _totalQty * 0.5).toFixed(1);
    const _heightIn     = _totalQty <= 1 ? '4' : _totalQty <= 3 ? '6' : '8';
    const _widthIn      = _totalQty <= 1 ? '10' : _totalQty <= 3 ? '12' : '14';

    body = {
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
        parcels: [{
          length: '14', width: _widthIn, height: _heightIn, distance_unit: 'in',
          weight: _weightLb, mass_unit: 'lb',
        }],
      },
      servicelevel_token: getServicelevelToken(meta.shipping_service || ''),
      label_file_type: 'PDF',
      async: false,
    };
  }

  const resp = await fetch('https://api.goshippo.com/transactions/', {
    method:  'POST',
    headers: {
      Authorization:  'ShippoToken ' + env.SHIPPO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();

  if (data.status !== 'SUCCESS') {
    throw new Error('Shippo label failed: ' + JSON.stringify(data.messages || data));
  }

  return data; // { tracking_number, tracking_url_provider, label_url, ... }
}

// ─── Decrement inventory ───────────────────────────────────────────────────────
// Reads the compact `inv` metadata field ({p: productId, s: size, q: qty}[])
// and subtracts the purchased quantities from product_sizes.stock_quantity.
// Non-fatal — a failed decrement never blocks order saving or emails.

async function decrementInventory(meta, env) {
  const serviceKey = getSupabaseServiceKey(env);
  if (!env.SUPABASE_URL || !serviceKey) return;

  let invItems;
  try {
    invItems = JSON.parse(meta.inv || '[]');
  } catch {
    console.warn('decrementInventory: could not parse inv metadata:', meta.inv);
    return;
  }
  if (!Array.isArray(invItems) || !invItems.length) return;

  const rpcHeaders = {
    apikey:         serviceKey,
    Authorization:  'Bearer ' + serviceKey,
    'Content-Type': 'application/json',
  };

  for (const { p: productId, s: size, q: qty } of invItems) {
    if (!productId || !size || !qty) continue;
    try {
      const rpcRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/decrement_stock`, {
        method:  'POST',
        headers: rpcHeaders,
        body:    JSON.stringify({ p_product_id: productId, p_size: size, p_qty: qty }),
      });
      if (!rpcRes.ok) {
        console.warn(`decrementInventory: RPC failed for ${productId} / ${size}:`, await rpcRes.text());
      } else {
        console.log(`Inventory decremented: ${productId} / ${size} by ${qty}`);
      }
    } catch (e) {
      console.warn(`decrementInventory error for ${productId} / ${size}:`, e.message);
    }
  }
}

// ─── Save order to Supabase ────────────────────────────────────────────────────

async function saveOrderToSupabase(pi, meta, tracking, env) {
  const serviceKey = getSupabaseServiceKey(env);
  if (!env.SUPABASE_URL || !serviceKey) throw new Error('Supabase order storage is not configured');

  // Idempotency: skip if an order for this PaymentIntent already exists
  const existingRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/orders?stripe_payment_intent_id=eq.${encodeURIComponent(pi.id)}&select=id&limit=1`,
    { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
  );
  if (existingRes.ok) {
    const existing = await existingRes.json().catch(() => []);
    if (Array.isArray(existing) && existing.length) {
      console.log(`Order for PI ${pi.id} already exists — idempotent skip`);
      return true;
    }
  }

  const items         = (() => { try { return JSON.parse(meta.items || '[]'); } catch { return []; } })();
  const subtotalCents = parseInt(meta.subtotal_amount_cents    || '0', 10);
  // charged_shipping_cents = what the customer actually paid (0 for free shipping)
  const shippingCents = parseInt(meta.charged_shipping_cents   || meta.shipping_amount_cents || '0', 10);
  const taxCents      = parseInt(meta.tax_amount_cents         || '0', 10);

  const resp = await fetch(env.SUPABASE_URL + '/rest/v1/orders', {
    method:  'POST',
    headers: {
      apikey:         serviceKey,
      Authorization:  'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      Prefer:         'return=minimal',
    },
    body: JSON.stringify({
      stripe_payment_intent_id: pi.id,
      user_id:          meta.user_id       || null,
      email:            meta.customer_email,
      customer_name:    meta.customer_name,
      items:            JSON.stringify(items),
      subtotal:         (subtotalCents / 100).toFixed(2),
      shipping:         (shippingCents  / 100).toFixed(2),
      tax:              (taxCents       / 100).toFixed(2),
      total:            (pi.amount      / 100).toFixed(2),
      free_shipping:    meta.free_shipping === 'true',
      ship_line1:       meta.ship_line1,
      ship_line2:       meta.ship_line2    || '',
      ship_city:        meta.ship_city,
      ship_state:       meta.ship_state,
      ship_zip:         meta.ship_zip,
      ship_country:     meta.ship_country  || 'US',
      shipping_provider: meta.shipping_provider || '',
      shipping_service:  meta.shipping_service  || '',
      tracking_number:   tracking.number,
      tracking_url:      tracking.url,
      label_url:         tracking.label,
      status:           'confirmed',
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error('Supabase insert failed (' + resp.status + '): ' + detail);
  }

  return true;
}

// ─── Send confirmation email ───────────────────────────────────────────────────

async function sendConfirmationEmail(pi, meta, tracking, env, emailKeyCache = {}) {
  const resendKey = resolveSetting('RESEND_API_KEY', env, emailKeyCache);
  if (!resendKey) return null;

  const toEmail  = (meta.customer_email || '').trim();
  if (!toEmail) return null;

  // Single from address used by BOTH Resend and Brevo — must be verified in both
  const fromEmail = resolveSetting('EMAIL_FROM', env, emailKeyCache)
    || (env.RESEND_FROM_EMAIL || '').trim()
    || 'orders@zuwera.store';

  // Brand logo — shown in email header (white wordmark works on dark background)
  const logoUrl = resolveSetting('BRAND_LOGO_URL', env, emailKeyCache)
    || 'https://zuwera.store/assets/Zuwera_Wordmark_White.png';

  const orderId      = pi.id.slice(-8).toUpperCase();
  const toName       = meta.customer_name || 'Customer';
  const totalDollars = (pi.amount / 100).toFixed(2);
  const carrier      = [meta.shipping_provider, meta.shipping_service].filter(Boolean).join(' ') || 'Standard Shipping';
  const subtotalCents = parseInt(meta.subtotal_amount_cents  || '0', 10);
  const shippingCents = parseInt(meta.charged_shipping_cents || '0', 10);
  const taxCents      = parseInt(meta.tax_amount_cents       || '0', 10);
  const discountCode  = (meta.discount_code || '').toUpperCase();
  const discountCents = parseInt(meta.discount_amount_cents  || '0', 10);

  // Fetch product images from Supabase by SKU/name (images are NOT stored in metadata
  // because long URLs exceed Stripe's 500-char per-value metadata limit)
  const productImageMap = {}; // key: sku or lowercased name → image_url
  const serviceKey = getSupabaseServiceKey(env);
  if (env.SUPABASE_URL && serviceKey) {
    try {
      const imgRes = await fetch(
        env.SUPABASE_URL + '/rest/v1/products?select=title,sku,image_url&limit=200',
        {
          headers: {
            apikey:        serviceKey,
            Authorization: 'Bearer ' + serviceKey,
          },
        }
      );
      if (imgRes.ok) {
        const prods = await imgRes.json();
        (prods || []).forEach(p => {
          if (p.sku        && p.image_url) productImageMap[p.sku.toLowerCase()]           = p.image_url;
          if (p.title      && p.image_url) productImageMap[p.title.trim().toLowerCase()]  = p.image_url;
        });
      }
    } catch (_) { /* non-fatal — email still sends without images */ }
  }

  let parsedItems = [];
  try { parsedItems = JSON.parse(meta.items || '[]'); } catch (_) {}

  const itemsHtml = parsedItems.length
    ? parsedItems.map(i => {
        const imageUrl = productImageMap[(i.sku || '').toLowerCase()]
                      || productImageMap[(i.name || '').trim().toLowerCase()]
                      || '';
        const imgCell = imageUrl
          ? `<img src="${imageUrl}" alt="${i.name}" width="72" height="90" style="width:72px;height:90px;object-fit:cover;border-radius:4px;display:block;">`
          : `<div style="width:72px;height:90px;background:rgba(244,241,235,.06);border-radius:4px;"></div>`;
        const variant = [i.size, i.color].filter(Boolean).join(' · ');
        return `<tr>
          <td style="padding:16px 0;border-bottom:1px solid rgba(244,241,235,.08);vertical-align:top;width:80px;">${imgCell}</td>
          <td style="padding:16px 12px;border-bottom:1px solid rgba(244,241,235,.08);vertical-align:top;">
            <div style="font-weight:600;font-size:15px;color:#f4f1eb;margin-bottom:4px;">${i.name}</div>
            ${variant ? `<div style="font-size:13px;color:rgba(244,241,235,.5);margin-bottom:4px;">${variant}</div>` : ''}
            ${i.sku ? `<div style="font-size:11px;color:rgba(244,241,235,.3);letter-spacing:.04em;font-family:monospace;">SKU: ${i.sku}</div>` : ''}
          </td>
          <td style="padding:16px 0;border-bottom:1px solid rgba(244,241,235,.08);vertical-align:top;text-align:right;white-space:nowrap;">
            <div style="font-size:14px;color:#f4f1eb;font-weight:500;">$${(i.amount / 100).toFixed(2)}</div>
            ${i.quantity > 1 ? `<div style="font-size:12px;color:rgba(244,241,235,.45);margin-top:3px;">× ${i.quantity}</div>` : ''}
          </td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="3" style="padding:16px 0;color:rgba(244,241,235,.5);">Your Zuwera order</td></tr>';

  const addrParts = [
    meta.ship_line1,
    meta.ship_line2,
    [meta.ship_city, meta.ship_state, meta.ship_zip].filter(Boolean).join(', '),
    meta.ship_country && meta.ship_country.toUpperCase() !== 'US' ? meta.ship_country : '',
  ].filter(Boolean);

  const addressHtml = addrParts.length ? `
      <tr><td style="padding:0 0 28px;">
        <p style="margin:0 0 8px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:rgba(244,241,235,.4);font-weight:600;">Ships To</p>
        <p style="margin:0;font-size:14px;color:rgba(244,241,235,.7);line-height:1.65;">${toName}<br>${addrParts.join('<br>')}</p>
      </td></tr>` : '';

  const discountRow = discountCode && discountCents > 0 ? `
            <tr>
              <td style="padding:4px 0;font-size:14px;color:rgba(244,241,235,.55);">Discount (${discountCode})</td>
              <td style="padding:4px 0;font-size:14px;text-align:right;color:#86c98e;">−$${(discountCents / 100).toFixed(2)}</td>
            </tr>` : '';

  const shippingDisplay = meta.free_shipping === 'true' ? 'Free' : `$${(shippingCents / 100).toFixed(2)}`;

  const etaText = (() => {
    const s = (meta.shipping_service || '').toLowerCase();
    if (/priority|express|overnight/.test(s)) return '1–3 business days';
    if (/first.?class/.test(s)) return '3–5 business days';
    if (/ground/.test(s)) return '5–7 business days';
    return '3–7 business days';
  })();

  const carrierHtml = `
      <tr><td style="padding:0 0 32px;">
        <p style="margin:0 0 8px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:rgba(244,241,235,.4);font-weight:600;">Delivery</p>
        <p style="margin:0;font-size:14px;color:rgba(244,241,235,.7);">Ships via ${carrier}</p>
        <p style="margin:4px 0 0;font-size:14px;color:rgba(244,241,235,.5);">Estimated delivery: ${etaText}</p>
        ${tracking.number ? `<p style="margin:6px 0 0;font-size:14px;color:rgba(244,241,235,.7);">Tracking: ${tracking.url ? `<a href="${tracking.url}" style="color:#f4f1eb;text-decoration:underline;">${tracking.number}</a>` : tracking.number}</p>` : ''}
      </td></tr>`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Order Confirmed – Zuwera</title>
</head>
<body style="margin:0;padding:0;background:#09090b;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#f4f1eb;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr><td align="center" style="padding:40px 20px 56px;">
      <table width="560" cellpadding="0" cellspacing="0" role="presentation" style="max-width:100%;width:100%;">

        <!-- Wordmark -->
        <tr><td style="padding-bottom:32px;">
          <img src="${logoUrl}" alt="ZUWERA" height="28" style="height:28px;width:auto;border:0;display:block;" onerror="this.style.display='none'">
        </td></tr>

        <!-- Confirmation heading -->
        <tr><td style="border-top:1px solid rgba(244,241,235,.12);padding:28px 0 32px;">
          <p style="margin:0 0 6px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:rgba(244,241,235,.4);font-weight:600;">Order Confirmed</p>
          <h1 style="margin:0 0 10px;font-size:34px;font-weight:700;line-height:1;color:#f4f1eb;">#${orderId}</h1>
          <p style="margin:0;font-size:14px;color:rgba(244,241,235,.5);line-height:1.6;">Thanks, ${toName}. Your order is confirmed and being prepared.</p>
        </td></tr>

        <!-- Items -->
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
            ${itemsHtml}
          </table>
        </td></tr>

        <!-- Pricing -->
        <tr><td style="padding:20px 0 0;">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
            <tr>
              <td style="padding:6px 0;font-size:14px;color:rgba(244,241,235,.55);">Subtotal</td>
              <td style="padding:6px 0;font-size:14px;text-align:right;color:#f4f1eb;">$${(subtotalCents / 100).toFixed(2)}</td>
            </tr>
            ${discountRow}
            <tr>
              <td style="padding:6px 0;font-size:14px;color:rgba(244,241,235,.55);">Shipping</td>
              <td style="padding:6px 0;font-size:14px;text-align:right;color:#f4f1eb;">${shippingDisplay}</td>
            </tr>
            <tr>
              <td style="padding:6px 0 0;font-size:14px;color:rgba(244,241,235,.55);">Tax</td>
              <td style="padding:6px 0 0;font-size:14px;text-align:right;color:#f4f1eb;">$${(taxCents / 100).toFixed(2)}</td>
            </tr>
            <tr>
              <td colspan="2" style="padding:0;"><div style="margin:12px 0;border-top:1px solid rgba(244,241,235,.12);"></div></td>
            </tr>
            <tr>
              <td style="font-size:16px;font-weight:700;color:#f4f1eb;padding-bottom:24px;">Total</td>
              <td style="font-size:16px;font-weight:700;text-align:right;color:#f4f1eb;padding-bottom:24px;">$${totalDollars}</td>
            </tr>
          </table>
        </td></tr>

        <!-- Shipping address -->
        ${addressHtml}

        <!-- Carrier / tracking -->
        ${carrierHtml}

        <!-- Footer -->
        <tr><td style="padding:32px 0 0;border-top:1px solid rgba(244,241,235,.08);">
          <p style="margin:0 0 6px;font-size:13px;color:rgba(244,241,235,.5);">
            <a href="https://zuwera.store/account/orders" style="color:rgba(244,241,235,.75);text-decoration:underline;">View order status</a>
            &nbsp;·&nbsp;
            <a href="https://zuwera.store/returns" style="color:rgba(244,241,235,.75);text-decoration:underline;">30-day free returns</a>
          </p>
          <p style="margin:0 0 20px;font-size:13px;color:rgba(244,241,235,.35);">Questions? <a href="mailto:orders@zuwera.store" style="color:rgba(244,241,235,.55);text-decoration:underline;">orders@zuwera.store</a></p>
          <p style="margin:0;font-size:12px;color:rgba(244,241,235,.2);">© ${new Date().getFullYear()} Zuwera. All rights reserved.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // ── Try Resend first ────────────────────────────────────────────────
  const resendResp = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      Authorization:  'Bearer ' + resendKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:     `Zuwera <${fromEmail}>`,
      to:       [toEmail],
      reply_to: 'orders@zuwera.store',
      subject:  `Order Confirmed – #${orderId}`,
      html,
    }),
  });

  if (resendResp.ok) {
    console.log('Email sent via Resend to', toEmail);
    return { provider: 'resend' };
  }

  // ── Resend failed — try Brevo fallback ──────────────────────────────
  const resendError = resendResp.status + ': ' + await resendResp.text().catch(() => '');
  console.warn('Resend failed (' + resendError + '), trying Brevo fallback…');

  const brevoKey = resolveSetting('BREVO_API_KEY', env, emailKeyCache);
  if (!brevoKey) {
    throw new Error('Resend error ' + resendError + ' — no BREVO_API_KEY set for fallback');
  }

  const brevoResp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method:  'POST',
    headers: {
      'api-key':      brevoKey,
      'Content-Type': 'application/json',
      Accept:         'application/json',
    },
    body: JSON.stringify({
      sender:      { name: 'Zuwera', email: fromEmail },
      to:          [{ email: toEmail, name: toName }],
      replyTo:     { email: 'orders@zuwera.store' },
      subject:     `Order Confirmed – #${orderId}`,
      htmlContent: html,
    }),
  });

  if (!brevoResp.ok) {
    const brevoError = brevoResp.status + ': ' + await brevoResp.text().catch(() => '');
    throw new Error('Both email providers failed. Resend: ' + resendError + ' | Brevo: ' + brevoError);
  }

  console.log('Email sent via Brevo fallback to', toEmail, '(Resend was unavailable)');
  return { provider: 'brevo', resendError };
}
