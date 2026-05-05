/**
 * admin-returns.js — Admin returns management API
 *
 * GET  /api/admin-returns             → { success, requests: [...] }
 * POST /api/admin-returns             → body { action, ... }
 *   action: 'update_return'           → { returnId, status, resolution, reason, notes, internalNotes, shippingAddress }
 *
 * Auth: Bearer <supabase JWT> — must belong to an admin user (role = 'admin' in profiles).
 */

const { ok, err, preflight } = require('./_shared');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

const VALID_STATUSES   = ['requested','approved','label_sent','denied','exchange_in_progress','completed','refunded','closed'];
const VALID_RESOLUTIONS = ['return','exchange','store_credit'];

// ── Helpers ───────────────────────────────────────────────────────

function sbFetch(path, options = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey:         SERVICE_KEY,
      Authorization:  `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer:         'return=representation',
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

async function isAdmin(userId) {
  const resp = await sbFetch(`/profiles?id=eq.${encodeURIComponent(userId)}&select=role&limit=1`);
  if (!resp.ok) return false;
  const rows = await resp.json().catch(() => []);
  return Array.isArray(rows) && rows[0]?.role === 'admin';
}

function mapRequest(r) {
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
    internalNotes:   r.internal_notes,
    customerMessage: r.customer_message,
    exchangeSku:     r.exchange_sku,
    shippingAddress: r.shipping_address,
    labelUrl:        r.label_url,
    trackingNumber:  r.tracking_number,
    trackingUrl:     r.tracking_url,
    carrier:         r.carrier,
    service:         r.service,
    labelError:      r.label_error,
    lastLabelError:  r.label_error,
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
  if (!user) return err(401, 'Invalid or expired session');
  const admin = await isAdmin(user.id);
  if (!admin) return err(403, 'Admin access required');

  // ── GET: load all return requests ────────────────────────────────
  if (event.httpMethod === 'GET') {
    const resp = await sbFetch('/return_requests?order=updated_at.desc&limit=500');
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      return err(502, body.message || 'Could not load return requests');
    }
    const rows = await resp.json().catch(() => []);
    return ok({ success: true, requests: (Array.isArray(rows) ? rows : []).map(mapRequest) });
  }

  // ── POST: actions ─────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON body'); }

    if (body.action === 'update_return') {
      const { returnId, status, resolution, reason, notes, internalNotes, shippingAddress } = body;
      if (!returnId) return err(400, 'returnId is required');

      const patch = {};
      if (status     !== undefined && VALID_STATUSES.includes(status))       patch.status         = status;
      if (resolution !== undefined && VALID_RESOLUTIONS.includes(resolution)) patch.resolution      = resolution;
      if (reason     !== undefined) patch.reason         = String(reason || '');
      if (notes      !== undefined) patch.notes          = String(notes || '');
      if (internalNotes !== undefined) patch.internal_notes = String(internalNotes || '');
      if (shippingAddress !== undefined) patch.shipping_address = shippingAddress;

      if (!Object.keys(patch).length) return err(400, 'No valid fields to update');

      const resp = await sbFetch(`/return_requests?id=eq.${encodeURIComponent(returnId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        return err(502, errBody.message || 'Could not update return request');
      }

      const rows = await resp.json().catch(() => []);
      const updated = Array.isArray(rows) ? rows[0] : rows;
      return ok({ success: true, request: updated ? mapRequest(updated) : null });
    }

    return err(400, `Unknown action: ${body.action}`);
  }

  return err(405, 'Method not allowed');
};
