import {
  cors,
  getCommerceBundle,
  getOrdersForUser,
  json,
  setSetting,
  upsertTimelineEntry,
  verifyUser,
} from './_commerce.js';
import { fetchSiteSettings, resolveSetting } from './_settings.js';

// ─── Loops subscriber sync ─────────────────────────────────────────────────────
// Called after save_profile — syncs the customer into Loops if they consented to marketing.

async function syncToLoops(env, { email, firstName, lastName, marketingConsent, smsConsent }) {
  const cache   = await fetchSiteSettings(['LOOPS_API_KEY'], env);
  const loopsKey = resolveSetting('LOOPS_API_KEY', env, cache);
  if (!loopsKey || !email) return;
  try {
    // Upsert contact in Loops — creates if new, updates if existing
    const resp = await fetch('https://app.loops.so/api/v1/contacts/upsert', {
      method:  'PUT',
      headers: { Authorization: `Bearer ${loopsKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        firstName:         firstName  || '',
        lastName:          lastName   || '',
        subscribed:        marketingConsent,
        userGroup:         'customer',
        source:            'zuwera_store',
        zwMarketingConsent: marketingConsent,
        zwSmsConsent:       smsConsent,
      }),
    });
    if (!resp.ok) {
      console.warn('Loops upsert failed:', resp.status, await resp.text().catch(() => ''));
    } else {
      console.log('Loops contact synced:', email, '| subscribed:', marketingConsent);
    }
  } catch (e) {
    console.warn('Loops sync error (non-fatal):', e.message);
  }
}

function cleanAddress(address = {}) {
  return {
    id: address.id || crypto.randomUUID(),
    label: String(address.label || 'Address').trim() || 'Address',
    name: String(address.name || '').trim(),
    line1: String(address.line1 || '').trim(),
    line2: String(address.line2 || '').trim(),
    city: String(address.city || '').trim(),
    state: String(address.state || '').trim().toUpperCase(),
    zip: String(address.zip || '').trim(),
    country: String(address.country || 'US').trim().toUpperCase(),
    isPrimary: Boolean(address.isPrimary),
  };
}

function mergeOrderWithOps(order, orderOps = {}, returnsRequests = []) {
  const override = orderOps?.[order.id] || {};
  const requests = returnsRequests.filter((request) => request.orderId === order.id);
  return {
    ...order,
    commerce: {
      fulfillmentStatus: override.fulfillmentStatus || order.fulfillment_status || 'unfulfilled',
      fraudStatus: override.fraudStatus || 'clear',
      notes: override.notes || '',
      tags: Array.isArray(override.tags) ? override.tags : [],
      timeline: Array.isArray(override.timeline) ? override.timeline : [],
      trackingNumber: override.trackingNumber || order.tracking_number || '',
      trackingUrl: override.trackingUrl || order.tracking_url || '',
      returnRequests: requests,
    },
  };
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestGet({ request, env }) {
  try {
    const accessToken = request.headers.get('Authorization') || '';
    const user = await verifyUser(env, accessToken);
    if (!user?.id) return json({ success: false, error: 'Unauthorized' }, 401, cors(env));

    const [bundle, orders] = await Promise.all([
      getCommerceBundle(env),
      getOrdersForUser(env, user.id, user.email || ''),
    ]);

    const profile = bundle.customerProfiles?.[user.id] || {};
    const returnsRequests = Array.isArray(bundle.returnsState?.requests)
      ? bundle.returnsState.requests.filter((request) => request.userId === user.id)
      : [];

    const enrichedOrders = (orders || []).map((order) => mergeOrderWithOps(order, bundle.orderOps, returnsRequests));

    return json({
      success: true,
      profile,
      returns: returnsRequests,
      orders: enrichedOrders,
    }, 200, cors(env));
  } catch (error) {
    return json({ success: false, error: error?.message || 'Could not load customer hub.' }, 500, cors(env));
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const accessToken = request.headers.get('Authorization') || '';
    const user = await verifyUser(env, accessToken);
    if (!user?.id) return json({ success: false, error: 'Unauthorized' }, 401, cors(env));

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    const bundle = await getCommerceBundle(env);

    if (action === 'save_profile') {
      const currentProfile = bundle.customerProfiles?.[user.id] || {};
      const addresses = Array.isArray(body.addresses) ? body.addresses.map(cleanAddress) : [];
      const nextProfile = {
        ...currentProfile,
        marketingConsent: Boolean(body.marketingConsent),
        smsConsent: Boolean(body.smsConsent),
        preferredChannel: String(body.preferredChannel || currentProfile.preferredChannel || 'email'),
        notes: String(body.notes || currentProfile.notes || ''),
        savedAddresses: addresses.map((address, index) => ({
          ...address,
          isPrimary: index === 0 ? true : Boolean(address.isPrimary),
        })),
        updatedAt: new Date().toISOString(),
      };
      const nextProfiles = {
        ...(bundle.customerProfiles || {}),
        [user.id]: nextProfile,
      };
      await setSetting(env, 'commerce_customer_profiles', nextProfiles);

      // Sync to Loops in background (non-blocking, non-fatal)
      syncToLoops(env, {
        email:           user.email || '',
        firstName:       String(body.firstName || '').trim(),
        lastName:        String(body.lastName  || '').trim(),
        marketingConsent: Boolean(body.marketingConsent),
        smsConsent:       Boolean(body.smsConsent),
      }).catch(e => console.warn('Loops sync failed (non-fatal):', e.message));

      return json({ success: true, profile: nextProfile }, 200, cors(env));
    }

    if (action === 'submit_return') {
      const eligibleOrders = await getOrdersForUser(env, user.id, user.email || '');
      const requestId = crypto.randomUUID();
      const nextRequest = {
        id: requestId,
        userId: user.id,
        orderId: String(body.orderId || '').trim(),
        orderLabel: String(body.orderLabel || '').trim(),
        resolution: String(body.resolution || 'return').trim(),
        reason: String(body.reason || '').trim(),
        notes: String(body.notes || '').trim(),
        status: 'requested',
        createdAt: new Date().toISOString(),
      };
      if (!nextRequest.orderId || !nextRequest.reason) {
        return json({ success: false, error: 'Order and reason are required.' }, 400, cors(env));
      }
      const matchedOrder = (eligibleOrders || []).find((order) => String(order.id || '').trim() === nextRequest.orderId);
      if (!matchedOrder) {
        return json({ success: false, error: 'You can only request returns for your own orders.' }, 403, cors(env));
      }
      nextRequest.orderLabel = nextRequest.orderLabel || `#${String(matchedOrder.id || '').slice(-8).toUpperCase()}`;

      const requests = Array.isArray(bundle.returnsState?.requests) ? [...bundle.returnsState.requests] : [];
      requests.unshift(nextRequest);
      await setSetting(env, 'commerce_returns', { requests: requests.slice(0, 500) });

      const nextOrderOps = { ...(bundle.orderOps || {}) };
      const existingOrderOps = nextOrderOps[nextRequest.orderId] || {};
      nextOrderOps[nextRequest.orderId] = {
        ...existingOrderOps,
        timeline: upsertTimelineEntry(existingOrderOps.timeline, {
          actor: user.email || 'customer',
          type: 'return_requested',
          message: `${nextRequest.resolution} requested by customer`,
        }),
      };
      await setSetting(env, 'commerce_order_ops', nextOrderOps);

      return json({ success: true, request: nextRequest }, 200, cors(env));
    }

    return json({ success: false, error: 'Unsupported action.' }, 400, cors(env));
  } catch (error) {
    return json({ success: false, error: error?.message || 'Could not update customer hub.' }, 500, cors(env));
  }
}
