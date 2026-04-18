/**
 * Temporary diagnostic: tests Resend directly by sending a real email.
 * POST /api/test-email  → sends a test order confirmation to RESEND_FROM_EMAIL
 * DELETE this file once email is confirmed working.
 */
export async function onRequestPost({ env }) {
  if (!env.RESEND_API_KEY) return json({ error: 'RESEND_API_KEY not set' }, 500);
  if (!env.RESEND_FROM_EMAIL) return json({ error: 'RESEND_FROM_EMAIL not set' }, 500);

  const toEmail   = env.RESEND_FROM_EMAIL; // send to yourself as a test
  const fromEmail = env.RESEND_FROM_EMAIL;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization:  'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    `Zuwera <${fromEmail}>`,
      to:      [toEmail],
      subject: 'Zuwera Email Test — confirming Resend works',
      html:    '<h2>✅ Resend is working!</h2><p>This is a test from your webhook pipeline.</p>',
    }),
  });

  const body = await resp.json();

  return json({
    resend_status: resp.status,
    resend_ok:     resp.ok,
    resend_response: body,
    from_email:    fromEmail,
    to_email:      toEmail,
    api_key_prefix: (env.RESEND_API_KEY || '').slice(0, 10) + '...',
  });
}

export async function onRequestGet({ env }) {
  return json({
    info: 'POST this URL to send a test email via Resend',
    resend_api_key_set: !!env.RESEND_API_KEY,
    resend_from_email:  env.RESEND_FROM_EMAIL || 'not set',
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
