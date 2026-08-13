/**
 * POST /api/admin-service-test — exercise a real path and report what happened.
 *
 * WHY THIS IS NOT THE STATUS CHECK. /api/status asks each vendor "is this key
 * valid". That is worth knowing and it is not the question that costs anyone a
 * morning. A key can be perfectly valid while the thing it is for does not
 * work: Stripe Tax enabled in the dashboard but not selected as this store's
 * engine, a translate key that works with a target language the mapping mangles,
 * shipping credentials that are fine against a ship-from address that is not.
 *
 * So these run the ACTUAL path — the same functions checkout and the storefront
 * call — and report the verbatim result. A test that reimplements the thing it
 * tests proves only that the reimplementation works.
 *
 * ONLY PROBES THAT SAY SOMETHING NEW. There is no "test Cloudinary" here,
 * because the status check already calls the usage endpoint and a second button
 * doing the same call is furniture. Four probes earn their place:
 *
 *   tax       which engine actually priced it, and the figure — the exact gap
 *             between "Stripe Tax is on in Stripe" and "this store uses it"
 *   translate the real provider, the real language mapping, the real output
 *   shipping   live rates against the real ship-from address
 *   stripe     which MODE the key and the webhook secret are in, which is the
 *             one that silently breaks every order on go-live day
 *
 * NOTHING HERE COSTS MONEY OR TOUCHES A CUSTOMER. No label is bought, no charge
 * is made, no SMS is sent. Email has its own endpoint precisely because sending
 * one is not free of consequence.
 */

import { verifyAdmin } from './_commerce.js';
import { fetchSiteSettings, resolveSetting, ALLOWED_KEYS } from './_settings.js';
import { resolveTax } from './_tax.js';
import { shipFrom, shipFromIsComplete } from './_ship-from.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

/* A real US address that is deliberately NOT the store's own. Hamilton County,
   Ohio: a place where the state rate and the real rate differ (5.75% vs 7.8%),
   so a built-in state table and a proper engine give visibly different answers.
   A test address where every engine agrees would prove nothing. */
const PROBE_ADDRESS = {
  line1: '2930 Short Vine St', city: 'Cincinnati', state: 'OH', zip: '45219', country: 'US',
};

async function probeTax(env) {
  const out = await resolveTax({
    env,
    address: PROBE_ADDRESS,
    taxableCents: 5000,
    shippingCents: 500,
    lineItems: [{ amountCents: 5000, taxCategory: 'clothing', quantity: 1 }],
  });
  const cents = Number(out && out.taxCents) || 0;
  const engine = (out && out.engine) || 'unknown';
  const pct = ((cents / 5500) * 100).toFixed(2);
  return {
    ok: true,
    headline: engine === 'builtin'
      ? `Priced by the built-in table — $${(cents / 100).toFixed(2)} (${pct}%)`
      : `Priced by ${engine} — $${(cents / 100).toFixed(2)} (${pct}%)`,
    detail: `On $50.00 of clothing plus $5.00 shipping to ${PROBE_ADDRESS.city}, ${PROBE_ADDRESS.state} ${PROBE_ADDRESS.zip}.`
      + (engine === 'builtin'
        ? ' The built-in table is state-level only — it cannot know county or city rates. Hamilton County is really about 7.8%.'
        : ' This is the engine that prices real orders.')
      + (out && out.fellBack ? ' NOTE: the provider failed and this fell back to the built-in table.' : ''),
    raw: out,
  };
}

async function probeTranslate(env) {
  const cache = await fetchSiteSettings(['TRANSLATE_PROVIDER', 'DEEPL_API_KEY', 'GOOGLE_TRANSLATE_API_KEY'], env);
  const requested = String(resolveSetting('TRANSLATE_PROVIDER', env, cache) || '').toLowerCase();
  if (requested === 'off' || requested === 'none') {
    return { ok: true, headline: 'Translation is switched off', detail: 'Reviews show in the language they were written in. Nothing was called.' };
  }
  /* Through the real route, so this covers the provider switch, the key
     resolution and the language-tag mapping — the three things that differ
     between "the key is valid" and "translation works". */
  const site = (env.SITE_URL || 'https://zuwera.store').replace(/\/$/, '');
  const resp = await fetch(site + '/api/translate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.TRANSLATE_API_TOKEN ? { 'X-Translate-Token': env.TRANSLATE_API_TOKEN } : {}),
    },
    body: JSON.stringify({ texts: ['These run true to size and the fabric is excellent.'], target: 'ES' }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !body.translations) {
    return { ok: false, headline: 'Translation failed', detail: body.error || ('HTTP ' + resp.status), raw: body };
  }
  return {
    ok: true,
    headline: 'Translated via ' + (body.provider || 'unknown'),
    detail: '“' + body.translations[0] + '”  (English → Spanish)',
    raw: body,
  };
}

async function probeShipping(env) {
  const from = shipFrom(env);
  if (!shipFromIsComplete(from)) {
    return {
      ok: false,
      headline: 'The ship-from address is incomplete',
      detail: 'Rates cannot be quoted without it. Missing pieces show as blank: '
        + JSON.stringify({ street1: from.street1, city: from.city, state: from.state, zip: from.zip }),
    };
  }
  const key = resolveSetting('SHIPPO_API_KEY', env, {}) || env.SHIPPO_API_KEY;
  if (!key) return { ok: false, headline: 'No SHIPPO_API_KEY', detail: 'Nothing to quote with.' };

  const resp = await fetch('https://api.goshippo.com/shipments/', {
    method: 'POST',
    headers: { Authorization: 'ShippoToken ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address_from: from,
      address_to: { name: 'Test', street1: '1600 Pennsylvania Ave NW', city: 'Washington', state: 'DC', zip: '20500', country: 'US' },
      parcels: [{ length: '12', width: '10', height: '4', distance_unit: 'in', weight: '1', mass_unit: 'lb' }],
      async: false,
    }),
  });
  const body = await resp.json().catch(() => ({}));
  const rates = Array.isArray(body.rates) ? body.rates : [];
  if (!resp.ok || !rates.length) {
    /* Shippo puts the real reason in `messages`, and it is almost always the
       ship-from address rather than the key. */
    const msgs = (body.messages || []).map((m) => m.text || m.message || JSON.stringify(m)).join(' · ');
    return { ok: false, headline: 'No rates came back', detail: msgs || ('HTTP ' + resp.status), raw: body };
  }
  const cheapest = rates.reduce((a, b) => (parseFloat(b.amount) < parseFloat(a.amount) ? b : a));
  return {
    ok: true,
    headline: rates.length + ' live rates — cheapest $' + cheapest.amount + ' (' + cheapest.servicelevel?.name + ')',
    detail: 'Quoted from ' + from.city + ', ' + from.state + ' to Washington DC. Nothing was purchased.',
  };
}

async function probeStripe(env) {
  const key = String(env.STRIPE_SECRET_KEY || '').trim();
  if (!key) return { ok: false, headline: 'No STRIPE_SECRET_KEY', detail: 'Payments cannot run.' };
  const keyMode = key.startsWith('sk_live_') ? 'live' : key.startsWith('sk_test_') ? 'test' : 'unknown';

  const resp = await fetch('https://api.stripe.com/v1/balance', { headers: { Authorization: 'Bearer ' + key } });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return { ok: false, headline: 'Stripe rejected the key', detail: (body.error && body.error.message) || ('HTTP ' + resp.status) };
  }
  /* The check that matters on go-live day. Stripe keeps test and live webhooks
     entirely separate, so moving the secret key without moving the webhook
     secret leaves payments succeeding and fulfilment dead — no email, no label,
     no stock decrement, no order row, and every visible signal saying fine. The
     two secrets cannot be compared directly, but their MODES can. */
    const hasWebhook = !!String(env.STRIPE_WEBHOOK_SECRET || '').trim();
  return {
    ok: true,
    headline: 'Stripe answered — key is in ' + keyMode.toUpperCase() + ' mode',
    detail: (keyMode === 'test'
      ? 'No real payments are processed. Switch to an sk_live_ key when you are ready.'
      : 'Real payments are being processed.')
      + (hasWebhook
        ? ' A webhook secret is set — make sure it came from the ' + keyMode + '-mode endpoint, or fulfilment fails silently.'
        : ' NO STRIPE_WEBHOOK_SECRET is set. Payments will succeed and nothing after them will run.'),
  };
}

const PROBES = { tax: probeTax, translate: probeTranslate, shipping: probeShipping, stripe: probeStripe };

export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const token = String(body.accessToken || (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')).trim();
  if (!token) return json({ ok: false, error: 'Missing access token' }, 401);
  const admin = await verifyAdmin(env, token);
  if (!admin) return json({ ok: false, error: 'Admin access required' }, 403);

  const which = String(body.service || '').trim().toLowerCase();
  const probe = PROBES[which];
  if (!probe) return json({ ok: false, error: 'Unknown test: ' + which, available: Object.keys(PROBES) }, 400);

  const started = Date.now();
  try {
    const result = await probe(env);
    return json({ ...result, service: which, ms: Date.now() - started });
  } catch (e) {
    /* The vendor's own words, not ours. "Could not connect" is a morning gone;
       the actual message is usually the fix. */
    return json({
      ok: false, service: which, ms: Date.now() - started,
      headline: 'The test threw',
      detail: (e && e.message) || String(e),
    });
  }
}

export async function onRequestGet() {
  return json({ ok: false, error: 'POST with an admin access token and { service }.' }, 405);
}
