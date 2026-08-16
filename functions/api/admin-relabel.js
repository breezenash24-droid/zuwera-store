/**
 * Cloudflare Pages Function: POST /api/admin-relabel   (admin only)
 *
 * Fix a shipping address and buy the label again, from the dashboard, in one
 * click.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * When a label purchase fails at checkout time, fulfilment does the right thing:
 * it records the failure, saves the order anyway and sends the confirmation, so
 * a customer who has been charged is never left with nothing. What it could not
 * do was FIX it. The dashboard raised a red banner reading "these orders were
 * paid but have no label; buy labels manually or fix the card and re-buy" — and
 * "manually" meant leaving the store, signing into Shippo, re-typing the
 * address, buying a label, and then coming back to paste the tracking number
 * into the order by hand. Every one of those steps is a chance to ship to the
 * wrong address or to lose the tracking number entirely.
 *
 * And the most common cause is not a declined card at all. It is this:
 *
 *     failed_address_validation — Recipient address invalid: Address not found
 *
 * A shopper mistyped their street. Nothing is wrong with the store, the card or
 * the integration; one field needs correcting and the label needs buying again.
 * That should be a text box and a button, which is what this is.
 *
 * ── Two steps, deliberately separate ─────────────────────────────────────────
 *
 *   action: 'validate' — runs the address past the carrier's validator and
 *                        returns what it thinks, including its own corrected
 *                        version. Buys nothing, changes nothing, costs nothing.
 *                        The admin sees the real reason before spending money.
 *
 *   action: 'buy'      — saves the corrected address to the order, buys the
 *                        label, writes the tracking back, and clears the
 *                        failure from the dashboard.
 *
 * They are separate because a validator that says "did you mean 123 Main St?"
 * is only useful if somebody gets to look at it first. Buying straight off a
 * guess is how you pay for a label to the wrong house.
 *
 * ── What is deliberately NOT reused ──────────────────────────────────────────
 *
 * The stored shipping_rate_object_id from checkout. A Shippo rate is bound to
 * the shipment it was quoted for — the OLD address — and rates expire. Re-using
 * it would either fail again for the same reason or, worse, succeed and print a
 * label for the address that was already wrong. So the shipment is built fresh
 * from what is on the order right now.
 */

import { cors, json, verifyAdmin, decide, mutateSetting } from './_commerce.js';
import { permsHave } from './_rbac.js';
import { shipFrom, shipFromIsComplete } from './_ship-from.js';
import { fetchSiteSettings, resolveSetting } from './_settings.js';
import { incrementShippoMonthlyCount } from './_shipping-usage.js';

const SHIPPO = 'https://api.goshippo.com';

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
}

function headersFor(env) {
  const key = serviceKey(env);
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}

/* One place that says what a destination address is, so the validator, the
   label and the order row cannot end up describing three different places. */
const ADDRESS_FIELDS = ['name', 'street1', 'street2', 'city', 'state', 'zip', 'country', 'phone', 'email'];

function cleanAddress(input) {
  const out = {};
  for (const f of ADDRESS_FIELDS) {
    out[f] = String((input && input[f]) || '').trim().slice(0, 120);
  }
  if (!out.country) out.country = 'US';
  return out;
}

function addressFromOrder(order) {
  return cleanAddress({
    name: order.customer_name,
    street1: order.ship_line1,
    street2: order.ship_line2,
    city: order.ship_city,
    state: order.ship_state,
    zip: order.ship_zip,
    country: order.ship_country || 'US',
    email: order.email,
  });
}

/** What is missing, in the words the person filling the form would use. */
function missingFields(a) {
  const need = { street1: 'Street address', city: 'City', state: 'State', zip: 'ZIP code' };
  return Object.keys(need).filter((k) => !a[k]).map((k) => need[k]);
}

/**
 * Ask Shippo whether the address is real, without buying anything.
 *
 * Shippo answers on the address object rather than by status code: an address
 * it cannot find comes back 200 with validation_results.is_valid === false and
 * the reason in messages. Reading only the HTTP status here would report every
 * bad address as fine, which is exactly the failure mode that made a label
 * purchase the first place anyone found out.
 */
async function validateAddress(env, a) {
  const resp = await fetch(SHIPPO + '/addresses/', {
    method: 'POST',
    headers: { Authorization: 'ShippoToken ' + env.SHIPPO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...a, validate: true }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return { checked: false, valid: null, messages: [String(data.detail || 'Shippo did not answer')], suggestion: null };
  }
  const vr = data.validation_results || {};
  const messages = Array.isArray(vr.messages)
    ? vr.messages.map((m) => String((m && (m.text || m.source)) || '')).filter(Boolean)
    : [];

  /* Shippo returns its OWN normalised version of the address on the same
     object — correct casing, the +4 on the ZIP, the standard street
     abbreviation. That is the thing worth showing: "use this instead" is a
     button, "invalid" is a puzzle. */
  const suggestion = cleanAddress({
    name: data.name, street1: data.street1, street2: data.street2,
    city: data.city, state: data.state, zip: data.zip,
    country: data.country, phone: data.phone, email: data.email,
  });
  const differs = ADDRESS_FIELDS.some((f) => (suggestion[f] || '') !== (a[f] || ''));

  return {
    checked: true,
    valid: vr.is_valid === true,
    messages,
    suggestion: differs ? suggestion : null,
  };
}

function parcelFor(items) {
  const qty = Math.max(1, (Array.isArray(items) ? items : []).reduce((s, i) => s + (Number(i && i.quantity) || 1), 0));
  return {
    length: '14',
    width: qty <= 1 ? '10' : qty <= 3 ? '12' : '14',
    height: qty <= 1 ? '4' : qty <= 3 ? '6' : '8',
    distance_unit: 'in',
    weight: (0.5 + qty * 0.5).toFixed(1),
    mass_unit: 'lb',
  };
}

/**
 * Build a fresh shipment, pick a rate, buy the label.
 *
 * Preference order is the store's own: whatever Admin → Shipping pinned, then
 * the cheapest thing that came back. Falling straight to cheapest would quietly
 * downgrade a store that has chosen Priority Mail for everything, and the
 * re-buy is exactly the moment nobody is watching.
 */
async function buyLabel(env, { from, to, items, preferred }) {
  const shipResp = await fetch(SHIPPO + '/shipments/', {
    method: 'POST',
    headers: { Authorization: 'ShippoToken ' + env.SHIPPO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ address_from: from, address_to: to, parcels: [parcelFor(items)], async: false }),
  });
  const shipment = await shipResp.json().catch(() => ({}));
  if (!shipResp.ok) {
    throw new Error('Shippo would not quote this shipment: ' + JSON.stringify(shipment.messages || shipment.detail || shipment));
  }
  const rates = Array.isArray(shipment.rates) ? shipment.rates : [];
  if (!rates.length) {
    /* A shipment with no rates is nearly always the address again — the carrier
       will quote anywhere it can deliver. Say so, rather than "no rates". */
    const msgs = (shipment.messages || []).map((m) => String(m && (m.text || m.source) || '')).filter(Boolean);
    throw new Error('No carrier would quote this address'
      + (msgs.length ? ' — ' + msgs.join('; ') : '. Check the street, city, state and ZIP agree with each other.'));
  }

  const price = (r) => Number(r.amount) || Infinity;
  let chosen = null;
  if (preferred && preferred.length) {
    for (const want of preferred) {
      chosen = rates.filter((r) =>
        String(r.provider || '').toLowerCase() === String(want.provider || '').toLowerCase()
        && String(r.servicelevel && r.servicelevel.name || '').toLowerCase() === String(want.servicelevel || '').toLowerCase()
      ).sort((a, b) => price(a) - price(b))[0] || null;
      if (chosen) break;
    }
  }
  if (!chosen) chosen = rates.slice().sort((a, b) => price(a) - price(b))[0];

  const txResp = await fetch(SHIPPO + '/transactions/', {
    method: 'POST',
    headers: { Authorization: 'ShippoToken ' + env.SHIPPO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rate: chosen.object_id, label_file_type: 'PDF', async: false }),
  });
  const tx = await txResp.json().catch(() => ({}));
  if (tx.status !== 'SUCCESS') {
    const msgs = (tx.messages || []).map((m) => String(m && (m.text || m.source) || '')).filter(Boolean);
    throw new Error(msgs.length ? msgs.join('; ') : 'Shippo refused the purchase: ' + JSON.stringify(tx.detail || tx));
  }

  /* Same test-mode rule the checkout path uses: a test label costs nothing and
     must not push a store toward the Veeqo switchover. */
  const isTest = tx.test === true || String(env.SHIPPO_API_KEY || '').trim().startsWith('shippo_test_');
  if (!isTest) await incrementShippoMonthlyCount(env).catch(() => {});

  return {
    tracking_number: tx.tracking_number || '',
    tracking_url: tx.tracking_url_provider || '',
    label_url: tx.label_url || '',
    provider: String(chosen.provider || ''),
    service: String((chosen.servicelevel && chosen.servicelevel.name) || ''),
    cost: Number(chosen.amount) || null,
    test: isTest,
  };
}

/** Take this order off the dashboard's failure list. */
async function clearFailure(env, orderNumber) {
  await mutateSetting(env, 'label_failures', (v) => {
    const list = Array.isArray(v) ? v : [];
    return list.filter((f) => String((f && f.order) || '') !== String(orderNumber));
  }).catch(() => {});
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  const H = cors(env);
  try {
    const accessToken = String(request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const admin = await verifyAdmin(env, accessToken);
    if (!admin) return json({ error: 'Not signed in as an admin.' }, 401, H);
    if (!permsHave(admin.permissions, 'order_write')) {
      return json({ error: 'Your account cannot change orders.' }, 403, H);
    }

    const body = await request.json().catch(() => ({}));
    const action = body.action === 'validate' ? 'validate' : 'buy';
    const orderNumber = String(body.order || '').trim().replace(/^#/, '');
    if (!orderNumber) return json({ error: 'Which order?' }, 400, H);

    if (!env.SHIPPO_API_KEY) {
      return json({ error: 'No Shippo API key is set, so no label can be bought here.' }, 400, H);
    }
    if (!env.SUPABASE_URL || !serviceKey(env)) {
      return json({ error: 'Order storage is not configured.' }, 500, H);
    }

    const rows = await fetch(
      `${env.SUPABASE_URL}/rest/v1/orders?select=*&order_number=eq.${encodeURIComponent(orderNumber)}&limit=1`,
      { headers: headersFor(env), cache: 'no-store' }
    ).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const order = rows && rows[0];
    if (!order) return json({ error: 'No order numbered ' + orderNumber + '.' }, 404, H);

    /* An address in the request replaces the one on the order; no address means
       "try again with what is already there", which is the right thing after
       fixing a declined card. */
    const supplied = body.address && typeof body.address === 'object';
    const to = supplied ? cleanAddress(body.address) : addressFromOrder(order);
    if (!to.email) to.email = String(order.email || '');
    if (!to.name) to.name = String(order.customer_name || 'Customer');

    const gaps = missingFields(to);
    if (gaps.length) {
      return json({ error: 'Still missing: ' + gaps.join(', ') + '.', address: to }, 400, H);
    }

    if (action === 'validate') {
      const check = await validateAddress(env, to);
      return json({ ok: true, action: 'validate', address: to, ...check }, 200, H);
    }

    /* Buying is spending real money against the store's carrier account, so it
       goes through the same limit engine as a refund does. */
    const verdict = await decide(env, accessToken, 'order_write', {
      action: 'relabel',
      resource: { orderId: String(order.id || ''), orderNumber },
    });
    if (!verdict.allow) {
      return json({ error: verdict.reason || 'A limit on your account stopped this.', rule: verdict.rule || '' }, 403, H);
    }

    if (order.tracking_number) {
      /* Two labels for one parcel is two charges and two tracking numbers, one
         of which will never move. Refuse rather than "helpfully" buying it. */
      return json({
        error: 'Order ' + orderNumber + ' already has tracking (' + order.tracking_number
          + '). Void that label in Shippo first if it is wrong.',
      }, 409, H);
    }

    const cache = await fetchSiteSettings(['shipping_preferred_service'], env).catch(() => ({}));
    const from = shipFrom(env, cache);
    if (!shipFromIsComplete(from)) {
      return json({ error: 'The store’s ship-from address is incomplete — set it in Admin → Shipping.' }, 400, H);
    }

    let preferred = [];
    try {
      const raw = resolveSetting('shipping_preferred_service', env, cache);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      preferred = Array.isArray(parsed && parsed.services) ? parsed.services : [];
    } catch (_) { preferred = []; }

    let label;
    try {
      label = await buyLabel(env, { from, to, items: order.items, preferred });
    } catch (e) {
      /* The reason goes back to the person who pressed the button, in full.
         "Label failed" with the detail only in a Worker log is how this ended
         up being diagnosed from a dashboard banner in the first place. */
      return json({ error: String((e && e.message) || 'The label could not be bought.') }, 502, H);
    }

    /* Write the corrected address and the tracking together. If this PATCH
       fails the label is already bought and paid for, so the response has to
       carry it — a tracking number that exists only in a failed database write
       is a label nobody can find. */
    const patch = {
      tracking_number: label.tracking_number,
      tracking_url: label.tracking_url,
      label_url: (label.label_url || '').length <= 480 ? label.label_url : '',
      shipping_provider: label.provider,
      shipping_service: label.service,
      customer_name: to.name,
      ship_line1: to.street1,
      ship_line2: to.street2,
      ship_city: to.city,
      ship_state: to.state,
      ship_zip: to.zip,
      ship_country: to.country,
    };
    const saved = await fetch(
      `${env.SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(order.id)}`,
      { method: 'PATCH', headers: { ...headersFor(env), Prefer: 'return=minimal' }, body: JSON.stringify(patch) }
    ).then((r) => r.ok).catch(() => false);

    await clearFailure(env, orderNumber);

    return json({
      ok: true,
      action: 'buy',
      order: orderNumber,
      saved,
      /* Said plainly rather than left for someone to notice: a test-mode label
         has a tracking number that will never move and cannot be handed to a
         carrier. */
      test: label.test,
      tracking: label.tracking_number,
      trackingUrl: label.tracking_url,
      labelUrl: label.label_url,
      provider: label.provider,
      service: label.service,
      cost: label.cost,
      address: to,
      warning: saved ? '' : 'The label was bought but the order could not be updated — save the tracking number below by hand.',
    }, 200, H);
  } catch (e) {
    return json({ error: String((e && e.message) || 'failed') }, 500, H);
  }
}
