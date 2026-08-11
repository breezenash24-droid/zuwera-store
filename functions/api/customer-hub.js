import {
  cors,
  getCommerceBundle,
  getOrdersForUser,
  json,
  mutateSetting,
  upsertTimelineEntry,
  verifyUser,
} from './_commerce.js';
import { fetchSiteSettings, resolveSetting } from './_settings.js';
import { returnEligibility, reconcileReturnItems, spokenForOn } from './_returns.js';
import { orderNo } from './_order-no.js';

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

    /* Eligibility computed HERE and sent down, rather than each page working
       it out from the raw orders. The pages had their own versions of the
       rule — which is to say they had none — and a rule the display and the
       endpoint each decide separately is a rule they will eventually disagree
       about, with the customer seeing the generous half. */
    const enrichedOrders = (orders || []).map((order) => {
      const merged = mergeOrderWithOps(order, bundle.orderOps, returnsRequests);
      const eligible = returnEligibility(merged, returnsRequests);
      return { ...merged, returnable: eligible.ok, returnBlockedReason: eligible.reason || '' };
    });

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
      await mutateSetting(env, 'commerce_customer_profiles', (cur) => ({
        ...(cur || {}),
        [user.id]: nextProfile,
      }));

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
      const userName = String(
        user.user_metadata?.full_name
        || user.user_metadata?.name
        || user.email
        || ''
      ).trim();
      const submittedItems = Array.isArray(body.returnItems) ? body.returnItems : [];
      const nextRequest = {
        id: requestId,
        userId: user.id,
        userEmail: String(user.email || '').trim(),
        userName,
        orderId: String(body.orderId || '').trim(),
        orderLabel: String(body.orderLabel || '').trim(),
        resolution: String(body.resolution || 'return').trim(),
        reason: String(body.reason || '').trim(),
        notes: String(body.notes || '').trim(),
        status: 'requested',
        createdAt: new Date().toISOString(),
        returnItems: submittedItems.slice(0, 20),
      };
      if (!nextRequest.orderId || !nextRequest.reason) {
        return json({ success: false, error: 'Order and reason are required.' }, 400, cors(env));
      }
      const matchedOrder = (eligibleOrders || []).find((order) => String(order.id || '').trim() === nextRequest.orderId);
      if (!matchedOrder) {
        return json({ success: false, error: 'You can only request returns for your own orders.' }, 403, cors(env));
      }

      /* Ownership was the ONLY check here, which is how a fully refunded order
         with a finished return request accepted a second one for the same item
         — landing in the admin queue looking exactly like a first request.
         Same function the pages use to decide what to offer, so what a
         customer is shown and what they are allowed cannot drift apart. */
      const submitBundle = await getCommerceBundle(env);
      const myRequests = Array.isArray(submitBundle.returnsState?.requests)
        ? submitBundle.returnsState.requests.filter((r) => r && r.userId === user.id)
        : [];
      const eligible = returnEligibility(matchedOrder, myRequests);
      if (!eligible.ok) {
        return json({ success: false, error: eligible.reason, code: eligible.code }, 409, cors(env));
      }
      /* Stamped from the order itself, so a request carries the same name the
         Orders page shows rather than a sixth one invented here. */
      nextRequest.orderLabel = orderNo(matchedOrder);
      nextRequest.customerEmail = String(matchedOrder.email || matchedOrder.customer_email || user.email || '').trim();
      nextRequest.customerName = String(matchedOrder.customer_name || userName || nextRequest.customerEmail || 'Customer').trim();
      nextRequest.orderTotal = Number(matchedOrder.total || matchedOrder.total_amount || 0);
      nextRequest.orderCreatedAt = matchedOrder.created_at || '';
      try {
        const allItems = typeof matchedOrder.items === 'string' ? JSON.parse(matchedOrder.items) : (Array.isArray(matchedOrder.items) ? matchedOrder.items : []);
        nextRequest.orderItems = allItems;

        /* The old check here was that the NAME appeared somewhere on the order,
           and nothing else. Size, colour, quantity and price all came from the
           request body and were stored as sent — so somebody who bought one
           small yellow shirt could ask for an extra-large black one, or ask
           five times, and the admin queue would show exactly that against a
           real order. The request is what a refund gets read from.

           Sending nothing still means "the whole order", which is the only
           reading of an empty selection. Sending something means that something
           gets checked. */
        if (nextRequest.returnItems.length === 0) {
          nextRequest.returnItems = eligible.availableItems.length ? eligible.availableItems : allItems;
        } else {
          const { items, rejected } = reconcileReturnItems(matchedOrder, nextRequest.returnItems, spokenForOn(myRequests, matchedOrder.id));
          /* Refused, not trimmed. The old code fell back to the ENTIRE order
             when every submitted item failed its check — so garbage in
             produced a request for everything, which is the worst possible
             reading of "none of that was valid". */
          if (!items.length) {
            return json({
              success: false,
              error: rejected.length
                ? 'Those items are not available to return on this order.'
                : 'Choose at least one item to return.',
              code: 'items_invalid',
            }, 409, cors(env));
          }
          nextRequest.returnItems = items;
          /* Kept so an admin can see somebody asked for more than they had.
             Once is a mis-tap; a pattern is worth knowing about. */
          if (rejected.length) {
            nextRequest.rejectedItems = rejected.slice(0, 20);
          }
        }
      } catch (_) { nextRequest.orderItems = []; }
      nextRequest.shippingAddress = {
        name: nextRequest.customerName,
        line1: matchedOrder.ship_line1 || '',
        line2: matchedOrder.ship_line2 || '',
        city: matchedOrder.ship_city || '',
        state: matchedOrder.ship_state || '',
        zip: matchedOrder.ship_zip || '',
        country: matchedOrder.ship_country || 'US',
      };

      await mutateSetting(env, 'commerce_returns', (cur) => {
        const list = Array.isArray(cur?.requests) ? cur.requests : [];
        return { requests: [nextRequest, ...list].slice(0, 500) };
      });

      await mutateSetting(env, 'commerce_order_ops', (cur) => {
        const ops = { ...(cur || {}) };
        const existingOrderOps = ops[nextRequest.orderId] || {};
        ops[nextRequest.orderId] = {
          ...existingOrderOps,
          timeline: upsertTimelineEntry(existingOrderOps.timeline, {
            actor: user.email || 'customer',
            type: 'return_requested',
            message: `${nextRequest.resolution} requested by customer`,
          }),
        };
        return ops;
      });

      return json({ success: true, request: nextRequest }, 200, cors(env));
    }

    if (action === 'delete_address') {
      const idx = Number(body.index);
      const currentProfile = bundle.customerProfiles?.[user.id] || {};
      const existing = Array.isArray(currentProfile.savedAddresses) ? currentProfile.savedAddresses : [];
      if (isNaN(idx) || idx < 0 || idx >= existing.length) {
        return json({ success: false, error: 'Invalid address index.' }, 400, cors(env));
      }
      const updated = existing.filter((_, i) => i !== idx).map((a, i) => ({ ...a, isPrimary: i === 0 }));
      const nextProfile = { ...currentProfile, savedAddresses: updated, updatedAt: new Date().toISOString() };
      await mutateSetting(env, 'commerce_customer_profiles', (cur) => ({ ...(cur || {}), [user.id]: nextProfile }));
      return json({ success: true, profile: nextProfile }, 200, cors(env));
    }

    if (action === 'delete_profile_data') {
      await mutateSetting(env, 'commerce_customer_profiles', (cur) => {
        const next = { ...(cur || {}) };
        delete next[user.id];
        return next;
      });
      return json({ success: true }, 200, cors(env));
    }

    return json({ success: false, error: 'Unsupported action.' }, 400, cors(env));
  } catch (error) {
    return json({ success: false, error: error?.message || 'Could not update customer hub.' }, 500, cors(env));
  }
}
