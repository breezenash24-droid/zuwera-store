/**
 * _processors.js — one place that knows how each payment processor differs.
 *
 * Adding a third processor should be a file and a line in the table at the
 * bottom, not an edit to every route that touches money. Before this it was the
 * second: admin-refund.js had grown `if (isPayPal) … if (!isPayPal) …` around
 * three separate operations, and a third processor would have made that a
 * three-way branch in each of them — the shape where one branch quietly gets
 * missed and the bug is a refund that does not happen.
 *
 * ── WHAT IS ALREADY SHARED, AND SHOULD STAY THAT WAY ────────────────────────
 *
 * Most of this system is processor-agnostic and was built that way on purpose:
 *
 *   _cart-pricing.js   quoteCart() prices a cart. Every processor calls it, so
 *                      none of them can drift into charging a different number.
 *   _fulfil.js         handleSuccessfulPayment() takes a duck-typed payment —
 *                      an id and an amount — and does the label, the order row,
 *                      the email, the stock, the loyalty, the tax filing.
 *   orders.processor   which one took it (migration 0018).
 *   orders.tax_txn     the filing reference (0019), on the ORDER rather than on
 *                      a Stripe PaymentIntent, which is where it used to live
 *                      and where a PayPal order could never put it.
 *
 * So this file is deliberately SMALL. It covers only the operations that
 * genuinely cannot be shared, and every one of them is about money moving back
 * out rather than in.
 *
 * ── THE INTERFACE ───────────────────────────────────────────────────────────
 *
 *   id            matches orders.processor
 *   label         what a human is shown
 *   available(env)  is it configured at all
 *   reference(order)
 *                 the id THIS processor's API expects, from the order row. The
 *                 column is called stripe_payment_intent_id and holds a PayPal
 *                 capture id too — deliberately, so order dedupe stays one
 *                 column — so each processor says how to read it.
 *   refundedSoFar({ env, order, reference, ledgerCents, ledgerCount })
 *                 → { refundedCents, chargedCents, count, known, … }
 *                 `known:false` means "cannot establish", and it must never be
 *                 spelled as a zero: a zero reads as "nothing refunded yet" and
 *                 permits a second refund on top of a first.
 *   refund({ env, order, reference, amountCents, reason, idempotencyKey })
 *                 → { ok, id, amountCents } | { ok:false, error, alreadyRefunded }
 *                 amountCents 0 or absent means refund everything.
 *
 * A processor that cannot answer one of these should say so rather than guess.
 * Every default in here fails towards refusing, because the cost of refusing a
 * refund is a support email and the cost of allowing a wrong one is money.
 */

import Stripe from 'stripe';
import { paypalCaptureState, refundPayPalCapture, reconcilePayPalRefunds } from './_paypal.js';
import { paypalConfig } from './_paypal.js';

/* ── Stripe ──────────────────────────────────────────────────────────────── */

const stripeProcessor = {
  id: 'stripe',
  label: 'Stripe',
  available: (env) => Boolean(env && env.STRIPE_SECRET_KEY),
  reference: (order) => String((order && order.stripe_payment_intent_id) || ''),

  async refundedSoFar({ env, reference }) {
    const unknown = { refundedCents: 0, chargedCents: 0, count: 0, known: false };
    if (!reference || !env.STRIPE_SECRET_KEY) return unknown;
    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
    try {
      const pi = await stripe.paymentIntents.retrieve(reference, { expand: ['latest_charge'] });
      const charge = pi && pi.latest_charge;
      const chargedCents = Number(
        (charge && charge.amount_captured) || (charge && charge.amount) || pi.amount_received || pi.amount || 0
      );
      /* The refunds themselves rather than charge.amount_refunded alone: a
         refund still pending shows in the list before it settles into the
         total, and money on its way out is money already spent for this
         purpose. */
      const list = await stripe.refunds.list({ payment_intent: reference, limit: 100 });
      const refunds = (list && Array.isArray(list.data) ? list.data : [])
        .filter((r) => r && r.status !== 'failed' && r.status !== 'canceled');
      const summed = refunds.reduce((n, r) => n + Number(r.amount || 0), 0);
      const reported = Number((charge && charge.amount_refunded) || 0);
      return {
        /* The larger of the two. They agree in the ordinary case; when they do
           not, the bigger number is the safer one to plan a refund against. */
        refundedCents: Math.max(summed, reported),
        chargedCents,
        count: refunds.length,
        known: true,
      };
    } catch (e) {
      console.warn('stripe refundedSoFar failed:', e && e.message);
      return unknown;
    }
  },

  async refund({ env, order, reference, amountCents, reason, adminId, adminEmail, action }) {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
    const params = {
      payment_intent: reference,
      reason: toStripeReason(reason),
      metadata: {
        order_id: String((order && order.id) || ''),
        admin_id: String(adminId || ''),
        admin_email: String(adminEmail || ''),
        action: String(action || ''),
        reason: String(reason || ''),
      },
    };
    if (Number.isFinite(Number(amountCents)) && Number(amountCents) > 0) {
      params.amount = Math.round(Number(amountCents));
    }
    try {
      const ref = await stripe.refunds.create(params);
      return { ok: true, id: ref.id, amountCents: ref.amount };
    } catch (err) {
      return { ok: false, error: 'Stripe error: ' + (err && err.message) };
    }
  },

  /* Where the tax filing reference lives for orders taken before 0019 added a
     column for it. Stripe was the only processor then, so this fallback is
     complete rather than partial. */
  async legacyTaxTransactionId({ env, reference }) {
    if (!reference || !env.STRIPE_SECRET_KEY) return '';
    try {
      const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
      const pi = await stripe.paymentIntents.retrieve(reference);
      return String((pi && pi.metadata && pi.metadata.tax_txn) || '');
    } catch (_) { return ''; }
  },
};

/* Stripe's own enum. Anything it does not recognise is rejected outright, so an
   unmapped reason must become one it knows rather than be passed through. */
function toStripeReason(reason) {
  const r = String(reason || '').toLowerCase();
  if (r.includes('fraud')) return 'fraudulent';
  if (r.includes('duplicate')) return 'duplicate';
  return 'requested_by_customer';
}

/* ── PayPal ──────────────────────────────────────────────────────────────── */

const paypalProcessor = {
  id: 'paypal',
  label: 'PayPal',
  available: (env) => paypalConfig(env).configured,
  /* Stored with a paypal_ prefix so it is never mistaken for a Stripe id.
     PayPal wants it bare. */
  reference: (order) => String((order && order.stripe_payment_intent_id) || '').replace(/^paypal_/, ''),

  async refundedSoFar({ env, reference, ledgerCents, ledgerCount }) {
    const state = await paypalCaptureState(env, reference);
    /* PayPal will not say how much of a PARTIAL refund went back, so this
       reconciles its status against what this panel recorded. See
       reconcilePayPalRefunds for why neither source is trusted alone. */
    return reconcilePayPalRefunds(state, ledgerCents, ledgerCount);
  },

  async refund({ env, reference, amountCents, reason, idempotencyKey }) {
    return refundPayPalCapture(env, {
      captureId: reference,
      amountCents: Number(amountCents) || 0,
      note: String(reason || '').slice(0, 255),
      requestId: idempotencyKey,
    });
  },

  /* No legacy location: PayPal orders only exist after 0019, so the order row
     is the only place this was ever kept. */
  async legacyTaxTransactionId() { return ''; },
};

/* ── The table ───────────────────────────────────────────────────────────────
   Adding a processor: implement the interface above and add it here. Nothing
   in admin-refund.js should need to know the name. */
export const PROCESSORS = {
  stripe: stripeProcessor,
  paypal: paypalProcessor,
};

/**
 * Which processor handled an order. Falls back to Stripe for rows written
 * before orders.processor existed — accurate, because nothing else could take
 * an order then.
 *
 * An UNRECOGNISED name returns null rather than defaulting. A processor this
 * build does not know about is one whose refund rules it also does not know,
 * and quietly refunding it as Stripe would send a capture id to the wrong API.
 */
export function processorFor(order) {
  const name = String((order && order.processor) || 'stripe').toLowerCase();
  return PROCESSORS[name] || null;
}
