/**
 * _paused.js — temporarily stop using a service without deleting its key.
 *
 * WHY THIS IS NOT AVAILABLE FOR EVERY SERVICE, which is the important half.
 *
 * A pause button is a request to make something stop happening. On a service
 * the store does not depend on, that is a useful control: SMS costs money per
 * message, order alerts get noisy, a second shipping provider can be switched
 * off while you look at a bill. On a service the store DOES depend on, the same
 * button is a way to break the shop from a settings page and not notice.
 *
 * The line is whether a customer can tell:
 *
 *   PAUSABLE — nothing a customer sees changes. SMS is an extra on top of the
 *   email they still get. Order alerts go to you, not them. Veeqo is a second
 *   opinion on rates Shippo already provides.
 *
 *   NOT PAUSABLE — Stripe (there is no store without payments), Supabase (there
 *   is no store at all), Resend (order confirmations stop and every signal still
 *   says fine — this codebase has already lost a week to exactly that failure),
 *   Shippo (checkout cannot quote shipping), Cloudflare and Cloudinary (pages
 *   and images).
 *
 * The refusal is deliberate. "Pause Resend" is a single click that silently
 * stops every customer being told their order exists, and the store would look
 * completely healthy while it happened. A control that dangerous should not be
 * one button away from the ones that are safe.
 *
 * Translation and the tax engine are absent for a different reason: they already
 * have "Off" in their own dropdowns, and a second way to say the same thing is
 * how two settings end up disagreeing.
 *
 * Loops was on this list and was removed. It reads like optional marketing, but
 * in this codebase loopsFallback() is the FOURTH tier of email failover and
 * nothing else — pausing it would quietly remove the last thing standing
 * between a Resend-and-Brevo outage and a customer never hearing that their
 * order exists. That is customer email, so it fails the rule above.
 */

import { fetchSiteSettings, resolveSetting } from './_settings.js';

/* The complete list. A service not named here has no pause and cannot be given
   one by writing a settings row — the check below only answers for these. */
export const PAUSABLE = ['twilio', 'veeqo', 'orderAlerts'];

export const PAUSE_LABELS = {
  twilio:      'SMS notifications',
  veeqo:       'Veeqo rate-shopping',
  orderAlerts: 'Slack / Discord order alerts',
};

/* What stops, said plainly, so the confirmation is about consequences rather
   than a service name. */
export const PAUSE_EFFECT = {
  twilio:      'Customers stop getting shipping texts. They still get every email.',
  veeqo:       'Rates come from Shippo only. Checkout still quotes and labels still print.',
  orderAlerts: 'You stop getting order pings. Orders are unaffected.',
};

/**
 * Is this service paused?
 *
 * Reads site_settings.api_paused, a flat map of service → true. Pass a
 * pre-fetched cache to avoid a second round trip inside a request that has
 * already read settings.
 *
 * Fails OPEN — an unreadable setting means NOT paused. A pause is a
 * convenience; a service silently staying off because a settings read wobbled
 * is an outage nobody asked for.
 */
export function isPaused(cache, service) {
  if (!PAUSABLE.includes(service)) return false;
  let raw = cache && cache.api_paused;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (_) { return false; } }
  return !!(raw && typeof raw === 'object' && raw[service] === true);
}

/** Convenience for a caller with no cache in hand. */
export async function loadPaused(env) {
  try {
    const cache = await fetchSiteSettings(['api_paused'], env);
    return cache || {};
  } catch (_) { return {}; }
}
