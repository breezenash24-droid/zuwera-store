/**
 * Temporary diagnostic: tests Resend directly by sending a real email.
 * POST /api/test-email sends a test order confirmation to the effective sender email.
 * DELETE this file once email is confirmed working.
 */

function resolveSenderEmail(env) {
  return (
    String(env.RESEND_FROM_EMAIL || '').trim()
    || String(env.SHIPPO_FROM_EMAIL || '').trim()
    || 'onboarding@resend.dev'
  );
}

export async function onRequestPost({ env }) {
  if (!env.RESEND_API_KEY) return json({ error: 'RESEND_API_KEY not set' }, 500);

  const fromEmail = resolveSenderEmail(env);
  const toEmail = fromEmail;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `Zuwera <${fromEmail}>`,
      to: [toEmail],
      subject: 'Zuwera Email Test - confirming Resend works',
      html: '<h2>Resend is working!</h2><p>This is a test from your webhook pipeline.</p>',
    }),
  });

  const body = await resp.json().catch(() => ({}));

  return json({
    resend_status: resp.status,
    resend_ok: resp.ok,
    resend_response: body,
    from_email: fromEmail,
    to_email: toEmail,
    sender_source: String(env.RESEND_FROM_EMAIL || '').trim()
      ? 'RESEND_FROM_EMAIL'
      : (String(env.SHIPPO_FROM_EMAIL || '').trim() ? 'SHIPPO_FROM_EMAIL' : 'onboarding@resend.dev fallback'),
    api_key_prefix: (env.RESEND_API_KEY || '').slice(0, 10) + '...',
  });
}

export async function onRequestGet({ env }) {
  return json({
    info: 'POST this URL to send a test email via Resend',
    resend_api_key_set: !!env.RESEND_API_KEY,
    resend_from_email: String(env.RESEND_FROM_EMAIL || '').trim() || 'not set',
    effective_sender_email: resolveSenderEmail(env),
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
