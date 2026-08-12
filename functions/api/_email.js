/**
 * _email.js — shared transactional email fallback helper.
 *
 * Loops is the THIRD failover tier behind Resend → Brevo. Unlike those two,
 * Loops' transactional API is template-based: it does not accept raw HTML.
 * You create one template in the Loops dashboard (Transactional → create),
 * give it two merge fields {{subject}} and {{body}}, and paste its
 * transactionalId into Cloudflare as LOOPS_TRANSACTIONAL_ID (or save it in
 * site_settings via Admin → APIs).
 *
 * This tier only fires when BOTH Resend and Brevo are unavailable — a true
 * belt-and-suspenders last resort so a drop-day order confirmation still
 * goes out during a double outage. If LOOPS_API_KEY or LOOPS_TRANSACTIONAL_ID
 * is not configured, the helper no-ops gracefully (returns {skipped:true}).
 */

import { resolveSetting } from './_settings.js';

/**
 * Where to send a customer who wants to look at their order.
 *
 * Every email that offered this linked to /account, hardcoded. Most of this
 * store's buyers check out as guests and have no account, so the link asked
 * them to log in — and on a shared computer where somebody else was still
 * signed in, it showed THAT person's orders. A customer clicking a link in
 * their own receipt landed in a stranger's account.
 *
 * An order with a user_id belongs to an account holder and /account is right
 * for them. Everyone else goes to the guest lookup carrying their order
 * number, so the only thing left to type is the email the message was sent to
 * — the one thing we can be certain they have.
 *
 * Shared rather than repeated, because it was repeated: the same wrong link
 * appeared in the order confirmation and again in the delivered notice, and
 * fixing one would have left the other.
 */
export function orderStatusUrl({ userId, orderNumber, siteUrl, token } = {}) {
  const base = String(siteUrl || 'https://zuwera.store').replace(/\/$/, '');
  if (userId) return base + '/account';

  /* A signed link straight to the order, when we have one.
   *
   * Without it the guest link carried only ?order=, which pre-filled the order
   * number and then asked for the email — and then emailed them a link. From
   * inside the receipt that is absurd: the message is ALREADY in the mailbox
   * being verified, so the verification proves something the click just proved.
   * It reads as being asked to prove you are yourself, twice.
   *
   * The email-me-a-link step is right for someone arriving at /returns on their
   * own, where nothing has been proven yet. It is wrong for someone who got
   * here by opening their own receipt, and the token is what tells the two
   * apart. */
  const t = String(token == null ? '' : token).trim();
  if (t) return base + '/returns?t=' + encodeURIComponent(t);

  const n = String(orderNumber == null ? '' : orderNumber).trim();
  return n ? base + '/returns?order=' + encodeURIComponent(n) : base + '/returns';
}

// Strip HTML to a readable plain-text body for the Loops template.
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

/**
 * Send a transactional email through Loops as a last-resort fallback.
 *
 * @param {object}  opts
 * @param {object}  opts.env    Cloudflare env
 * @param {object} [opts.cache] Pre-fetched site_settings cache (optional)
 * @param {string}  opts.to     Recipient email
 * @param {string}  opts.subject
 * @param {string} [opts.html]  HTML body (converted to plain text for the template)
 * @param {string} [opts.text]  Plain-text body (overrides html if provided)
 * @param {object} [opts.dataVariables] Extra merge fields for the Loops template
 * @returns {Promise<{ok:boolean, provider?:string, skipped?:boolean, error?:string}>}
 */
export async function loopsFallback({ env, cache = {}, to, subject, html, text, dataVariables = {} }) {
  const apiKey = resolveSetting('LOOPS_API_KEY', env, cache);
  const txId   = resolveSetting('LOOPS_TRANSACTIONAL_ID', env, cache);
  if (!apiKey || !txId) return { skipped: true };
  if (!to) return { skipped: true, error: 'no recipient' };

  const body = (text || htmlToText(html) || subject || '').slice(0, 4000);

  try {
    const resp = await fetch('https://app.loops.so/api/v1/transactional', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transactionalId: txId,
        email: to,
        dataVariables: { subject: subject || 'Zuwera', body, ...dataVariables },
      }),
    });
    if (resp.ok) {
      console.log('Email sent via Loops fallback to', to, '(Resend + Brevo were unavailable)');
      return { ok: true, provider: 'loops' };
    }
    const err = resp.status + ': ' + await resp.text().catch(() => '');
    return { ok: false, error: 'Loops send failed: ' + err };
  } catch (e) {
    return { ok: false, error: 'Loops send error: ' + (e && e.message || e) };
  }
}

/**
 * Send one transactional email, trying each configured provider in order.
 *
 *   Resend → SendGrid → Brevo → Loops
 *
 * WHY THIS EXISTS. Eleven files had their own copy of this chain, each with
 * small differences in from-name and reply-to. Adding a provider meant editing
 * all eleven and getting all eleven right — which is precisely the duplication
 * that has produced silent divergence elsewhere in this codebase. SendGrid was
 * the moment to stop: one chain, one place, and a test that asserts nothing
 * calls a provider directly any more.
 *
 * Callers keep their own from-name and reply-to, because an order confirmation
 * and a journal newsletter should not look like they came from the same
 * mailbox — those stay parameters rather than being flattened into one style.
 *
 * @param {object}  o
 * @param {object}  o.env
 * @param {object} [o.cache]     pre-fetched site_settings (avoids a re-query)
 * @param {string}  o.to
 * @param {string} [o.toName]
 * @param {string}  o.subject
 * @param {string}  o.html
 * @param {string}  o.fromEmail
 * @param {string} [o.fromName]  defaults to 'Zuwera'
 * @param {string} [o.replyTo]
 * @returns {Promise<{provider:string}>}  throws if every provider is unavailable
 */
export async function sendTransactional({ env, cache = {}, to, toName, subject, html, fromEmail, fromName = 'Zuwera', replyTo }) {
  const resendKey  = resolveSetting('RESEND_API_KEY', env, cache);
  const sendgridKey = resolveSetting('SENDGRID_API_KEY', env, cache);
  const brevoKey   = resolveSetting('BREVO_API_KEY', env, cache);

  /* Resolve the sender HERE rather than trusting every caller to pass one.
     One of the nine did not, and the template composed the literal string
     "Zuwera <undefined>" — which Resend rejected with a 422 the caller never
     saw, so an approval email simply never arrived and nothing said why.

     A caller that omits it is not doing anything unreasonable; the sender is a
     property of the store, not of the message. So the default lives with the
     function that needs it. */
  const sender = String(
    fromEmail
    || resolveSetting('EMAIL_FROM', env, cache)
    || (env && env.RESEND_FROM_EMAIL)
    || 'orders@zuwera.store',
  ).trim();

  /* And refuse outright rather than send something malformed. Every provider
     below rejects an invalid From, each in its own way and each silently as far
     as the caller is concerned, so failing here — loudly, once — beats three
     different provider errors nobody reads. */
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
    console.error('[email] refusing to send: invalid from address', JSON.stringify(sender));
    return { ok: false, error: 'invalid from address' };
  }

  // Deduplicates retries at the provider if the same message is sent twice.
  const refId = (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : `zw-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  if (resendKey) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${fromName} <${sender}>`, to: [to], subject, html,
        ...(replyTo ? { reply_to: replyTo } : {}),
        headers: { 'X-Entity-Ref-ID': refId },
      }),
    }).catch(() => null);
    if (r && r.ok) return { provider: 'resend' };
  }

  if (sendgridKey) {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sendgridKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to, ...(toName ? { name: toName } : {}) }] }],
        from: { email: sender, name: fromName },
        ...(replyTo ? { reply_to: { email: replyTo } } : {}),
        subject,
        content: [{ type: 'text/html', value: html }],
      }),
    }).catch(() => null);
    // SendGrid answers 202 Accepted, not 200 — r.ok covers both, but it is
    // worth knowing that a success here means queued, not delivered.
    if (r && r.ok) return { provider: 'sendgrid' };
  }

  if (brevoKey) {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { name: fromName, email: sender },
        to: [{ email: to, ...(toName ? { name: toName } : {}) }],
        ...(replyTo ? { replyTo: { email: replyTo } } : {}),
        subject, htmlContent: html,
      }),
    }).catch(() => null);
    if (r && r.ok) return { provider: 'brevo' };
  }

  const loops = await loopsFallback({ env, cache, to, subject, html });
  if (loops.ok) return { provider: 'loops' };

  throw new Error('No email provider configured.');
}
