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

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function onRequestPost({ request, env }) {
  // Guard: catch missing env vars early with clear log messages
  if (!env.STRIPE_SECRET_KEY)    console.error('MISSING ENV: STRIPE_SECRET_KEY not set in Cloudflare');
  if (!env.STRIPE_WEBHOOK_SECRET) console.error('MISSING ENV: STRIPE_WEBHOOK_SECRET not set in Cloudflare');
  if (!env.RESEND_API_KEY)        console.warn('MISSING ENV: RESEND_API_KEY not set — emails will be skipped');
  if (!env.SUPABASE_URL)          console.warn('MISSING ENV: SUPABASE_URL not set — orders will not be saved');

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
      // Always return 200 to Stripe so it doesn't retry — log the error internally
      console.error('handleSuccessfulPayment failed:', e.message);
      logWebhookEvent(env, {
        event_type:     event.type,
        payment_intent: pi.id,
        sig_verified:   true,
        raw_status:     'handler_error',
        error_message:  e.message,
      }).catch(() => {});
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
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return;
  try {
    await fetch(env.SUPABASE_URL + '/rest/v1/webhook_events', {
      method:  'POST',
      headers: {
        apikey:         env.SUPABASE_SERVICE_KEY,
        Authorization:  'Bearer ' + env.SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json',
        Prefer:         'return=minimal',
      },
      body: JSON.stringify(fields),
    });
  } catch (_) { /* intentionally swallowed */ }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

async function handleSuccessfulPayment(pi, meta, env, stripe) {
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

  // Step 2: Everything else in parallel now that we have tracking info
  const [stripeUpdateResult, dbResult, emailResult, invResult] = await Promise.allSettled([
    // Update Stripe PaymentIntent metadata with tracking
    tracking.number
      ? stripe.paymentIntents.update(pi.id, {
          metadata: {
            tracking_number: tracking.number,
            tracking_url:    tracking.url,
            label_url:       tracking.label,
          },
        })
      : Promise.resolve(null),

    // Save order to Supabase (with tracking already available)
    saveOrderToSupabase(pi, meta, tracking, env),

    // Send confirmation email
    sendConfirmationEmail(pi, meta, tracking, env),

    // Decrement product_sizes stock_quantity for each purchased item
    decrementInventory(meta, env),
  ]);

  if (stripeUpdateResult.status === 'rejected') console.error('Stripe metadata update failed:', stripeUpdateResult.reason);
  if (dbResult.status        === 'rejected') console.error('Supabase save failed:',          dbResult.reason);
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
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return;

  let invItems;
  try {
    invItems = JSON.parse(meta.inv || '[]');
  } catch {
    console.warn('decrementInventory: could not parse inv metadata:', meta.inv);
    return;
  }
  if (!Array.isArray(invItems) || !invItems.length) return;

  const authHeaders = {
    apikey:         env.SUPABASE_SERVICE_KEY,
    Authorization:  'Bearer ' + env.SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json',
    Prefer:         'return=minimal',
  };

  for (const { p: productId, s: size, q: qty } of invItems) {
    if (!productId || !size || !qty) continue;
    try {
      // Fetch current stock for this product + size
      const getRes = await fetch(
        `${env.SUPABASE_URL}/rest/v1/product_sizes?select=stock_quantity&product_id=eq.${encodeURIComponent(productId)}&size=eq.${encodeURIComponent(size)}&limit=1`,
        { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_KEY } }
      );
      if (!getRes.ok) {
        console.warn(`decrementInventory: GET failed for ${productId} / ${size}:`, getRes.status);
        continue;
      }
      const rows = await getRes.json();
      if (!rows?.length) {
        console.warn(`decrementInventory: no row found for productId=${productId} size=${size}`);
        continue;
      }

      const currentStock = parseInt(rows[0].stock_quantity ?? '0', 10);
      const newStock     = Math.max(0, currentStock - qty);

      const patchRes = await fetch(
        `${env.SUPABASE_URL}/rest/v1/product_sizes?product_id=eq.${encodeURIComponent(productId)}&size=eq.${encodeURIComponent(size)}`,
        { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ stock_quantity: newStock }) }
      );
      if (!patchRes.ok) {
        console.warn(`decrementInventory: PATCH failed for ${productId} / ${size}:`, await patchRes.text());
      } else {
        console.log(`Inventory updated: ${productId} / ${size}: ${currentStock} → ${newStock}`);
      }
    } catch (e) {
      console.warn(`decrementInventory error for ${productId} / ${size}:`, e.message);
    }
  }
}

// ─── Save order to Supabase ────────────────────────────────────────────────────

async function saveOrderToSupabase(pi, meta, tracking, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;

  const items         = (() => { try { return JSON.parse(meta.items || '[]'); } catch { return []; } })();
  const subtotalCents = parseInt(meta.subtotal_amount_cents    || '0', 10);
  // charged_shipping_cents = what the customer actually paid (0 for free shipping)
  const shippingCents = parseInt(meta.charged_shipping_cents   || meta.shipping_amount_cents || '0', 10);
  const taxCents      = parseInt(meta.tax_amount_cents         || '0', 10);

  const resp = await fetch(env.SUPABASE_URL + '/rest/v1/orders', {
    method:  'POST',
    headers: {
      apikey:         env.SUPABASE_SERVICE_KEY,
      Authorization:  'Bearer ' + env.SUPABASE_SERVICE_KEY,
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

async function sendConfirmationEmail(pi, meta, tracking, env) {
  if (!env.RESEND_API_KEY) return null;

  const toEmail  = (meta.customer_email || '').trim();
  if (!toEmail) return null;

  const fromEmail = (env.RESEND_FROM_EMAIL || 'onboarding@resend.dev').trim(); // trim newlines/spaces

  const orderId      = pi.id.slice(-8).toUpperCase();
  const toName       = meta.customer_name || 'Customer';
  const totalDollars = (pi.amount / 100).toFixed(2);
  const carrier      = [meta.shipping_provider, meta.shipping_service].filter(Boolean).join(' ') || 'Standard Shipping';

  // Fetch product images from Supabase by SKU/name (images are NOT stored in metadata
  // because long URLs exceed Stripe's 500-char per-value metadata limit)
  const productImageMap = {}; // key: sku or lowercased name → image_url
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    try {
      const imgRes = await fetch(
        env.SUPABASE_URL + '/rest/v1/products?select=title,sku,image_url&limit=200',
        {
          headers: {
            apikey:        env.SUPABASE_SERVICE_KEY,
            Authorization: 'Bearer ' + env.SUPABASE_SERVICE_KEY,
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

  let itemsHtml = '';
  try {
    itemsHtml = JSON.parse(meta.items || '[]').map(i => {
      const imageUrl = productImageMap[(i.sku || '').toLowerCase()]
                    || productImageMap[(i.name || '').trim().toLowerCase()]
                    || '';
      const imgHtml = imageUrl
        ? `<img src="${imageUrl}" alt="${i.name}" width="64" height="64" style="width:64px;height:64px;object-fit:cover;border-radius:6px;display:block;">`
        : `<div style="width:64px;height:64px;border-radius:6px;background:#f4f1eb;display:flex;align-items:center;justify-content:center;font-size:1.4rem;">👕</div>`;
      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #eee;vertical-align:middle;width:80px">${imgHtml}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #eee;vertical-align:middle">
          <div style="font-weight:600;font-size:.9rem">${i.name}</div>
          ${i.sku ? `<div style="font-size:.78rem;color:#999">SKU: ${i.sku}</div>` : ''}
        </td>
        <td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;vertical-align:middle;white-space:nowrap;font-size:.9rem">${i.quantity} × $${(i.amount / 100).toFixed(2)}</td>
      </tr>`;
    }).join('');
  } catch (_) {
    itemsHtml = '<tr><td colspan="3">Your Zuwera order</td></tr>';
  }

  const trackingHtml = tracking.number
    ? `<p style="margin:16px 0 0">
        <strong>Tracking:</strong>
        ${tracking.url
          ? `<a href="${tracking.url}" style="color:#F891A5">${tracking.number}</a>`
          : tracking.number}
       </p>`
    : '';

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f1eb;font-family:'DM Sans',Helvetica,Arial,sans-serif;color:#09090b">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:100%">
        <tr><td style="background:#09090b;padding:28px 36px">
          <h1 style="margin:0;font-family:Georgia,serif;font-size:1.6rem;letter-spacing:.12em;color:#f4f1eb">ZUWERA</h1>
        </td></tr>
        <tr><td style="padding:32px 36px">
          <h2 style="margin:0 0 8px;font-size:1.1rem">Order Confirmed ✓</h2>
          <p style="margin:0 0 24px;color:#666;font-size:.9rem">Order #${orderId} — Thank you, ${toName}!</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:.9rem;margin-bottom:20px">
            ${itemsHtml}
          </table>
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:.9rem">
            <tr>
              <td style="padding:4px 0;color:#666">Shipping</td>
              <td style="padding:4px 0;text-align:right">${meta.free_shipping === 'true' ? 'Free' : '$' + (parseInt(meta.charged_shipping_cents || '0') / 100).toFixed(2)}</td>
            </tr>
            <tr>
              <td style="padding:4px 0;color:#666">Tax</td>
              <td style="padding:4px 0;text-align:right">$${(parseInt(meta.tax_amount_cents || '0') / 100).toFixed(2)}</td>
            </tr>
            <tr>
              <td style="padding:8px 0 0;font-weight:700">Total</td>
              <td style="padding:8px 0 0;text-align:right;font-weight:700">$${totalDollars}</td>
            </tr>
          </table>
          <p style="margin:20px 0 0;font-size:.85rem;color:#666">Ships via <strong>${carrier}</strong></p>
          ${trackingHtml}
        </td></tr>
        <tr><td style="background:#f4f1eb;padding:20px 36px;font-size:.78rem;color:#888;text-align:center">
          Questions? Reply to this email or visit zuwera.store
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const resp = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      Authorization:  'Bearer ' + env.RESEND_API_KEY,
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

  if (!resp.ok) throw new Error('Resend error ' + resp.status + ': ' + await resp.text());
  return true;
}
