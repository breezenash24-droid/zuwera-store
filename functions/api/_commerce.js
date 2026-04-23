export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

export function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.SITE_URL || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
}

function getSupabaseKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '';
}

function supabaseHeaders(env, token = '') {
  const apiKey = getSupabaseKey(env);
  const authHeader = token || apiKey;
  if (!env.SUPABASE_URL || !apiKey) {
    throw new Error('Supabase is not configured for commerce features.');
  }
  return {
    apikey: apiKey,
    Authorization: `Bearer ${authHeader}`,
    'Content-Type': 'application/json',
  };
}

async function supabaseSelect(env, path, token = '') {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: supabaseHeaders(env, token),
  });
  if (!resp.ok) {
    const details = await resp.text().catch(() => '');
    throw new Error(`Supabase request failed (${resp.status}): ${details || path}`);
  }
  return resp.json().catch(() => []);
}

async function supabaseUpsertSetting(env, key, value) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/site_settings`, {
    method: 'POST',
    headers: {
      ...supabaseHeaders(env),
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify([{ key, value }]),
  });
  if (!resp.ok) {
    const details = await resp.text().catch(() => '');
    throw new Error(`Failed to save ${key}: ${details || resp.status}`);
  }
  const rows = await resp.json().catch(() => []);
  return rows?.[0]?.value ?? value;
}

export async function getSetting(env, key, fallback = null) {
  const rows = await supabaseSelect(env, `site_settings?select=value&key=eq.${encodeURIComponent(key)}&limit=1`);
  return rows?.[0]?.value ?? fallback;
}

export async function setSetting(env, key, value) {
  return supabaseUpsertSetting(env, key, value);
}

export async function getCommerceBundle(env) {
  const rows = await supabaseSelect(
    env,
    `site_settings?select=key,value&key=in.(${['commerce_config', 'commerce_returns', 'commerce_order_ops', 'commerce_customer_profiles', 'commerce_inventory'].join(',')})`
  );
  const byKey = Object.fromEntries((rows || []).map((row) => [row.key, row.value]));
  return {
    config: byKey.commerce_config || {},
    returnsState: byKey.commerce_returns || { requests: [] },
    orderOps: byKey.commerce_order_ops || {},
    customerProfiles: byKey.commerce_customer_profiles || {},
    inventory: sanitizeInventoryState(byKey.commerce_inventory || {}),
  };
}

export async function verifyUser(env, accessToken) {
  const token = String(accessToken || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const resp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: supabaseHeaders(env, token),
  });
  if (!resp.ok) return null;
  return resp.json().catch(() => null);
}

export async function verifyAdmin(env, accessToken) {
  const user = await verifyUser(env, accessToken);
  if (!user?.id) return null;
  const rows = await supabaseSelect(env, `profiles?select=id,email,role,full_name&id=eq.${encodeURIComponent(user.id)}&limit=1`);
  const profile = rows?.[0] || null;
  if (!profile || profile.role !== 'admin') return null;
  return { ...user, profile };
}

export async function getOrdersForUser(env, userId) {
  if (!userId) return [];
  return supabaseSelect(
    env,
    `orders?select=*&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`
  );
}

export async function getOrdersForAdmin(env, limit = 200) {
  return supabaseSelect(env, `orders?select=*&order=created_at.desc&limit=${Math.max(1, Math.min(500, Number(limit) || 200))}`);
}

export async function getProfilesForAdmin(env, limit = 200) {
  return supabaseSelect(env, `profiles?select=*&order=created_at.desc&limit=${Math.max(1, Math.min(500, Number(limit) || 200))}`);
}

export function normalizePromoCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

export function sanitizeCommerceConfig(rawConfig = {}) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const promotions = Array.isArray(config.promotions) ? config.promotions : [];
  return {
    updatedAt: config.updatedAt || '',
    promotions: promotions
      .filter((promo) => promo && promo.active !== false && normalizePromoCode(promo.code))
      .map((promo) => ({
        code: normalizePromoCode(promo.code),
        label: String(promo.label || promo.code || 'Offer'),
        type: String(promo.type || 'percent'),
        value: Number(promo.value || 0),
        minSubtotal: Number(promo.minSubtotal || 0),
        description: String(promo.description || ''),
        active: promo.active !== false,
      })),
    integrations: config.integrations || {},
    shippingAutomation: config.shippingAutomation || {},
    customerExperience: config.customerExperience || {},
    returnsPolicy: config.returnsPolicy || {},
    loyalty: config.loyalty || {},
    subscriptions: config.subscriptions || {},
    affiliates: config.affiliates || {},
    merchandising: config.merchandising || {},
  };
}

export function sanitizeInventoryState(rawInventory = {}) {
  const inventory = rawInventory && typeof rawInventory === 'object' ? rawInventory : {};
  const rawLocations = Array.isArray(inventory.locations) ? inventory.locations : [];
  const locations = rawLocations
    .filter((location) => location && (location.id || location.name || location.code))
    .map((location, index) => ({
      id: String(location.id || `location-${index + 1}`).trim(),
      name: String(location.name || location.code || `Location ${index + 1}`).trim(),
      code: String(location.code || location.name || `LOC${index + 1}`).trim().toUpperCase(),
      type: String(location.type || 'warehouse').trim(),
      priority: Number.isFinite(Number(location.priority)) ? Number(location.priority) : index + 1,
      active: location.active !== false,
    }));

  return {
    locations: locations.length ? locations : [{
      id: 'main',
      name: 'Main Warehouse',
      code: 'MAIN',
      type: 'warehouse',
      priority: 1,
      active: true,
    }],
    variantOverrides: inventory.variantOverrides && typeof inventory.variantOverrides === 'object' ? inventory.variantOverrides : {},
    history: Array.isArray(inventory.history) ? inventory.history.slice(0, 250) : [],
    automation: inventory.automation && typeof inventory.automation === 'object'
      ? inventory.automation
      : {
          enabled: true,
          defaultThreshold: 8,
          alertEmail: '',
          alertSms: '',
          alertWebhook: '',
          autoReserveAtCheckout: true,
        },
  };
}

export function computePromotionDiscount(promotion, subtotalCents, shippingCents = 0) {
  if (!promotion) return 0;
  const minSubtotalCents = Math.round(Number(promotion.minSubtotal || 0) * 100);
  if (subtotalCents < minSubtotalCents) return 0;

  const type = String(promotion.type || 'percent');
  const value = Number(promotion.value || 0);

  if (type === 'percent') {
    return Math.max(0, Math.min(subtotalCents, Math.round(subtotalCents * (value / 100))));
  }
  if (type === 'fixed') {
    return Math.max(0, Math.min(subtotalCents, Math.round(value * 100)));
  }
  if (type === 'shipping') {
    return Math.max(0, Math.min(shippingCents, Math.round(value * 100) || shippingCents));
  }
  return 0;
}

export function upsertTimelineEntry(entries, nextEntry) {
  const current = Array.isArray(entries) ? [...entries] : [];
  current.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...nextEntry,
  });
  return current.slice(0, 50);
}
