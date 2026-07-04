// GET /api/posthog-summary?range=30
//
// Admin-only proxy for PostHog behavioural analytics. The PostHog *personal*
// API key is a secret and must never reach the browser, so this Function holds
// it (Cloudflare env: POSTHOG_PERSONAL_API_KEY) and runs the HogQL queries.
//
// Degrades gracefully: if the key isn't configured it returns
// { ok:true, configured:false } with 200 so the admin UI can show setup steps
// instead of an error. Requires the 'analytics' RBAC permission.
import { cors, json, verifyAdminCan } from './_commerce.js';

const PH_API = 'https://us.posthog.com'; // storefront uses us.i.posthog.com → US cloud

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestGet({ request, env }) {
  const headers = cors(env);
  try {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    const admin = await verifyAdminCan(env, token, 'analytics');
    if (!admin) return json({ ok: false, error: 'Not authorized' }, 401, headers);

    const key = env.POSTHOG_PERSONAL_API_KEY || env.POSTHOG_API_KEY || '';
    if (!key) return json({ ok: true, configured: false }, 200, headers);

    let days = parseInt(new URL(request.url).searchParams.get('range') || '30', 10);
    if (!Number.isFinite(days) || days <= 0) days = 30;
    if (days > 365) days = 365;

    // Resolve the project id (env override, else the key's default project).
    let projectId = env.POSTHOG_PROJECT_ID || '';
    if (!projectId) {
      const meRes = await fetch(`${PH_API}/api/users/@me/`, { headers: { Authorization: `Bearer ${key}` } });
      if (!meRes.ok) {
        const detail = (await meRes.text().catch(() => '')).slice(0, 200);
        return json({ ok: false, configured: true, error: `PostHog auth failed (${meRes.status}). Check the personal API key.`, detail }, 502, headers);
      }
      const me = await meRes.json().catch(() => ({}));
      projectId = me?.team?.id || me?.organization?.teams?.[0]?.id || '';
      if (!projectId) return json({ ok: false, configured: true, error: 'Could not resolve a PostHog project. Set POSTHOG_PROJECT_ID.' }, 502, headers);
    }

    const hog = async (q) => {
      const r = await fetch(`${PH_API}/api/projects/${projectId}/query/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { kind: 'HogQLQuery', query: q } }),
      });
      if (!r.ok) { const t = (await r.text().catch(() => '')).slice(0, 200); throw new Error(`PostHog query ${r.status}: ${t}`); }
      const d = await r.json();
      return d.results || [];
    };

    const since = `now() - INTERVAL ${days} DAY`;
    const [totals, funnel, pages, refs, devices] = await Promise.all([
      hog(`SELECT count() AS pv, count(DISTINCT person_id) AS visitors, count(DISTINCT properties.$session_id) AS sessions
           FROM events WHERE event = '$pageview' AND timestamp >= ${since}`),
      hog(`SELECT
             count(DISTINCT if(event = '$pageview', person_id, NULL))          AS visited,
             count(DISTINCT if(event = 'product_viewed', person_id, NULL))      AS viewed,
             count(DISTINCT if(event = 'add_to_cart', person_id, NULL))         AS added,
             count(DISTINCT if(event = 'checkout_started', person_id, NULL))    AS checkout,
             count(DISTINCT if(event = 'purchase_completed', person_id, NULL))  AS purchased
           FROM events
           WHERE timestamp >= ${since}
             AND event IN ('$pageview', 'product_viewed', 'add_to_cart', 'checkout_started', 'purchase_completed')`),
      hog(`SELECT properties.$pathname AS path, count() AS views
           FROM events WHERE event = '$pageview' AND timestamp >= ${since}
           GROUP BY path ORDER BY views DESC LIMIT 12`),
      hog(`SELECT coalesce(nullIf(properties.$referring_domain, ''), '(direct)') AS ref, count(DISTINCT person_id) AS visitors
           FROM events WHERE event = '$pageview' AND timestamp >= ${since}
           GROUP BY ref ORDER BY visitors DESC LIMIT 10`),
      hog(`SELECT coalesce(nullIf(properties.$device_type, ''), 'unknown') AS device, count(DISTINCT person_id) AS visitors
           FROM events WHERE event = '$pageview' AND timestamp >= ${since}
           GROUP BY device ORDER BY visitors DESC`),
    ]);

    const t = totals[0] || [0, 0, 0];
    const f = funnel[0] || [0, 0, 0, 0, 0];
    return json({
      ok: true, configured: true, range: days,
      totals: { pageviews: Number(t[0]) || 0, visitors: Number(t[1]) || 0, sessions: Number(t[2]) || 0 },
      funnel: { visited: Number(f[0]) || 0, viewed: Number(f[1]) || 0, added: Number(f[2]) || 0, checkout: Number(f[3]) || 0, purchased: Number(f[4]) || 0 },
      topPages: pages.map((r) => ({ path: r[0] || '(none)', views: Number(r[1]) || 0 })),
      referrers: refs.map((r) => ({ ref: r[0] || '(direct)', visitors: Number(r[1]) || 0 })),
      devices: devices.map((r) => ({ device: r[0] || 'unknown', visitors: Number(r[1]) || 0 })),
    }, 200, headers);
  } catch (e) {
    return json({ ok: false, configured: true, error: e?.message || 'PostHog request failed' }, 502, headers);
  }
}
