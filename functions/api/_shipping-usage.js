/**
 * Shippo free-tier usage counter.
 *
 * Shippo's free plan includes a fixed number of labels per calendar month
 * (default 30, override with SHIPPO_FREE_LIMIT). We count outbound labels
 * actually purchased via Shippo — the accurate signal — in a month-keyed
 * `site_settings` row:  SHIPPO_LABELS_YYYY_MM = <count>.
 *
 * The rate endpoint reads the count to decide whether to keep offering Shippo;
 * the webhook increments it after each successful Shippo label purchase.
 * Read-modify-write (no DB lock) is fine here: labels are bought one-per-order
 * in the webhook, so contention is negligible and being a label or two over the
 * limit just means one extra Shippo label — never a broken checkout.
 */

export function shippoMonthKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `SHIPPO_LABELS_${y}_${m}`;
}

export function shippoFreeLimit(env, cache = {}) {
  const raw = cache.SHIPPO_FREE_LIMIT || env.SHIPPO_FREE_LIMIT || '30';
  const n = parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function sb(env) {
  const url = (env.SUPABASE_URL || env.SUPABASE_PROJECT_URL || '').trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key) return null;
  return { url, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
}

function toInt(value) {
  // site_settings.value is JSONB — could come back as a number or a JSON string.
  const n = parseInt(String(value == null ? 0 : value).replace(/"/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Current month's Shippo label count (0 when unset or Supabase not configured). */
export async function getShippoMonthlyCount(env, key = shippoMonthKey()) {
  const c = sb(env);
  if (!c) return 0;
  try {
    const resp = await fetch(
      `${c.url}/rest/v1/site_settings?key=eq.${encodeURIComponent(key)}&select=value`,
      { headers: c.headers }
    );
    if (!resp.ok) return 0;
    const rows = await resp.json().catch(() => []);
    return toInt(rows && rows[0] && rows[0].value);
  } catch (_) {
    return 0;
  }
}

/** Increment this month's Shippo label count. Non-fatal — never throws. */
export async function incrementShippoMonthlyCount(env) {
  const c = sb(env);
  if (!c) return;
  const key = shippoMonthKey();
  try {
    const current = await getShippoMonthlyCount(env, key);
    await fetch(`${c.url}/rest/v1/site_settings?on_conflict=key`, {
      method: 'POST',
      headers: { ...c.headers, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ key, value: current + 1 }),
    });
  } catch (e) {
    console.error('incrementShippoMonthlyCount failed:', e.message);
  }
}

/**
 * Record a failed shipping-label purchase so the admin dashboard can raise a
 * flashing alert (a decline of the card on the Shippo/Veeqo account otherwise
 * fails silently — the order saves without tracking and nobody notices).
 *
 * Stored in site_settings.label_failures as a capped array of small entries.
 * site_settings is PUBLICLY READABLE, so no PII goes in here — only the order
 * number, provider source, a truncated error string, and a timestamp. The admin
 * (who has site_settings write access via RLS) clears entries from the dashboard.
 * Non-fatal — never throws.
 */
export async function recordLabelFailure(env, { order, pi, source, error }) {
  const c = sb(env);
  if (!c) return;
  const KEY = 'label_failures';
  try {
    const resp = await fetch(
      `${c.url}/rest/v1/site_settings?key=eq.${KEY}&select=value`,
      { headers: c.headers }
    );
    const rows = resp.ok ? await resp.json().catch(() => []) : [];
    let list = rows && rows[0] && rows[0].value;
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch (_) { list = []; } }
    if (!Array.isArray(list)) list = [];

    list.push({
      order: String(order || '').slice(0, 24),
      pi: String(pi || '').slice(0, 40),
      source: String(source || 'shippo').slice(0, 12),
      error: String(error || 'unknown').slice(0, 180),
      at: new Date().toISOString(),
    });
    // Keep the 20 most recent so the row never grows unbounded.
    list = list.slice(-20);

    await fetch(`${c.url}/rest/v1/site_settings?on_conflict=key`, {
      method: 'POST',
      headers: { ...c.headers, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ key: KEY, value: list }),
    });
  } catch (e) {
    console.error('recordLabelFailure failed:', e.message);
  }
}
