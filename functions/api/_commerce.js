import { resolvePerms, permsHave } from './_rbac.js';

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
    'Access-Control-Allow-Origin': env.SITE_URL || 'https://zuwera.store',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
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
  const rows = await supabaseSelect(env, `profiles?select=id,email,role,full_name,admin_role,admin_permissions&id=eq.${encodeURIComponent(user.id)}&limit=1`);
  const profile = rows?.[0] || null;
  if (!profile || profile.role !== 'admin') return null;
  // admin_role may be null on stores that haven't run supabase-rbac.sql yet —
  // treat that as super_admin so RBAC rollout never locks the owner out.
  const adminRole = profile.admin_role || 'super_admin';
  // Effective flat permission list from role preset + per-user overrides.
  const permissions = resolvePerms({ admin_role: adminRole, admin_permissions: profile.admin_permissions });
  return { ...user, profile, admin_role: adminRole, permissions };
}

// Like verifyAdmin, but also requires the person to hold `permission`
// (resolved from their role preset + per-user access overrides).
// Returns the admin object on success, or null if unauthenticated / not permitted.
export async function verifyAdminCan(env, accessToken, permission) {
  const admin = await verifyAdmin(env, accessToken);
  if (!admin) return null;
  if (!permsHave(admin.permissions, permission)) return null;
  return admin;
}

export async function getOrdersForUser(env, userId, userEmail = '') {
  if (!userId && !userEmail) return [];

  // Primary: match by user_id
  let orders = [];
  if (userId) {
    orders = await supabaseSelect(
      env,
      `orders?select=*&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`
    );
  }

  // Email fallback: covers guest checkouts and orders created before user_id was written.
  // De-duplicate by id so orders that already have user_id set don't appear twice.
  if (userEmail) {
    const emailOrders = await supabaseSelect(
      env,
      `orders?select=*&email=ilike.${encodeURIComponent(userEmail)}&order=created_at.desc`
    );
    if (emailOrders?.length) {
      const seen = new Set(orders.map((o) => o.id));
      for (const o of emailOrders) {
        if (!seen.has(o.id)) orders.push(o);
      }
      // Re-sort merged list newest first
      orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
  }

  return orders;
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
        targetProductIds: Array.isArray(promo.targetProductIds) ? promo.targetProductIds.map(String).filter(Boolean) : [],
        targetCollectionIds: Array.isArray(promo.targetCollectionIds) ? promo.targetCollectionIds.map(String).filter(Boolean) : [],
      })),
    localDelivery: sanitizeLocalDelivery(config.localDelivery),
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

// Campus hand-delivery config: a ZIP allow-list that unlocks a free in-person
// delivery option at checkout. ZIPs are normalized to 5 digits; anything else
// is dropped so a bad value can never widen eligibility.
export function sanitizeLocalDelivery(rawLocalDelivery = {}) {
  const ld = rawLocalDelivery && typeof rawLocalDelivery === 'object' ? rawLocalDelivery : {};
  const zips = Array.isArray(ld.zips)
    ? Array.from(new Set(ld.zips.map((z) => String(z).trim()).filter((z) => /^\d{5}$/.test(z))))
    : [];
  return {
    enabled: ld.enabled === true,
    label: String(ld.label || 'Campus hand-delivery'),
    instructions: String(ld.instructions || ''),
    zips,
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

export function computePromotionDiscount(promotion, subtotalCents, shippingCents = 0, cartItems = null) {
  if (!promotion) return 0;

  const targetProductIds = Array.isArray(promotion.targetProductIds) ? promotion.targetProductIds : [];
  const targetCollectionIds = Array.isArray(promotion.targetCollectionIds) ? promotion.targetCollectionIds : [];
  const hasTargets = targetProductIds.length > 0 || targetCollectionIds.length > 0;

  // When targets are specified, compute discount only on matching line items
  let applicableSubtotalCents = subtotalCents;
  if (hasTargets && Array.isArray(cartItems) && cartItems.length > 0) {
    applicableSubtotalCents = cartItems.reduce((sum, item) => {
      const pid = String(item.productId || item.product_id || item.id || '');
      const cid = String(item.collectionId || item.collection_id || item.collection || '');
      const matches =
        (targetProductIds.length > 0 && targetProductIds.includes(pid)) ||
        (targetCollectionIds.length > 0 && targetCollectionIds.includes(cid));
      if (!matches) return sum;
      return sum + Math.round(Number(item.amount || 0) * Number(item.quantity || 1));
    }, 0);
  }

  const minSubtotalCents = Math.round(Number(promotion.minSubtotal || 0) * 100);
  if (subtotalCents < minSubtotalCents) return 0;

  const type = String(promotion.type || 'percent');
  const value = Number(promotion.value || 0);

  if (type === 'percent') {
    return Math.max(0, Math.min(applicableSubtotalCents, Math.round(applicableSubtotalCents * (value / 100))));
  }
  if (type === 'fixed') {
    return Math.max(0, Math.min(applicableSubtotalCents, Math.round(value * 100)));
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
