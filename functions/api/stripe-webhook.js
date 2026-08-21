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
/* Fulfilment lives in _fulfil.js so PayPal can reach it without importing
   this route, and with it the Stripe SDK. Same reasoning as _cart-pricing.js. */
import { handleSuccessfulPayment, getSupabaseServiceKey } from './_fulfil.js';
import { sendOrderAlerts } from './_order-alerts.js';
import { mutateSetting } from './_commerce.js';
import { notifyOps } from './_notify-ops.js';
import { loopsFallback } from './_email.js';
import { getEmailAppearance, getEmailContent, fillTemplate, renderEmailShell } from './_email-theme.js';
import { buildUserData, sendCapiEvents } from './_capi.js';
import { veeqoBookShipment } from './_veeqo.js';
import { incrementShippoMonthlyCount, recordLabelFailure } from './_shipping-usage.js';
/* One function decides what an order is called. Spelling the fallback out
   here again is how a store ends up with six names for one order. */
import { orderNoPlain } from './_order-no.js';

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

// Per-COLOUR image map so order emails/records show each variant's OWN photo
async function alreadyHandled(env, event) {
  const key = getSupabaseServiceKey(env);
  if (!env.SUPABASE_URL || !key || !event || !event.id) return false;
  try {
    const res = await fetch(env.SUPABASE_URL + '/rest/v1/processed_events', {
      method: 'POST',
      headers: {
        apikey: key, Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({ event_id: event.id, event_type: event.type || null }),
    });
    if (res.ok) return false;                       // claimed it — first time through
    // 409 is the primary key refusing a second insert: someone else has it.
    if (res.status === 409) return true;
    /* Anything else (404 no table, 401, 5xx) means we could not establish
       either way. Proceed — the older order-exists guard still stands behind
       this for the common case. */
    console.warn('Dedupe unavailable (' + res.status + ') — proceeding without it');
    return false;
  } catch (e) {
    console.warn('Dedupe check failed (' + e.message + ') — proceeding without it');
    return false;
  }
}

/* Give the claim back.
 *
 * alreadyHandled() claims an event BEFORE fulfilment runs, which is right — two
 * concurrent deliveries of the same event must not both create an order. But it
 * made a failure permanent: the row stayed, so every Stripe retry hit the 409,
 * was read as "already done", and did nothing. The handler answered 500 saying
 * "Stripe should retry this event" while guaranteeing the retry could not work.
 *
 * That is how an order survives a transient fault and still never gets its
 * confirmation email, its label or its stock decrement — for ever, with the
 * retries that exist to fix exactly this quietly turned into no-ops.
 *
 * Best-effort: if releasing fails, the event stays claimed and we are no worse
 * off than before. */
async function releaseClaim(env, event) {
  const key = getSupabaseServiceKey(env);
  if (!env.SUPABASE_URL || !key || !event?.id) return;
  try {
    await fetch(
      env.SUPABASE_URL + '/rest/v1/processed_events?event_id=eq.' + encodeURIComponent(event.id),
      { method: 'DELETE', headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'return=minimal' } },
    );
  } catch (e) {
    console.warn('Could not release the dedupe claim for ' + event.id + ': ' + e.message);
  }
}

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

  /* ── Has this exact delivery been handled already? ──────────────────────
     There was already a guard: "does an order for this PaymentIntent exist".
     It catches the ordinary retry and misses two things. Two deliveries
     arriving at once can BOTH pass it before either writes, because a
     select-then-insert has a gap between the looking and the writing. And an
     event that creates no order — a dispute, a refund — has nothing to look
     for, so it is not deduped at all.

     Keyed on Stripe's event id, which is stable across retries and unique per
     delivery. The PRIMARY KEY is the lock: both racers insert, exactly one
     succeeds, and the loser gets a duplicate-key error it reads as "someone
     else has this". No window between the check and the claim, because the
     check IS the claim.

     Only a genuine duplicate stops the handler. If the table is missing —
     migration 0006 not applied yet — this proceeds exactly as it does today.
     Treating "cannot dedupe" as "already done" would silently drop every
     order, which is a far worse failure than the one it guards against. */
  if (await alreadyHandled(env, event)) {
    console.log('Duplicate delivery of', event.id, '— already handled');
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
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
      /* The callback is the only Stripe-shaped thing fulfilment still needs:
         somewhere to write the tracking number back to. */
      await handleSuccessfulPayment(pi, meta, env, (tracking) => stripe.paymentIntents.update(pi.id, {
        metadata: {
          tracking_number: tracking.number,
          tracking_url:    tracking.url,
          // Veeqo labels come back as a large base64 data URL — too big for
          // Stripe metadata (500-char cap). Only store real hosted URLs here;
          // the full label is always saved on the order row in Supabase.
          label_url:       (tracking.label && tracking.label.length <= 480) ? tracking.label : '',
        },
        /* And onto the shipping record itself, where Stripe reads it.
           A "product not received" dispute is answered with the address it went
           to and the tracking number that proves it arrived; in metadata those
           are notes to ourselves, here they are evidence Stripe can submit.

           The whole hash is resent, not just the two new fields — Stripe
           replaces `shipping` rather than merging into it, so sending only the
           carrier would erase the address this exists to preserve. Skipped
           entirely when the intent has no shipping, which is every order placed
           before that was set. */
        ...(pi.shipping && pi.shipping.address ? {
          shipping: {
            name:    pi.shipping.name || '',
            ...(pi.shipping.phone ? { phone: pi.shipping.phone } : {}),
            address: pi.shipping.address,
            carrier: meta.shipping_service || meta.shipping_provider || '',
            tracking_number: tracking.number,
          },
        } : {}),
      }));
    } catch (e) {
      console.error('handleSuccessfulPayment failed:', e.message);
      /* Hand the claim back BEFORE answering 500, or the retry this response
         asks for is deduped away and the order is never fulfilled at all. */
      await releaseClaim(env, event);
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

    // Chat alerts (admin → APIs → More Integrations). Deliberately AFTER the
    // try/catch above, so it only runs once fulfilment has actually succeeded,
    // and deliberately not awaited into the response path — a Slack outage must
    // never turn a paid, fulfilled order into a 500 that Stripe then retries.
    // Same fire-and-forget shape as logWebhookEvent above.
    sendOrderAlerts(env, {
      orderNumber: orderNoPlain({ order_number: meta.order_number, stripe_payment_intent_id: pi.id }),
      totalCents:  pi.amount || 0,
      email:       meta.customer_email || '',
      items:       (() => { try { return JSON.parse(meta.items || '[]'); } catch { return []; } })(),
    }).catch(e => console.warn('order alerts failed (non-fatal):', e.message));
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
