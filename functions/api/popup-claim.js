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
  };
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

/** Insert or re-subscribe. Same rules as /api/subscribe, which owns the table. */
async function subscribe(env, H, email, source) {
  const base = `${env.SUPABASE_URL}/rest/v1/newsletter_subscribers`;
  const existing = await fetch(`${base}?select=id,status&email=eq.${encodeURIComponent(email)}&limit=1`, { headers: H, cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  if (existing && existing[0]) {
    if (existing[0].status === 'unsubscribed') {
      await fetch(`${base}?id=eq.${existing[0].id}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'subscribed', unsubscribed_at: null }),
      });
    }
    return;
  }
  await fetch(base, {
    method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ email, source }),
  });
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
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
    await subscribe(env, H, email, source);

    if (!s.enabled || s.mode !== 'discount') return json({ ok: true }, 200, cors(env));

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
    return json(minted ? { ok: true, code } : { ok: true }, 200, cors(env));
  } catch (e) {
    return json({ ok: false, error: (e && e.message) || 'failed' }, 500, cors(env));
  }
}
