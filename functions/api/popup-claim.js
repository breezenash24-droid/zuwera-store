/**
 * Cloudflare Pages Function: POST /api/popup-claim   (public)
 *
 * The email popup's submit handler. Captures the address into
 * newsletter_subscribers and — when the popup is configured to offer one —
 * returns a discount code that actually works at checkout.
 *
 * Body: { email, source? }   →   { ok: true, code?: string }
 *
 * The browser sends an email address and nothing else. Every term of the offer
 * (whether there is one at all, percent vs fixed, the value, the minimum, the
 * expiry) is read HERE from site_settings.email_popup, so editing the request
 * can't inflate the discount, and a popup switched off in the admin can't be
 * used to mint codes by calling this endpoint directly.
 *
 * Two ways to run the offer, chosen in the admin:
 *
 *   shared — one code for everyone (WELCOME10). Nothing is minted per shopper;
 *            the promo is created once, on first claim, if it isn't in Coupons
 *            already. An existing code of the same name is left exactly as the
 *            admin set it — this never overwrites terms.
 *
 *   unique — one code per email address, capped at a single use. The code is
 *            DERIVED from the address (SHA-256 of email + prefix), not random,
 *            so a shopper who submits twice gets the same code back instead of
 *            minting a second one. That is what bounds the promotions list: it
 *            can grow by unique address, never by request count.
 *
 * Expired popup promos are dropped on each mint, so an old campaign's codes
 * don't accumulate in commerce_config forever.
 */

import { cors, json, mutateSetting } from './_commerce.js';
import { getEmailAppearance, getEmailContent, fillTemplate, renderEmailShell } from './_email-theme.js';
import { logEmail } from './_email-log.js';
import { fetchSiteSettings, resolveSetting } from './_settings.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1
const POPUP_LABEL = 'Popup';                                 // marks what we minted
const MAX_POPUP_PROMOS = 5000;

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}
function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
}

/**
 * Server-side mirror of the popup config. Deliberately only the fields that
 * decide an offer — the copy and the layout are the browser's business.
 */
export function parsePopupSettings(v) {
  v = v || {};
  const d = v.discount || {};
  // CLAMP, don't fall back. Treating an out-of-range number as "unset" made the
  // two halves disagree: the browser's normalize() clamps -99 to 0 and shows a
  // 0% offer, while falling back here would have issued a real 10% code. When
  // they differ, the popup is advertising something other than what it hands
  // out — so both sides clamp identically.
  const nonNeg = (x, f) => { const n = Number(x); return Number.isFinite(n) ? Math.max(0, n) : f; };
  return {
    enabled: v.enabled === true,
    mode: v.mode === 'signup' ? 'signup' : 'discount',
    source: d.source === 'unique' ? 'unique' : 'shared',
    code: String(d.code || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24),
    type: d.type === 'fixed' ? 'fixed' : 'percent',
    value: nonNeg(d.value, 10),
    minSubtotal: nonNeg(d.minSubtotal, 0),
    expiryDays: Math.floor(nonNeg(d.expiryDays, 30)),
    prefix: String(d.prefix || 'WELCOME').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'WELCOME',
    welcomeEmail: !!(v.welcomeEmail && v.welcomeEmail.on === true),
  };
}

/** "10% off" / "$15 off" — the phrase the email and the code description share. */
function discountLabel(s) {
  return s.type === 'fixed' ? `$${s.value} off` : `${s.value}% off`;
}

/**
 * The welcome email. Goes through the same theme, shell and log as every other
 * email the store sends, so it inherits the fonts, colours and logo set in
 * Appearance → Emails rather than being a one-off that drifts from them.
 *
 * Best-effort by design: the signup has already succeeded and the code is
 * already on screen by the time this runs. A mail provider being down must not
 * turn a successful capture into an error the shopper sees.
 */
async function sendWelcomeEmail(env, { to, code, label }) {
  // Same key set every other email function loads, so the theme, the logo and
  // the editable copy all resolve exactly as they do elsewhere.
  const cache = await fetchSiteSettings(
    ['RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_FROM', 'BRAND_LOGO_URL', 'fonts', 'brand', 'email_theme', 'email_settings'],
    env
  );
  const fromEmail = resolveSetting('EMAIL_FROM', env, cache) || 'orders@zuwera.store';
  const resendKey = resolveSetting('RESEND_API_KEY', env, cache);
  const brevoKey = resolveSetting('BREVO_API_KEY', env, cache);
  if (!resendKey && !brevoKey) return false;

  const a = getEmailAppearance(cache);
  const c = getEmailContent(cache, 'popup_welcome');
  const vars = { code: code || '', discount: label || '' };

  const codeBlock = code
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:4px 0 18px;">
         <div style="display:inline-block;padding:14px 26px;border:1px dashed ${a.border};border-radius:6px;font-family:${a.fontMono};font-size:20px;letter-spacing:.18em;color:${a.text};">${String(code).replace(/[<>&]/g, '')}</div>
       </td></tr></table>`
    : '';

  const html = renderEmailShell(a, {
    kicker: fillTemplate(c.kicker, vars),
    heading: fillTemplate(c.heading, vars),
    intro: fillTemplate(c.intro, vars),
    bodyHtml: codeBlock,
    footer: fillTemplate(c.footer, vars),
  });
  const subject = fillTemplate(c.subject, vars);

  let provider = '';
  if (resendKey) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Zuwera <${fromEmail}>`, to: [to], subject, html }),
    }).catch(() => null);
    if (r && r.ok) provider = 'resend';
  }
  if (!provider && brevoKey) {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: { name: 'Zuwera', email: fromEmail }, to: [{ email: to }], subject, htmlContent: html }),
    }).catch(() => null);
    if (r && r.ok) provider = 'brevo';
  }

  // Logged either way. A welcome email that silently never sends is the kind of
  // thing nobody notices for months; in Admin → Emails it shows as failed.
  await logEmail(env, {
    type: 'popup_welcome', recipient: to, subject,
    status: provider ? 'sent' : 'failed', provider: provider || '',
    meta: { code: code || '' },
  }).catch(() => {});
  return !!provider;
}

/** 'YYYY-MM-DD', or '' for never — the format validate-promo parses. */
function expiryDate(days) {
  const d = Math.floor(Number(days) || 0);
  if (d <= 0) return '';
  return new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
}

function isExpired(promo) {
  const exp = String((promo && promo.expirationDate) || '').trim();
  if (!exp) return false;
  const t = Date.parse(exp + 'T23:59:59Z');
  return Number.isFinite(t) && t < Date.now();
}

/** Same address always yields the same code, so re-submitting mints nothing. */
async function codeForEmail(email, prefix) {
  const bytes = new TextEncoder().encode(prefix + '|' + email);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let suffix = '';
  for (let i = 0; i < 5; i++) suffix += CODE_ALPHABET[hash[i] % CODE_ALPHABET.length];
  return (prefix + suffix).slice(0, 24);
}

function popupPromo(code, s, single) {
  return {
    code,
    label: POPUP_LABEL,
    description: s.type === 'fixed' ? `$${s.value} off your first order` : `${s.value}% off your first order`,
    type: s.type,
    value: s.value,
    minSubtotal: s.minSubtotal,
    active: true,
    expirationDate: expiryDate(s.expiryDays),
    maxUsage: single ? 1 : null,
    usageCount: 0,
    targetProductIds: [],
    targetCollectionIds: [],
  };
}

async function readPopupSettings(env, H) {
  const rows = await fetch(
    `${env.SUPABASE_URL}/rest/v1/site_settings?select=value&key=eq.email_popup&limit=1`,
    { headers: H, cache: 'no-store' }
  ).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  let v = rows && rows[0] && rows[0].value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
  return parsePopupSettings(v);
}

/**
 * Insert or re-subscribe. Same rules as /api/subscribe, which owns the table.
 *
 * Returns true only if the address is now definitely on the list. The first
 * version ignored the write result entirely, which is the worst possible
 * failure for this endpoint: newsletter_subscribers is admin-only under RLS, so
 * a deployment without a real service-role key would have the insert rejected,
 * the shopper would still be thanked and handed a discount code, and the
 * address — the entire point of the exercise — would be gone. Silence is not an
 * option on the capture path.
 */
async function subscribe(env, H, email, source) {
  const base = `${env.SUPABASE_URL}/rest/v1/newsletter_subscribers`;
  const lookup = await fetch(`${base}?select=id,status&email=eq.${encodeURIComponent(email)}&limit=1`, { headers: H, cache: 'no-store' });
  if (!lookup.ok) return false;
  const existing = await lookup.json().catch(() => []);

  if (existing && existing[0]) {
    if (existing[0].status === 'unsubscribed') {
      const res = await fetch(`${base}?id=eq.${existing[0].id}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'subscribed', unsubscribed_at: null }),
      });
      return res.ok;
    }
    return true;   // already subscribed — nothing to do, and that is a success
  }

  const res = await fetch(base, {
    method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ email, source }),
  });
  if (res.ok) return true;
  // A duplicate means someone else inserted it between the lookup and here.
  // They are on the list, which is all this promised.
  const txt = await res.text().catch(() => '');
  return /duplicate|unique/i.test(txt);
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env, waitUntil }) {
  try {
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const source = String(body.source || 'popup').slice(0, 60);
    if (!validEmail(email)) return json({ ok: false, error: 'Please enter a valid email address.' }, 400, cors(env));

    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return json({ ok: false, error: 'not configured' }, 500, cors(env));
    const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };

    const s = await readPopupSettings(env, H);

    // The signup always lands, even with the popup switched off — an address in
    // hand is worth keeping, and a shopper who just typed it should not get an
    // error because someone toggled a setting mid-session.
    const captured = await subscribe(env, H, email, source);
    if (!captured) {
      // Do not hand out a code for an address that was not saved. The shopper
      // sees a real error and can retry; the admin sees nothing appear in
      // Subscribers, which is the truth rather than a silent hole.
      return json({ ok: false, error: 'We could not save your email just now. Please try again.' }, 502, cors(env));
    }

    if (!s.enabled || s.mode !== 'discount') {
      if (s.welcomeEmail) {
        const p = sendWelcomeEmail(env, { to: email, code: '', label: '' }).catch(() => {});
        if (typeof waitUntil === 'function') waitUntil(p);
      }
      return json({ ok: true }, 200, cors(env));
    }

    // Fire the welcome email in the background. The shopper already has their
    // code on screen; making them wait on a mail provider would be the tail
    // wagging the dog, and a provider outage must not fail a good signup.
    const mail = (code) => {
      if (!s.welcomeEmail) return;
      const p = sendWelcomeEmail(env, { to: email, code, label: discountLabel(s) }).catch(() => {});
      if (typeof waitUntil === 'function') waitUntil(p);
    };

    if (s.source === 'shared') {
      if (!s.code) return json({ ok: true }, 200, cors(env));   // no code set yet
      await mutateSetting(env, 'commerce_config', (cfg) => {
        cfg = cfg || {};
        const promos = Array.isArray(cfg.promotions) ? cfg.promotions.slice() : [];
        // Only create it if it doesn't exist. A code the admin already set up in
        // Coupons keeps ITS terms — this must never quietly rewrite a live promo.
        if (!promos.some((p) => String((p && p.code) || '').toUpperCase() === s.code)) {
          promos.push(popupPromo(s.code, s, false));
        }
        return { ...cfg, promotions: promos };
      });
      mail(s.code);
      return json({ ok: true, code: s.code }, 200, cors(env));
    }

    const code = await codeForEmail(email, s.prefix);
    let minted = true;
    await mutateSetting(env, 'commerce_config', (cfg) => {
      cfg = cfg || {};
      // Reset per attempt: mutateSetting re-runs this on a CAS retry, and a cap
      // hit on the first pass must not stick if the second pass has room.
      minted = true;
      let promos = Array.isArray(cfg.promotions) ? cfg.promotions.slice() : [];
      if (promos.some((p) => String((p && p.code) || '').toUpperCase() === code)) return cfg;  // already theirs

      // Housekeeping: expired popup codes are dead weight in a blob every
      // checkout reads. Only ones WE minted and only once past their date —
      // anything an admin created by hand is left alone.
      promos = promos.filter((p) => !(p && p.label === POPUP_LABEL && isExpired(p)));

      if (promos.filter((p) => p && p.label === POPUP_LABEL).length >= MAX_POPUP_PROMOS) {
        minted = false;
        return { ...cfg, promotions: promos };
      }
      promos.push(popupPromo(code, s, true));
      return { ...cfg, promotions: promos };
    });

    // At the cap the signup still counts; there just isn't a code to hand out.
    // Better than handing over one that checkout would reject.
    mail(minted ? code : '');
    return json(minted ? { ok: true, code } : { ok: true }, 200, cors(env));
  } catch (e) {
    return json({ ok: false, error: (e && e.message) || 'failed' }, 500, cors(env));
  }
}
