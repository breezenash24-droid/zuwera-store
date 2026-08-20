import { resolvePerms, permsHave } from './_rbac.js';

import { can } from './_abac.js';
import { recordDecision } from './_audit.js';
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

// Atomic read-modify-write on one site_settings JSON blob via an optimistic
// compare-and-swap on the `rev` column (added by supabase-atomic-settings.sql).
//
// `mutator(currentValue)` returns the next value. If another writer bumped `rev`
// between our read and write, the CAS matches zero rows and we re-read + re-apply,
// so concurrent writers can no longer clobber each other (the lost-update bug that
// dropped customer profiles, return requests, and freshly-minted promo codes).
//
// If the `rev` column isn't deployed yet, PostgREST 400s on the rev filter and we
// transparently fall back to a plain upsert — identical to the old behaviour — so
// this is safe to ship before the migration runs.
export async function mutateSetting(env, key, mutator, { retries = 6 } = {}) {
  const H = supabaseHeaders(env);
  const base = `${env.SUPABASE_URL}/rest/v1/site_settings`;

  for (let attempt = 0; attempt < retries; attempt++) {
    const readResp = await fetch(`${base}?select=value,rev&key=eq.${encodeURIComponent(key)}&limit=1`, {
      headers: H, cache: 'no-store',
    });
    if (!readResp.ok) {
      if (readResp.status === 400) return fallbackWrite(env, key, mutator); // rev column not deployed
      throw new Error(`mutateSetting read failed (${readResp.status}) for ${key}`);
    }
    const rows = await readResp.json().catch(() => []);
    const existing = rows && rows[0];
    const nextValue = await mutator(existing ? existing.value : null);

    if (!existing) {
      // No row yet — insert with rev=1. A racing insert loses the unique(key)
      // constraint and 409s; we retry and take the CAS-update path.
      const ins = await fetch(base, {
        method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify([{ key, value: nextValue, rev: 1 }]),
      });
      if (ins.ok) return nextValue;
      continue;
    }

    const curRev = Number(existing.rev) || 0;
    const upd = await fetch(`${base}?key=eq.${encodeURIComponent(key)}&rev=eq.${encodeURIComponent(existing.rev)}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({ value: nextValue, rev: curRev + 1 }),
    });
    if (!upd.ok) {
      if (upd.status === 400) return fallbackWrite(env, key, mutator, nextValue); // rev column not deployed
      continue; // transient — retry
    }
    const updated = await upd.json().catch(() => []);
    if (Array.isArray(updated) && updated.length > 0) return nextValue; // won the CAS
    // 0 rows changed → another writer bumped rev between our read and write → retry
  }

  // Exhausted retries under heavy contention — best-effort plain write rather than
  // failing the request. Extremely rare.
  return fallbackWrite(env, key, mutator);
}

async function fallbackWrite(env, key, mutator, precomputed) {
  const nextValue = precomputed !== undefined
    ? precomputed
    : await mutator(await getSetting(env, key, null));
  return setSetting(env, key, nextValue);
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

/* ── THE SECOND FACTOR IS PART OF WHO YOU ARE, NOT PART OF THE LOGIN SCREEN ──
 *
 * admin.html does this properly on the surface: `checkMFAAndProceed()` reads the
 * assurance level, forces TOTP enrolment when there is no factor, challenges
 * when there is, and only then shows the panel. None of that reached here.
 *
 * `/auth/v1/user` answers for an aal1 token — email and password, no code — so
 * a session that never passed the challenge resolved to a full admin at every
 * endpoint below. The TOTP prompt was a gate on one HTML page that anybody
 * holding the password could walk around with `curl`.
 *
 * WHY THE CLAIM IS SAFE TO READ THIS WAY. The token's signature is verified by
 * the `/auth/v1/user` call above — if it were forged or expired that call fails
 * and we never get here. Decoding the payload of an already-verified token is
 * reading what the issuer said, not trusting the caller. It is the same token
 * Supabase itself just vouched for.
 *
 * FAIL CLOSED, AND WITH NO SWITCH. There is deliberately no environment
 * variable to turn this off. A store that could disable MFA enforcement is a
 * store where MFA enforcement is off, because that is the setting somebody
 * flips at 2am and never flips back — the same reasoning that keeps
 * REFUND_SECRET in Cloudflare rather than in the panel. Recovery from a lost
 * authenticator is a Supabase dashboard action by the owner, and it is written
 * down in RUNBOOKS.md.
 *
 * NOBODY IS LOCKED OUT BY THIS. Reaching the panel already requires clearing
 * the MFA step, and the one endpoint that runs BEFORE it — /api/admin-access,
 * which answers "are you an admin at all" — has its own auth path and does not
 * come through here. A first admin on a fresh store enrols through Supabase's
 * own API, which upgrades the session to aal2 before any endpoint is called.
 */
function jwtClaims(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) {
    return null;
  }
}

/* The assurance level of a token, or '' when it does not say. An absent claim
   is NOT treated as aal1-and-fine: it is treated as unknown, which fails the
   check below, because "the token did not say" and "the token said aal1" are
   the same amount of evidence that a second factor was used. */
export function assuranceOf(accessToken) {
  const token = String(accessToken || '').replace(/^Bearer\s+/i, '').trim();
  const claims = jwtClaims(token) || {};
  return String(claims.aal || '').toLowerCase();
}

export const MFA_REQUIRED_REASON =
  'This session has not completed two-factor verification. Sign out of the admin panel and sign in again with your authenticator code.';

export async function verifyAdmin(env, accessToken) {
  const user = await verifyUser(env, accessToken);
  if (!user?.id) return null;
  const rows = await supabaseSelect(env, `profiles?select=id,email,role,full_name,admin_role,admin_permissions&id=eq.${encodeURIComponent(user.id)}&limit=1`);
  const profile = rows?.[0] || null;
  if (!profile || profile.role !== 'admin') return null;
  /* Held here rather than at each of the 21 endpoints that resolve an admin,
     because a check that has to be remembered 21 times is a check that is
     missing from one of them. */
  const aal = assuranceOf(accessToken);
  if (aal !== 'aal2') {
    console.warn('admin auth: refused an', aal || 'unstated', 'assurance session for', profile.email);
    return null;
  }
  // admin_role may be null on stores that haven't run supabase-rbac.sql yet —
  // treat that as super_admin so RBAC rollout never locks the owner out.
  const adminRole = profile.admin_role || 'super_admin';
  // Effective flat permission list from role preset + per-user overrides.
  const permissions = resolvePerms({ admin_role: adminRole, admin_permissions: profile.admin_permissions });
  return { ...user, profile, admin_role: adminRole, permissions, aal };
}

// Like verifyAdmin, but also requires the person to hold `permission`
// (resolved from their role preset + per-user access overrides).
// Returns the admin object on success, or null if unauthenticated / not permitted.
/* ── ABAC: the layer that can only narrow ─────────────────────────────────────
 * RBAC answers "does this role grant the action". ABAC answers "and is it
 * allowed in THIS case" — a refund under $100, an order in your own region,
 * business hours. The engine has existed and been tested for a while; nothing
 * called it, so every rule a store could write was inert.
 *
 * It goes here, on the one gate every admin action already passes through,
 * because a second authorization path is a second place for a bypass. A store
 * with no rules behaves exactly as it does today: can() returns allow when the
 * list is empty, so adoption costs nothing and there is no branch to keep in
 * step.
 *
 * Direction is the whole design and is enforced by the engine, not here: ABAC
 * may only take permission away. It is handed the RBAC answer and cannot turn a
 * false into a true. See abac-layering-decision — a mode switch was rejected
 * because turning ABAC off would be a silent privilege ESCALATION, with
 * constraints like "refunds under $100" simply vanishing.
 *
 * Rules that cannot be read are treated as NO rules, deliberately. The
 * alternative — failing closed on an unreadable settings row — locks every
 * admin out of the whole panel over a transient read, and RBAC is still doing
 * its job underneath. Narrowing that silently stops narrowing is a real risk
 * and it is logged, not swallowed.
 */
async function abacRules(env) {
  try {
    const cfg = await getSetting(env, 'abac_rules', null);
    const list = Array.isArray(cfg) ? cfg : (cfg && Array.isArray(cfg.rules) ? cfg.rules : []);
    return list;
  } catch (e) {
    console.warn('abac: rules unreadable, proceeding on RBAC alone —', e && e.message);
    return [];
  }
}

/* Requests and approvals are ONE list, not two.
   A pending request and a granted approval are the same record at different
   points in its life, and splitting them means two places that can disagree
   about whether a thing was approved — with the authorization system reading
   one of them. `status` carries it: pending → approved | declined. */
export const ABAC_REQUESTS_KEY = 'abac_requests';

async function abacWaivers(env) {
  try {
    const cfg = await getSetting(env, ABAC_REQUESTS_KEY, null);
    return Array.isArray(cfg) ? cfg : [];
  } catch (e) {
    /* Unreadable means no waivers, which refuses rather than permits — the
       opposite default from the rules, and for the same reason. An
       unreadable RULE list must not silently stop constraining; an
       unreadable WAIVER list must not silently start permitting. */
    console.warn('abac: waivers unreadable, none applied —', e && e.message);
    return [];
  }
}

async function burnWaiver(env, id, byAdminId) {
  const at = new Date().toISOString();
  await mutateSetting(env, ABAC_REQUESTS_KEY, (cur) => {
    const list = Array.isArray(cur) ? cur : [];
    return list.map((w) => (w && String(w.id) === String(id) && !w.usedAt
      ? { ...w, usedAt: at, usedBy: String(byAdminId || '') }
      : w));
  });
}

/**
 * The full decision. `ctx` carries what the rules are written about: the action,
 * plus whatever the endpoint knows (amount, region, the resource being touched).
 * @returns  allow, reason, admin
 */
export async function decide(env, accessToken, permission, ctx = {}) {
  const admin = await verifyAdmin(env, accessToken);
  if (!admin) {
    /* Say which refusal it is. "Not signed in as an admin" to somebody who is
       plainly signed in as an admin reads as a bug and gets retried; the
       assurance level is the one refusal with an action attached to it. */
    const aal = assuranceOf(accessToken);
    return {
      allow: false,
      reason: (aal && aal !== 'aal2') ? MFA_REQUIRED_REASON : 'not signed in as an admin',
      admin: null,
    };
  }

  const rbacAllowed = permsHave(admin.permissions, permission);
  const rules = await abacRules(env);
  const waivers = await abacWaivers(env);
  const verdict = can(rbacAllowed, rules, {
    action: ctx.action || permission,
    ...ctx,
    /* The subject, so a rule can say "your own region" or "not your own
       order". Spread AFTER ctx so an endpoint cannot pass itself a different
       identity than the one that just authenticated. */
    subject: {
      id: admin.id,
      email: admin.email,
      role: admin.admin_role || admin.role,
    },
    /* Same reason, and it matters more here: an endpoint that could pass its
       own waiver list could waive anything. */
    waivers,
  });

  /* Spend it. A waiver good for one use has to be marked used before the
     action it permits, not after — a refund that fails partway would
     otherwise leave the waiver live for a second attempt, and "approved
     once" would quietly mean "approved until it works".
     A write failure denies. The alternative is an unburnable waiver, which
     is an approval that never runs out. */
  if (verdict.allow && verdict.usedWaiver) {
    try {
      await burnWaiver(env, verdict.usedWaiver, admin.id);
    } catch (e) {
      console.warn('abac: could not spend waiver —', e && e.message);
      return { allow: false, reason: 'Could not record the approval being used. Nothing was changed.',
               limited: true, admin: null };
    }
  }

  /* ── THE DECISION LOGS ITSELF ──────────────────────────────────────────────
     Not the interface. The 48 audit rows this codebase had were all written by
     admin-main.js, which means they described what the PANEL did — and the
     panel is not the only thing holding the token. A row written here is
     written whether the action was asked for by the admin page, by a script, or
     by somebody with a stolen session, because this is the gate all three come
     through.

     Awaited rather than fired and forgotten: a log entry that may or may not
     have been written before the response goes out is not evidence of
     anything. record() never throws, so a logging failure cannot turn into a
     failed refund — it comes back as false and is shouted into the tail. */
  const logged = await recordDecision(env, admin, permission, verdict, ctx.request || null);

  return {
    allow: verdict.allow,
    reason: verdict.reason,
    rule: verdict.rule,
    /* Only true when the ROLE allowed it and a limit did not. That is the
       refusal somebody can be asked to approve; "your role cannot do this" is
       not, and offering to ask about it wastes everyone's time. */
    limited: !!verdict.limited && rbacAllowed,
    ownerMayOverride: !!verdict.ownerMayOverride,
    admin: verdict.allow ? admin : null,
    logged,
  };
}

/**
 * A refusal that has to travel out of a function that is not the handler.
 *
 * Some limits can only be checked in the middle of the work. A shipping label's
 * price is not known until the carrier has quoted it, so "no label over $40"
 * has to be asked after the quote and before the purchase — inside the function
 * that buys, several frames below the one that can return a 403.
 *
 * Thrown rather than returned so the buy cannot continue by accident: a
 * `return` that a caller forgets to check reads as success, and here that means
 * the money is already spent. The handler recognises it by `limitVerdict` and
 * answers with the SAME shape every other limited endpoint uses — `rule` is
 * load-bearing, because the panel offers to request a waiver for exactly that
 * rule and a refusal that does not name one cannot be asked about.
 */
export function limitError(verdict) {
  const e = new Error((verdict && verdict.reason) || 'A limit on your account stopped this.');
  e.limitVerdict = verdict || {};
  return e;
}

/** The 403 body for one of the above. One shape, so two endpoints cannot drift. */
export function limitResponse(e, headers) {
  const v = (e && e.limitVerdict) || {};
  return json({
    error: e && e.message,
    limited: !!v.limited,
    rule: v.rule || '',
    ownerMayOverride: !!v.ownerMayOverride,
  }, 403, headers);
}

export async function verifyAdminCan(env, accessToken, permission, ctx = {}) {
  /* Every existing caller passes no ctx and keeps working: with no context and
     no rules, this is the RBAC check it always was. A caller that has something
     to say about the case — an amount, a region — passes it and the rules can
     act on it. */
  const { allow, admin } = await decide(env, accessToken, permission, ctx);
  return allow ? admin : null;
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
        // Expiry + usage limits are set in Admin → Coupons and are checked by
        // getPromotionForCode() / validate-promo. They MUST survive sanitising:
        // dropping them here silently disabled both limits, so a code with
        // "max uses 3" kept working forever.
        expirationDate: promo.expirationDate ? String(promo.expirationDate) : '',
        maxUsage: promo.maxUsage === undefined || promo.maxUsage === null || promo.maxUsage === '' ? null : Number(promo.maxUsage),
        usageCount: Number(promo.usageCount || 0),
        targetProductIds: Array.isArray(promo.targetProductIds) ? promo.targetProductIds.map(String).filter(Boolean) : [],
        targetCollectionIds: Array.isArray(promo.targetCollectionIds) ? promo.targetCollectionIds.map(String).filter(Boolean) : [],
      })),
    localDelivery: sanitizeLocalDelivery(config.localDelivery),
    // Which payment methods this store offers. Must survive sanitising for the
    // same reason maxUsage above had to: this function is the only thing
    // between the stored blob and everything that reads it, so a key it does
    // not list is a setting that saves, reloads as absent, and quietly reverts
    // to off. For PayPal that reads as "the button stopped appearing" with
    // nothing in the panel to explain it.
    payments: config.payments || {},
    integrations: config.integrations || {},
    shippingAutomation: config.shippingAutomation || {},
    customerExperience: config.customerExperience || {},
    /* Sanitised explicitly rather than passed through, for the reason spelled
       out above `payments`: a key this function does not list is a setting that
       saves, reloads as absent, and quietly reverts. For member pricing that
       would read as "I turned it off and it came back on by itself". */
    memberPricing: sanitizeMemberPricing(config.memberPricing),
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
/**
 * Does this store charge members a different price at all?
 *
 * ABSENT MEANS ON, and that direction is the whole safety of the switch. Every
 * store predates this setting, and several of them have member prices sitting
 * on products right now; reading a missing key as "off" would silently withdraw
 * a discount those shoppers are being shown. An unreadable settings row means
 * the same thing, for the same reason.
 *
 * The one rule that matters beyond that: the DISPLAY and the TILL must read
 * this from the same place. A switch that only reaches the storefront hides the
 * member price and still charges it; a switch that only reaches checkout shows
 * $25 and takes $40, which the never-bill-above-the-quote guard turns into a
 * refused sale. So membership itself is what this gates — one flag, consulted
 * where `isMember` is decided, in both paths.
 */
export function sanitizeMemberPricing(rawMemberPricing = {}) {
  const mp = rawMemberPricing && typeof rawMemberPricing === 'object' ? rawMemberPricing : {};
  return { enabled: mp.enabled !== false };
}

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
