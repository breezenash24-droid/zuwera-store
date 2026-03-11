/**
 * Vercel Serverless Function: /api/shippo-rates
 *
 * Fetches live shipping rates from Shippo.
 *
 * Environment variables (set in Vercel Dashboard → Settings → Environment):
 *   SHIPPO_API_KEY, SHIPPO_FROM_NAME, SHIPPO_FROM_STREET1,
 *   SHIPPO_FROM_CITY, SHIPPO_FROM_STATE, SHIPPO_FROM_ZIP,
 *   SHIPPO_FROM_COUNTRY, SHIPPO_FROM_EMAIL, SITE_URL
 */

const CORS = {
  'Access-Control-Allow-Origin':  process.env.SITE_URL || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function getFromAddress() {
  return {
    name:    process.env.SHIPPO_FROM_NAME    || 'Zuwera',
    street1: process.env.SHIPPO_FROM_STREET1 || '123 Brand St',
    city:    process.env.SHIPPO_FROM_CITY    || 'Los Angeles',
    state:   process.env.SHIPPO_FROM_STATE   || 'CA',
    zip:     process.env.SHIPPO_FROM_ZIP     || '90001',
    country: process.env.SHIPPO_FROM_COUNTRY || 'US',
    email:   process.env.SHIPPO_FROM_EMAIL   || 'orders@zuwera.store',
  };
}

const DEFAULT_PARCEL = {
  length: '14', width: '10', height: '4', distance_unit: 'in',
  weight: '2',  mass_unit: 'lb',
};

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { address, parcel: customParcel } = req.body;

    if (!address?.zip || !address?.country)
      return res.status(400).json({ error: 'address.zip and address.country are required' });

    const parcel = customParcel || DEFAULT_PARCEL;

    const resp = await fetch('https://api.goshippo.com/shipments/', {
      method: 'POST',
      headers: {
        Authorization:  `ShippoToken ${process.env.SHIPPO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
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
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      console.error('Shippo error:', detail);
      return res.status(502).json({ error: 'Shippo API error' });
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

    return res.status(200).json({ rates });
  } catch (e) {
    console.error('shippo-rates error:', e);
    return res.status(500).json({ error: e.message });
  }
};
