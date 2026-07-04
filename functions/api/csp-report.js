/**
 * /api/csp-report — receives Content-Security-Policy violation reports (the CSP
 * header's `report-uri` target) and stores them in Supabase `error_log` with
 * source='csp'. Lets you see, in the DB, exactly what the report-only CSP would
 * block — so you can tighten to an enforced script-src from real data. Defensive,
 * size-capped, always 204. Review with:
 *   select message, count(*) from error_log where source='csp' group by 1 order by 2 desc;
 * and clear noise with:  delete from error_log where source='csp';
 */
const DEFAULT_SUPABASE_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

export async function onRequestPost({ request, env }) {
  try {
    const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
    const url = env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
    if (!key) return new Response(null, { status: 204 });

    const body = await request.json().catch(() => ({}));
    const r = body['csp-report'] || body || {};
    const directive = clip(r['violated-directive'] || r['effective-directive'], 120);
    if (!directive) return new Response(null, { status: 204 });

    const blocked = clip(r['blocked-uri'], 300);
    const src = clip(r['source-file'], 300);
    const line = r['line-number'];
    const row = {
      source: 'csp',
      message: (directive + (blocked ? ' → ' + blocked : '')).slice(0, 500),
      url: clip(r['document-uri'], 500),
      stack: clip(src ? src + (line != null ? ':' + line : '') : null, 500),
      release: 'csp-report',
    };

    await fetch(`${url}/rest/v1/error_log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    }).catch(() => {});
  } catch (_) {}
  return new Response(null, { status: 204 });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}
