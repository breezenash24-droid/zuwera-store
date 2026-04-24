/**
 * Cloudflare Pages Function: /api/api-status
 * Returns live usage stats for all integrated third-party services.
 *
 * Required env vars (set in CF Pages > Settings > Variables & Secrets):
 *   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
 *   RESEND_API_KEY
 *   BREVO_API_KEY            (optional — email fallback)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)
 *   STRIPE_SECRET_KEY
 *   SHIPPO_API_KEY
 *   CLOUDFLARE_ZONE_ID, CLOUDFLARE_GRAPHQL_TOKEN
 */

function json(body) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

async function checkDeepL(env) {
  const key = (env.DEEPL_API_KEY || env.DEEPL_API_KEY_ || '').trim().replace(/,$/, ''); // strip trailing comma if any
  if (!key) return { ok: false, configured: false, error: 'DEEPL_API_KEY not set' };
  try {
    const resp = await fetch('https://api-free.deepl.com/v2/usage', {
      headers: { Authorization: `DeepL-Auth-Key ${key}` }
    });
    // Also try paid API endpoint if free fails
    const resp2 = resp.ok ? resp : await fetch('https://api.deepl.com/v2/usage', {
      headers: { Authorization: `DeepL-Auth-Key ${key}` }
    });
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

async function checkCloudinary(env) {
  const cloudName   = (env.CLOUDINARY_CLOUD_NAME || '').trim();
  const apiKey      = (env.CLOUDINARY_API_KEY || '').trim();
  const apiSecret   = (env.CLOUDINARY_API_SECRET || '').trim();
  if (!cloudName || !apiKey || !apiSecret) return { ok: false, configured: false, error: 'Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET to Cloudflare to see usage' };
  try {
    const creds = btoa(`${apiKey}:${apiSecret}`);
    const resp  = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/usage`, {
      headers: { Authorization: `Basic ${creds}` }
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const d = await resp.json();
    return {
      ok: true,
      plan: d.plan || 'Free',
      credits: d.credits   || null,   // { usage, limit, used_percent }
      storage: d.storage   || null,   // { usage (bytes), limit, used_percent }
      bandwidth: d.bandwidth || null, // { usage (bytes), limit, used_percent }
      objects: d.objects   || null,   // { usage, limit }
      transformations: d.transformations || null,
      lastUpdated: d.last_updated || null,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkResend(env) {
  const key = (env.RESEND_API_KEY || '').trim();
  if (!key) return { ok: false, configured: false, error: 'RESEND_API_KEY not set' };
  try {
    const resp = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!resp.ok) return { ok: false, keyActive: false, error: `HTTP ${resp.status} — key may be invalid` };
    const d = await resp.json();
    return {
      ok: true,
      keyActive: true,
      // Resend free: 3,000/month, 100/day — no quota API, show plan defaults
      freePlan: { dailyLimit: 100, monthlyLimit: 3000 },
      domains: (d.data || []).map(dom => ({ name: dom.name, status: dom.status })),
      note: 'Resend does not expose remaining quota via API. Limits shown are Free plan defaults.',
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkBrevo(env) {
  const key = (env.BREVO_API_KEY || '').trim();
  if (!key) return { ok: false, configured: false, error: 'BREVO_API_KEY not set — email failover not active' };
  try {
    const resp = await fetch('https://api.brevo.com/v3/account', {
      headers: { 'api-key': key, Accept: 'application/json' }
    });
    if (!resp.ok) return { ok: false, keyActive: false, error: `HTTP ${resp.status}` };
    const d = await resp.json();
    const plan = Array.isArray(d.plan) ? (d.plan[0] || {}) : (d.plan || {});
    return {
      ok: true,
      configured: true,
      keyActive: true,
      accountEmail: d.email || '',
      companyName: d.companyName || '',
      plan: plan.type || 'free',
      credits: plan.credits !== undefined ? plan.credits : null,
      creditsType: plan.creditsType || 'daily',
      // Brevo free: 300 emails/day, no monthly cap
      freePlan: { dailyLimit: 300 },
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkSupabase(env) {
  const url = (env.SUPABASE_URL || '').trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key) return { ok: false, error: 'Missing SUPABASE_URL or service key' };
  try {
    const headers = { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' };
    const [ordersRes, productsRes, usersRes, sizesRes] = await Promise.all([
      fetch(`${url}/rest/v1/orders?select=id`,   { headers }),
      fetch(`${url}/rest/v1/products?select=id`, { headers }),
      fetch(`${url}/auth/v1/admin/users?page=1&per_page=1`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` }
      }),
      fetch(`${url}/rest/v1/product_sizes?select=id`, { headers }),
    ]);
    const parseCount = (res) => parseInt(res.headers.get('content-range')?.split('/')[1] || '0');
    const ordersCount  = parseCount(ordersRes);
    const productsCount = parseCount(productsRes);
    const sizesCount   = parseCount(sizesRes);
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

async function checkStripe(env) {
  const key = (env.STRIPE_SECRET_KEY || '').trim();
  if (!key) return { ok: false, error: 'STRIPE_SECRET_KEY not set' };
  const mode = key.startsWith('sk_live_') ? 'live' : key.startsWith('sk_test_') ? 'test' : 'unknown';
  try {
    const resp = await fetch('https://api.stripe.com/v1/balance', {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!resp.ok) return { ok: false, keyActive: false, mode, error: `HTTP ${resp.status}` };
    const d = await resp.json();
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

async function checkShippo(env) {
  const key = (env.SHIPPO_API_KEY || '').trim();
  if (!key) return { ok: false, error: 'SHIPPO_API_KEY not set' };
  try {
    const resp = await fetch('https://api.goshippo.com/addresses/?results=1', {
      headers: { Authorization: `ShippoToken ${key}` }
    });
    return {
      ok: resp.ok,
      keyActive: resp.ok,
      plan: 'Starter (pay-per-label)',
      note: 'Shippo Starter is free — you only pay for shipping labels. No quota limits.',
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkCloudflare(env) {
  const zoneTag = (env.CLOUDFLARE_ZONE_ID || env.CF_ZONE_ID || '').trim();
  const token   = (env.CLOUDFLARE_GRAPHQL_TOKEN || env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN || '').trim();
  if (!zoneTag || !token) return { ok: false, error: 'Missing CLOUDFLARE_ZONE_ID or CLOUDFLARE_GRAPHQL_TOKEN' };
  try {
    // Verify token by fetching zone details
    const resp = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneTag}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!resp.ok) return { ok: false, keyActive: false, error: `HTTP ${resp.status}` };
    const d = await resp.json();
    const zone = d.result || {};
    return {
      ok: true,
      keyActive: true,
      plan: zone.plan?.name || 'Free',
      zoneName: zone.name || '',
      status: zone.status || '',
      note: 'Cloudflare Pages is free with unlimited requests on the free plan.',
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function onRequestGet({ env }) {
  // Run all checks in parallel for speed
  const [cloudinary, resend, brevo, supabase, stripe, shippo, cloudflare, deepl] = await Promise.allSettled([
    checkCloudinary(env),
    checkResend(env),
    checkBrevo(env),
    checkSupabase(env),
    checkStripe(env),
    checkShippo(env),
    checkCloudflare(env),
    checkDeepL(env),
  ]);

  const unwrap = (r) => r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason?.message || 'Unknown error' };

  return json({
    ok: true,
    fetchedAt: new Date().toISOString(),
    services: {
      cloudinary:  unwrap(cloudinary),
      resend:      unwrap(resend),
      brevo:       unwrap(brevo),
      supabase:    unwrap(supabase),
      stripe:      unwrap(stripe),
      shippo:      unwrap(shippo),
      cloudflare:  unwrap(cloudflare),
      deepl:       unwrap(deepl),
    }
  });
}
