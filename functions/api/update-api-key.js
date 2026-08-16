/**
 * Cloudflare Pages Function: POST /api/update-api-key
 *
 * Admin-protected endpoint to upsert an API key/setting into Supabase
 * `site_settings`.  Values saved here override the corresponding Cloudflare
 * env vars on every subsequent request — no redeploy required.
 *
 * Body: { accessToken: string, keyName: string, keyValue: string }
 */

import { ALLOWED_KEYS, maskKey } from './_settings.js';
/* brandName(env), not getEmailAppearance(cache, env). This alert fires when an
   API key changed — possibly because somebody got into the panel — and it must
   not need the database to say who it is from. env-only is the point. */
import { brandName } from './_config.js';

const ADMIN_EMAILS = ['breezenash24@gmail.com', 'nasirubreeze@zuwera.store'];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Tamper-proof security alert: emailed on ANY key change (or a rejected attempt to
 * change a locked key). DELIBERATELY reads its email credentials from ENV ONLY — never
 * via resolveSetting/site_settings — so an attacker who deletes the admin-editable
 * RESEND/BREVO override can NOT silence this alert. For the strongest guarantee set a
 * dedicated SECURITY_ALERT_RESEND_KEY (or _BREVO_KEY) + SECURITY_ALERT_EMAIL in
 * Cloudflare; otherwise it falls back to the env RESEND_API_KEY / BREVO_API_KEY.
 * Best-effort + never throws — it must never block or fail the key operation itself.
 */
/**
 * Record a key change in admin_audit_log.
 *
 * NEVER the value, and not even a reversible hint of it. The masked preview is
 * first-four-last-four, which is already on screen for anyone who can see this
 * page — safe to store, and it is what makes an entry identifiable ("that is
 * the key I pasted") without being usable.
 *
 * REJECTED ATTEMPTS ARE RECORDED TOO. An admin trying to overwrite a key that
 * is locked to Cloudflare is the more interesting row of the two: it is either
 * somebody confused about where a secret lives, or somebody probing what this
 * endpoint will accept. Only logging successes would keep the second one out of
 * the record entirely.
 *
 * Best-effort. A key that saved and an audit row that did not is worse than
 * either, but failing the save because the log is unavailable is worse still —
 * the alert email has already gone out and carries the same facts.
 */
async function auditKeyChange(env, { keyName, masked, by, userId, ua, rejected }) {
  const url = (env.SUPABASE_URL || env.SUPABASE_PROJECT_URL || '').trim();
  const sk  = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !sk) return;
  try {
    await fetch(`${url}/rest/v1/admin_audit_log`, {
      method: 'POST',
      headers: {
        apikey: sk, Authorization: `Bearer ${sk}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        action: rejected ? 'api_key.rejected' : 'api_key.update',
        resource_type: 'api_key',
        resource_id: keyName,
        admin_user_id: userId || null,
        admin_email: by || null,
        user_agent: String(ua || '').slice(0, 300),
        metadata: { masked: masked || null },
      }),
    });
  } catch (_) { /* the alert email carries the same facts */ }
}

async function sendKeyChangeAlert(env, info) {
  try {
    const resendKey = (env.SECURITY_ALERT_RESEND_KEY || env.RESEND_API_KEY || '').trim();
    const brevoKey  = (env.SECURITY_ALERT_BREVO_KEY  || env.BREVO_API_KEY  || '').trim();
    const brand     = brandName(env);
    const from      = (env.SECURITY_ALERT_FROM || env.EMAIL_FROM || (brand + ' Security <security@zuwera.store>')).trim();
    const to        = (env.SECURITY_ALERT_EMAIL || '').trim() ? [env.SECURITY_ALERT_EMAIL.trim()] : ADMIN_EMAILS;
    const verb      = info.attempted ? 'change was ATTEMPTED on a locked key' : 'was changed';
    const subject   = `${info.attempted ? '🚨' : '⚠️'} ${brand} API key ${info.attempted ? 'change attempt' : 'changed'}: ${info.keyName}`;
    const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">
      <h2 style="margin:0 0 12px">API key ${verb}</h2>
      <p style="margin:0 0 16px;color:#444">A key was ${info.attempted ? 'attempted to be changed' : 'updated'} in your ${brand} admin. If this was not you, your admin session may be compromised — rotate the affected key in <strong>Cloudflare</strong> and change your password immediately.</p>
      <table style="border-collapse:collapse;font-size:14px">
        <tr><td style="padding:4px 14px 4px 0;color:#888">Key</td><td style="padding:4px 0"><strong>${info.keyName}</strong></td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#888">New value</td><td style="padding:4px 0"><code>${info.masked || '—'}</code></td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#888">By</td><td style="padding:4px 0">${info.by || 'unknown'}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#888">IP</td><td style="padding:4px 0">${info.ip || 'unknown'}</td></tr>
        <tr><td style="padding:4px 14px 4px 0;color:#888">When</td><td style="padding:4px 0">${info.when}</td></tr>
      </table>
      <p style="font-size:12px;color:#bbb;margin-top:24px;border-top:1px solid #eee;padding-top:12px">${brand} Admin Security · automated alert · cannot be disabled from the admin panel</p>
    </div>`;
    if (resendKey) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, subject, html }),
      });
    } else if (brevoKey) {
      const senderEmail = (from.match(/<([^>]+)>/) || [null, from])[1];
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: { email: senderEmail, name: brand + ' Security' }, to: to.map(e => ({ email: e })), subject, htmlContent: html }),
      });
    } else {
      console.error('[update-api-key] SECURITY ALERT could not send — no env RESEND_API_KEY / BREVO_API_KEY set. Add SECURITY_ALERT_RESEND_KEY in Cloudflare.');
    }
  } catch (e) {
    console.error('[update-api-key] security alert send failed:', e && e.message);
  }
}

async function validateAdmin(accessToken, env) {
  const url     = (env.SUPABASE_URL || env.SUPABASE_PROJECT_URL || '').trim();
  const anonKey = (env.SUPABASE_ANON_KEY || '').trim();
  const svcKey  = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  const apiKey  = anonKey || svcKey;

  const resp = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: apiKey, Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error('Session invalid or expired');

  const user   = await resp.json();
  const emails = [
    user?.email,
    ...(Array.isArray(user?.identities)
      ? user.identities.map(i => i?.identity_data?.email || i?.email)
      : []),
  ]
    .filter(Boolean)
    .map(e => String(e).toLowerCase().trim());

  if (!emails.some(e => ADMIN_EMAILS.includes(e))) {
    throw new Error('Account does not have admin privileges');
  }
  return user;
}

export async function onRequestPost({ request, env }) {
  try {
    const body      = await request.json().catch(() => ({}));
    const { accessToken, keyName, keyValue } = body;

    if (!accessToken) return json({ ok: false, error: 'Missing access token' }, 401);

    const adminUser = await validateAdmin(accessToken, env);
    const _by   = (adminUser && adminUser.email) || 'admin';
    const _byId = (adminUser && adminUser.id) || null;
    const _ip   = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
    const _ua   = request.headers.get('user-agent') || '';
    const _when = new Date().toISOString();

    if (!keyName || !ALLOWED_KEYS.has(keyName)) {
      // A validated admin tried to write a key that isn't editable here (e.g. a locked
      // crown-jewel like STRIPE_SECRET_KEY) — alert, then reject.
      if (keyName) await sendKeyChangeAlert(env, { keyName, masked: '(rejected — key is locked to Cloudflare)', by: _by, ip: _ip, when: _when, attempted: true });
      /* The more interesting of the two rows: either somebody confused about
         where a secret lives, or somebody probing what this endpoint accepts. */
      if (keyName) await auditKeyChange(env, { keyName, masked: null, by: _by, userId: _byId, ua: _ua, rejected: true });
      return json({ ok: false, error: `"${keyName}" is not editable here — it's locked to Cloudflare env vars` }, 400);
    }
    if (!keyValue || String(keyValue).includes('•')) {
      return json({ ok: false, error: 'Invalid value — do not paste the masked preview' }, 400);
    }

    const url = (env.SUPABASE_URL || env.SUPABASE_PROJECT_URL || '').trim();
    const sk  = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
    if (!url || !sk) return json({ ok: false, error: 'Supabase not configured' }, 500);

    // Upsert into `site_settings` (same table used by all commerce functions).
    // Array body + Prefer merge-duplicates handles INSERT-or-UPDATE on the
    // unique `key` column without needing an explicit ?on_conflict query param.
    const resp = await fetch(`${url}/rest/v1/site_settings`, {
      method:  'POST',
      headers: {
        apikey:          sk,
        Authorization:   `Bearer ${sk}`,
        'Content-Type':  'application/json',
        Prefer:          'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([{ key: keyName, value: keyValue.trim() }]),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.status);
      return json({ ok: false, error: `Supabase error: ${errText}` }, 500);
    }

    console.log(`[update-api-key] Admin updated ${keyName}`);
    await sendKeyChangeAlert(env, { keyName, masked: maskKey(keyValue.trim()), by: _by, ip: _ip, when: _when });
    /* And WRITE IT DOWN, not only email it.
       Until now a key change produced an alert and nothing else — so the record
       of who rotated what, and when, existed solely in whoever's inbox received
       that mail, for as long as they kept it. Every other consequential admin
       action goes into admin_audit_log; API keys, which are the most
       consequential thing on the page, were the one exception.
       It also makes the answer available where the question gets asked: "this
       stopped working on Tuesday — did somebody change the key?" is a query
       against a table, not a search of an inbox. */
    await auditKeyChange(env, {
      keyName, masked: maskKey(keyValue.trim()), by: _by, userId: _byId, ua: _ua, rejected: false,
    });
    return json({ ok: true, keyName, message: `${keyName} saved successfully` });
  } catch (e) {
    return json({ ok: false, error: e.message || 'Unknown error' }, 500);
  }
}
