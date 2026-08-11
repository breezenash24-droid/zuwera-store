/**
 * POST /api/admin-refund
 *
 * Two-factor protected refund / cancellation endpoint.
 *
 * Factor 1 — Supabase admin JWT:    proves who you are
 * Factor 2 — REFUND_SECRET env var: proves you authorized this specific action
 *            (separate from admin password, never stored in the database)
 *
 * Rate limiting: 5 wrong codes within 10 minutes → 1-hour lockout.
 * On lockout: alert email sent immediately via Resend (Brevo fallback).
 * Every attempt (success and failure) is appended to the refund audit log.
 */

import Stripe from 'stripe';
import { cors, json, verifyAdmin, decide, getSetting, setSetting, getCommerceBundle } from './_commerce.js';
import { permsHave } from './_rbac.js';
import { fetchSiteSettings, resolveSetting } from './_settings.js';
import { getEmailAppearance, renderEmailShell } from './_email-theme.js';

const RATE_LIMIT_KEY = 'refund_rate_limit';
const AUDIT_LOG_KEY  = 'refund_audit_log';
const MAX_BAD        = 5;
const WINDOW_MS      = 10 * 60 * 1000;  // 10 minutes
const LOCKOUT_MS     = 60 * 60 * 1000;  // 1 hour

// ── Entry point ───────────────────────────────────────────────────────────────

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  const h = cors(env);

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid request body.' }, 400, h);
  }

  const { accessToken, orderId, refundKey, action, amountCents, reason, customerNote } = body;

  // ── 1. Verify admin JWT + refund permission ─────────────────────────────────
  const admin = await verifyAdmin(env, accessToken);
  if (!admin) return json({ error: 'Unauthorized.' }, 403, h);
  if (!permsHave(admin.permissions, 'refund')) {
    await audit(env, {
      adminId: String(admin.id || ''), adminEmail: String(admin.email || ''),
      orderId, action, success: false, note: `blocked: role "${admin.admin_role}" lacks refund permission`,
    });
    return json({ error: 'Your role does not have permission to issue refunds.' }, 403, h);
  }

  // ── 2. REFUND_SECRET must exist in Cloudflare env vars ──────────────────────
  const secret = env.REFUND_SECRET;
  if (!secret) {
    return json({
      error: 'Refund system is not configured. Add REFUND_SECRET to your Cloudflare environment variables.',
    }, 503, h);
  }

  const adminId    = String(admin.id || admin.profile?.id || 'unknown');
  const adminEmail = String(admin.email || admin.profile?.email || '');

  // ── 3. Rate-limit check ──────────────────────────────────────────────────────
  const limitData = await getSetting(env, RATE_LIMIT_KEY, {}).catch(() => ({}));
  const entry = limitData?.[adminId] || { attempts: 0, windowStart: 0, lockedUntil: 0 };
  const now = Date.now();

  if (entry.lockedUntil && now < entry.lockedUntil) {
    const mins = Math.ceil((entry.lockedUntil - now) / 60000);
    await audit(env, { adminId, adminEmail, orderId, action, success: false, note: 'rate_limited' });
    return json({
      error: `Too many failed attempts. Refund access is locked for ${mins} more minute${mins !== 1 ? 's' : ''}.`,
    }, 429, h);
  }

  // ── 4. Validate authorization code ──────────────────────────────────────────
  if (!refundKey || refundKey !== secret) {
    const inWindow    = now - (entry.windowStart || 0) < WINDOW_MS;
    const attempts    = inWindow ? (entry.attempts || 0) + 1 : 1;
    const windowStart = inWindow ? (entry.windowStart || now) : now;
    const justLocked  = attempts >= MAX_BAD;
    const lockedUntil = justLocked ? now + LOCKOUT_MS : (entry.lockedUntil || 0);

    await setSetting(env, RATE_LIMIT_KEY, {
      ...limitData,
      [adminId]: { attempts, windowStart, lockedUntil },
    });
    await audit(env, { adminId, adminEmail, orderId, action, success: false, note: 'invalid_key', attempts });

    // Send alert email when the lockout threshold is crossed
    if (justLocked) {
      await sendLockoutAlert(env, { adminEmail, adminId, orderId, attempts, lockedUntil });
    }

    const remaining = MAX_BAD - attempts;
    const msg = remaining <= 0
      ? 'Incorrect code. Refund access is locked for 1 hour. A security alert has been sent to your email.'
      : `Incorrect authorization code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining before lockout.`;
    return json({ error: msg }, 403, h);
  }

  // Good code — reset rate-limit counter for this admin
  if ((entry.attempts || 0) > 0) {
    await setSetting(env, RATE_LIMIT_KEY, {
      ...limitData,
      [adminId]: { attempts: 0, windowStart: 0, lockedUntil: 0 },
    });
  }

  // ── 5. Validate action ───────────────────────────────────────────────────────
  if (!['cancel', 'cancel_refund', 'refund', 'check'].includes(action)) {
    return json({ error: 'Invalid action.' }, 400, h);
  }
  if (!orderId) return json({ error: 'orderId is required.' }, 400, h);

  // ── 6. Fetch order from Supabase ─────────────────────────────────────────────
  const sbKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
  const sbH   = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  const orderRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&select=*&limit=1`,
    { headers: sbH }
  );
  const orders = orderRes.ok ? await orderRes.json().catch(() => []) : [];
  const order  = orders?.[0];
  if (!order) return json({ error: 'Order not found.' }, 404, h);

  /* The limits an owner set under Users. The role said yes; this asks whether
     it is allowed for THIS refund.

     Placed AFTER the order loads, because it needs the order: the amount, and
     how many items the refund covers. Written earlier in the handler it read
     `order` before its declaration — a temporal dead zone error that would have
     thrown on every refund, not just limited ones.

     Amount in DOLLARS, because that is the unit the panel asks for. Passing
     cents against a limit written as "$500" would refuse every refund over five
     dollars and look exactly like the limit working. */
  const refundDollars = Number.isFinite(Number(amountCents))
    ? Number(amountCents) / 100
    : (Number(order.total) || null);
  const verdict = await decide(env, accessToken, 'refund', {
    action: 'refund',
    resource: {
      amount: refundDollars,
      /* How MANY, not just how much. A ten-item refund is a different kind of
         decision from an expensive one, and a store may want to stop one
         without stopping the other. */
      itemCount: Array.isArray(order.items) ? order.items.length : null,
      orderId: String(orderId || ''),
    },
  });
  if (!verdict.allow) {
    await audit(env, {
      adminId: String(admin.id || ''), adminEmail: String(admin.email || ''),
      orderId, action, success: false, note: `blocked by limit: ${verdict.reason}`,
    });
    return json({
      error: verdict.reason || 'A limit on your account stopped this refund.',
      limited: !!verdict.limited,
      /* Which limit, so the panel can ask about THIS one. A request that does
         not name the rule it is about cannot be turned into a waiver — the
         engine matches on it, and a yes to one limit is not a yes to all. */
      rule: verdict.rule || '',
      /* A super admin on a "notify" limit is told they may proceed by changing
         it — they have the power, they just have not used it. */
      ownerMayOverride: !!verdict.ownerMayOverride,
    }, 403, h);
  }

  // ── 7. Guard against invalid state transitions ───────────────────────────────
  if (order.status === 'cancelled') {
    return json({ error: 'Order is already cancelled.' }, 400, h);
  }
  /* `check` is allowed past, because the whole point of it is to report on an
     order in exactly this state before somebody tries. */
  if (order.status === 'refunded' && action !== 'cancel' && action !== 'check') {
    return json({ error: 'Order has already been fully refunded.' }, 400, h);
  }
  if (action !== 'cancel' && !order.stripe_payment_intent_id) {
    return json({ error: 'No Stripe payment on record for this order — cannot issue refund.' }, 400, h);
  }

  // ── 8. Block refund if associated return item not yet received ───────────────
  if (action === 'refund' || action === 'cancel_refund') {
    try {
      const bundle = await getCommerceBundle(env);
      const requests = Array.isArray(bundle.returnsState?.requests) ? bundle.returnsState.requests : [];
      /* EVERY request for this order, not the first one found. An order can
         carry more than one — the bug that started this audit produced exactly
         that, a finished request beside a fresh one — and .find() picked
         whichever happened to be first. Which one that was decided whether the
         refund went through. */
      const linked = requests.filter(r => String(r.orderId || '') === String(orderId));

      /* `refunded` used to be in this set, so a return already paid out was
         read as clearance to pay it out again. It is the opposite: the
         strongest signal in the list that this is a second attempt. */
      const READY_TO_REFUND = new Set(['item_received', 'completed', 'closed']);

      const done = linked.find(r => String(r.status || '') === 'refunded');
      if (done) {
        await audit(env, { adminId, adminEmail, orderId, action, success: false, note: 'blocked: a return on this order is already refunded' });
        return json({
          error: 'A return on this order has already been refunded. Refunding again would pay for the same item twice — '
               + 'check the Returns tab for this order before continuing.',
          alreadyRefunded: true,
        }, 409, h);
      }

      const waiting = linked.find(r => !READY_TO_REFUND.has(String(r.status || '')));
      if (waiting) {
        await audit(env, { adminId, adminEmail, orderId, action, success: false, note: `blocked: return status is "${waiting.status}"` });
        return json({
          error: `Cannot issue refund — the returned item has not been received yet (return status: "${waiting.status}"). Mark the return as "Item Received" before refunding.`,
        }, 400, h);
      }
    } catch { /* if bundle fetch fails, do not block the refund — log only */ }
  }

  /* ── 8b. What has ALREADY been refunded ──────────────────────────────────────

     Nothing tracked this. A full refund sets order.status = 'refunded' and the
     guard above catches a second one — but a PARTIAL refund deliberately
     leaves the status alone, so $20 could be refunded on a $50 order four
     times over and every attempt looked like the first.

     Money did not actually escape, because Stripe keeps its own ledger and
     refuses a refund past the charge. But that is a backstop nobody chose,
     reached by pressing the button and reading whatever error came back — and
     it is silent about the far more common version, where the second refund is
     small enough to fit and simply should not have happened.

     So it is asked, and asked of STRIPE rather than tracked here. A number this
     side would be a second ledger to keep in step with the real one, and the
     day they disagree is the day it matters. */
  const stripeClient = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
  let already = { refundedCents: 0, chargedCents: 0, count: 0, known: false };
  if (order.stripe_payment_intent_id) {
    try {
      already = await refundedSoFar(stripeClient, order.stripe_payment_intent_id);
    } catch (e) {
      console.warn('refund: could not read Stripe history —', e && e.message);
    }
  }

  /* A read-only look at the same answer, so the panel can warn BEFORE somebody
     presses the button rather than after. It runs behind the identical
     authorization and authorization-code checks above — a preflight that is
     easier to reach than the action it describes is an information leak. */
  if (action === 'check') {
    return json({
      success: true, check: true, orderId,
      alreadyRefundedCents: already.refundedCents,
      chargedCents: already.chargedCents,
      refundCount: already.count,
      known: already.known,
      orderStatus: String(order.status || ''),
    }, 200, h);
  }

  // ── 9. Issue Stripe refund ───────────────────────────────────────────────────
  let stripeRefundId     = null;
  let stripeRefundAmount = null;

  if (action === 'refund' || action === 'cancel_refund') {
    const stripe = stripeClient;

    /* Refuse rather than let Stripe refuse. Same outcome for the money, but
       this one can say what already happened and who did it, instead of
       handing an admin a raw API error about an amount they cannot see. */
    if (already.known) {
      const remaining = Math.max(0, already.chargedCents - already.refundedCents);
      const wanted = (action === 'refund' && amountCents && Number.isFinite(Number(amountCents)))
        ? Math.round(Number(amountCents))
        : remaining;
      if (remaining <= 0) {
        await audit(env, { adminId, adminEmail, orderId, action, success: false,
          note: `blocked: already fully refunded (${already.count} refund${already.count === 1 ? '' : 's'})` });
        return json({
          error: `This order has already been refunded in full — $${(already.refundedCents / 100).toFixed(2)} across `
               + `${already.count} refund${already.count === 1 ? '' : 's'}. Nothing further can be refunded.`,
          alreadyRefundedCents: already.refundedCents, chargedCents: already.chargedCents,
        }, 409, h);
      }
      if (wanted > remaining) {
        await audit(env, { adminId, adminEmail, orderId, action, success: false,
          note: `blocked: ${wanted}c requested, ${remaining}c remaining` });
        return json({
          error: `Only $${(remaining / 100).toFixed(2)} is left to refund on this order — `
               + `$${(already.refundedCents / 100).toFixed(2)} has already gone back. Nothing was charged or refunded.`,
          alreadyRefundedCents: already.refundedCents, chargedCents: already.chargedCents,
        }, 409, h);
      }
    }

    const params = {
      payment_intent: order.stripe_payment_intent_id,
      reason:         toStripeReason(reason),
      metadata: {
        order_id:    String(orderId),
        admin_id:    adminId,
        admin_email: adminEmail,
        action,
        reason:      String(reason || ''),
      },
    };

    if (action === 'refund' && amountCents && Number.isFinite(Number(amountCents))) {
      params.amount = Math.round(Number(amountCents));
    }

    try {
      const ref      = await stripe.refunds.create(params);
      stripeRefundId     = ref.id;
      stripeRefundAmount = ref.amount;
    } catch (err) {
      await audit(env, { adminId, adminEmail, orderId, action, success: false, note: `stripe: ${err.message}` });
      return json({ error: `Stripe error: ${err.message}` }, 400, h);
    }
  }

  // ── 10. Update order in Supabase ─────────────────────────────────────────────
  const orderTotalCents = Math.round(Number(order.total || 0) * 100);
  const isFullRefund    = action === 'cancel_refund'
    || (action === 'refund' && (!amountCents || Math.round(Number(amountCents)) >= orderTotalCents));

  const patch = {
    status: action === 'cancel' ? 'cancelled' : isFullRefund ? 'refunded' : order.status,
  };

  await fetch(`${env.SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`, {
    method:  'PATCH',
    headers: { ...sbH, Prefer: 'return=minimal' },
    body:    JSON.stringify(patch),
  });

  // ── 11. Audit log ─────────────────────────────────────────────────────────────
  await audit(env, {
    adminId, adminEmail, orderId, action, success: true,
    reason:            reason || '',
    stripeRefundId,
    stripeRefundAmount,
    newStatus:         patch.status,
    customerEmail:     order.email,
    orderTotal:        order.total,
  });

  // ── 12. Customer refund notification email ────────────────────────────────────
  if ((action === 'cancel_refund' || action === 'refund') && order.email) {
    await sendRefundEmail(env, {
      customerEmail:     order.email,
      customerName:      order.customer_name || order.email,
      orderNumber:       order.order_number || String(orderId).slice(-8).toUpperCase(),
      action,
      orderTotal:        order.total,
      stripeRefundAmount,
      reason,
      customerNote:      String(customerNote || '').trim(),
    });
  }

  return json({
    success: true, action, orderId,
    newStatus: patch.status, stripeRefundId, stripeRefundAmount,
  }, 200, h);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toStripeReason(r) {
  if (r === 'duplicate')  return 'duplicate';
  if (r === 'fraudulent') return 'fraudulent';
  return 'requested_by_customer';
}

/* Stripe's ledger, not ours. `known` is the load-bearing field: a failed read
   must not read as "nothing refunded yet", which is what a bare 0 would do —
   and that reading permits exactly the refund this exists to stop. Callers
   check `known` before trusting the numbers. */
async function refundedSoFar(stripe, paymentIntentId) {
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
  const charge = pi && pi.latest_charge;
  const chargedCents = Number(
    (charge && charge.amount_captured) || (charge && charge.amount) || pi.amount_received || pi.amount || 0
  );

  /* Read the refunds rather than trusting charge.amount_refunded alone: a
     refund still pending shows in the list before it settles into the total,
     and money on its way out is money already spent for this purpose. */
  const list = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 });
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
}

async function audit(env, entry) {
  try {
    const existing = await getSetting(env, AUDIT_LOG_KEY, []);
    const log = Array.isArray(existing) ? existing : [];
    log.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), ...entry });
    await setSetting(env, AUDIT_LOG_KEY, log.slice(0, 500));
  } catch { /* never block a refund because logging failed */ }
}

// ── Lockout alert email ───────────────────────────────────────────────────────

async function sendLockoutAlert(env, { adminEmail, adminId, orderId, attempts, lockedUntil }) {
  try {
    const cache      = await fetchSiteSettings(['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM'], env);
    const resendKey  = resolveSetting('RESEND_API_KEY', env, cache);
    const brevoKey   = resolveSetting('BREVO_API_KEY',  env, cache);
    const fromEmail  = resolveSetting('EMAIL_FROM', env, cache) || 'alerts@zuwera.store';
    const alertEmail = adminEmail || env.ADMIN_EMAILS?.split(',')[0]?.trim();

    if (!alertEmail || (!resendKey && !brevoKey)) return;

    const lockedUntilStr = new Date(lockedUntil).toUTCString();
    const subject = '⚠ Security Alert — Refund Authorization Lockout';
    const html = `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">
  <div style="border-top:3px solid #e05050;padding-top:20px">
    <h2 style="margin:0 0 8px;color:#e05050">Refund Lockout Triggered</h2>
    <p style="color:#555;margin:0 0 20px">Someone entered the wrong refund authorization code <strong>${attempts} times</strong> on your Zuwera admin panel. Refund access has been locked for 1 hour.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
      <tr style="border-bottom:1px solid #eee"><td style="padding:8px 4px;color:#888">Admin account</td><td style="padding:8px 4px"><strong>${esc(adminEmail)}</strong></td></tr>
      <tr style="border-bottom:1px solid #eee"><td style="padding:8px 4px;color:#888">Failed attempts</td><td style="padding:8px 4px"><strong>${attempts}</strong></td></tr>
      <tr style="border-bottom:1px solid #eee"><td style="padding:8px 4px;color:#888">Target order</td><td style="padding:8px 4px">${orderId ? esc(String(orderId).slice(-8).toUpperCase()) : 'N/A'}</td></tr>
      <tr><td style="padding:8px 4px;color:#888">Locked until</td><td style="padding:8px 4px">${esc(lockedUntilStr)}</td></tr>
    </table>
    <p style="font-size:13px;color:#888">If this was you, wait 1 hour and try again with the correct code. If you did not attempt this, your admin session may be compromised — change your password immediately.</p>
    <p style="font-size:12px;color:#bbb;margin-top:24px;border-top:1px solid #eee;padding-top:12px">Zuwera Admin Security &nbsp;·&nbsp; This is an automated alert</p>
  </div>
</body></html>`;

    if (resendKey) {
      await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ from: fromEmail, to: [alertEmail], subject, html }),
      });
      return;
    }

    if (brevoKey) {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method:  'POST',
        headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          sender:  { email: fromEmail, name: 'Zuwera Security' },
          to:      [{ email: alertEmail }],
          subject,
          htmlContent: html,
        }),
      });
    }
  } catch { /* alert is best-effort, never block the lockout response */ }
}

// ── Customer refund / cancellation email ─────────────────────────────────────

// Builds the refund email on the shared shell. Exported so the admin email
// preview can render it with sample data (a refund can't be triggered on demand).
export function buildRefundEmail({ action, orderNumber, orderTotal, stripeRefundAmount, reason, customerName, customerNote, fromEmail, appearance }) {
  const a = appearance;
  const isPartial   = action === 'refund';
  const refundAmt   = stripeRefundAmount ? `$${(stripeRefundAmount / 100).toFixed(2)}` : `$${Number(orderTotal || 0).toFixed(2)}`;
  const orderAmt    = `$${Number(orderTotal || 0).toFixed(2)}`;
  const firstName   = esc(String(customerName || '').split(' ')[0] || 'there');
  const reasonText  = reason === 'duplicate'   ? 'Duplicate order'
    : reason === 'fraudulent'                  ? 'Fraudulent transaction'
    : reason === 'out_of_stock'                ? 'Item out of stock'
    : 'Customer request';

  const subject = isPartial
    ? `Partial refund of ${refundAmt} processed — Order ${esc(orderNumber)}`
    : `Your refund of ${refundAmt} is on its way — Order ${esc(orderNumber)}`;

  const sumRow = (labelTxt, val, strong) => `
    <tr><td style="padding:11px 16px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${a.muted};width:42%;border-bottom:1px solid ${a.border};font-family:${a.fontMono};">${labelTxt}</td>
    <td style="padding:11px 16px;font-size:13px;color:${a.text};${strong ? 'font-weight:700;' : ''}border-bottom:1px solid ${a.border};">${val}</td></tr>`;
  const body = `
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${a.border};border-radius:8px;overflow:hidden;margin-bottom:24px;text-align:center;">
      <tr><td style="padding:24px 20px;background:rgba(128,128,128,.06);">
        <p style="margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:${a.muted};font-family:${a.fontMono};">Amount refunded</p>
        <p style="margin:0;font-size:42px;font-weight:800;color:${a.text};letter-spacing:-.02em;font-family:${a.fontHead};line-height:1;">${esc(refundAmt)}</p>
        ${isPartial ? `<p style="margin:8px 0 0;font-size:12px;color:${a.muted};">Partial refund · Order total was ${esc(orderAmt)}</p>` : ''}
      </td></tr>
    </table>
    <p style="margin:0 0 22px;font-size:14px;color:${a.muted};line-height:1.75;">Hi ${firstName}, we've processed your ${isPartial ? 'partial refund' : 'refund'}. Depending on your bank or card issuer, it will appear on your statement within <strong style="color:${a.text};">5–10 business days</strong>.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${a.border};border-radius:8px;overflow:hidden;margin-bottom:24px;">
      ${sumRow('Order', esc(orderNumber), true)}
      ${sumRow('Refund', esc(refundAmt), true)}
      ${sumRow('Reason', esc(reasonText))}
      ${sumRow('Timeline', '5–10 business days')}
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(128,128,128,.06);border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${a.muted};font-family:${a.fontMono};">Don't see it after 10 days?</p>
        <p style="margin:0;font-size:13px;color:${a.muted};line-height:1.65;">Check your bank statement for a credit from Stripe or Zuwera. If it still hasn't appeared, reply to this email and we'll look into it right away.</p>
      </td></tr>
    </table>
    ${customerNote ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${a.border};border-radius:8px;overflow:hidden;margin-bottom:24px;">
      <tr><td style="padding:11px 16px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${a.muted};background:rgba(128,128,128,.06);font-family:${a.fontMono};">A note from us</td></tr>
      <tr><td style="padding:14px 16px;font-size:13px;color:${a.text};line-height:1.65;white-space:pre-wrap;">${esc(customerNote)}</td></tr>
    </table>` : ''}
    <p style="margin:0;font-size:13px;color:${a.muted};line-height:1.6;">Questions? Reach us at <a href="mailto:${esc(fromEmail)}" style="color:${a.accent};font-weight:600;text-decoration:underline;">${esc(fromEmail)}</a></p>`;

  const html = renderEmailShell(a, {
    kicker:  isPartial ? 'Partial refund' : 'Refund confirmed',
    heading: 'Your money is on its way back',
    intro:   '',
    bodyHtml: body,
    footer:  `© ${new Date().getFullYear()} Zuwera · zuwera.store · This is an automated message`,
  });
  return { subject, html };
}

async function sendRefundEmail(env, { customerEmail, customerName, orderNumber, action, orderTotal, stripeRefundAmount, reason, customerNote }) {
  try {
    const cache     = await fetchSiteSettings(['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM', 'BRAND_LOGO_URL', 'fonts', 'brand', 'email_theme'], env);
    const resendKey = resolveSetting('RESEND_API_KEY', env, cache);
    const brevoKey  = resolveSetting('BREVO_API_KEY',  env, cache);
    const fromEmail = resolveSetting('EMAIL_FROM', env, cache) || 'support@zuwera.store';
    const a         = getEmailAppearance(cache);
    a.logo = resolveSetting('BRAND_LOGO_URL', env, cache) || a.logo;   // covers an env-var logo

    if (!customerEmail || (!resendKey && !brevoKey)) return;

    const { subject, html } = buildRefundEmail({
      action, orderNumber, orderTotal, stripeRefundAmount, reason, customerName, customerNote, fromEmail, appearance: a,
    });

    if (resendKey) {
      await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ from: fromEmail, to: [customerEmail], subject, html }),
      });
      return;
    }

    if (brevoKey) {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method:  'POST',
        headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          sender:      { email: fromEmail, name: 'Zuwera' },
          to:          [{ email: customerEmail }],
          subject,
          htmlContent: html,
        }),
      });
    }
  } catch { /* never block the refund response because email failed */ }
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
