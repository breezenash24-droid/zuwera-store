/**
 * Cloudflare Pages Function: /api/paypal-config
 *
 * Whether the checkout should offer PayPal, and the one public fact it needs to
 * draw the button.
 *
 * The client id is not a secret — PayPal's own SDK takes it in a script URL, so
 * it is visible in the page source of every store that accepts PayPal. The
 * secret is what matters, and it never leaves the Worker: paypalConfig() reads
 * both from the environment, and only clientId is returned from here.
 *
 * ── WHY BEING CONFIGURED IS NOT ENOUGH ──────────────────────────────────────
 *
 * Two conditions, both required:
 *
 *   Credentials exist.        Nothing to draw a button with otherwise.
 *   An admin has turned it on. commerce_config.payments.paypal.enabled
 *
 * Setting the environment variables looks like the deliberate act, and it very
 * nearly is. What stops it being enough is PAYPAL_ENV: it defaults to sandbox,
 * so the first credentials anyone adds are almost always sandbox credentials.
 * If having credentials alone lit the button, the moment those were saved every
 * shopper on the live storefront would be handed a PayPal window that cannot
 * take their money — and the store would look broken to everyone but the person
 * who set it up, who is the one person testing in sandbox on purpose.
 *
 * So switching it on is its own act, taken by someone who can see which mode it
 * is in. `mode` is returned for that: the checkout shows a test-mode notice in
 * sandbox, the same way the Stripe test banner works.
 */

import { getSetting, json } from './_commerce.js';
import { paypalConfig } from './_paypal.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

/* Pulled out so the decision can be run rather than read. Everything that
   matters about this endpoint is which of two independent facts have to be true
   together, and an assertion that reads the source cannot tell the `&&` from an
   `||`. */
export function paypalOffered({ configured, adminEnabled }) {
  /* Strictly true, and strict HERE rather than at the call site. Written the
     other way — a truthy test here and an `=== true` in the handler — the
     guarantee lives in the part that is awkward to run and the part that is
     easy to run promises less than the endpoint actually does. Then this
     function passes its tests while meaning something weaker than the code it
     stands for, which is a worse position than having no function at all.

     What it excludes: a settings row holding the string "true" or a 1, an
     unreadable database returning undefined, an absent key. None of those is
     somebody deciding to accept PayPal. */
  return configured === true && adminEnabled === true;
}

export async function onRequestGet({ env }) {
  const cfg = paypalConfig(env);

  /* Read raw and handed over as-is: paypalOffered decides what counts, so this
     block cannot accidentally be more permissive than the decision is. */
  let adminEnabled;
  try {
    const commerce = await getSetting(env, 'commerce_config', {});
    adminEnabled = (((commerce && commerce.payments) || {}).paypal || {}).enabled;
  } catch (e) {
    console.warn('paypal-config could not read commerce_config:', e && e.message);
  }

  const enabled = paypalOffered({ configured: cfg.configured, adminEnabled });

  return json({
    enabled,
    /* Only when it is actually being offered. A client id sitting in a response
       on a store that does not take PayPal is a loose end for no gain. */
    clientId: enabled ? cfg.clientId : '',
    mode: cfg.mode,
    /* So the admin panel can tell "no credentials" from "credentials, switched
       off" — two states that need completely different next steps and that a
       single `enabled: false` cannot distinguish. */
    configured: cfg.configured,
  }, 200, {
    ...CORS,
    /* Short. Turning PayPal off is something you might do because it is
       misbehaving, and a ten-minute cache would mean shoppers kept being shown
       it for ten minutes after you did. */
    'Cache-Control': 'public, max-age=30, s-maxage=60',
  });
}
