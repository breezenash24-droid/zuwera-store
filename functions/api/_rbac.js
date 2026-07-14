// Zuwera RBAC — single source of truth for staff access.
//
// Two layers:
//   1. admin_role  — a PRESET (super_admin / manager / finance / fulfillment /
//                    content / viewer). One-click starting point.
//   2. admin_permissions.pages — an optional per-section override map, each set
//                    to 'none' | 'view' | 'edit'. When present it is authoritative;
//                    when absent we fall back to the preset for that role.
//
// Effective flat permissions (used by can()/gating) are derived by resolvePerms():
//   - a page id in the list  => the person may VIEW that page
//   - an action perm in the list (product_write, refund, …) => they may do it
// super_admin resolves to ['*'] (everything). role_manage is super_admin-only.
//
// admin.html mirrors this logic (search "ZW_RBAC") — KEEP THE TWO IN SYNC.
// Serverless endpoints call resolvePerms()/adminHas() so custom access is
// enforced in the backend for sensitive actions, not just hidden in the UI.

export const STAFF_ROLES = ['super_admin', 'manager', 'finance', 'fulfillment', 'content', 'viewer'];

export const ROLE_LABELS = {
  super_admin: 'Super Admin',
  manager: 'Manager',
  finance: 'Finance',
  fulfillment: 'Fulfillment',
  content: 'Content Editor',
  viewer: 'Viewer (read-only)'
};

// Every admin page id (matches ADMIN_PAGES in admin.html).
export const PAGE_IDS = [
  'dashboard', 'analytics', 'finance', 'products', 'legacy', 'sizecharts',
  'reviews', 'questions', 'journal', 'subscribers', 'commerce', 'meta', 'orders', 'receipts', 'shipping', 'returns', 'users',
  'website', 'settings', 'tax', 'apis', 'audit', 'flags'
];

// The action capability a page grants when set to 'edit'. Pages without an entry
// (dashboard, analytics, audit) are informational — 'edit' behaves like 'view'.
export const PAGE_WRITE_PERM = {
  products: 'product_write', legacy: 'product_write', sizecharts: 'product_write',
  reviews: 'review_write',
  questions: 'review_write',
  journal: 'builder_edit',
  subscribers: 'builder_edit',
  commerce: 'coupon_write',
  meta: 'settings_write',
  receipts: 'order_write', shipping: 'order_write',
  returns: 'return_process',
  finance: 'refund',
  website: 'builder_edit', settings: 'builder_edit',
  tax: 'tax_write',
  apis: 'apikey_manage',
  users: 'user_manage'
};

// Preset access maps (page -> level) for each role. super_admin is special (all).
const V = 'view', E = 'edit';
export const ROLE_PRESET_LEVELS = {
  manager: {
    dashboard: V, analytics: V, finance: E, products: E, legacy: E, sizecharts: E,
    reviews: E, questions: E, journal: E, subscribers: E, commerce: E, meta: E, orders: V, receipts: E, shipping: E, returns: E,
    users: E, website: E, settings: E, tax: E, audit: V, flags: E
  },
  finance: {
    dashboard: V, analytics: V, finance: E, orders: V, receipts: V, tax: E, audit: V
  },
  fulfillment: {
    dashboard: V, products: V, orders: V, receipts: E, shipping: E, returns: E
  },
  content: {
    dashboard: V, products: E, sizecharts: E, reviews: E, questions: E, journal: E, website: E, settings: E
  },
  viewer: Object.fromEntries(PAGE_IDS.map(p => [p, V]))
};

// The page->level map for a person: explicit override if set, else role preset.
export function levelMapFor(profile) {
  const override = profile && profile.admin_permissions && profile.admin_permissions.pages;
  if (override && typeof override === 'object') return override;
  const role = profile && profile.admin_role;
  if (role === 'super_admin') return Object.fromEntries(PAGE_IDS.map(p => [p, E]));
  return ROLE_PRESET_LEVELS[role] || {};
}

// Resolve a person's effective flat permission list from role + overrides.
export function resolvePerms(profile) {
  const role = profile && profile.admin_role;
  if (role === 'super_admin') return ['*'];

  const levels = levelMapFor(profile);
  const perms = new Set();
  let anyView = false;
  for (const page of PAGE_IDS) {
    const lvl = levels[page] || 'none';
    if (lvl === 'view' || lvl === 'edit') { perms.add(page); anyView = true; }
    if (lvl === 'edit' && PAGE_WRITE_PERM[page]) perms.add(PAGE_WRITE_PERM[page]);
  }
  if (anyView) perms.add('export');
  // bulk_actions follows write access to catalog or orders.
  if (perms.has('product_write') || perms.has('order_write')) perms.add('bulk_actions');
  // role_manage is deliberately never granted here — super_admin only.
  return [...perms];
}

// Does a resolved permission list include `permission`?
export function permsHave(perms, permission) {
  if (!Array.isArray(perms)) return false;
  if (perms.includes('*')) return true;
  return perms.includes(permission);
}

// Convenience for endpoints holding a full admin object (with .permissions).
export function adminHas(admin, permission) {
  return permsHave(admin && admin.permissions, permission);
}

// ── Back-compat shims ────────────────────────────────────────────────────────
// Older call sites used ROLE_PERMISSIONS[role] / roleCan(role, perm). Keep them
// working by resolving from the role preset (no per-user override available).
export const ROLE_PERMISSIONS = new Proxy({}, {
  get(_t, role) {
    if (role === 'super_admin') return ['*'];
    return resolvePerms({ admin_role: role });
  }
});

export function roleCan(adminRole, permission) {
  if (adminRole === 'super_admin') return true;
  return permsHave(resolvePerms({ admin_role: adminRole }), permission);
}
