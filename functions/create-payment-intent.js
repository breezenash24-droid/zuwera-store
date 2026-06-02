/**
 * Cloudflare Pages Function: /api/create-payment-intent
 *
 * Runs on Cloudflare's edge network (Workers runtime).
 * env vars are accessed via context.env — NOT process.env.
 *
 * Environment variables (set in CF Pages Dashboard → Settings → Environment variables):
 *   STRIPE_SECRET_KEY, SITE_URL
 *
 * Note: Uses Stripe SDK v10+ which supports the Workers/edge runtime.
 *       Run `npm install stripe` in your project root before deploying.
 */

import Stripe from 'stripe';

const CORS = (env) => ({
  'Access-Control-Allow-Origin':  env.SITE_URL || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
});

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
  const stripe  = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });

  try {
    const { items, shippingRate, shippingAmountCents, address } = await request.json();

    if (!items?.length || !address?.email)
      return new Response(JSON.stringify({ error: 'Missing required fields: items and address.email' }), { status: 400, headers });

    const getItemName = (item) => item?.name || item?.title || 'Product';
    const getItemPriceCents = (item) => {
      const parsed = Number.parseFloat(item?.price);
      if (!Number.isFinite(parsed) || parsed < 0) return 0;
      return Math.round(parsed * 100);
    };
    const parseShippingFallbackCents = (value) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) return 0;
      return Math.round(parsed);
    };

    const subtotalCents = items.reduce(
      (sum, item) => sum + getItemPriceCents(item) * (item.quantity || 1),
      0
    );
    const parsedShippingAmount = Number.parseFloat(shippingRate?.amount);
    const shippingCents = Number.isFinite(parsedShippingAmount) && parsedShippingAmount > 0
      ? Math.round(parsedShippingAmount * 100)
      : parseShippingFallbackCents(shippingAmountCents);

    const lineItems = items.map(item => ({
      name:     getItemName(item),
      amount:   getItemPriceCents(item),
      quantity: item.quantity || 1,
    }));

    // ── Sales tax (mirrors checkout-tax.js — keep in sync) ────────────────
    const salesTaxRate = (() => {
      const FLAT = { KY: 0.06, IN: 0.07 };
      const OH_COUNTY = {
        Adams:0.0725,Allen:0.0675,Ashland:0.07,Ashtabula:0.07,Athens:0.07,
        Auglaize:0.0725,Belmont:0.0725,Brown:0.0725,Butler:0.07,Carroll:0.0725,
        Champaign:0.0725,Clark:0.0725,Clermont:0.07,Clinton:0.0725,Columbiana:0.0725,
        Coshocton:0.0725,Crawford:0.0725,Cuyahoga:0.08,Darke:0.0725,Defiance:0.0725,
        Delaware:0.07,Erie:0.0675,Fairfield:0.0675,Fayette:0.0725,Franklin:0.075,
        Fulton:0.0725,Gallia:0.0725,Geauga:0.07,Greene:0.0675,Guernsey:0.0725,
        Hamilton:0.07,Hancock:0.0675,Hardin:0.0725,Harrison:0.0725,Henry:0.0725,
        Highland:0.0725,Hocking:0.0725,Holmes:0.0725,Huron:0.0725,Jackson:0.0725,
        Jefferson:0.0725,Knox:0.0725,Lake:0.0725,Lawrence:0.0725,Licking:0.0725,
        Logan:0.0725,Lorain:0.065,Lucas:0.0725,Madison:0.07,Mahoning:0.0725,
        Marion:0.0725,Medina:0.0675,Meigs:0.0725,Mercer:0.0725,Miami:0.0675,
        Monroe:0.0725,Montgomery:0.075,Morgan:0.0725,Morrow:0.0725,Muskingum:0.0725,
        Noble:0.0725,Ottawa:0.07,Paulding:0.0725,Perry:0.0725,Pickaway:0.0725,
        Pike:0.0725,Portage:0.0725,Preble:0.07,Putnam:0.0725,Richland:0.0725,
        Ross:0.0725,Sandusky:0.0725,Scioto:0.0725,Seneca:0.0725,Shelby:0.0725,
        Stark:0.065,Summit:0.0675,Trumbull:0.0725,Tuscarawas:0.0725,Union:0.07,
        VanWert:0.0725,Vinton:0.0725,Warren:0.0675,Washington:0.0725,Wayne:0.0675,
        Williams:0.0725,Wood:0.0675,Wyandot:0.0725,
      };
      const OH_ZIP3 = {
        '430':'Franklin','431':'Franklin','432':'Franklin','433':'Marion','434':'Wood',
        '435':'Defiance','436':'Lucas','437':'Muskingum','438':'Coshocton',
        '440':'Lorain','441':'Cuyahoga','442':'Summit','443':'Summit',
        '444':'Mahoning','445':'Mahoning','446':'Stark','447':'Stark','448':'Stark',
        '449':'Richland',
        '450':'Hamilton','451':'Clermont','452':'Hamilton','453':'Miami','454':'Montgomery',
        '455':'Clark','456':'Ross','457':'Athens','458':'Allen','459':'Allen',
      };
      const IL_ZIP3 = {
        '600':0.0825,'601':0.0725,'602':0.0725,'603':0.07,'604':0.0825,'605':0.0725,
        '606':0.1025,'607':0.1025,'608':0.0825,'609':0.075,
        '610':0.0825,'611':0.08,'612':0.0825,'613':0.0625,'614':0.085,'615':0.085,
        '616':0.0825,'617':0.0625,'618':0.0725,'619':0.0725,
        '620':0.0835,'621':0.0725,'622':0.0625,'623':0.085,'624':0.085,'625':0.09,
        '626':0.085,'627':0.085,'628':0.0625,'629':0.0725,
      };
      const BASE = {
        AL:0.04,AK:0,AZ:0.056,AR:0.065,CA:0.0725,CO:0.029,CT:0.0635,DE:0,
        FL:0.06,GA:0.04,HI:0.04,ID:0.06,IL:0.0625,IN:0.07,IA:0.06,KS:0.065,
        KY:0.06,LA:0.05,ME:0.055,MD:0.06,MA:0.0625,MI:0.06,MN:0.06875,
        MS:0.07,MO:0.04225,MT:0,NE:0.055,NV:0.0685,NH:0,NJ:0.06625,
        NM:0.05125,NY:0.04,NC:0.0475,ND:0.05,OH:0.0575,OK:0.045,OR:0,
        PA:0.06,RI:0.07,SC:0.06,SD:0.042,TN:0.07,TX:0.0625,UT:0.061,
        VT:0.06,VA:0.053,WA:0.065,WV:0.06,WI:0.05,WY:0.04,DC:0.06,
      };
      return function(state, zip) {
        const s = (state || '').toUpperCase().slice(0, 2);
        if (!s) return 0;
        if (FLAT[s] !== undefined) return FLAT[s];
        const z = String(zip || '').replace(/\D/g, '');
        if (s === 'OH' && z.length >= 3) {
          const county = OH_ZIP3[z.slice(0, 3)];
          return (county && OH_COUNTY[county]) ? OH_COUNTY[county] : 0.0725;
        }
        if (s === 'IL' && z.length >= 3) return IL_ZIP3[z.slice(0, 3)] ?? (BASE.IL || 0.0625);
        return BASE[s] || 0;
      };
    })();

    const taxRate  = salesTaxRate(address.state, address.zip);
    const taxCents = Math.round(subtotalCents * taxRate); // tax on merchandise only, not shipping

    // Deterministic idempotency key (no Buffer in Workers — use btoa)
    const cartFingerprint = items
      .map(i => `${getItemName(i)}:${i.quantity || 1}:${getItemPriceCents(i)}`)
      .sort()
      .join('|');
    const encoded        = btoa(unescape(encodeURIComponent(cartFingerprint))).slice(0, 32);
    const idempotencyKey = `pi_${address.email}_${shippingCents}_${encoded}`;

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount:   subtotalCents + shippingCents + taxCents,
        currency: 'usd',
        automatic_payment_methods: { enabled: true },
        receipt_email: address.email,
        shipping: {
          name: address.name,
          address: {
            line1:       address.line1,
            line2:       address.line2 || '',
            city:        address.city,
            state:       address.state,
            postal_code: address.zip,
            country:     address.country || 'US',
          },
        },
        metadata: {
          customer_email:        address.email,
          customer_name:         address.name,
          items:                 JSON.stringify(lineItems),
          shipping_provider:     shippingRate?.provider    || '',
          shipping_service:      shippingRate?.servicelevel || '',
          shipping_amount_cents: String(shippingCents),
          tax_amount_cents:      String(taxCents),
          tax_rate:              String(taxRate),
          ship_line1:   address.line1,
          ship_line2:   address.line2 || '',
          ship_city:    address.city,
          ship_state:   address.state,
          ship_zip:     address.zip,
          ship_country: address.country || 'US',
        },
      },
      { idempotencyKey }
    );

    return new Response(JSON.stringify({
      clientSecret: paymentIntent.client_secret,
      orderId:      paymentIntent.id,
      subtotal:     (subtotalCents / 100).toFixed(2),
      shipping:     (shippingCents  / 100).toFixed(2),
      tax:          (taxCents       / 100).toFixed(2),
    }), { status: 200, headers });

  } catch (e) {
    console.error('create-payment-intent error:', e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}
