/* ────────────────────────────────────────────────────────────────────────────
   _notify-ops.js — tell a human when a failover fires.

   The failovers worked and nobody found out. Resend→Brevo logged one line to
   the Workers console, which is not retained and which nobody tails, so uptime
   was protected and awareness was not. That is the gap this closes: it is the
   difference between "we stayed up" and "we knew".

   THREE CHANNELS, chosen by severity rather than configured per event, so
   adding a new alert cannot accidentally start paging someone at 3am:

     warn      Slack        a fallback fired, or a quota is getting close.
                            The system is fine. Somebody should know by morning.
     critical  Slack + SMS  every provider in a chain failed, or a quota is
                            spent. Something is not being delivered right now.

   Email sits alongside Slack at both levels when configured, because not every
   store has Slack — but with one rule that matters more than it looks:

   AN EMAIL ALERT MUST NOT ROUTE THROUGH THE PROVIDER THAT JUST FAILED. Sending
   "Resend is down" via Resend is an alert that arrives exactly when it is not
   needed and vanishes exactly when it is. Callers pass `avoid`, and the email
   channel skips those providers.

   DEDUPE. A provider having a bad afternoon can fire the same edge hundreds of
   times. Four hundred Slack messages is the same as no alerting, because you
   start ignoring the channel — so the same event key is sent at most once an
   hour. The store is a module-scope Map, which is per-isolate: Cloudflare may
   run several, so this is a large reduction rather than a guarantee. Stated
   plainly because the upgrade (a shared key with a timestamp) is a schema
   change, and a comment that oversells this would let someone skip it.

   Everything here is best-effort and never throws. An alert that breaks the
   request it was reporting on would be worse than the silence it replaces.
   ──────────────────────────────────────────────────────────────────────────── */

const DEDUPE_WINDOW_MS = 60 * 60 * 1000;
const seen = new Map();

/* Cheap bound on the Map. An isolate that lives for days would otherwise hold
   every event key it has ever seen. */
function prune(now) {
  if (seen.size < 200) return;
  for (const [k, at] of seen) if (now - at > DEDUPE_WINDOW_MS) seen.delete(k);
}

function firstSend(key, now) {
  const at = seen.get(key);
  if (at && now - at < DEDUPE_WINDOW_MS) return false;
  seen.set(key, now);
  prune(now);
  return true;
}

async function toSlack(env, { severity, event, detail, store }) {
  const url = (env.OPS_SLACK_WEBHOOK || '').trim();
  if (!url) return { skipped: 'no webhook' };
  const icon = severity === 'critical' ? ':rotating_light:' : ':warning:';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `${icon} *${severity.toUpperCase()}* — ${event}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `${icon} *${severity.toUpperCase()}* — ${event}` } },
        { type: 'section', text: { type: 'mrkdwn', text: '```' + String(detail || '').slice(0, 2500) + '```' } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `${store || 'store'} · ${new Date().toISOString()}` }] },
      ],
    }),
  });
  return res.ok ? { ok: true } : { error: res.status + '' };
}

/* Deliberately its own minimal sender rather than the storefront's themed one.
   An ops alert wants to leave through the shortest path that still works — the
   themed shell reads settings, which is another thing that can be the reason
   you are being alerted in the first place. */
async function toEmail(env, { severity, event, detail, avoid }) {
  const to = (env.OPS_ALERT_EMAIL || env.ALERT_EMAIL || '').trim();
  if (!to) return { skipped: 'no address' };
  const from = (env.OPS_ALERT_FROM || 'alerts@zuwera.store').trim();
  const skip = new Set((avoid || []).map((s) => String(s).toLowerCase()));
  const subject = `[${severity}] ${event}`;
  const text = `${event}\n\n${detail || ''}\n\n${new Date().toISOString()}`;

  const resendKey = (env.OPS_ALERT_RESEND_KEY || env.RESEND_API_KEY || '').trim();
  if (resendKey && !skip.has('resend')) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (r.ok) return { ok: true, via: 'resend' };
  }
  const brevoKey = (env.OPS_ALERT_BREVO_KEY || env.BREVO_API_KEY || '').trim();
  if (brevoKey && !skip.has('brevo')) {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': brevoKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Zuwera Alerts', email: from },
        to: [{ email: to }], subject, textContent: text,
      }),
    });
    if (r.ok) return { ok: true, via: 'brevo' };
  }
  return { error: 'no usable provider' };
}

/* SMS is critical-only, and that restraint is the feature. A channel that
   fires for warnings gets muted, and a muted channel is not a channel. */
async function toSms(env, { event }) {
  const sid = (env.TWILIO_ACCOUNT_SID || '').trim();
  const token = (env.TWILIO_AUTH_TOKEN || '').trim();
  const from = (env.TWILIO_FROM || '').trim();
  const to = (env.OPS_ALERT_SMS || '').trim();
  if (!sid || !token || !from || !to) return { skipped: 'not configured' };
  const body = new URLSearchParams({ To: to, From: from, Body: `[CRITICAL] ${event}`.slice(0, 300) });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(sid + ':' + token),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  return r.ok ? { ok: true } : { error: r.status + '' };
}

/**
 * Fire an ops alert. Never throws, never rejects.
 *
 * @param env    Worker env (holds the channel credentials)
 * @param opts   {severity:'warn'|'critical', event, detail, key?, avoid?, store?}
 *               key   — dedupe identity; defaults to the event text
 *               avoid — providers that must NOT carry the alert (they failed)
 */
export async function notifyOps(env, opts = {}) {
  try {
    const severity = opts.severity === 'critical' ? 'critical' : 'warn';
    const event = String(opts.event || 'unspecified').slice(0, 200);
    const payload = {
      severity, event,
      detail: opts.detail == null ? '' : String(opts.detail),
      avoid: opts.avoid || [],
      store: opts.store || 'zuwera.store',
    };
    if (!firstSend(String(opts.key || event), Date.now())) return { deduped: true };

    /* allSettled, not all: one dead channel must not stop the others. The
       whole point is that something reaches a person. */
    const jobs = [toSlack(env, payload), toEmail(env, payload)];
    if (severity === 'critical') jobs.push(toSms(env, payload));
    const out = await Promise.allSettled(jobs);
    const sent = out.some((r) => r.status === 'fulfilled' && r.value && r.value.ok);
    /* Logged either way — this line is the last resort when every channel is
       unconfigured, which is exactly the state a new deployment starts in. */
    console.log('[ops-alert]', severity, event, sent ? 'delivered' : 'NOT DELIVERED', payload.detail.slice(0, 400));
    return { sent };
  } catch (e) {
    console.log('[ops-alert] notifier failed', e && e.message);
    return { error: 'notifier failed' };
  }
}

export const __test = { firstSend, seen, DEDUPE_WINDOW_MS };
