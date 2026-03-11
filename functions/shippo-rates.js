/**
 * Cloudflare Pages Function: /api/shippo-rates
 *
 * Runs on Cloudflare's edge network (Workers runtime).
 * env vars are accessed via context.env — NOT process.env.
 *
 * Environment variables (set in CF Pages Dashboard → Settings → Environment variables):
 *   SHIPPO_API_KEY, SHIPPO_FROM_NAME, SHIPPO_FROM_STREET1,
 *   SHIPPO_FROM_CITY, SHIPPO_FROM_STATE, SHIPPO_FROM_ZIP,
 *   SHIPPO_FROM_COUNTRY, SHIPPO_FROM_EMAIL, SITE_URL
 */

const CORS = (env) => ({
  'Access-Control-Allow-Origin':  env.SITE_URL || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
});

const DEFAULT_PARCEL = {
  length: '14', width: '10', height: '4', distance_unit: 'in',
  weight: '2',  mass_unit: 'lb',
};

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function onRequestPost({ request, env }) {
  const headers = CORS(env);

  try {
    const { address, parcel: customParcel } = await request.json();

    if (!address?.zip || !address?.country)
      return new Response(JSON.stringify({ error: 'address.zip and address.country are required' }), { status: 400, headers });

    const parcel = customParcel || DEFAULT_PARCEL;

    const fromAddress = {
      name:    env.SHIPPO_FROM_NAME    || 'Zuwera',
      street1: env.SHIPPO_FROM_STREET1 || '123 Brand St',
      city:    env.SHIPPO_FROM_CITY    || 'Los Angeles',
      state:   env.SHIPPO_FROM_STATE   || 'CA',
      zip:     env.SHIPPO_FROM_ZIP     || '90001',
      country: env.SHIPPO_FROM_COUNTRY || 'US',
      email:   env.SHIPPO_FROM_EMAIL   || 'orders@zuwera.store',
    };

    const resp = await fetch('https://api.goshippo.com/shipments/', {
      method: 'POST',
      headers: {
        Authorization:  `ShippoToken ${env.SHIPPO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        address_from: fromAddress,
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
      return new Response(JSON.stringify({ error: 'Shippo API error' }), { status: 502, headers });
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

    return new Response(JSON.stringify({ rates }), { status: 200, headers });

  } catch (e) {
    console.error('shippo-rates error:', e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}
