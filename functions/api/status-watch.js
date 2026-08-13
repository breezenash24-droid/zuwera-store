/**
 * POST /api/status-watch — check every service on a schedule, and say something
 * when the answer CHANGES.
 *
 * WHY. Nothing called /api/status except the admin page, so a key that died at
 * 4am stayed dead and silent until somebody happened to open the tab. The panel
 * could tell you what was true while you were looking at it and nothing else.
 * That is the gap between a status page and being told.
 *
 * ONLY TRANSITIONS. A cron that reports "Resend is still failing" every fifteen
 * minutes is a cron whose alerts get muted inside a day, and a muted alert is
 * worse than none — it is the same silence, plus the belief that you are
 * covered. So this fires when a service crosses from working to failing, and
 * again when it comes back. Steady state, good or bad, says nothing.
 *
 * The previous state comes from api_status_log, which is why this needed
 * migration 0014 first: with no history there is no "previous", and every run
 * would look like a transition. Where history is missing this records the run
 * and alerts on nothing, which is the correct behaviour for a first run rather
 * than a special case.
 *
 * IT RUNS THE PANEL'S OWN CHECKS. runChecks() is imported, not reimplemented —
 * a watcher with its own copy of "is Resend healthy" eventually disagrees with
 * the page, and that disagreement surfaces as an alert nobody can reproduce by
 * opening the dashboard. The obvious next step would actively mislead.
 *
 * SETUP: any external cron (cron-job.org, GitHub Actions) →
 *   POST https://<site>/api/status-watch
 *   header  x-cron-token: <STATUS_WATCH_TOKEN>
 * Every 15–30 minutes is plenty; these are vendor health checks, not a heartbeat.
 */

import { fetchSiteSettings, ALLOWED_KEYS } from './_settings.js';
import { runChecks, recordRun, svcKey, checkReturnSigning } from './api-status.js';
import { notifyOps } from './_notify-ops.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

/* Constant-time-ish compare on the shared token. Not a password — a shared
   secret in a cron config — but a length-leaking early return is free to avoid. */
function tokenOk(given, expected) {
  const a = String(given || ''), b = String(expected || '');
  if (!b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* The last result recorded for each service, before this run.
   One query, newest-first, grouped here — the first row seen per service is its
   most recent, because the query is ordered. */
async function previousStates(env) {
  const url = (env.SUPABASE_URL || '').trim();
  const key = svcKey(env);
  if (!url || !key) return null;
  try {
    const r = await fetch(
      url + '/rest/v1/api_status_log?select=service,ok,checked_at&order=checked_at.desc&limit=400',
      { headers: { apikey: key, Authorization: 'Bearer ' + key } },
    );
    if (!r.ok) return null;              // table absent → no previous state, not an error
    const rows = await r.json().catch(() => []);
    const prev = {};
    for (const row of (Array.isArray(rows) ? rows : [])) {
      if (!(row.service in prev)) prev[row.service] = { ok: !!row.ok, at: row.checked_at };
    }
    return prev;
  } catch (_) { return null; }
}

/* Human names, so an alert reads like a sentence rather than a key. */
const LABELS = {
  cloudinary: 'Cloudinary', resend: 'Resend', brevo: 'Brevo', supabase: 'Supabase',
  stripe: 'Stripe', shippo: 'Shippo', veeqo: 'Veeqo', cloudflare: 'Cloudflare',
  deepl: 'DeepL', loops: 'Loops', twilio: 'Twilio', posthog: 'PostHog',
  returnSigning: 'Guest returns (signing)',
};

/* What actually breaks for a customer when this service is down. An alert that
   says "Shippo is failing" makes someone go and look; one that says checkout
   cannot quote shipping tells them whether to get out of bed. */
const IMPACT = {
  resend:     'Order confirmations and return links stop reaching customers (Brevo should take over — check that it is configured).',
  brevo:      'Email failover is gone. Resend is now the only path, with nothing behind it.',
  supabase:   'Orders, products and sessions all run through this. Expect the storefront to be broken.',
  stripe:     'Payments. Checkout cannot take money while this is failing.',
  shippo:     'Checkout cannot quote shipping rates or buy labels (Veeqo may cover it).',
  cloudinary: 'Product image transforms fail — there is no fallback for these.',
  returnSigning: 'Every guest return is failing silently, and the page still tells customers a link was sent.',
};

export async function onRequestPost({ request, env }) {
  const expected = String(env.STATUS_WATCH_TOKEN || '').trim();
  if (!expected) {
    return json({ ok: false, error: 'STATUS_WATCH_TOKEN is not set, so this endpoint is disabled.' }, 503);
  }
  if (!tokenOk(request.headers.get('x-cron-token'), expected)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const cache = await fetchSiteSettings([...ALLOWED_KEYS], env);
  const [services, prev] = await Promise.all([
    runChecks(env, cache, checkReturnSigning),
    previousStates(env),
  ]);

  /* No history at all means this is the first run (or 0014 has not been
     applied). Record it and say nothing — treating an unknown previous state as
     a transition would alert on every service at once, which is exactly the
     noise that gets a cron muted. */
  const firstRun = !prev || Object.keys(prev).length === 0;

  const broke = [], fixed = [];
  for (const [name, s] of Object.entries(services)) {
    const now = !!(s && s.ok);
    const before = prev && prev[name];
    if (firstRun || !before) continue;
    if (before.ok && !now) broke.push({ name, s });
    else if (!before.ok && now) fixed.push({ name, s });
  }

  /* Recorded BEFORE alerting, so a failure to send an alert cannot also lose
     the observation — the next run would then see the same "transition" again
     and alert twice for one event. */
  await recordRun(env, services).catch(() => {});

  for (const { name, s } of broke) {
    const label = LABELS[name] || name;
    try {
      await notifyOps(env, {
        settings: cache,
        key: 'service-down',
        severity: 'critical',
        event: label + ' stopped responding',
        detail: (s && s.error ? String(s.error) : 'The health check failed.')
          + (IMPACT[name] ? '\n\nWhat this affects: ' + IMPACT[name] : ''),
        /* Never announce an email outage through the provider that is down. */
        avoid: name === 'resend' ? ['resend'] : (name === 'brevo' ? ['brevo'] : []),
      });
    } catch (_) { /* an alert that cannot send must not fail the run */ }
  }

  for (const { name } of fixed) {
    try {
      await notifyOps(env, {
        settings: cache,
        key: 'service-recovered',
        severity: 'info',
        event: (LABELS[name] || name) + ' is working again',
        detail: 'It started answering normally. Nothing to do — this is the all-clear for the earlier alert.',
      });
    } catch (_) {}
  }

  return json({
    ok: true,
    checked: Object.keys(services).length,
    firstRun,
    broke: broke.map((b) => b.name),
    fixed: fixed.map((f) => f.name),
  });
}

/* GET is deliberately not implemented. A health watcher reachable by anything
   that follows links — a preview crawler, a browser prefetch — is a watcher
   that fires alerts nobody triggered. */
export async function onRequestGet() {
  return json({ ok: false, error: 'POST with the x-cron-token header.' }, 405);
}
