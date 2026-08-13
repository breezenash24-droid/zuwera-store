/**
 * Cloudflare Pages Function: /api/api-status
 * Returns live usage stats for all integrated third-party services,
 * plus masked previews of each API key (reads from Supabase site_settings first,
 * falls back to Cloudflare env vars).
 *
 * Required env vars (set in CF Pages > Settings > Variables & Secrets):
 *   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
 *   RESEND_API_KEY
 *   BREVO_API_KEY            (optional — email fallback)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)
 *   STRIPE_SECRET_KEY
 *   SHIPPO_API_KEY
 *   CLOUDFLARE_ZONE_ID, CLOUDFLARE_GRAPHQL_TOKEN
 *   DEEPL_API_KEY            (optional)
 */

import { fetchSiteSettings, resolveSetting, maskKey, ALLOWED_KEYS } from './_settings.js';
import { getShippoMonthlyCount, shippoFreeLimit, shippoMonthKey } from './_shipping-usage.js';
import { veeqoKey, veeqoDiagnose } from './_veeqo.js';
import { verifyAdmin } from './_commerce.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function withTimeout(promise, ms = 6000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Request timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

// ─── Individual service checks ────────────────────────────────────────────────
// Each check function receives the env + a pre-fetched Supabase settings cache.

async function checkDeepL(env, cache) {
  // translate.js accepts DEEPL_API_KEY, DEEPL_AUTH_KEY, or DEEPL_KEY — match that fallback chain
  const key = resolveSetting('DEEPL_API_KEY', env, cache)
    || (env.DEEPL_API_KEY_ || '').trim().replace(/,$/, '')
    || resolveSetting('DEEPL_AUTH_KEY', env, cache)
    || resolveSetting('DEEPL_KEY', env, cache);
  if (!key) return { ok: false, configured: false, optional: true, error: 'DEEPL_API_KEY not set' };
  try {
    const resp = await withTimeout(fetch('https://api-free.deepl.com/v2/usage', {
      headers: { Authorization: `DeepL-Auth-Key ${key}` }
    }));
    const resp2 = resp.ok ? resp : await withTimeout(fetch('https://api.deepl.com/v2/usage', {
      headers: { Authorization: `DeepL-Auth-Key ${key}` }
    }));
    if (!resp2.ok) return { ok: false, keyActive: false, error: `HTTP ${resp2.status} — key may be invalid` };
    const d = await resp2.json();
    const pct = d.character_limit > 0 ? ((d.character_count / d.character_limit) * 100) : 0;
    return {
      ok: true,
      keyActive: true,
      characterCount: d.character_count || 0,
      characterLimit: d.character_limit || 500000,
      usedPercent: parseFloat(pct.toFixed(1)),
      remaining: (d.character_limit || 500000) - (d.character_count || 0),
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkCloudinary(env, cache) {
  const cloudName = resolveSetting('CLOUDINARY_CLOUD_NAME', env, cache);
  const apiKey    = resolveSetting('CLOUDINARY_API_KEY',    env, cache);
  const apiSecret = resolveSetting('CLOUDINARY_API_SECRET', env, cache);
  const missing = [];
  if (!cloudName) missing.push('CLOUDINARY_CLOUD_NAME');
  if (!apiKey)    missing.push('CLOUDINARY_API_KEY');
  if (!apiSecret) missing.push('CLOUDINARY_API_SECRET');
  if (missing.length) {
    return { ok: false, configured: false, missing, error: `Missing key${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}` };
  }
  try {
    const creds = btoa(`${apiKey}:${apiSecret}`);
    const resp  = await withTimeout(fetch(`https://api.cloudinary.com/v1_1/${cloudName}/usage`, {
      headers: { Authorization: `Basic ${creds}` }
    }));
    if (!resp.ok) {
      const is401 = resp.status === 401;
      return {
        ok: false,
        is401,
        error: is401
          ? 'HTTP 401 — CLOUDINARY_CLOUD_NAME does not match the account these credentials belong to'
          : `HTTP ${resp.status}`,
      };
    }
    const d = await resp.json();
    return {
      ok: true,
      plan: d.plan || 'Free',
      credits:         d.credits         || null,
      storage:         d.storage         || null,
      bandwidth:       d.bandwidth       || null,
      objects:         d.objects         || null,
      transformations: d.transformations || null,
      lastUpdated:     d.last_updated    || null,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkResend(env, cache) {
  const key = resolveSetting('RESEND_API_KEY', env, cache);
  if (!key) return { ok: false, configured: false, error: 'RESEND_API_KEY not set' };
  try {
    const resp = await withTimeout(fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${key}` }
    }));
    if (!resp.ok) return { ok: false, keyActive: false, error: `HTTP ${resp.status} — key may be invalid` };
    const d = await resp.json();
    return {
      ok: true,
      keyActive: true,
      freePlan: { dailyLimit: 100, monthlyLimit: 3000 },
      domains: (d.data || []).map(dom => ({ name: dom.name, status: dom.status })),
      note: 'Resend does not expose remaining quota via API. Limits shown are Free plan defaults.',
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkBrevo(env, cache) {
  const key = resolveSetting('BREVO_API_KEY', env, cache);
  if (!key) return { ok: false, configured: false, optional: true, error: 'BREVO_API_KEY not set — email failover not active' };
  try {
    const resp = await withTimeout(fetch('https://api.brevo.com/v3/account', {
      headers: { 'api-key': key, Accept: 'application/json' }
    }));
    if (!resp.ok) return { ok: false, keyActive: false, error: `HTTP ${resp.status}` };
    const d    = await resp.json();
    const plan = Array.isArray(d.plan) ? (d.plan[0] || {}) : (d.plan || {});
    return {
      ok: true,
      configured: true,
      keyActive: true,
      accountEmail: d.email       || '',
      companyName:  d.companyName || '',
      plan:         plan.type     || 'free',
      credits:      plan.credits !== undefined ? plan.credits : null,
      creditsType:  plan.creditsType || 'daily',
      freePlan: { dailyLimit: 300 },
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

/* ── Whether the backup could actually carry the load ────────────────────────
   Every other quota on this page answers "am I going to run out". Brevo cannot
   be asked that, because Brevo sends nothing while Resend is healthy — its
   usage is zero on almost every day, and a straight-line forecast from zero is
   noise dressed up as information.

   The question a failover provider has to answer is different, and nobody was
   asking it: if Resend goes down on a bad day, is 300 emails a day enough?
   A backup that cannot carry the traffic is not a backup, and the way you find
   that out should not be during the outage.

   So: the busiest day of real sending in the last 30, from email_log — the
   record of what this store actually sends, not an estimate. Capped, because
   this runs inside a status check that must stay cheap, and a cap that is hit
   is reported as "at least" rather than quietly under-counting.

   Returns null whenever the answer would be invented — no service key, no
   table, no sends yet. Same refusal as projectQuota: a missing number beats a
   made-up one. */
const PEAK_SCAN_LIMIT = 5000;

export async function emailPeakDay(env) {
  const url = (env.SUPABASE_URL || '').trim();
  const key = svcKey(env);
  if (!url || !key) return null;

  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  try {
    const resp = await withTimeout(fetch(
      url + '/rest/v1/email_log?select=created_at&status=eq.sent'
          + '&created_at=gte.' + encodeURIComponent(since)
          + '&order=created_at.desc&limit=' + PEAK_SCAN_LIMIT,
      { headers: { apikey: key, Authorization: 'Bearer ' + key } }
    ));
    if (!resp.ok) return null;
    const rows = await resp.json().catch(() => null);
    if (!Array.isArray(rows) || !rows.length) return null;

    /* Grouped here rather than in SQL: PostgREST cannot group without an RPC,
       and adding a migration for a display line is a poor trade. */
    const byDay = {};
    for (const r of rows) {
      const d = String(r.created_at || '').slice(0, 10);
      if (d) byDay[d] = (byDay[d] || 0) + 1;
    }
    const days = Object.keys(byDay);
    if (!days.length) return null;
    const peakDate = days.reduce((a, b) => (byDay[b] > byDay[a] ? b : a));

    return {
      peak: byDay[peakDate],
      peakDate,
      daysWithSends: days.length,
      /* Hitting the cap means the real peak may be higher — the oldest rows in
         the window were never read. Say so rather than report a floor as a
         fact. */
      capped: rows.length >= PEAK_SCAN_LIMIT,
    };
  } catch (_) { return null; }
}

async function checkSupabase(env) {
  // Supabase URL/key always come from env (they bootstrap everything else)
  const url = (env.SUPABASE_URL || '').trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key) return { ok: false, error: 'Missing SUPABASE_URL or service key' };
  try {
    const headers = { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' };
    const [ordersRes, productsRes, usersRes, sizesRes] = await Promise.all([
      withTimeout(fetch(`${url}/rest/v1/orders?select=id`,   { headers })),
      withTimeout(fetch(`${url}/rest/v1/products?select=id`, { headers })),
      withTimeout(fetch(`${url}/auth/v1/admin/users?page=1&per_page=1`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` }
      })),
      withTimeout(fetch(`${url}/rest/v1/product_sizes?select=id`, { headers })),
    ]);
    const parseCount = (res) => parseInt(res.headers.get('content-range')?.split('/')[1] || '0');
    const ordersCount   = parseCount(ordersRes);
    const productsCount = parseCount(productsRes);
    const sizesCount    = parseCount(sizesRes);
    let authUsers = null;
    if (usersRes.ok) {
      try { const ud = await usersRes.json(); authUsers = ud.total || null; } catch(_) {}
    }
    return {
      ok: true,
      keyActive: true,
      plan: 'Free',
      limits: { dbStorage: '500 MB', fileStorage: '1 GB', bandwidth: '2 GB', authUsers: 50000, edgeFunctions: 500000 },
      counts: { orders: ordersCount, products: productsCount, productSizes: sizesCount, authUsers },
      note: 'Storage usage is not available via the REST API. Check the Supabase dashboard for exact usage.',
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkStripe(env, cache) {
  const key  = resolveSetting('STRIPE_SECRET_KEY', env, cache);
  if (!key) return { ok: false, configured: false, error: 'STRIPE_SECRET_KEY not set' };
  const mode = key.startsWith('sk_live_') ? 'live' : key.startsWith('sk_test_') ? 'test' : 'unknown';
  try {
    const resp = await withTimeout(fetch('https://api.stripe.com/v1/balance', {
      headers: { Authorization: `Bearer ${key}` }
    }));
    if (!resp.ok) return { ok: false, keyActive: false, mode, error: `HTTP ${resp.status}` };
    const d    = await resp.json();
    const avail = (d.available || []).map(b => `$${(b.amount / 100).toFixed(2)} ${b.currency.toUpperCase()}`);
    return {
      ok: true,
      keyActive: true,
      mode,
      availableBalance: avail.join(', ') || '$0.00',
      note: 'Stripe has no API quota — you are billed per transaction only.',
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkShippo(env, cache) {
  const key = resolveSetting('SHIPPO_API_KEY', env, cache);
  if (!key) return { ok: false, configured: false, error: 'SHIPPO_API_KEY not set' };
  try {
    const [addrResp, shipResp] = await Promise.all([
      withTimeout(fetch('https://api.goshippo.com/addresses/?results=1', { headers: { Authorization: `ShippoToken ${key}` } })),
      withTimeout(fetch('https://api.goshippo.com/shipments/?results=1', { headers: { Authorization: `ShippoToken ${key}` } })),
    ]);
    if (!addrResp.ok) return { ok: false, keyActive: false, error: `HTTP ${addrResp.status} — key may be invalid` };
    let totalShipments = null;
    if (shipResp.ok) {
      try { const d = await shipResp.json(); totalShipments = d.count ?? null; } catch (_) {}
    }
    // Free-tier usage this month (labels bought via Shippo) + how many are left
    // before checkout switches to Veeqo.
    const limit = shippoFreeLimit(env, cache);
    const used  = await getShippoMonthlyCount(env);
    /* Which mode the key is in, because "26/30" means two very different
       things depending on the answer. Test labels are free, carry fake tracking
       numbers, and are no longer counted at all — so a test key showing a
       non-zero count is history from before that fix. */
    const testMode = String(key).startsWith('shippo_test_');
    return {
      ok: true,
      keyActive: true,
      testMode,
      plan: testMode ? 'Test mode (labels are not real)' : 'Starter (pay-per-label)',
      totalShipments,
      freeTier: {
        month: shippoMonthKey(),
        limit,
        used,
        remaining: Math.max(0, limit - used),
        exhausted: used >= limit,
      },
      note: `Free-tier labels this month: ${used}/${limit}. ${used >= limit ? 'Exhausted — checkout is using Veeqo.' : `${Math.max(0, limit - used)} left before switching to Veeqo.`}`,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

/**
 * Is Stripe Tax switched on in the STRIPE ACCOUNT?
 *
 * A different question from "is it this store's tax engine", and the panel was
 * answering only the second while saying "Not set up" — which reads as "you
 * have not done anything", when the likeliest truth is that somebody enabled it
 * in Stripe and never selected it here. That is the exact state where a shop
 * believes tax is being calculated properly and the built-in state table is
 * quietly pricing every order.
 *
 * Deliberately NOT added to /api/tax-config, which is a public endpoint. Whether
 * a business has registered for tax collection is account information; it
 * belongs behind the admin check like everything else here.
 */
async function checkStripeTax(env) {
  const key = String(env.STRIPE_SECRET_KEY || '').trim();
  if (!key) return { ok: false, configured: false, optional: true, error: 'STRIPE_SECRET_KEY not set' };
  try {
    const resp = await withTimeout(fetch('https://api.stripe.com/v1/tax/settings', {
      headers: { Authorization: 'Bearer ' + key },
    }));
    const d = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      /* Stripe answers 403 when Tax has never been touched on the account. That
         is a real answer — "not enabled" — not a failure worth alarming about. */
      const notEnabled = resp.status === 403 || (d.error && /tax/i.test(d.error.message || ''));
      return notEnabled
        ? { ok: false, configured: false, optional: true, active: false, error: 'Stripe Tax is not enabled on this Stripe account' }
        : { ok: false, error: (d.error && d.error.message) || ('HTTP ' + resp.status) };
    }
    /* `active` means Stripe has everything it needs to calculate. `pending`
       means something is still missing — usually the business address or a
       registration — and it will not price anything until that is resolved. */
    const status = String(d.status || '').toLowerCase();
    return {
      ok: status === 'active',
      configured: true,
      optional: true,
      active: status === 'active',
      status,
      /* Why it is pending, in Stripe's own words. Without this the answer is
         "not working" and the next step is a hunt through their dashboard. */
      missing: (d.status_details && d.status_details.pending && d.status_details.pending.missing_fields) || [],
      headOffice: !!(d.head_office && d.head_office.address && d.head_office.address.country),
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkVeeqo(env, cache) {
  const key = veeqoKey(env, cache);
  if (!key) return { ok: false, configured: false, optional: true, error: 'VEEQO_API_KEY not set' };
  try {
    // Lightweight auth check against the Veeqo API. Only a 401/403 means a bad
    // key; other statuses (e.g. endpoint differences) still count as reachable
    // so we don't show a false "invalid" — real validation happens at checkout.
    const resp = await withTimeout(fetch('https://api.veeqo.com/current_user', { headers: { 'x-api-key': key } }));
    if (resp.status === 401 || resp.status === 403) return { ok: false, keyActive: false, error: `HTTP ${resp.status} — key may be invalid` };

    // A valid key does NOT mean the rate feed works: Veeqo only returns quotes
    // once Amazon Shipping (Buy Shipping V2) is connected as a carrier with a
    // ship-from location. Probe with a real quote request (store address to
    // itself, 1 lb parcel — quotes are free, nothing is booked) so the admin
    // card can show whether checkout would actually get Veeqo rates.
    let rateFeed = null;
    const from = {
      name:    resolveSetting('SHIPPO_FROM_NAME', env, cache) || 'Zuwera',
      street1: resolveSetting('SHIPPO_FROM_STREET1', env, cache),
      city:    resolveSetting('SHIPPO_FROM_CITY', env, cache),
      state:   resolveSetting('SHIPPO_FROM_STATE', env, cache),
      zip:     resolveSetting('SHIPPO_FROM_ZIP', env, cache),
      country: resolveSetting('SHIPPO_FROM_COUNTRY', env, cache) || 'US',
      phone:   resolveSetting('SHIPPO_FROM_PHONE', env, cache),
    };
    if (from.street1 && from.city && from.zip) {
      try {
        const diag = await withTimeout(veeqoDiagnose({
          env,
          from,
          to: { name: from.name, line1: from.street1, city: from.city, state: from.state, zip: from.zip, country: from.country },
          parcel: { weight: '1', mass_unit: 'lb', length: '12', width: '10', height: '4', distance_unit: 'in' },
          settingsCache: cache,
        }), 8000);
        rateFeed = { quotes: diag.quotesReturned || 0, live: (diag.quotesReturned || 0) > 0, diag };
      } catch (e) {
        rateFeed = { quotes: 0, live: false, error: e.message };
      }
    } else {
      rateFeed = { quotes: 0, live: false, error: 'SHIPPO_FROM_* address incomplete — probe skipped' };
    }

    return {
      ok: true,
      keyActive: true,
      rateFeed,
      note: 'Veeqo (Amazon-owned, free) provides USPS rates via Amazon Shipping V2. Used to rate-shop against Shippo and as the fallback once Shippo’s free tier is used up. Requires Amazon Shipping V2 enabled in Veeqo.',
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkLoops(env, cache) {
  const key = resolveSetting('LOOPS_API_KEY', env, cache);
  if (!key) return { ok: false, configured: false, optional: true, error: 'LOOPS_API_KEY not set' };
  try {
    const resp = await withTimeout(fetch('https://app.loops.so/api/v1/api-key', {
      headers: { Authorization: `Bearer ${key}` }
    }));
    if (!resp.ok) return { ok: false, keyActive: false, error: `HTTP ${resp.status} — key may be invalid` };
    const d = await resp.json();
    return {
      ok: true,
      keyActive: true,
      teamName: d.teamName || '',
      note: 'Loops handles marketing emails (drop announcements, restock alerts). Free up to 1,000 contacts.',
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkTwilio(env, cache) {
  const sid   = resolveSetting('TWILIO_ACCOUNT_SID',  env, cache);
  const token = resolveSetting('TWILIO_AUTH_TOKEN',   env, cache);
  const from  = resolveSetting('TWILIO_FROM_NUMBER',  env, cache);
  if (!sid || !token) return { ok: false, configured: false, optional: true, error: 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set' };
  try {
    const creds = btoa(`${sid}:${token}`);
    const resp  = await withTimeout(fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
      headers: { Authorization: `Basic ${creds}` }
    }));
    if (!resp.ok) return { ok: false, keyActive: false, error: `HTTP ${resp.status} — credentials may be invalid` };
    const d = await resp.json();
    return {
      ok: true,
      keyActive: true,
      accountName:   d.friendly_name || '',
      accountStatus: d.status        || '',
      fromNumber:    from            || '(not set)',
      note: 'SMS notifications for shipped/delivered events. Requires customer SMS opt-in.',
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkPostHog(env, cache) {
  let key = resolveSetting('POSTHOG_API_KEY', env, cache) || (env.POSTHOG_PROJECT_API_KEY || '').trim();

  // Fall back to reading the phc_ key embedded in the static posthog-init.js asset
  if (!key && env.ASSETS) {
    try {
      const assetResp = await env.ASSETS.fetch(new Request('https://placeholder.local/posthog-init.js'));
      if (assetResp.ok) {
        const text  = await assetResp.text();
        const match = text.match(/phc_[A-Za-z0-9_]{20,}/);
        if (match) key = match[0];
      }
    } catch (_) {}
  }

  if (!key) return { ok: false, configured: false, optional: true, error: 'POSTHOG_API_KEY not set — add your PostHog project API key (starts with phc_)' };
  if (!key.startsWith('phc_') || key.length < 20) {
    return { ok: false, keyActive: false, error: 'Key should start with phc_ and be at least 20 characters — check your PostHog project settings.' };
  }
  // Validate against the PostHog decide endpoint — fastest ping that accepts project API keys
  try {
    const resp = await withTimeout(fetch('https://us.i.posthog.com/decide/?v=3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, distinct_id: '__admin_ping__' }),
    }));
    const ok = resp.status === 200 || resp.status === 400; // 400 = key found but bad payload; both confirm key exists
    if (!ok && resp.status === 401) return { ok: false, keyActive: false, error: 'Key rejected (401) — check your PostHog project API key' };
    return {
      ok: true,
      keyActive: true,
      validated: true,
      note: 'PostHog analytics is active. View events and recordings at app.posthog.com.',
    };
  } catch (e) {
    // If decide endpoint fails, fall back to format-only confirmation
    return { ok: true, keyActive: true, validated: false, note: 'Key format looks valid. Could not reach PostHog to confirm — check app.posthog.com.' };
  }
}

async function checkCloudflare(env, cache) {
  const zoneTag = resolveSetting('CLOUDFLARE_ZONE_ID', env, cache)
    || (env.CF_ZONE_ID || '').trim();
  const token   = resolveSetting('CLOUDFLARE_GRAPHQL_TOKEN', env, cache)
    || (env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN || '').trim();
  if (!zoneTag || !token) return { ok: false, error: 'Missing CLOUDFLARE_ZONE_ID or CLOUDFLARE_GRAPHQL_TOKEN' };
  try {
    const resp = await withTimeout(fetch(`https://api.cloudflare.com/client/v4/zones/${zoneTag}`, {
      headers: { Authorization: `Bearer ${token}` }
    }));
    if (!resp.ok) return { ok: false, keyActive: false, error: `HTTP ${resp.status}` };
    const d    = await resp.json();
    const zone = d.result || {};
    return {
      ok: true,
      keyActive: true,
      plan:     zone.plan?.name || 'Free',
      zoneName: zone.name       || '',
      status:   zone.status     || '',
      note:     'Cloudflare Pages is free with unlimited requests on the free plan.',
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const svcKey = (env) => (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();

/* Not a service — a setting whose absence turns a customer-facing feature off
   without any outward sign.
 *
 * Every guest return starts with an emailed link, and that link is signed.
 * With no secret there is nothing to sign with, so no email is sent — and the
 * returns page still answers "we have emailed a link to start your return",
 * because that sentence is deliberately identical for every outcome so it
 * cannot be used to probe which orders exist. Right for the customer, and it
 * means the operator's only signal is a customer complaining.
 *
 * It belongs on this panel precisely because nothing else will ever show it.
 * NOT optional: a store that takes orders can be asked for a return. */
export function checkReturnSigning(e) {
  const has = (e.RETURN_TOKEN_SECRET || '').trim() || (e.CHECKOUT_RATE_SECRET || '').trim();
  if (!has) {
    return {
      ok: false, configured: false,
      error: 'RETURN_TOKEN_SECRET not set — guest returns are silently failing. '
        + 'Customers are told a link was emailed and none is sent. '
        + 'Set it to any long random string in Cloudflare.',
    };
  }
  /* Long enough to be worth signing with. A short secret is brute-forceable
     offline against a single captured link, and a forged token is a link into
     somebody else's order. */
  if (has.length < 24) {
    return {
      ok: false, configured: true,
      error: 'The returns signing secret is only ' + has.length + ' characters. '
        + 'Use at least 32 random ones — a short secret can be brute-forced from a single link.',
    };
  }
  return {
    ok: true, configured: true,
    note: (e.RETURN_TOKEN_SECRET || '').trim()
      ? 'Signing with RETURN_TOKEN_SECRET.'
      : 'Signing with CHECKOUT_RATE_SECRET. Set RETURN_TOKEN_SECRET to give returns their own key.',
  };
}

/**
 * Run every service check and return the results keyed by service.
 *
 * EXPORTED so the scheduled watcher runs THESE checks rather than its own.
 * A watcher with a second copy of "is Resend healthy" is a watcher that
 * eventually disagrees with the panel, and the disagreement surfaces as an
 * alert nobody can reproduce by opening the page — the worst kind, because the
 * obvious next step (look at the dashboard) actively misleads.
 *
 * `extra` lets a caller fold in checks that are not vendor calls (the returns
 * signing secret), so the watcher covers exactly what the panel covers.
 */
export async function runChecks(env, cache, extra) {
  const [cloudinary, resend, brevo, supabase, stripe, shippo, veeqo, cloudflare, deepl, loops, twilio, posthog, stripeTax] =
    await Promise.allSettled([
      checkCloudinary(env, cache),
      checkResend(env, cache),
      checkBrevo(env, cache),
      checkSupabase(env),          // always uses env for bootstrap keys
      checkStripe(env, cache),
      checkShippo(env, cache),
      checkVeeqo(env, cache),
      checkCloudflare(env, cache),
      checkDeepL(env, cache),
      checkLoops(env, cache),
      checkTwilio(env, cache),
      checkPostHog(env, cache),
      checkStripeTax(env),
    ]);

  const unwrap = (r) =>
    r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason?.message || 'Unknown error' };

  const out = {
    cloudinary: unwrap(cloudinary),
    resend:     unwrap(resend),
    brevo:      unwrap(brevo),
    supabase:   unwrap(supabase),
    stripe:     unwrap(stripe),
    shippo:     unwrap(shippo),
    veeqo:      unwrap(veeqo),
    cloudflare: unwrap(cloudflare),
    deepl:      unwrap(deepl),
    loops:      unwrap(loops),
    twilio:     unwrap(twilio),
    posthog:    unwrap(posthog),
    stripeTax:  unwrap(stripeTax),
  };
  if (typeof extra === 'function') out.returnSigning = extra(env);

  /* Attached to brevo rather than returned beside it, so the one card that
     needs it gets it and nothing else has to know this exists. Only asked for
     when Brevo is actually configured — an unconfigured failover has no
     capacity question to answer, and this is a database round trip. */
  if (out.brevo && out.brevo.configured) {
    out.brevo.peakDay = await emailPeakDay(env);
  }
  return out;
}

/* Also exported: the watcher needs to write its own run, or a check that
   happened at 4am leaves no trace and the next morning's panel says the service
   has been healthy all night. */
export { recordRun, svcKey };

/* ── How long has it been like this? ─────────────────────────────────────────
   A status page that only knows about right now cannot answer the question
   anybody actually has. "Resend is failing" is a fact; "Resend has been failing
   since 04:12" is something you can act on, and the difference is entirely
   whether the last check was written down.

   One query for every service, grouped here rather than thirteen queries — the
   whole point is that this must not cost more than the checks it annotates. */
async function statusHistory(env) {
  const url = (env.SUPABASE_URL || '').trim();
  const key = svcKey(env);
  if (!url || !key) return {};
  try {
    const r = await fetch(
      url + '/rest/v1/api_status_log?select=service,ok,checked_at&order=checked_at.desc&limit=600',
      { headers: { apikey: key, Authorization: 'Bearer ' + key } },
    );
    if (!r.ok) return {};                       // table not created yet → no history, no error
    const rows = await r.json().catch(() => []);
    const by = {};
    for (const row of (Array.isArray(rows) ? rows : [])) {
      (by[row.service] = by[row.service] || []).push(row);
    }
    const out = {};
    for (const [service, list] of Object.entries(by)) {
      // Already newest-first from the query.
      const current = list[0];
      if (!current) continue;
      /* `since` walks back through the unbroken run of the SAME result. The
         first row that disagrees ends the run, so `since` is the oldest sample
         that still matches — i.e. when this state began, as far as we saw. */
      let since = current.checked_at;
      for (const row of list) {
        if (row.ok !== current.ok) break;
        since = row.checked_at;
      }
      const lastOk = (list.find((r2) => r2.ok) || {}).checked_at || null;
      out[service] = {
        since,
        lastOk,
        samples: list.length,
        /* Enough for a sparkline, oldest-first so it reads left to right. */
        recent: list.slice(0, 24).map((r2) => (r2.ok ? 1 : 0)).reverse(),
      };
    }
    return out;
  } catch (_) { return {}; }
}

/* ── When did this service last actually DO something? ───────────────────────
   "The key is valid" and "this is working" are different claims, and only the
   second one is what an operator means. The evidence already exists — every
   send is logged, every webhook delivery is logged — it has simply never been
   read on this page.

   Deliberately separate from the health check: a key can validate perfectly
   while nothing has used it for a month, and that gap is worth seeing. */
/**
 * When each key was last changed, and by whom.
 *
 * "This stopped working on Tuesday — did somebody change the key?" was
 * previously answerable only by searching an inbox for the alert email, if
 * anyone still had it. Every other consequential admin action is in
 * admin_audit_log; API keys, the most consequential thing on this page, were
 * the one exception until update-api-key.js started writing here.
 *
 * Keyed by the KEY NAME (RESEND_API_KEY), which the admin maps onto its card —
 * one card can own several keys, and Cloudinary owning three is exactly the
 * case where "which one changed" is the useful part.
 */
async function keyChanges(env) {
  const url = (env.SUPABASE_URL || '').trim();
  const key = svcKey(env);
  if (!url || !key) return {};
  try {
    const r = await fetch(
      url + '/rest/v1/admin_audit_log'
      + '?select=resource_id,admin_email,created_at,action'
      + '&resource_type=eq.api_key&order=created_at.desc&limit=200',
      { headers: { apikey: key, Authorization: 'Bearer ' + key } },
    );
    if (!r.ok) return {};                 // nothing recorded yet is not an error
    const rows = await r.json().catch(() => []);
    const out = {};
    /* Newest first, so the first row seen for a key is its latest change. */
    for (const row of (Array.isArray(rows) ? rows : [])) {
      if (!row || !row.resource_id || out[row.resource_id]) continue;
      out[row.resource_id] = {
        at: row.created_at,
        by: row.admin_email || 'an admin',
        rejected: row.action === 'api_key.rejected',
      };
    }
    return out;
  } catch (_) { return {}; }
}

async function lastUsed(env) {
  const url = (env.SUPABASE_URL || '').trim();
  const key = svcKey(env);
  if (!url || !key) return {};
  const H = { headers: { apikey: key, Authorization: 'Bearer ' + key } };
  const out = {};

  const [emails, hooks] = await Promise.allSettled([
    fetch(url + '/rest/v1/email_log?select=provider,status,created_at&status=eq.sent&order=created_at.desc&limit=60', H),
    fetch(url + '/rest/v1/webhook_events?select=received_at,raw_status&order=received_at.desc&limit=1', H),
  ]);

  if (emails.status === 'fulfilled' && emails.value.ok) {
    const rows = await emails.value.json().catch(() => []);
    /* Per PROVIDER, because the whole point of a failover chain is knowing
       which tier is carrying the traffic. A store that thinks it is on Resend
       and is quietly running on Brevo is a store about to be surprised. */
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const p = String(row.provider || '').toLowerCase();
      if (p && !out[p]) out[p] = { at: row.created_at, what: 'email sent' };
    }
  }

  if (hooks.status === 'fulfilled' && hooks.value.ok) {
    const rows = await hooks.value.json().catch(() => []);
    if (Array.isArray(rows) && rows[0]) {
      /* received_at, not created_at — webhook_events has no created_at, so
         this was handing sinceWords() undefined and the card said Stripe was
         last used "at an unknown time" while the row it had just read carried
         the timestamp. */
      out.stripe = { at: rows[0].received_at, what: 'webhook received' };
    }
  }

  return out;
}

/* Written after the response is built, never before it is sent — recording
   history must not slow down the page that triggers it, and must never be the
   reason a status check fails. */
async function recordRun(env, services) {
  const url = (env.SUPABASE_URL || '').trim();
  const key = svcKey(env);
  if (!url || !key) return;
  const rows = Object.entries(services || {}).map(([service, s]) => ({
    service,
    ok: !!(s && s.ok),
    configured: s && s.configured !== undefined ? !!s.configured : null,
    detail: (s && s.error) ? String(s.error).slice(0, 500) : null,
  }));
  if (!rows.length) return;
  try {
    await fetch(url + '/rest/v1/rpc/record_api_status', {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_rows: rows }),
    });
  } catch (_) { /* history is a nicety; the status page is not */ }
}

export async function onRequestGet({ request, env, waitUntil }) {
  // Admin-only: this response includes masked previews of every API key and the
  // full service inventory — useful recon for an attacker, so it requires the
  // same Supabase admin bearer token as the other admin endpoints.
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const admin = token ? await verifyAdmin(env, token) : null;
  if (!admin) return json({ ok: false, error: 'Admin authorization required' }, 401);

  // Fetch Supabase overrides first (one round-trip, all keys at once)
  const cacheKeys = [...ALLOWED_KEYS];
  const cache     = await fetchSiteSettings(cacheKeys, env);

  const built = await runChecks(env, cache, checkReturnSigning);

  // Build masked key map for display in the admin UI
  // Each key shows the value from Supabase (if overridden) or env var, masked.
  /* A few of these are settings, not credentials — a provider name, a country
     code, a threshold. Masking them makes the admin unable to show what is
     currently selected: maskKey turns anything eight characters or shorter into
     "••••••••", so "google" and "deepl" and "off" are indistinguishable and a
     dropdown cannot pre-select the saved value. Returned verbatim, because
     there is nothing in them to protect. */
  const PLAIN_KEYS = new Set([
    'TRANSLATE_PROVIDER', 'SHIP_FROM_STATE', 'SHIP_FROM_COUNTRY',
    'FROM_STATE', 'FROM_COUNTRY', 'SHIPPO_FROM_STATE', 'SHIPPO_FROM_COUNTRY',
    'SHIPPO_FREE_LIMIT',
  ]);
  const maskedKeys = {};
  for (const k of cacheKeys) {
    const v = cache[k] || (env[k] || '').trim().replace(/,$/, '');
    maskedKeys[k] = v ? (PLAIN_KEYS.has(k) ? v : maskKey(v)) : null;
  }

  /* Env-only values the panel still needs to REPORT ON, masked.
     maskedKeys is built from ALLOWED_KEYS, so moving the cron tokens and
     webhook URLs out of that list to stop an admin choosing them also removed
     them from this map — and the Cron card reads it to say "Set / Not set".
     Without this the card would report every one of them missing while they sat
     correctly configured in Cloudflare, which is a worse lie than the problem
     the move was fixing.

     Masked exactly like everything else. The panel needs to know a value
     EXISTS; it has never needed to see one. */
  for (const k of ['REVIEW_REQUEST_TOKEN', 'ABANDONED_CART_TOKEN', 'STATUS_WATCH_TOKEN',
                   'SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL']) {
    const v = (env[k] || '').trim();
    maskedKeys[k] = v ? maskKey(v) : null;
  }

  /* Both read alongside each other, and neither is allowed to fail the page:
     history is missing until migration 0014 runs, and email_log/webhook_events
     may be empty on a new store. A status panel that breaks because its own
     annotations are unavailable would be a poor trade. */
  const [historyR, usedR, changedR, pausedR] = await Promise.allSettled([
    statusHistory(env), lastUsed(env), keyChanges(env), fetchSiteSettings(['api_paused'], env),
  ]);
  const pausedCache = pausedR.status === 'fulfilled' ? (pausedR.value || {}) : {};
  let pausedMap = pausedCache.api_paused || {};
  if (typeof pausedMap === 'string') { try { pausedMap = JSON.parse(pausedMap); } catch (_) { pausedMap = {}; } }
  if (!pausedMap || typeof pausedMap !== 'object') pausedMap = {};
  const history = historyR.status === 'fulfilled' ? historyR.value : {};
  const used    = usedR.status === 'fulfilled' ? usedR.value : {};
  const changed = changedR.status === 'fulfilled' ? changedR.value : {};

  /* Each service carries its own history and its own last-used evidence, rather
     than the admin joining three maps by key — one place to get the pairing
     wrong instead of three. */
  for (const [name, s] of Object.entries(built)) {
    if (!s || typeof s !== 'object') continue;
    if (history[name]) s.history = history[name];
    if (used[name]) s.lastUsed = used[name];
  }

  /* After the answer is assembled, so recording never delays it. waitUntil lets
     the write finish after the response has gone out; without it the Worker can
     be torn down mid-flight and the history is silently patchy. */
  const write = recordRun(env, built);
  if (typeof waitUntil === 'function') waitUntil(write); else await write.catch(() => {});

  return json({
    ok: true,
    fetchedAt: new Date().toISOString(),
    services: built,
    maskedKeys,
    /* Keyed by KEY NAME, not by service — one card can own several keys, and
       "which of Cloudinary's three changed" is the useful part. The admin does
       the mapping because it already knows which keys belong to which card. */
    keyChanges: changed,
    /* Which non-critical services are paused, so a card can say so rather than
       looking healthy while doing nothing. */
    paused: pausedMap,
  });
}
