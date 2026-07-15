/**
 * Cloudflare Pages Function: POST /api/loyalty   (signed-in shopper)
 *
 * Points balance + redemption for the Rewards tab on /account.
 *
 * Redeeming does NOT touch pricing: it mints a single-use promo code into the
 * existing commerce_config.promotions list (maxUsage: 1), so the discount runs
 * through the same server-recomputed promo path as every other coupon. That
 * single-use cap is only meaningful because sanitizeCommerceConfig now preserves
 * maxUsage/usageCount (see PR #145) — without it a reward code was reusable.
 *
 * Body: { accessToken, action }
 *   action: 'balance' | 'redeem'
 */

import { cors, json } from './_commerce.js';

const SUPABASE_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

const DEFAULTS = { enabled: false, pointsPerDollar: 1, redeemPoints: 100, redeemValue: 5 };

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}

export async function loyaltySettings(env, H) {
  const rows = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings?select=value&key=eq.loyalty_settings&limit=1`, { headers: H, cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  let v = rows && rows[0] && rows[0].value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
  v = v || {};
  const num = (x, d) => (Number(x) > 0 ? Number(x) : d);
  return {
    enabled: v.enabled === true,
    pointsPerDollar: num(v.pointsPerDollar, DEFAULTS.pointsPerDollar),
    redeemPoints: Math.floor(num(v.redeemPoints, DEFAULTS.redeemPoints)),
    redeemValue: num(v.redeemValue, DEFAULTS.redeemValue),
  };
}

async function balanceOf(env, H, userId) {
  const rows = await fetch(`${env.SUPABASE_URL}/rest/v1/loyalty_ledger?select=points&user_id=eq.${encodeURIComponent(userId)}`, { headers: H, cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  return (rows || []).reduce((n, r) => n + (parseInt(r.points, 10) || 0), 0);
}

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes
  let s = '';
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 6; i++) s += alphabet[buf[i] % alphabet.length];
  return 'ZW' + s;
}

// Add a single-use fixed-amount promo to commerce_config.promotions.
async function mintRewardCode(env, H, valueDollars) {
  const rows = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings?select=value&key=eq.commerce_config&limit=1`, { headers: H, cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const cfg = (rows && rows[0] && rows[0].value) || {};
  const promos = Array.isArray(cfg.promotions) ? cfg.promotions : [];

  let code = randomCode();
  const taken = new Set(promos.map((p) => String((p && p.code) || '').toUpperCase()));
  let guard = 0;
  while (taken.has(code) && guard++ < 10) code = randomCode();

  promos.push({
    code,
    label: 'Loyalty reward',
    description: `Your reward — $${valueDollars} off`,
    type: 'fixed',
    value: valueDollars,
    minSubtotal: 0,
    active: true,
    expirationDate: '',
    maxUsage: 1,      // enforced now that sanitizeCommerceConfig keeps this field
    usageCount: 0,
    targetProductIds: [],
    targetCollectionIds: [],
  });
  cfg.promotions = promos;

  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings?key=eq.commerce_config`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ value: cfg }),
  });
  if (!r.ok) throw new Error('Could not create your reward code.');
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
    const userId = user && user.id;
    if (!userId) return json({ ok: false, error: 'Please sign in again.' }, 401, cors(env));

    const key = serviceKey(env);
    if (!env.SUPABASE_URL || !key) return json({ ok: false, error: 'not configured' }, 500, cors(env));
    const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };

    const settings = await loyaltySettings(env, H);
    const action = String(body.action || 'balance');

    if (action === 'balance') {
      if (!settings.enabled) return json({ ok: true, enabled: false }, 200, cors(env));
      const [balance, history] = await Promise.all([
        balanceOf(env, H, userId),
        fetch(`${env.SUPABASE_URL}/rest/v1/loyalty_ledger?select=points,reason,promo_code,created_at&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=20`, { headers: H, cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : [])).catch(() => []),
      ]);
      return json({
        ok: true, enabled: true, balance,
        pointsPerDollar: settings.pointsPerDollar,
        redeemPoints: settings.redeemPoints,
        redeemValue: settings.redeemValue,
        canRedeem: balance >= settings.redeemPoints,
        history: history || [],
      }, 200, cors(env));
    }

    if (action === 'redeem') {
      if (!settings.enabled) return json({ ok: false, error: 'Rewards are not available right now.' }, 400, cors(env));
      const balance = await balanceOf(env, H, userId);
      if (balance < settings.redeemPoints) {
        return json({ ok: false, error: `You need ${settings.redeemPoints} points to redeem — you have ${balance}.` }, 400, cors(env));
      }

      // Spend the points first, then mint. If minting fails, hand them back so a
      // failure can never silently eat someone's balance.
      const spendRes = await fetch(`${env.SUPABASE_URL}/rest/v1/loyalty_ledger`, {
        method: 'POST', headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({ user_id: userId, points: -settings.redeemPoints, reason: 'redeem' }),
      });
      if (!spendRes.ok) return json({ ok: false, error: 'Could not redeem right now.' }, 500, cors(env));
      const spendRow = (await spendRes.json().catch(() => []))[0];

      let code;
      try {
        code = await mintRewardCode(env, H, settings.redeemValue);
      } catch (e) {
        if (spendRow && spendRow.id) {
          await fetch(`${env.SUPABASE_URL}/rest/v1/loyalty_ledger?id=eq.${encodeURIComponent(spendRow.id)}`, {
            method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' },
          }).catch(() => {});
        }
        return json({ ok: false, error: (e && e.message) || 'Could not redeem right now.' }, 500, cors(env));
      }

      if (spendRow && spendRow.id) {
        await fetch(`${env.SUPABASE_URL}/rest/v1/loyalty_ledger?id=eq.${encodeURIComponent(spendRow.id)}`, {
          method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ promo_code: code }),
        }).catch(() => {});
      }

      return json({ ok: true, code, value: settings.redeemValue, balance: balance - settings.redeemPoints }, 200, cors(env));
    }

    return json({ ok: false, error: 'Unknown action' }, 400, cors(env));
  } catch (e) {
    console.error('[loyalty]', e && e.message);
    return json({ ok: false, error: (e && e.message) || 'failed' }, 500, cors(env));
  }
}
