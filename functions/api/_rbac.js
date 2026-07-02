// Zuwera RBAC — single source of truth for staff roles → permissions.
//
// Used by the serverless endpoints (admin-refund, admin-returns, user delete,
// save-page-builder, set-admin-role) to enforce least privilege server-side.
// admin.html mirrors ROLE_PERMISSIONS for UI gating — KEEP THE TWO IN SYNC.
// (Search "ZW_RBAC" in admin.html for the mirror.)
//
// Permission keys are either a page id (view access) or an action capability.
// super_admin implicitly has every permission ('*').

export const STAFF_ROLES = ['super_admin', 'manager', 'finance', 'fulfillment', 'content', 'viewer'];

export const ROLE_LABELS = {
  super_admin: 'Super Admin',
  manager: 'Manager',
  finance: 'Finance',
  fulfillment: 'Fulfillment',
  content: 'Content Editor',
  viewer: 'Viewer (read-only)'
};

// Every permission a non-super role can be granted. Page ids match ADMIN_PAGES.
export const ROLE_PERMISSIONS = {
  super_admin: ['*'],

  manager: [
    // pages
    'dashboard', 'analytics', 'finance', 'products', 'legacy', 'sizecharts',
    'reviews', 'commerce', 'meta', 'receipts', 'shipping', 'returns', 'users',
    'website', 'settings', 'tax', 'audit',
    // actions (no apis page, no role/apikey management)
    'refund', 'return_process', 'product_write', 'order_write',
    'user_manage', 'builder_edit', 'bulk_actions', 'export'
  ],

  finance: [
    'dashboard', 'analytics', 'finance', 'receipts', 'tax', 'audit',
    'refund', 'export'
  ],

  fulfillment: [
    'dashboard', 'products', 'receipts', 'shipping', 'returns',
    'order_write', 'return_process', 'product_write', 'bulk_actions', 'export'
  ],

  content: [
    'dashboard', 'products', 'sizecharts', 'reviews', 'website', 'settings',
    'product_write', 'builder_edit', 'export'
  ],

  viewer: [
    'dashboard', 'analytics', 'finance', 'products', 'legacy', 'sizecharts',
    'reviews', 'commerce', 'meta', 'receipts', 'shipping', 'returns', 'users',
    'website', 'settings', 'tax', 'audit',
    'export'
  ]
};

// Does a staff role have a given permission?
export function roleCan(adminRole, permission) {
  if (!adminRole) return false;
  const perms = ROLE_PERMISSIONS[adminRole];
  if (!perms) return false;
  if (perms.includes('*')) return true;
  return perms.includes(permission);
}
