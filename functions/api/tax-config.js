/**
 * Cloudflare Pages Function: /api/tax-config
 *
 * The rates as the server actually has them.
 *
 * Two things live here, and the difference between them matters:
 *
 *   • the raw overrides an admin has saved, which is what the Tax page edits;
 *   • `effective`, the table the payment path will really use — shipped
 *     defaults, then Cloudflare env vars, then those overrides, merged in that
 *     order by the same function that merges them at checkout.
 *
 * `effective` exists because the admin page had its own hardcoded copy of the
 * rate table to display, and a page that shows you 7.0% while the store charges
 * 7.8% is worse than one that shows you nothing — it is where you would go to
 * check, and it would confirm the wrong number.
 */

import { fetchSiteSettings } from './_settings.js';
import { effectiveTables, getTaxEngineConfig } from './_tax.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=300', // 5-minute CDN cache
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
}

export async function onRequestGet({ env }) {
  try {
    const settings = await fetchSiteSettings(['tax_rate_overrides'], env);
    const raw = settings.tax_rate_overrides;
    const overrides = raw
      ? (typeof raw === 'object' ? raw : JSON.parse(raw))
      : {};
    // Strip the internal metadata before returning to the browser
    const { updatedAt: _u, editedKeys: _e, ...ratesOnly } = overrides;
    /* WHICH engine, not just which rates. The integrations panel already asked
       this endpoint for `engine` and this endpoint never answered — it read
       tax_rate_overrides and nothing else — so the answer was always '' and the
       Stripe Tax card reported "not selected as this store's engine" while
       Stripe Tax was pricing every order. A card whose whole job is to tell you
       whether something is switched on, confidently saying no.

       Not a secret, and not a new exposure: /api/tax-quote has always returned
       the engine name, and the provider credentials are Cloudflare env vars.
       The worst this discloses is which tax service the store uses. */
    const cfg = await getTaxEngineConfig(env);

    return new Response(JSON.stringify({
      ...ratesOnly,
      engine: cfg.engine,
      /* Whether the built-in table can still price an order if the provider
         cannot be reached — which decides how much of the Tax page is even
         relevant. */
      fallback: cfg.fallback !== false,
      /* What checkout will actually charge from, so the Tax page can show the
         real numbers instead of a copy that drifts. */
      effective: effectiveTables(env, overrides),
    }), { status: 200, headers: CORS_HEADERS });
  } catch (_) {
    return new Response('{}', { status: 200, headers: CORS_HEADERS });
  }
}
