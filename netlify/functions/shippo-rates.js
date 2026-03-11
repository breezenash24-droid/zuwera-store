/**
 * Netlify Function: shippo-rates
 *
 * Fetches live shipping rates from Shippo for a given address + parcel.
 *
 * POST body (JSON):
 *  {
 *    address: { name, line1, city, state, zip, country },
 *    parcel: { length, width, height, weight }  // optional
 *  }
 *
 * Response: { rates: [{ provider, servicelevel, amount, currency, days, objectId }] }
 */

const { ok, err, preflight, getFromAddress, DEFAULT_PARCEL } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST')    return err(405, 'Method not allowed');

  try {
    const { address, parcel: customParcel } = JSON.parse(event.body);

    if (!address?.zip || !address?.country)
      return err(400, 'address.zip and address.country are required');

    const parcel = customParcel || DEFAULT_PARCEL;

    const shipmentPayload = {
      address_from: getFromAddress(),
      address_to: {
        name:    address.name    || 'Customer',
        street1: address.line1   || '',
        city:    address.city    || '',
        state:   address.state   || '',
        zip:     address.zip,
        country: address.country || 'US',
      },
      parcels: [parcel],
      async: false,
    };

    const resp = await fetch('https://api.goshippo.com/shipments/', {
      method: 'POST',
      headers: {
        Authorization:  `ShippoToken ${process.env.SHIPPO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(shipmentPayload),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      console.error('Shippo error:', detail);
      return err(502, 'Shippo API error');
    }

    const data  = await resp.json();
    const rates = (data.rates || [])
      .filter(r => r.object_status === 'VALID')
      .map(r => ({
        objectId:     r.object_id,
        provider:     r.provider,
        servicelevel: r.servicelevel_name,
        amount:       r.amount,
        currency:     r.currency,
        days:         r.estimated_days,
      }))
      .sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount));

    return ok({ rates });
  } catch (e) {
    console.error('shippo-rates error:', e);
    return err(500, e.message);
  }
};
