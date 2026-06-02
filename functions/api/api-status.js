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

function json(body) {
  return new Response(JSON.stringify(body), {
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
    return {
      ok: true,
      keyActive: true,
      plan: 'Starter (pay-per-label)',
      totalShipments,
      note: 'Shippo Starter is free — you only pay when a label is purchased. No monthly quota limits.',
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

export async function onRequestGet({ env }) {
  // Fetch Supabase overrides first (one round-trip, all keys at once)
  const cacheKeys = [...ALLOWED_KEYS];
  const cache     = await fetchSiteSettings(cacheKeys, env);

  // Run all service checks in parallel
  const [cloudinary, resend, brevo, supabase, stripe, shippo, cloudflare, deepl, loops, twilio, posthog] =
    await Promise.allSettled([
      checkCloudinary(env, cache),
      checkResend(env, cache),
      checkBrevo(env, cache),
      checkSupabase(env),          // always uses env for bootstrap keys
      checkStripe(env, cache),
      checkShippo(env, cache),
      checkCloudflare(env, cache),
      checkDeepL(env, cache),
      checkLoops(env, cache),
      checkTwilio(env, cache),
      checkPostHog(env, cache),
    ]);

  const unwrap = (r) =>
    r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason?.message || 'Unknown error' };

  // Build masked key map for display in the admin UI
  // Each key shows the value from Supabase (if overridden) or env var, masked.
  const maskedKeys = {};
  for (const k of cacheKeys) {
    const v = cache[k] || (env[k] || '').trim().replace(/,$/, '');
    maskedKeys[k] = v ? maskKey(v) : null;
  }

  return json({
    ok: true,
    fetchedAt: new Date().toISOString(),
    services: {
      cloudinary: unwrap(cloudinary),
      resend:     unwrap(resend),
      brevo:      unwrap(brevo),
      supabase:   unwrap(supabase),
      stripe:     unwrap(stripe),
      shippo:     unwrap(shippo),
      cloudflare: unwrap(cloudflare),
      deepl:      unwrap(deepl),
      loops:      unwrap(loops),
      twilio:     unwrap(twilio),
      posthog:    unwrap(posthog),
    },
    maskedKeys,
  });
}
