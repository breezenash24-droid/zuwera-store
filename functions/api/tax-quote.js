/**
 * Cloudflare Pages Function: /api/tax-quote
 *
 * What the checkout summary is allowed to display as tax.
 *
 * Before this existed, the browser worked tax out for itself from a copy of the
 * rate table baked into checkout-tax.js, and the server worked it out from
 * resolveTax(). Two answerers, one question — and they disagreed in the way
 * those things always do: quietly, and about money. A cart shown at $93.75 was
 * charged $94.39, because the browser's table said Hamilton County was 7.0% and
 * the engine the store had actually configured said 7.8%. The browser's copy
 * could not have known: it had no idea an engine setting existed at all.
 *
 * So the browser stops working it out. It asks here, and here calls the very
 * same resolveTax() the payment path calls. If the answer is wrong now, it is
 * wrong in both places at once and by the same amount — which is a bug you can
 * find, rather than a discrepancy nobody sees until a customer writes in.
 *
 * Deliberately unauthenticated: tax has to be shown before anyone signs in, and
 * a rate for a ZIP is not a secret. It stays cheap to serve because the answer
 * is cached at the edge and, for external engines, again inside resolveTax.
 */

import { resolveTax, normalizeStateCode } from './_tax.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

/* Long enough that typing a ZIP does not mean a provider call per keystroke,
   short enough that a rate corrected in Admin → Tax reaches shoppers the same
   afternoon rather than the next deploy. */
const EDGE_CACHE_SECONDS = 300;

/* A quote is a display figure, and the amount only scales it. Clamping keeps a
   stray or hostile value from being multiplied into nonsense, and keeps this
   endpoint from being a way to run up someone's metered tax-API bill. */
const MAX_AMOUNT_CENTS = 100_000_00;

function intParam(value, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, max);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
  });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = url.searchParams;

  const address = {
    state: q.get('state') || '',
    zip: q.get('zip') || '',
    city: q.get('city') || '',
    country: (q.get('country') || 'US').trim().toUpperCase() || 'US',
  };

  const taxableCents  = intParam(q.get('amount'), MAX_AMOUNT_CENTS);
  const shippingCents = intParam(q.get('shipping'), MAX_AMOUNT_CENTS);

  try {
    /* No dbOverrides passed on purpose — resolveTax reads Admin → Tax itself,
       so this endpoint cannot drift from the payment path by forgetting to. */
    const tax = await resolveTax({
      env, request, address, taxableCents, shippingCents,
    });

    return new Response(JSON.stringify({
      stateCode: tax.stateCode || normalizeStateCode(address.state),
      rate: tax.rate || 0,
      taxCents: tax.taxCents || 0,
      engine: tax.engine || 'builtin',
      /* Present when an external provider could not be reached. The shopper is
         never shown this; it is here so the browser console and anyone reading
         a HAR file can tell an approximate quote from an authoritative one. */
      ...(tax.fallbackFrom ? { fallbackFrom: tax.fallbackFrom } : {}),
      ...(tax.cached ? { cached: true } : {}),
    }), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        /* Vary is implicit in the query string, so a plain public cache is safe
           here — two shoppers in the same ZIP with the same cart total should
           absolutely get the same answer. */
        'Cache-Control': `public, max-age=60, s-maxage=${EDGE_CACHE_SECONDS}`,
      },
    });
  } catch (err) {
    /* resolveTax is written never to throw, so reaching here means something
       structural — settings unreadable, an import gone missing. Answering "I do
       not know" lets the checkout show a pending tax line and carry on; the
       amount that gets CHARGED is computed server-side at payment time either
       way, so a failure here costs a display, not a sale. */
    console.error('[tax-quote]', err && err.message);
    return new Response(JSON.stringify({ unavailable: true }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
    });
  }
}
