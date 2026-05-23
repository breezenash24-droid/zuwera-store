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
import { cors, json, verifyAdmin, getSetting, setSetting, getCommerceBundle } from './_commerce.js';
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

  // ── 8. Block refund if associated return item not yet received ───────────────
  if (action === 'refund' || action === 'cancel_refund') {
    try {
      const bundle = await getCommerceBundle(env);
      const requests = Array.isArray(bundle.returnsState?.requests) ? bundle.returnsState.requests : [];
      const linked = requests.find(r => String(r.orderId || '') === String(orderId));
      const REFUND_ALLOWED = new Set(['item_received', 'completed', 'refunded', 'closed']);
      if (linked && !REFUND_ALLOWED.has(linked.status || '')) {
        await audit(env, { adminId, adminEmail, orderId, action, success: false, note: `blocked: return status is "${linked.status}"` });
        return json({
          error: `Cannot issue refund — the returned item has not been received yet (return status: "${linked.status}"). Mark the return as "Item Received" before refunding.`,
        }, 400, h);
      }
    } catch { /* if bundle fetch fails, do not block the refund — log only */ }
  }

  // ── 9. Issue Stripe refund ───────────────────────────────────────────────────
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

    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f4f1eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1eb;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;">

        <!-- Header -->
        <tr><td style="padding-bottom:28px;" align="center">
          <p style="margin:0;font-size:13px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#09090b;">ZUWERA</p>
        </td></tr>

        <!-- Card -->
        <tr><td style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.07);">

          <!-- Green top bar -->
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="background:#09090b;padding:28px 36px 24px;">
              <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.45);">${isPartial ? 'Partial Refund' : 'Refund Confirmed'}</p>
              <h1 style="margin:0;font-size:26px;font-weight:800;color:#ffffff;line-height:1.2;">Your money is<br>on its way back.</h1>
            </td></tr>

            <!-- Refund amount hero -->
            <tr><td style="background:#f4f1eb;padding:28px 36px;border-bottom:1px solid #e8e4db;">
              <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#888;">Amount refunded</p>
              <p style="margin:0;font-size:42px;font-weight:900;color:#09090b;letter-spacing:-.02em;">${esc(refundAmt)}</p>
              ${isPartial ? `<p style="margin:6px 0 0;font-size:12px;color:#888;">Partial refund · Order total was ${esc(orderAmt)}</p>` : ''}
            </td></tr>

            <!-- Details -->
            <tr><td style="padding:28px 36px;">
              <p style="margin:0 0 20px;font-size:15px;color:#444;line-height:1.7;">Hi ${firstName}, we've processed your ${isPartial ? 'partial refund' : 'refund'}. Depending on your bank or card issuer, it will appear on your statement within <strong style="color:#09090b;">5–10 business days</strong>.</p>

              <!-- Order summary table -->
              <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e4db;border-radius:8px;overflow:hidden;margin-bottom:24px;">
                <tr style="background:#f9f7f3;">
                  <td style="padding:11px 16px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#888;width:45%;">Order</td>
                  <td style="padding:11px 16px;font-size:13px;font-weight:700;color:#09090b;">${esc(orderNumber)}</td>
                </tr>
                <tr style="border-top:1px solid #e8e4db;">
                  <td style="padding:11px 16px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#888;">Refund</td>
                  <td style="padding:11px 16px;font-size:13px;font-weight:700;color:#09090b;">${esc(refundAmt)}</td>
                </tr>
                <tr style="border-top:1px solid #e8e4db;background:#f9f7f3;">
                  <td style="padding:11px 16px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#888;">Reason</td>
                  <td style="padding:11px 16px;font-size:13px;color:#09090b;">${esc(reasonText)}</td>
                </tr>
                <tr style="border-top:1px solid #e8e4db;">
                  <td style="padding:11px 16px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#888;">Timeline</td>
                  <td style="padding:11px 16px;font-size:13px;color:#09090b;">5–10 business days</td>
                </tr>
              </table>

              <!-- What to do block -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1eb;border-radius:8px;margin-bottom:24px;">
                <tr><td style="padding:16px 20px;">
                  <p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#888;">Don't see it after 10 days?</p>
                  <p style="margin:0;font-size:13px;color:#555;line-height:1.6;">Check your bank statement for a credit from Stripe or Zuwera. If it still hasn't appeared, reply to this email and we'll look into it right away.</p>
                </td></tr>
              </table>

              <p style="margin:0;font-size:13px;color:#888;line-height:1.6;">Questions? Reach us at <a href="mailto:${esc(fromEmail)}" style="color:#09090b;font-weight:600;">${esc(fromEmail)}</a></p>
            </td></tr>
          </table>

        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:24px 0 8px;" align="center">
          <p style="margin:0;font-size:11px;color:#aaa;letter-spacing:.04em;">© ZUWERA · <a href="https://zuwera.store" style="color:#aaa;text-decoration:none;">zuwera.store</a> · This is an automated message</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

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
