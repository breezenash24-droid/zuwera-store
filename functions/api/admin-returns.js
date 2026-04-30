import {
  cors,
  getCommerceBundle,
  getOrdersForAdmin,
  getProfilesForAdmin,
  json,
  setSetting,
  upsertTimelineEntry,
  verifyAdmin,
} from './_commerce.js';

function orderTotal(order = {}) {
  return Number(order.total || order.total_amount || 0);
}

function orderLabel(order = {}) {
  return order.id ? `#${String(order.id).slice(-8).toUpperCase()}` : '';
}

function profileName(profile = {}) {
  return profile.full_name || profile.name || profile.email || '';
}

function addressFromOrder(order = {}) {
  return {
    name: order.customer_name || order.email || order.customer_email || '',
    line1: order.ship_line1 || '',
    line2: order.ship_line2 || '',
    city: order.ship_city || '',
    state: order.ship_state || '',
    zip: order.ship_zip || '',
    country: order.ship_country || 'US',
  };
}

function enrichRequests(requests = [], orders = [], profiles = []) {
  const ordersById = new Map(orders.map((order) => [String(order.id || ''), order]));
  const profilesById = new Map(profiles.map((profile) => [String(profile.id || ''), profile]));
  const profilesByEmail = new Map(
    profiles
      .filter((profile) => profile.email)
      .map((profile) => [String(profile.email).toLowerCase(), profile])
  );

  return requests.map((request) => {
    const order = ordersById.get(String(request.orderId || '')) || {};
    const email = String(
      request.customerEmail
      || request.userEmail
      || order.email
      || order.customer_email
      || ''
    ).trim();
    const profile = profilesById.get(String(request.userId || ''))
      || profilesByEmail.get(email.toLowerCase())
      || {};
    const customerName = String(
      request.customerName
      || request.userName
      || order.customer_name
      || profileName(profile)
      || email
      || 'Customer'
    ).trim();

    return {
      ...request,
      customerEmail: email,
      customerName,
      userEmail: request.userEmail || email,
      userName: request.userName || customerName,
      orderLabel: request.orderLabel || orderLabel(order),
      orderTotal: request.orderTotal ?? orderTotal(order),
      orderStatus: order.status || request.orderStatus || '',
      paymentStatus: order.payment_status || request.paymentStatus || '',
      fulfillmentStatus: order.fulfillment_status || request.fulfillmentStatus || '',
      shippingProvider: order.shipping_provider || request.shippingProvider || '',
      shippingService: order.shipping_service || request.shippingService || '',
      outboundTrackingNumber: order.tracking_number || request.outboundTrackingNumber || '',
      outboundTrackingUrl: order.tracking_url || request.outboundTrackingUrl || '',
      orderCreatedAt: request.orderCreatedAt || order.created_at || '',
      shippingAddress: request.shippingAddress || addressFromOrder(order),
      orderItems: request.orderItems || order.items || [],
    };
  });
}

async function requireAdmin(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const admin = await verifyAdmin(env, token);
  if (!admin) throw new Error('Not authorized');
  return admin;
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestGet({ request, env }) {
  try {
    await requireAdmin(request, env);
    const [bundle, orders, profiles] = await Promise.all([
      getCommerceBundle(env),
      getOrdersForAdmin(env, 500),
      getProfilesForAdmin(env, 500),
    ]);
    const requests = Array.isArray(bundle.returnsState?.requests) ? bundle.returnsState.requests : [];
    return json({
      success: true,
      requests: enrichRequests(requests, orders, profiles),
    }, 200, cors(env));
  } catch (error) {
    return json({ success: false, error: error?.message || 'Could not load returns.' }, 401, cors(env));
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const admin = await requireAdmin(request, env);
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    if (action !== 'update_return') {
      return json({ success: false, error: 'Unsupported action.' }, 400, cors(env));
    }

    const returnId = String(body.returnId || '').trim();
    if (!returnId) return json({ success: false, error: 'Missing return id.' }, 400, cors(env));

    const bundle = await getCommerceBundle(env);
    const requests = Array.isArray(bundle.returnsState?.requests) ? [...bundle.returnsState.requests] : [];
    const idx = requests.findIndex((request) => request.id === returnId);
    if (idx === -1) return json({ success: false, error: 'Return request not found.' }, 404, cors(env));

    const current = requests[idx];
    const allowedStatuses = new Set(['requested', 'approved', 'denied', 'completed', 'label_sent', 'exchange_in_progress', 'refunded', 'closed']);
    const nextStatus = String(body.status || current.status || 'requested').trim();
    if (!allowedStatuses.has(nextStatus)) {
      return json({ success: false, error: 'Unsupported return status.' }, 400, cors(env));
    }

    requests[idx] = {
      ...current,
      status: nextStatus,
      resolution: String(body.resolution || current.resolution || 'return').trim(),
      reason: String(body.reason || current.reason || '').trim(),
      notes: String(body.notes || current.notes || '').trim(),
      internalNotes: String(body.internalNotes || current.internalNotes || '').trim(),
      customerMessage: String(body.customerMessage || current.customerMessage || '').trim(),
      refundAmount: body.refundAmount === '' || body.refundAmount === undefined
        ? (current.refundAmount ?? '')
        : Number(body.refundAmount),
      exchangeSku: String(body.exchangeSku || current.exchangeSku || '').trim(),
      adminResolution: String(body.adminResolution || current.adminResolution || '').trim(),
      inspectionNotes: String(body.inspectionNotes || current.inspectionNotes || '').trim(),
      updatedAt: new Date().toISOString(),
      updatedBy: admin.profile?.email || admin.email || '',
    };

    await setSetting(env, 'commerce_returns', { requests: requests.slice(0, 500) });

    if (current.orderId) {
      const nextOrderOps = { ...(bundle.orderOps || {}) };
      const orderOps = nextOrderOps[current.orderId] || {};
      nextOrderOps[current.orderId] = {
        ...orderOps,
        timeline: upsertTimelineEntry(orderOps.timeline, {
          actor: admin.profile?.email || admin.email || 'admin',
          type: 'return_updated',
          message: `Return request ${nextStatus}`,
        }),
      };
      await setSetting(env, 'commerce_order_ops', nextOrderOps);
    }

    return json({ success: true, request: requests[idx] }, 200, cors(env));
  } catch (error) {
    return json({ success: false, error: error?.message || 'Could not update return.' }, 500, cors(env));
  }
}
