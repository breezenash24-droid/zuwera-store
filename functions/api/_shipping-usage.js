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
