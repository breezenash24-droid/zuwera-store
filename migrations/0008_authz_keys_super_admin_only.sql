-- ============================================================================
-- 0008 — a limit an admin can delete is not a limit
--
-- Found by signing in as a Manager and editing the limits panel. It saved.
--
-- Every one of these lives in site_settings, and site_settings has a single
-- policy for admins:
--
--     CREATE POLICY "Admin full access" ON site_settings
--       FOR ALL USING (public.current_user_is_admin());
--
-- and current_user_is_admin() checks `role = 'admin'` and nothing else. Not
-- admin_role. So Manager, Finance, Fulfilment and Viewer all pass it, and the
-- browser writes these keys directly — there is no endpoint in between to
-- check anything.
--
-- Three escalations, and they compound:
--
--   abac_rules        The limits on what admins may do. A manager capped at
--                     $500 opens Users, sets it to $50,000 or deletes the rule,
--                     and refunds what they like. The cap is decoration.
--
--   refund_audit_log  Who refunded what. Writable by every admin, so the
--                     record naming a person can be edited by that person.
--                     Worse than the first: the first lets them act, this one
--                     lets them erase having acted, which is what makes the
--                     first one survivable when it is only the owner's word
--                     against the log.
--
--   refund_rate_limit Five wrong authorization codes locks refunds for an
--                     hour. The lockout counter is a row this same person can
--                     overwrite, so it stops being a lockout and becomes a
--                     speed bump — reset it and keep guessing, indefinitely.
--
-- The fix is a RESTRICTIVE policy, which ANDs with the permissive one rather
-- than replacing it. "Admin full access" keeps working for every other key;
-- these three additionally require a super admin.
--
-- WRITES ONLY. Reading stays open to any admin on purpose: a manager should be
-- able to see the limits that bind them and the refunds they made. Being told
-- why you were refused is not a privilege, and hiding it only produces someone
-- who asks for super admin so they can find out.
--
-- The Cloudflare Worker is unaffected. It writes with the service role key,
-- which bypasses RLS entirely — so the refund endpoint still appends to the
-- audit log and still trips the lockout counter.
-- ============================================================================

-- Distinct from current_user_is_admin(), which deliberately does not look at
-- admin_role. NULL means super admin because that is what the rest of the
-- system already assumes for a profile predating granular roles — see
-- `u.admin_role || 'super_admin'` in admin-main.js and resolvePerms() in
-- functions/api/_rbac.js. Reading it any other way here would lock the owner
-- out of their own store.
CREATE OR REPLACE FUNCTION public.current_user_is_super_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
      AND coalesce(admin_role, 'super_admin') = 'super_admin'
  );
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

-- One list, referenced three times. Adding a key here protects it against all
-- three write paths at once; protecting insert but not update would be an
-- upsert away from meaningless, and .upsert() is exactly what the panel calls.
CREATE OR REPLACE FUNCTION public.is_authz_settings_key(k TEXT)
RETURNS BOOLEAN AS $$
  SELECT k IN ('abac_rules', 'refund_audit_log', 'refund_rate_limit');
$$ LANGUAGE sql IMMUTABLE;

DROP POLICY IF EXISTS "Authz keys insert: super admin only" ON public.site_settings;
CREATE POLICY "Authz keys insert: super admin only"
  ON public.site_settings AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    NOT public.is_authz_settings_key(key) OR public.current_user_is_super_admin()
  );

-- Both halves. USING decides which existing rows may be targeted, WITH CHECK
-- decides what they may become; without the first, a manager could not create
-- the row but could overwrite one that exists, which is the case that matters.
DROP POLICY IF EXISTS "Authz keys update: super admin only" ON public.site_settings;
CREATE POLICY "Authz keys update: super admin only"
  ON public.site_settings AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (
    NOT public.is_authz_settings_key(key) OR public.current_user_is_super_admin()
  )
  WITH CHECK (
    NOT public.is_authz_settings_key(key) OR public.current_user_is_super_admin()
  );

-- Deleting the audit log is the same act as emptying it.
DROP POLICY IF EXISTS "Authz keys delete: super admin only" ON public.site_settings;
CREATE POLICY "Authz keys delete: super admin only"
  ON public.site_settings AS RESTRICTIVE FOR DELETE TO authenticated
  USING (
    NOT public.is_authz_settings_key(key) OR public.current_user_is_super_admin()
  );

-- ── How to check it worked ──────────────────────────────────────────────────
-- Signed in as a NON-super-admin, in the browser console on the admin page:
--
--   await sb.from('site_settings').upsert({ key: 'abac_rules', value: [] })
--
-- Before: { error: null }. After: a row-level security error. Then confirm a
-- normal setting still saves, so the restriction is on these keys and not on
-- being an admin:
--
--   await sb.from('site_settings').select('value').eq('key','abac_rules')
--
-- must still RETURN the rules — reading is deliberately left open.
