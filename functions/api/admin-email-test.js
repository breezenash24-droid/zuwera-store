/**
 * POST /api/admin-email-test — send one real email, and say exactly what happened.
 *
 * WHY THIS EXISTS. There was no way to find out whether email worked without
 * placing an order and waiting. When nothing arrived, every layer was a
 * suspect — the key, the sending domain, the From address, the recipient, the
 * provider's suppression list — and the only evidence was a console.warn in a
 * Worker log nobody reads.
 *
 * So this reports the whole chain rather than a boolean. Which providers are
 * configured, which one answered, what address it sent as, and — the part that
 * actually matters — the provider's own response when it refuses. A 422 saying
 * "Invalid `from` field" is a fix; "could not send" is a morning gone.
 *
 * Accepted is not delivered, and this endpoint is careful to say so. Every
 * provider here returns success when it has QUEUED a message. A message can be
 * queued and then bounce, or be dropped for an address on a suppression list,
 * and neither shows up here — only in the provider's own dashboard.
 */

import { cors, json, verifyAdmin } from './_commerce.js';
import { fetchSiteSettings, resolveSetting } from './_settings.js';

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  const h = cors(env);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, 400, h); }

  /* verifyAdmin returns the user, or null. It does NOT return { ok } — checking
     for that rejected every admin, which is a fine way to make a diagnostic
     tool need diagnosing. */
  const admin = await verifyAdmin(env, body.accessToken || '');
  if (!admin) return json({ error: 'Admin access required.' }, 403, h);

  /* Defaults to the admin's own address: the common case is "does email work
     at all", and making someone type their own address to find out is friction
     for no benefit. */
  const to = String(body.to || admin.profile?.email || admin.email || '').trim();
  if (!to) return json({ error: 'Who should it go to?' }, 400, h);

  const cache = await fetchSiteSettings(
    ['RESEND_API_KEY', 'BREVO_API_KEY', 'SENDGRID_API_KEY', 'LOOPS_API_KEY',
     'LOOPS_TRANSACTIONAL_ID', 'EMAIL_FROM'], env,
  );

  /* Resolved the same way every real email resolves it, so this tests what the
     store actually does rather than a simplified version of it. */
  const from = String(
    resolveSetting('EMAIL_FROM', env, cache) || env.RESEND_FROM_EMAIL || 'orders@zuwera.store',
  ).trim();

  const configured = {
    resend: Boolean(resolveSetting('RESEND_API_KEY', env, cache)),
    sendgrid: Boolean(resolveSetting('SENDGRID_API_KEY', env, cache)),
    brevo: Boolean(resolveSetting('BREVO_API_KEY', env, cache)),
    loops: Boolean(resolveSetting('LOOPS_API_KEY', env, cache) && resolveSetting('LOOPS_TRANSACTIONAL_ID', env, cache)),
  };

  if (!Object.values(configured).some(Boolean)) {
    return json({
      ok: false, configured, from,
      error: 'No email provider is configured. Set RESEND_API_KEY in Cloudflare.',
    }, 200, h);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    return json({
      ok: false, configured, from,
      error: 'The From address is not a valid email: "' + from + '". Set EMAIL_FROM.',
    }, 200, h);
  }

  const stamp = new Date().toISOString();
  const subject = 'Zuwera email test — ' + stamp.slice(0, 19).replace('T', ' ');
  const html = '<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6">'
    + '<p>This is a test from your Zuwera admin panel.</p>'
    + '<p>If you are reading it, sending works: the key is valid, the domain is '
    + 'verified for <strong>' + from + '</strong>, and this address is not being '
    + 'suppressed.</p>'
    + '<p style="color:#666;font-size:13px">Sent ' + stamp + '</p></div>';

  /* Tried in the same order as the real chain, and NOT stopped at the first
     success — knowing that Resend works while Brevo is misconfigured is worth
     more than knowing that something worked. The attempts are cheap and this
     is a button an admin presses deliberately. */
  const attempts = [];

  if (configured.resend) {
    attempts.push(await attempt('resend', () => fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + resolveSetting('RESEND_API_KEY', env, cache),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: 'Zuwera <' + from + '>', to: [to], subject, html }),
    })));
  }

  if (configured.brevo) {
    attempts.push(await attempt('brevo', () => fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': resolveSetting('BREVO_API_KEY', env, cache), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Zuwera', email: from },
        to: [{ email: to }], subject, htmlContent: html,
      }),
    })));
  }

  const worked = attempts.filter((a) => a.ok).map((a) => a.provider);

  return json({
    ok: worked.length > 0,
    to, from, configured, attempts,
    /* Said in as many words, because "sent" is the single most misleading word
       in email. Every provider above answers 200 when it has accepted the
       message for delivery, which is not the same as it arriving. */
    note: worked.length
      ? 'Accepted by ' + worked.join(', ') + '. That means queued, not delivered — '
        + 'check the provider dashboard for bounces or a suppressed address if it does not arrive.'
      : 'Every configured provider refused. The response text above is theirs, not ours.',
  }, 200, h);
}

/* Never throws. A provider being unreachable is a result to report, not an
   exception that hides the other providers' results. */
async function attempt(provider, run) {
  try {
    const resp = await run();
    const text = await resp.text().catch(() => '');
    return {
      provider, ok: resp.ok, status: resp.status,
      /* The provider's own words. This is the whole point: "Invalid `from`
         field" is actionable and "failed" is not. */
      response: text.slice(0, 400),
    };
  } catch (e) {
    return { provider, ok: false, status: 0, response: String((e && e.message) || e).slice(0, 400) };
  }
}
