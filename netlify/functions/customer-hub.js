/**
 * customer-hub.js — Customer-facing returns portal API
 *
 * GET  /api/customer-hub  → { success, orders, returns }
 * POST /api/customer-hub  → body { action, ... }
 *   action: 'submit_return'  → { orderId, orderLabel, resolution, reason, notes }
 *   action: 'save_profile'   → { addresses, marketingConsent, smsConsent, preferredChannel, notes }
 *
 * Auth: Bearer <supabase user JWT> in Authorization header.
 */

const { ok, err, preflight } = require('./_shared');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

// ── Helpers ───────────────────────────────────────────────────────

function sbFetch(path, options = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey:        SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer:        'return=representation',
      ...(options.headers || {}),
    },
  });
}

async function getUser(token) {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.id ? data : null;
}

function mapReturn(r) {
  return {
    id:              r.id,
    createdAt:       r.created_at,
    updatedAt:       r.updated_at,
    userId:          r.user_id,
    orderId:         r.order_id,
    orderLabel:      r.order_label,
    orderTotal:      r.order_total,
    orderStatus:     r.order_status,
    customerEmail:   r.customer_email,
    customerName:    r.customer_name,
    resolution:      r.resolution,
    status:          r.status,
    reason:          r.reason,
    notes:           r.notes,
    customerMessage: r.customer_message,
    exchangeSku:     r.exchange_sku,
    shippingAddress: r.shipping_address,
    labelUrl:        r.label_url,
    trackingNumber:  r.tracking_number,
    trackingUrl:     r.tracking_url,
    carrier:         r.carrier,
    service:         r.service,
    labelSentAt:     r.label_sent_at,
  };
}

// ── Handler ───────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (!SUPABASE_URL || !SERVICE_KEY) return err(500, 'Supabase not configured');

  // Auth
  const token = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return err(401, 'Missing auth token');
  const user = await getUser(token);
  if (!user) return err(401, 'Invalid or expired session. Please sign in again.');

  // ── GET: orders + returns + profile for this user ─────────────
  if (event.httpMethod === 'GET') {
    const [ordersResp, returnsResp, profileResp] = await Promise.all([
      sbFetch(`/orders?user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc&limit=50`),
      sbFetch(`/return_requests?user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc`),
      sbFetch(`/profiles?id=eq.${encodeURIComponent(user.id)}&select=role,preferences&limit=1`),
    ]);

    if (!ordersResp.ok) return err(502, 'Could not load orders');
    const orders  = await ordersResp.json().catch(() => []);
    const returns = returnsResp.ok ? (await returnsResp.json().catch(() => [])) : [];
    const profileRows = profileResp.ok ? (await profileResp.json().catch(() => [])) : [];
    const profileRow = Array.isArray(profileRows) ? profileRows[0] : null;

    return ok({
      success: true,
      orders:  Array.isArray(orders)  ? orders  : [],
      returns: (Array.isArray(returns) ? returns : []).map(mapReturn),
      profile: profileRow?.preferences || {},
    });
  }

  // ── POST: actions ─────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON body'); }

    // ── submit_return ─────────────────────────────────────────
    if (body.action === 'submit_return') {
      const { orderId, orderLabel, resolution = 'return', reason = '', notes = '' } = body;
      if (!orderId) return err(400, 'orderId is required');
      if (!reason.trim()) return err(400, 'Please describe your reason for returning');

      // Fetch the order to get total + status + customer info
      const orderResp = await sbFetch(`/orders?id=eq.${encodeURIComponent(orderId)}&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
      const orders = orderResp.ok ? (await orderResp.json().catch(() => [])) : [];
      const order  = Array.isArray(orders) ? orders[0] : null;

      const row = {
        user_id:          user.id,
        order_id:         orderId,
        order_label:      orderLabel || `#${String(orderId).slice(-8).toUpperCase()}`,
        order_total:      order?.amount_total ? (order.amount_total / 100) : null,
        order_status:     order?.fulfillment_status || order?.status || null,
        customer_email:   user.email || order?.customer_email || null,
        customer_name:    user.user_metadata?.full_name || order?.customer_name || null,
        resolution:       ['return','exchange','store_credit'].includes(resolution) ? resolution : 'return',
        status:           'requested',
        reason:           reason.trim(),
        notes:            notes.trim(),
        shipping_address: order?.shipping_address || null,
      };

      const insertResp = await sbFetch('/return_requests', {
        method: 'POST',
        body: JSON.stringify(row),
      });

      if (!insertResp.ok) {
        const errBody = await insertResp.json().catch(() => ({}));
        return err(502, errBody.message || 'Could not submit return request');
      }

      const inserted = await insertResp.json().catch(() => []);
      const request  = Array.isArray(inserted) ? inserted[0] : inserted;
      return ok({ success: true, request: request ? mapReturn(request) : null });
    }

    // ── save_profile ──────────────────────────────────────────
    if (body.action === 'save_profile') {
      const { addresses, marketingConsent, smsConsent, preferredChannel, notes: profileNotes } = body;

      const preferences = {
        savedAddresses:   Array.isArray(addresses) ? addresses.slice(0, 5) : [],
        marketingConsent: Boolean(marketingConsent),
        smsConsent:       Boolean(smsConsent),
        preferredChannel: String(preferredChannel || 'email'),
        notes:            String(profileNotes || ''),
        updatedAt:        new Date().toISOString(),
      };

      // Upsert into profiles — safe since user's row was created on sign-up
      const upsertResp = await sbFetch(`/profiles?id=eq.${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ preferences }),
      });

      if (!upsertResp.ok) {
        // If no row to patch (new user without profile row), insert one
        const insertResp = await sbFetch('/profiles', {
          method: 'POST',
          body: JSON.stringify({ id: user.id, preferences }),
        });
        if (!insertResp.ok) {
          const errBody = await insertResp.json().catch(() => ({}));
          return err(502, errBody.message || 'Could not save profile');
        }
      }

      return ok({ success: true, profile: preferences });
    }

    return err(400, `Unknown action: ${body.action}`);
  }

  return err(405, 'Method not allowed');
};
