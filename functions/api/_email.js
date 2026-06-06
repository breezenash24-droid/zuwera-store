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
