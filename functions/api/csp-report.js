/**
 * /api/csp-report — receives Content-Security-Policy violation reports (the CSP
 * header's `report-uri` target) and stores them in Supabase `error_log` with
 * source='csp'. Lets you see, in the DB, exactly what the report-only CSP would
 * block — so you can tighten to an enforced script-src from real data. Defensive,
 * size-capped, always 204. Review with:
 *   select message, count(*) from error_log where source='csp' group by 1 order by 2 desc;
 * and clear noise with:  delete from error_log where source='csp';
 */

import { supabaseUrl } from './_config.js';
import { limit } from './_ratelimit.js';

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

export async function onRequestPost({ request, env }) {
  /* The report-only policy now points at every inline block on every page, so
     this endpoint is about to receive far more than it ever has. The row dedupe
     below keeps the LOG small; this keeps the REQUESTS bounded — an unmetered
     public write is still an unmetered public write, however small each row. */
  const limited = await limit(env, request, 'csp-report');
  if (limited) return limited;

  try {
    const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
    const url = supabaseUrl(env);
    if (!key) return new Response(null, { status: 204 });

    const body = await request.json().catch(() => ({}));
    const r = body['csp-report'] || body || {};
    const directive = clip(r['violated-directive'] || r['effective-directive'], 120);
    if (!directive) return new Response(null, { status: 204 });

    const blockedRaw = clip(r['blocked-uri'], 300);
    const src = clip(r['source-file'], 300);
    const line = r['line-number'];

    /* ── One row per VIOLATION, not per pageview ───────────────────────────
       27,993 of this table's 28,038 rows were CSP reports, at 700 a day, and
       they were a handful of distinct problems repeated thousands of times.
       The 79 real JavaScript errors were buried underneath them, which is the
       actual cost: a log nobody can read is a log nobody reads.

       Most of the duplication is cache-busting junk in the URL. Google
       Analytics posts to /g/collect?v=2&tid=…&gtm=45je6852v9245643753za200…
       and that gtm token changes on every pageview, so one misconfigured
       hostname produced thousands of "distinct" messages. Stripping the query
       collapses them to one line that says the thing worth knowing: this
       directive is blocking this host. */
    const blocked = blockedRaw ? blockedRaw.split('?')[0] : blockedRaw;
    const row = {
      source: 'csp',
      message: (directive + (blocked ? ' → ' + blocked : '')).slice(0, 500),
      /* The page is dropped for the same reason — every product page produced
         its own copy of the same violation. The directive and the host are what
         identify the problem; which page happened to trigger it is not. */
      url: null,
      stack: clip(src ? src.split('?')[0] + (line != null ? ':' + line : '') : null, 500),
      release: 'csp-report',
    };

    /* Already recorded in the last 24 hours? Then this is the same problem
       still happening, and a second row says nothing the first did not.
       Best-effort: a failed lookup writes the row, because losing a report is
       worse than storing a duplicate. */
    try {
      const since = new Date(Date.now() - 86400000).toISOString();
      const dupe = await fetch(
        `${url}/rest/v1/error_log?select=id&source=eq.csp`
        + `&message=eq.${encodeURIComponent(row.message)}`
        + `&created_at=gte.${encodeURIComponent(since)}&limit=1`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } },
      );
      if (dupe.ok) {
        const rows = await dupe.json().catch(() => []);
        if (Array.isArray(rows) && rows.length) return new Response(null, { status: 204 });
      }
    } catch (_) { /* fall through and record it */ }

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
