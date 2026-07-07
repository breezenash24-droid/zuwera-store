/**
 * Shared Veeqo Rate-Shopping helper (https://developers.veeqo.com/rate-shopping-api).
 *
 * Veeqo is the Amazon-owned free shipping platform. Its Rate Shopping API returns
 * USPS (and UPS) rates via "Amazon Shipping V2", so it acts as a second source of
 * USPS rates alongside Shippo. The flow is:
 *   1. POST /shipping/api/v1/rates      -> quotes[] + remote_shipment_id
 *   2. POST /shipping/api/v1/shipments  -> books a chosen rate, returns label (base64) + tracking
 *
 * Auth: `x-api-key: <VEEQO_API_KEY>` header.
 *
 * Everything here fails soft: no key / bad response / network error -> returns []
 * (rates) or throws (booking). Callers treat an empty rate list as "Veeqo
 * unavailable" and fall back to Shippo, so checkout never breaks.
 */

import { resolveSetting } from './_settings.js';

const VEEQO_BASE = 'https://api.veeqo.com';

export function veeqoKey(env, cache) {
  return resolveSetting('VEEQO_API_KEY', env, cache || {});
}

// Map "USPS Ground Advantage" / "UPS Ground" -> a short carrier code that matches
// Shippo's rate.provider semantics (used for USPS-first sorting + display).
function carrierFromService(serviceName) {
  const s = String(serviceName || '');
  if (/usps/i.test(s)) return 'USPS';
  if (/ups/i.test(s)) return 'UPS';
  if (/fedex/i.test(s)) return 'FedEx';
  if (/dhl/i.test(s)) return 'DHL';
  return 'USPS';
}

function estDaysFromDate(deliveryDate) {
  if (!deliveryDate) return null;
  const d = new Date(deliveryDate).getTime();
  if (!Number.isFinite(d)) return null;
  const days = Math.round((d - Date.now()) / 86400000);
  return days > 0 ? days : null;
}

/**
 * Fetch normalized Veeqo rates. Returns [] when Veeqo is not configured or errors.
 * Each rate matches the Shippo-normalized shape used by /api/shippo-rates, plus
 * `source: 'veeqo'` and `remoteShipmentId` (needed to book the label later).
 *
 * @param from  Shippo-style from address { name, street1, street2, city, state, zip, country, phone }
 * @param to    { name, line1, line2, city, state, zip, country, phone }
 * @param parcel Shippo-style parcel { weight, mass_unit, length, width, height, distance_unit }
 */
export async function veeqoGetRates({ env, from, to, parcel, settingsCache }) {
  const key = veeqoKey(env, settingsCache);
  if (!key) return [];

  const addr = (a, fallbackName) => ({
    name: a.name || fallbackName,
    phone: a.phone || '0000000000',
    line1: a.line1 || a.street1 || '',
    line2: a.line2 || a.street2 || '',
    town: a.city || '',
    county: a.state || '',
    postcode: a.zip || '',
    country_code: String(a.country || 'US').toUpperCase(),
  });

  const body = {
    from_address: addr(from, 'Zuwera'),
    to_address: addr(to, 'Customer'),
    parcels: [{
      weight: parseFloat(parcel.weight) || 1,
      weight_unit: parcel.mass_unit || 'lb',
      length: parseFloat(parcel.length) || undefined,
      width: parseFloat(parcel.width) || undefined,
      height: parseFloat(parcel.height) || undefined,
      dimension_unit: parcel.distance_unit || 'in',
    }],
  };

  let data;
  try {
    const resp = await fetch(VEEQO_BASE + '/shipping/api/v1/rates', {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.error('Veeqo rates error:', resp.status, await resp.text().catch(() => ''));
      return [];
    }
    data = await resp.json();
  } catch (e) {
    console.error('Veeqo rates fetch failed:', e.message);
    return [];
  }

  const remoteShipmentId = data.remote_shipment_id || '';
  const quotes = Array.isArray(data.quotes) ? data.quotes : [];

  return quotes.map((q) => {
    const service = String(q.service_name || '');
    const amount = q.total_charge != null ? q.total_charge : q.base_rate;
    return {
      source: 'veeqo',
      objectId: q.rate_id,                 // the rate identifier used for booking
      remoteShipmentId,
      provider: carrierFromService(service),
      servicelevel: service.replace(/^USPS\s+/i, '').trim() || service,
      amount: amount != null ? String(amount) : '',
      currency: q.currency_code || 'USD',
      days: estDaysFromDate(q.delivery_date),
    };
  }).filter((r) => r.objectId && r.amount && r.remoteShipmentId);
}

/**
 * Book a previously-quoted Veeqo rate and get the label. Throws on failure.
 * Returns a Shippo-transaction-shaped object so the webhook can treat it uniformly.
 * NOTE: Veeqo returns the label as base64 PDF content (not a hosted URL).
 */
export async function veeqoBookShipment({ env, rateId, remoteShipmentId, settingsCache }) {
  const key = veeqoKey(env, settingsCache);
  if (!key) throw new Error('VEEQO_API_KEY not set');
  if (!rateId || !remoteShipmentId) throw new Error('Veeqo booking needs rateId + remoteShipmentId');

  const resp = await fetch(VEEQO_BASE + '/shipping/api/v1/shipments', {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label_format: 'PDF',
      shipments: [{ remote_shipment_id: remoteShipmentId, rate_id: rateId }],
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('Veeqo booking failed: ' + JSON.stringify(data));

  // Response may return the shipment at top level or nested under shipments[0].
  const s = (Array.isArray(data.shipments) && data.shipments[0]) || data;
  const b64 = s.label_content || s.labelContent || s.label || '';

  return {
    tracking_number: s.tracking_number || s.trackingNumber || '',
    tracking_url_provider: s.tracking_url || s.tracking_url_provider || s.trackingUrl || '',
    // Store the label inline as a data URL so it works everywhere label_url is used
    // (admin download link, order record) without needing a file host.
    label_url: b64 ? ('data:application/pdf;base64,' + b64) : '',
    label_is_inline: !!b64,
  };
}
