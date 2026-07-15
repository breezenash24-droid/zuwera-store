/**
 * Cloudflare Pages Function: POST /api/referral   (signed-in shopper)
 *
 * "Refer a friend": each shopper gets one code. The friend types it in the normal
 * promo box for a discount; when their order lands, stripe-webhook credits the
 * referrer with loyalty points.
 *
 * Nothing here touches pricing. The friend's discount is a normal promo in
 * commerce_config.promotions, so it runs through the same server-recomputed path
 * as every other code. Each referral promo carries a maxUsage cap so a code can't
 * be farmed indefinitely — that cap is only real because #145 fixed
 * sanitizeCommerceConfig dropping maxUsage.
 *
 * Codes are minted lazily (first time a shopper opens Refer a Friend) so we don't
 * stuff commerce_config with a promo for every account that never refers anyone.
 *
 * Body: { accessToken, action }
 *   action: 'get'
 */

import { cors, json } from './_commerce.js';

const SUPABASE_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
const SITE = 'https://zuwera.store';

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}

export function parseReferralSettings(v) {
  v = v || {};
  const pos = (x, d) => (Number(x) > 0 ? Number(x) : d);
  const nonNeg = (x, d) => (Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : d);
  return {
    enabled: v.enabled === true,
    friendType: v.friendType === 'fixed' ? 'fixed' : 'percent',
    friendValue: pos(v.friendValue, 10),
    friendMinSubtotal: nonNeg(v.friendMinSubtotal, 0),
    maxUsesPerCode: Math.floor(nonNeg(v.maxUsesPerCode, 25)), // 0 = unlimited
    referrerPoints: Math.floor(nonNeg(v.referrerPoints, 100)),
  };
}

async function readSetting(env, H, key, parser) {
  const rows = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings?select=value&key=eq.${key}&limit=1`, { headers: H, cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  let v = rows && rows[0] && rows[0].value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
  return parser(v);
}

function makeCode(seed) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < 4; i++) s += alphabet[buf[i] % alphabet.length];
  const base = String(seed || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'FRIEND';
  return (base + s).slice(0, 12);
}

// Create the shopper's code + its promo entry. Lazy: only on first open.
async function mintReferral(env, H, user, s) {
  const seed = (user.user_metadata && user.user_metadata.full_name) || (user.email || '').split('@')[0];

  // Reserve the code row first (unique on user_id, so a double-click can't make two).
  let code = makeCode(seed);
  let row = null;
  for (let attempt = 0; attempt < 6 && !row; attempt++) {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/referral_codes`, {
      method: 'POST', headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({ user_id: user.id, code }),
    });
    if (r.ok) { row = (await r.json().catch(() => []))[0]; break; }
    const txt = await r.text().catch(() => '');
    if (/referral_codes_user_id_key|user_id/i.test(txt)) {
      // Raced with another request — reuse the existing row.
      const ex = await fetch(`${env.SUPABASE_URL}/rest/v1/referral_codes?select=code&user_id=eq.${encodeURIComponent(user.id)}&limit=1`, { headers: H, cache: 'no-store' })
        .then((x) => (x.ok ? x.json() : [])).catch(() => []);
      if (ex && ex[0]) return ex[0].code;
    }
    if (!/duplicate|unique/i.test(txt)) throw new Error('Could not create your referral code.');
    code = makeCode(seed); // code collision — try another
  }
  if (!row) throw new Error('Could not create your referral code.');

  // Matching promo so the friend's code actually discounts at checkout.
  const cRows = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings?select=value&key=eq.commerce_config&limit=1`, { headers: H, cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const cfg = (cRows && cRows[0] && cRows[0].value) || {};
  const promos = Array.isArray(cfg.promotions) ? cfg.promotions : [];
  if (!promos.some((p) => String((p && p.code) || '').toUpperCase() === code.toUpperCase())) {
    promos.push({
      code,
      label: 'Referral',
      description: `A friend sent you $${s.friendType === 'fixed' ? s.friendValue + ' off' : s.friendValue + '% off'}`,
      type: s.friendType,
      value: s.friendValue,
      minSubtotal: s.friendMinSubtotal || 0,
      active: true,
      expirationDate: '',
      maxUsage: s.maxUsesPerCode > 0 ? s.maxUsesPerCode : null,
      usageCount: 0,
      targetProductIds: [],
      targetCollectionIds: [],
    });
    cfg.promotions = promos;
    await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings?key=eq.commerce_config`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ value: cfg }),
    });
  }
  return code;
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const accessToken = String(body.accessToken || '').trim();
    if (!accessToken) return json({ ok: false, error: 'Please sign in.' }, 401, cors(env));

    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + accessToken },
    });
    if (!userRes.ok) return json({ ok: false, error: 'Please sign in again.' }, 401, cors(env));
    const user = await userRes.json();
    if (!user || !user.id) return json({ ok: false, error: 'Please sign in again.' }, 401, cors(env));

    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return json({ ok: false, error: 'not configured' }, 500, cors(env));
    const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };

    const s = await readSetting(env, H, 'referral_settings', parseReferralSettings);
    if (!s.enabled) return json({ ok: true, enabled: false }, 200, cors(env));

    // Existing code, or mint one now.
    const existing = await fetch(`${env.SUPABASE_URL}/rest/v1/referral_codes?select=code&user_id=eq.${encodeURIComponent(user.id)}&limit=1`, { headers: H, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const code = (existing && existing[0] && existing[0].code) || await mintReferral(env, H, user, s);

    // How many referrals have paid out (ledger rows we wrote on referred orders).
    const credits = await fetch(`${env.SUPABASE_URL}/rest/v1/loyalty_ledger?select=points&user_id=eq.${encodeURIComponent(user.id)}&reason=eq.referral`, { headers: H, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : [])).catch(() => []);

    return json({
      ok: true, enabled: true, code,
      link: `${SITE}/?ref=${encodeURIComponent(code)}`,
      friendType: s.friendType,
      friendValue: s.friendValue,
      friendMinSubtotal: s.friendMinSubtotal,
      referrerPoints: s.referrerPoints,
      referrals: credits.length,
      pointsEarned: credits.reduce((n, r) => n + (parseInt(r.points, 10) || 0), 0),
    }, 200, cors(env));
  } catch (e) {
    console.error('[referral]', e && e.message);
    return json({ ok: false, error: (e && e.message) || 'failed' }, 500, cors(env));
  }
}
