/**
 * Order alerts — posts a short "new order" message to Slack and/or Discord.
 *
 * Configured from the admin (APIs → More Integrations). The webhook URLs are
 * secrets: anyone holding one can post into the channel, so they live in the
 * masked key store (ALLOWED_KEYS in _settings.js) rather than in
 * site_settings.integrations, which is anon-readable by design.
 *
 * Called fire-and-forget from stripe-webhook AFTER fulfilment has already
 * succeeded. Nothing in here may throw or block: a Slack outage must never
 * turn a paid, fulfilled order into a 500 that Stripe then retries.
 */

import { fetchSiteSettings, resolveSetting } from './_settings.js';
import { isPaused } from './_paused.js';

const TIMEOUT_MS = 4000;

function money(cents) {
  const n = Number(cents);
  return Number.isFinite(n) ? `$${(n / 100).toFixed(2)}` : '—';
}

/** Never let a slow or hanging webhook hold the request open. */
async function postJson(url, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!resp.ok) console.warn('order alert rejected:', resp.status);
  } catch (e) {
    console.warn('order alert failed (non-fatal):', e.message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} env
 * @param {object} order
 * @param {string} order.orderNumber
 * @param {number} order.totalCents
 * @param {string} [order.email]
 * @param {Array<{name:string,quantity:number}>} [order.items]
 * @param {string} [order.siteUrl]
 */
export async function sendOrderAlerts(env, order) {
  let slack = '';
  let discord = '';
  try {
    const cache = await fetchSiteSettings(['SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL', 'api_paused'], env);
    /* Paused from the admin. Read here rather than at the webhook call so a
       pause covers both channels at once and cannot half-apply. */
    if (isPaused(cache, 'orderAlerts')) return;
    slack   = resolveSetting('SLACK_WEBHOOK_URL', env, cache);
    discord = resolveSetting('DISCORD_WEBHOOK_URL', env, cache);
  } catch (e) {
    console.warn('order alert config read failed (non-fatal):', e.message);
    return;
  }
  if (!slack && !discord) return;

  const lines = (order.items || [])
    .slice(0, 10)
    .map(i => `• ${i.quantity || 1} × ${i.name}`)
    .join('\n');
  const extra = (order.items || []).length > 10 ? `\n…and ${order.items.length - 10} more` : '';

  // Deliberately no shipping address or full name — these land in a chat channel
  // that is usually broader than the people entitled to customer PII.
  const text =
    `🛒 *New order ${order.orderNumber}* — ${money(order.totalCents)}\n` +
    (order.email ? `${order.email}\n` : '') +
    (lines ? `${lines}${extra}` : '');

  const jobs = [];
  if (slack)   jobs.push(postJson(slack, { text }));
  // Discord uses ** for bold and rejects Slack's single-asterisk syntax.
  if (discord) jobs.push(postJson(discord, { content: text.replace(/\*(.+?)\*/g, '**$1**') }));

  await Promise.allSettled(jobs);
}
