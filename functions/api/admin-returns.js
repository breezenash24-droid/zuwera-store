import {
  cors,
  getCommerceBundle,
  getOrdersForAdmin,
  getProfilesForAdmin,
  json,
  mutateSetting,
  setSetting,
  upsertTimelineEntry,
  verifyAdmin,
} from './_commerce.js';
import { permsHave } from './_rbac.js';

function orderTotal(order = {}) {
  return Number(order.total || order.total_amount || 0);
}

function orderLabel(order = {}) {
  return order.id ? `#${String(order.id).slice(-8).toUpperCase()}` : '';
}

function profileName(profile = {}) {
  return profile.full_name || profile.name || profile.email || '';
}

function cleanString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function cleanNumber(value, fallback = '') {
  if (value === '' || value === undefined || value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
      returnItems: Array.isArray(request.returnItems) && request.returnItems.length > 0
        ? request.returnItems
        : (request.orderItems || order.items || []),
    };
  });
}

async function requireAdmin(request, env, permission = 'returns') {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const admin = await verifyAdmin(env, token);
  if (!admin) throw new Error('Not authorized');
  if (permission && !permsHave(admin.permissions, permission)) {
    throw new Error('Your role does not have permission for this action.');
  }
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

/**
 * Give ONE order its own returns deadline, or take it away again.
 *
 * The store-wide window is a policy; this is the exception to it. Support has to
 * be able to say yes to "it arrived damaged and I was away for a month" without
 * turning enforcement off for everybody — and a rule with no exception is a rule
 * that gets turned off the first time it is inconvenient, which is how the store
 * ends up back where it started with no window at all.
 *
 * A DATE, not a number of days: see overrideFrom() in _returns.js. Because it
 * replaces the computed deadline rather than extending it, the same field also
 * SHORTENS a window, which is what a final-sale item needs and would otherwise
 * have been a second mechanism.
 *
 * mutateSetting rather than setSetting — this is a read-modify-write on a shared
 * blob, and the plain write loses whatever another admin saved in between. The
 * update_return path above still uses setSetting; that is pre-existing and out
 * of scope here, but it is the same hazard.
 */
async function setReturnWindow({ body, env, admin }) {
  const orderId = String(body.orderId || '').trim();
  if (!orderId) return json({ success: false, error: 'Missing order id.' }, 400, cors(env));

  const raw = String(body.openUntil || '').trim();
  const clearing = raw === '';
  let iso = '';

  if (!clearing) {
    /* A bare YYYY-MM-DD is what a date input sends, and parsing that as UTC
       midnight would end the window at 8pm the previous evening for a shopper in
       Ohio. Read it as the END of that day, so a deadline of the 14th means all
       of the 14th — which is what both the admin and the customer will assume. */
    const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999Z` : raw);
    if (!Number.isFinite(ms)) {
      return json({ success: false, error: 'That is not a date we can read.' }, 400, cors(env));
    }
    /* Ten years is not a window, it is switching the rule off for one order
       while making it look like a date. Refuse rather than silently clamp: the
       admin should know the number they typed was not the number stored. */
    if (ms > Date.now() + 3650 * 86400000) {
      return json({ success: false, error: 'That date is more than ten years away.' }, 400, cors(env));
    }
    iso = new Date(ms).toISOString();
  }

  const actor = admin.profile?.email || admin.email || 'admin';
  const note = cleanString(body.note, '');

  await mutateSetting(env, 'commerce_order_ops', (currentValue) => {
    const ops = currentValue && typeof currentValue === 'object' ? { ...currentValue } : {};
    const entry = ops[orderId] && typeof ops[orderId] === 'object' ? { ...ops[orderId] } : {};

    if (clearing) delete entry.returnsOpenUntil;
    else entry.returnsOpenUntil = iso;
    entry.returnsWindowSetBy = clearing ? '' : actor;
    entry.returnsWindowSetAt = clearing ? '' : new Date().toISOString();
    entry.returnsWindowNote  = clearing ? '' : note;

    /* Onto the same timeline the rest of this file writes to, because "why is
       this order still returnable" is a question asked months later by somebody
       who was not the one who decided. */
    entry.timeline = upsertTimelineEntry(entry.timeline, {
      actor,
      type: 'return_window',
      message: clearing
        ? 'Return window reset to the store policy'
        : `Returns open until ${iso.slice(0, 10)}${note ? ` — ${note}` : ''}`,
    });

    ops[orderId] = entry;
    return ops;
  });

  return json({ success: true, orderId, openUntil: iso }, 200, cors(env));
}

export async function onRequestPost({ request, env }) {
  try {
    const admin = await requireAdmin(request, env, 'return_process');
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    if (action === 'set_return_window') {
      return await setReturnWindow({ body, env, admin });
    }
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
    const allowedStatuses = new Set(['requested', 'approved', 'denied', 'completed', 'label_sent', 'item_received', 'exchange_in_progress', 'refunded', 'closed']);
    const nextStatus = String(body.status || current.status || 'requested').trim();
    if (!allowedStatuses.has(nextStatus)) {
      return json({ success: false, error: 'Unsupported return status.' }, 400, cors(env));
    }

    requests[idx] = {
      ...current,
      status: nextStatus,
      resolution: cleanString(body.resolution, current.resolution || 'return'),
      reason: cleanString(body.reason, current.reason || ''),
      notes: cleanString(body.notes, current.notes || ''),
      internalNotes: cleanString(body.internalNotes, current.internalNotes || ''),
      customerMessage: cleanString(body.customerMessage, current.customerMessage || ''),
      refundAmount: cleanNumber(body.refundAmount, current.refundAmount ?? ''),
      exchangeSku: cleanString(body.exchangeSku, current.exchangeSku || ''),
      adminResolution: cleanString(body.adminResolution, current.adminResolution || ''),
      inspectionNotes: cleanString(body.inspectionNotes, current.inspectionNotes || ''),
      labelUrl: cleanString(body.labelUrl, current.labelUrl || ''),
      trackingNumber: cleanString(body.trackingNumber, current.trackingNumber || ''),
      trackingUrl: cleanString(body.trackingUrl, current.trackingUrl || ''),
      carrier: cleanString(body.carrier, current.carrier || ''),
      service: cleanString(body.service, current.service || ''),
      labelAmount: cleanNumber(body.labelAmount, current.labelAmount ?? ''),
      labelCurrency: cleanString(body.labelCurrency, current.labelCurrency || ''),
      labelSentAt: cleanString(body.labelSentAt, current.labelSentAt || ''),
      lastLabelError: body.clearLabelError ? '' : cleanString(body.lastLabelError, current.lastLabelError || ''),
      labelErrorAt: body.clearLabelError ? '' : cleanString(body.labelErrorAt, current.labelErrorAt || ''),
      updatedAt: new Date().toISOString(),
      updatedBy: admin.profile?.email || admin.email || '',
    };

    if (requests[idx].status === 'label_sent' && (requests[idx].labelUrl || requests[idx].trackingNumber) && !requests[idx].labelSentAt) {
      requests[idx].labelSentAt = requests[idx].updatedAt;
    }

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
