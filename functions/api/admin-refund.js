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
import { cors, json, verifyAdmin, getSetting, setSetting } from './_commerce.js';
import { fetchSiteSettings, resolveSetting } from './_settings.js';

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

  const { accessToken, orderId, refundKey, action, amountCents, reason } = body;

  // ── 1. Verify admin JWT ──────────────────────────────────────────────────────
  const admin = await verifyAdmin(env, accessToken);
  if (!admin) return json({ error: 'Unauthorized.' }, 403, h);

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
  if (!['cancel', 'cancel_refund', 'refund'].includes(action)) {
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

  // ── 7. Guard against invalid state transitions ───────────────────────────────
  if (order.status === 'cancelled') {
    return json({ error: 'Order is already cancelled.' }, 400, h);
  }
  if (order.status === 'refunded' && action !== 'cancel') {
    return json({ error: 'Order has already been fully refunded.' }, 400, h);
  }
  if (action !== 'cancel' && !order.stripe_payment_intent_id) {
    return json({ error: 'No Stripe payment on record for this order — cannot issue refund.' }, 400, h);
  }

  // ── 8. Issue Stripe refund ───────────────────────────────────────────────────
  let stripeRefundId     = null;
  let stripeRefundAmount = null;

  if (action === 'refund' || action === 'cancel_refund') {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

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

  // ── 9. Update order in Supabase ──────────────────────────────────────────────
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

  // ── 10. Audit log ─────────────────────────────────────────────────────────────
  await audit(env, {
    adminId, adminEmail, orderId, action, success: true,
    reason:            reason || '',
    stripeRefundId,
    stripeRefundAmount,
    newStatus:         patch.status,
    customerEmail:     order.email,
    orderTotal:        order.total,
  });

  // ── 11. Customer refund notification email ────────────────────────────────────
  if ((action === 'cancel_refund' || action === 'refund') && order.email) {
    await sendRefundEmail(env, {
      customerEmail:     order.email,
      customerName:      order.customer_name || order.email,
      orderNumber:       order.order_number || String(orderId).slice(-8).toUpperCase(),
      action,
      orderTotal:        order.total,
      stripeRefundAmount,
      reason,
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

async function sendRefundEmail(env, { customerEmail, customerName, orderNumber, action, orderTotal, stripeRefundAmount, reason }) {
  try {
    const cache     = await fetchSiteSettings(['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM'], env);
    const resendKey = resolveSetting('RESEND_API_KEY', env, cache);
    const brevoKey  = resolveSetting('BREVO_API_KEY',  env, cache);
    const fromEmail = resolveSetting('EMAIL_FROM', env, cache) || 'support@zuwera.store';

    if (!customerEmail || (!resendKey && !brevoKey)) return;

    const isPartial  = action === 'refund';
    const refundAmt  = stripeRefundAmount ? `$${(stripeRefundAmount / 100).toFixed(2)}` : `$${Number(orderTotal || 0).toFixed(2)}`;
    const reasonText = reason === 'duplicate' ? 'Duplicate order'
      : reason === 'fraudulent' ? 'Fraudulent transaction'
      : reason === 'out_of_stock' ? 'Item out of stock'
      : 'Customer request';

    const subject = isPartial
      ? `Your partial refund for order ${orderNumber} is on its way`
      : `Your refund for order ${orderNumber} is on its way`;

    const html = `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111;background:#fff">
  <div style="border-top:3px solid #111;padding-top:20px">
    <p style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#888;margin:0 0 18px">Zuwera</p>
    <h2 style="margin:0 0 8px;font-size:1.3rem">Your refund is on its way</h2>
    <p style="color:#555;margin:0 0 24px;font-size:14px;line-height:1.6">Hi ${esc(customerName)}, your ${isPartial ? 'partial refund' : 'refund'} for order <strong>${esc(orderNumber)}</strong> has been processed. The amount below will appear back on your original payment method within <strong>5–10 business days</strong> depending on your bank.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px;border:1px solid #eee;border-radius:8px;overflow:hidden">
      <tr style="background:#f9f9f9"><td style="padding:12px 16px;color:#888;width:40%">Order</td><td style="padding:12px 16px"><strong>${esc(orderNumber)}</strong></td></tr>
      <tr><td style="padding:12px 16px;color:#888;border-top:1px solid #eee">Refund amount</td><td style="padding:12px 16px;border-top:1px solid #eee"><strong style="font-size:16px">${esc(refundAmt)}</strong></td></tr>
      <tr style="background:#f9f9f9"><td style="padding:12px 16px;color:#888;border-top:1px solid #eee">Reason</td><td style="padding:12px 16px;border-top:1px solid #eee">${esc(reasonText)}</td></tr>
    </table>
    <p style="font-size:13px;color:#888;line-height:1.6">If you have any questions, reply to this email or contact us at <a href="mailto:${esc(fromEmail)}" style="color:#111">${esc(fromEmail)}</a>.</p>
    <p style="font-size:12px;color:#bbb;margin-top:24px;border-top:1px solid #eee;padding-top:12px">Zuwera &nbsp;·&nbsp; This is an automated message</p>
  </div>
</body></html>`;

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
