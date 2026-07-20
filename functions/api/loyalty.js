/**
 * Cloudflare Pages Function: POST /api/loyalty   (signed-in shopper)
 *
 * Points balance + redemption for the Rewards tab on /account.
 *
 * Redeeming does NOT touch pricing: it mints a single-use coupon into the
 * existing commerce_config.promotions list, so the discount runs through the
 * same server-recomputed promo path as every other code. The single-use cap
 * (and any expiry the admin sets on reward codes) only actually holds because
 * sanitizeCommerceConfig preserves maxUsage/usageCount/expirationDate — see #145.
 *
 * Body: { accessToken, action, points? }
 *   action: 'balance' | 'redeem'   (redeem takes the chosen tier's `points`)
 */

import { cors, json, mutateSetting } from './_commerce.js';

const SUPABASE_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

const FALLBACK_TIER = { points: 100, value: 5 };

function serviceKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}

/**
 * Normalise site_settings.loyalty_settings into a full config. Kept lenient so a
 * half-filled or legacy (single redeemPoints/redeemValue) row still works.
 */
export function parseLoyaltySettings(v) {
  v = v || {};
  const pos = (x, d) => (Number(x) > 0 ? Number(x) : d);
  const nonNeg = (x, d) => (Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : d);

  let tiers = Array.isArray(v.tiers) && v.tiers.length ? v.tiers : null;
  if (!tiers) {
    // Legacy shape: a single redeemPoints → redeemValue pair.
    tiers = [{ points: pos(v.redeemPoints, FALLBACK_TIER.points), value: pos(v.redeemValue, FALLBACK_TIER.value) }];
  }
  tiers = tiers
    .map((t) => ({ points: Math.floor(pos(t && t.points, 0)), value: pos(t && t.value, 0) }))
    .filter((t) => t.points > 0 && t.value > 0)
    .sort((a, b) => a.points - b.points)
    .slice(0, 6);
  if (!tiers.length) tiers = [{ ...FALLBACK_TIER }];

  return {
    enabled: v.enabled === true,
    programName: String(v.programName || 'Rewards').slice(0, 40),
    pointsLabel: String(v.pointsLabel || 'points').slice(0, 20),
    pointsPerDollar: pos(v.pointsPerDollar, 1),
    minOrderToEarn: nonNeg(v.minOrderToEarn, 0),
    tiers,
    rewardExpiryDays: Math.floor(nonNeg(v.rewardExpiryDays, 0)),
    rewardMinSubtotal: nonNeg(v.rewardMinSubtotal, 0),
  };
}

async function readSettings(env, H) {
  const rows = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings?select=value&key=eq.loyalty_settings&limit=1`, { headers: H, cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  let v = rows && rows[0] && rows[0].value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
  return parseLoyaltySettings(v);
}

async function balanceOf(env, H, userId) {
  const rows = await fetch(`${env.SUPABASE_URL}/rest/v1/loyalty_ledger?select=points&user_id=eq.${encodeURIComponent(userId)}`, { headers: H, cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  return (rows || []).reduce((n, r) => n + (parseInt(r.points, 10) || 0), 0);
}

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[buf[i] % alphabet.length];
  return 'ZW' + s;
}

// Add a single-use fixed-amount promo to commerce_config.promotions. The code is
// chosen and appended INSIDE the atomic mutator so a concurrent mint (loyalty or
// referral) can't overwrite it — the commerce_config lost-update bug.
async function mintRewardCode(env, { value, expiryDays, minSubtotal }) {
  let expirationDate = '';
  if (expiryDays > 0) {
    const d = new Date(Date.now() + expiryDays * 86400000);
    expirationDate = d.toISOString().slice(0, 10); // YYYY-MM-DD, as the checks expect
  }

  let code = '';
  await mutateSetting(env, 'commerce_config', (cfg) => {
    cfg = cfg || {};
    const promos = Array.isArray(cfg.promotions) ? cfg.promotions.slice() : [];
    const taken = new Set(promos.map((p) => String((p && p.code) || '').toUpperCase()));
    code = randomCode();
    let guard = 0;
    while (taken.has(code) && guard++ < 10) code = randomCode();
    promos.push({
      code,
      label: 'Loyalty reward',
      description: `Your reward — $${value} off`,
      type: 'fixed',
      value,
      minSubtotal: minSubtotal || 0,
      active: true,
      expirationDate,
      maxUsage: 1,
      usageCount: 0,
      targetProductIds: [],
      targetCollectionIds: [],
    });
    return { ...cfg, promotions: promos };
  });
  if (!code) throw new Error('Could not create your reward code.');
  return { code, expirationDate };
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

    const s = await readSettings(env, H);
    const action = String(body.action || 'balance');

    if (action === 'balance') {
      if (!s.enabled) return json({ ok: true, enabled: false }, 200, cors(env));
      const [balance, history] = await Promise.all([
        balanceOf(env, H, userId),
        fetch(`${env.SUPABASE_URL}/rest/v1/loyalty_ledger?select=points,reason,promo_code,created_at&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=20`, { headers: H, cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : [])).catch(() => []),
      ]);
      return json({
        ok: true, enabled: true, balance,
        programName: s.programName,
        pointsLabel: s.pointsLabel,
        pointsPerDollar: s.pointsPerDollar,
        minOrderToEarn: s.minOrderToEarn,
        rewardExpiryDays: s.rewardExpiryDays,
        rewardMinSubtotal: s.rewardMinSubtotal,
        tiers: s.tiers.map((t) => ({ ...t, canRedeem: balance >= t.points })),
        history: history || [],
      }, 200, cors(env));
    }

    if (action === 'redeem') {
      if (!s.enabled) return json({ ok: false, error: 'Rewards are not available right now.' }, 400, cors(env));

      // Redeem the tier the shopper picked; default to the cheapest.
      const wanted = Math.floor(Number(body.points) || 0);
      const tier = wanted > 0 ? s.tiers.find((t) => t.points === wanted) : s.tiers[0];
      if (!tier) return json({ ok: false, error: 'That reward is no longer available.' }, 400, cors(env));

      // Spend atomically: redeem_loyalty() checks the balance and writes the spend
      // row in one advisory-locked step, so concurrent redeems can't double-spend.
      // Falls back to the legacy check-then-insert if the RPC isn't deployed yet —
      // run supabase-atomic-settings.sql to activate the atomic path.
      let spendId = null;
      let balanceAfter = null;
      const rpc = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/redeem_loyalty`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ p_user_id: userId, p_points: tier.points }),
      });

      if (rpc.ok) {
        const out = await rpc.json().catch(() => null);
        const row = Array.isArray(out) ? out[0] : out;
        spendId = row && (row.spend_id != null ? row.spend_id : row.spendId);
        balanceAfter = row && (row.new_balance != null ? row.new_balance : row.newBalance);
      } else if (rpc.status === 404) {
        // RPC not deployed — legacy path (NOT concurrency-safe; run the migration).
        const balance = await balanceOf(env, H, userId);
        if (balance < tier.points) {
          return json({ ok: false, error: `You need ${tier.points} ${s.pointsLabel} for that reward — you have ${balance}.` }, 400, cors(env));
        }
        const spendRes = await fetch(`${env.SUPABASE_URL}/rest/v1/loyalty_ledger`, {
          method: 'POST', headers: { ...H, Prefer: 'return=representation' },
          body: JSON.stringify({ user_id: userId, points: -tier.points, reason: 'redeem' }),
        });
        if (!spendRes.ok) return json({ ok: false, error: 'Could not redeem right now.' }, 500, cors(env));
        spendId = ((await spendRes.json().catch(() => []))[0] || {}).id || null;
        balanceAfter = balance - tier.points;
      } else {
        // RPC ran and rejected — most commonly an insufficient balance.
        const txt = await rpc.text().catch(() => '');
        if (/insufficient_balance/.test(txt)) {
          const balance = await balanceOf(env, H, userId).catch(() => 0);
          return json({ ok: false, error: `You need ${tier.points} ${s.pointsLabel} for that reward — you have ${balance}.` }, 400, cors(env));
        }
        return json({ ok: false, error: 'Could not redeem right now.' }, 500, cors(env));
      }

      // Points are spent. Mint the reward code; if minting fails, hand the points
      // back so a failure can never silently eat someone's balance.
      let minted;
      try {
        minted = await mintRewardCode(env, {
          value: tier.value, expiryDays: s.rewardExpiryDays, minSubtotal: s.rewardMinSubtotal,
        });
      } catch (e) {
        if (spendId) {
          await fetch(`${env.SUPABASE_URL}/rest/v1/loyalty_ledger?id=eq.${encodeURIComponent(spendId)}`, {
            method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' },
          }).catch(() => {});
        }
        return json({ ok: false, error: (e && e.message) || 'Could not redeem right now.' }, 500, cors(env));
      }

      if (spendId) {
        await fetch(`${env.SUPABASE_URL}/rest/v1/loyalty_ledger?id=eq.${encodeURIComponent(spendId)}`, {
          method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ promo_code: minted.code }),
        }).catch(() => {});
      }

      return json({
        ok: true, code: minted.code, value: tier.value,
        expiresOn: minted.expirationDate || '', minSubtotal: s.rewardMinSubtotal,
        balance: balanceAfter != null ? balanceAfter : await balanceOf(env, H, userId),
      }, 200, cors(env));
    }

    return json({ ok: false, error: 'Unknown action' }, 400, cors(env));
  } catch (e) {
    console.error('[loyalty]', e && e.message);
    return json({ ok: false, error: (e && e.message) || 'failed' }, 500, cors(env));
  }
}
