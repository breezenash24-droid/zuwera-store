/**
 * POST /api/admin-export — bulk people export, through a place that can say no.
 *
 * WHY THIS EXISTS AS AN ENDPOINT. The "Export customers" limit sat in the
 * panel marked not-working, and could not be made to work, because the export
 * never left the browser: exportUsersCSV() read the profiles already on the
 * page and built a file. Nothing was asked, so nothing could refuse.
 *
 * WHAT IT DOES AND DOES NOT BUY YOU, plainly, because a control believed to be
 * stronger than it is is worse than none. An admin who can read profiles can
 * always read profiles — through this, through the panel, or through the
 * client in a console. This limit is not a wall around the data. It bounds the
 * ONE-CLICK path that turns "can read the customer list" into "has the customer
 * list, as a file, in a download folder", which is the form most of it takes.
 * Making that path refuse, log, and be worth explaining is the whole benefit.
 *
 * Closing the rest means RLS narrow enough that an admin cannot select the
 * table wholesale — a different change, on a different schedule, and it should
 * not be smuggled in under a CSV button.
 */

import { cors, json, decide } from './_commerce.js';

const KINDS = {
  customers: { role: 'customer', label: 'customers' },
  admins:    { role: 'admin',    label: 'admins' },
};

/* The export is a read of everything; a page size is the only thing standing
   between a slow query and a timeout. */
const HARD_CAP = 5000;

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  const h = cors(env);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, 400, h); }

  const { accessToken, kind } = body || {};
  const spec = KINDS[String(kind || 'customers')];
  if (!spec) return json({ error: 'Unknown export.' }, 400, h);

  const sbKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
  const sbH = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
  const base = `${env.SUPABASE_URL}/rest/v1/profiles?role=eq.${encodeURIComponent(spec.role)}`;

  /* COUNTED FIRST, then decided. A limit written as "no more than 500 rows"
     cannot be applied to a number nobody has yet, and counting after the fact
     would mean the rows were already read — at which point refusing is a
     gesture. PostgREST returns the count in a header for a zero-row read, so
     this costs one cheap request. */
  let total = null;
  try {
    const countRes = await fetch(`${base}&select=id&limit=1`, {
      headers: { ...sbH, Prefer: 'count=exact', Range: '0-0' },
    });
    const cr = countRes.headers.get('content-range') || '';
    const parsed = Number(String(cr).split('/')[1]);
    if (Number.isFinite(parsed)) total = parsed;
  } catch (e) {
    console.warn('export: could not count rows —', e && e.message);
  }

  /* An uncountable export is refused rather than run. The limit is written
     about a number, and "we could not work out how many" is not a smaller
     number — it is no answer, and running anyway would make the limit
     skippable by whatever made the count fail. */
  if (total === null) {
    return json({ error: 'Could not work out how many rows this would export, so it was not run.' }, 503, h);
  }

  const verdict = await decide(env, accessToken, 'customer_export', {
    action: 'customer_export',
    resource: { count: total, kind: String(kind || 'customers') },
  });
  if (!verdict.allow) {
    return json({
      error: verdict.reason || 'A limit on your account stopped this export.',
      limited: !!verdict.limited,
      ownerMayOverride: !!verdict.ownerMayOverride,
      count: total,
    }, 403, h);
  }

  const res = await fetch(
    `${base}&select=id,email,full_name,role,admin_role,created_at&order=created_at.desc&limit=${HARD_CAP}`,
    { headers: sbH }
  );
  if (!res.ok) return json({ error: 'Could not read the list.' }, 502, h);
  const rows = await res.json().catch(() => []);

  return json({ success: true, kind, count: Array.isArray(rows) ? rows.length : 0, total, rows }, 200, h);
}
