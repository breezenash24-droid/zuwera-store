-- ============================================================================
-- 0010 — any admin could make themselves super admin
--
-- Found while working out whether the "changing a price" limit could ever
-- truly bind. It cannot, and neither can any of the others, because of this.
--
-- profiles carries:
--
--     CREATE POLICY "Admins manage profiles" ON profiles
--       FOR ALL TO authenticated USING (public.current_user_is_admin());
--
-- and current_user_is_admin() checks `role = 'admin'` and nothing else — not
-- admin_role. So a Manager, a Viewer, anyone with a seat in the panel, can run
-- this from a browser console:
--
--     await sb.from('profiles')
--       .update({ admin_role: 'super_admin' })
--       .eq('id', '<their own id>')
--
-- and it succeeds. There is no endpoint in the way; set-admin-role.js exists,
-- checks RBAC and the limits, and is simply not the only route.
--
-- WHY THIS OUTRANKS EVERYTHING ELSE BUILT THIS WEEK. Every limit is scoped by
-- role. Migration 0008 stops a manager editing the limits that bind them — but
-- it lets them promote themselves out of scope instead, and 0008's own gate is
-- current_user_is_super_admin(), which is a column this same person can write.
-- Refund caps, the approval queue, granting-roles limits: all of it is
-- decoration if the subject can choose their own subject.role.
--
-- THE EXISTING TRIGGER DOES NOT COVER THIS, and reads as though it might.
-- prevent_profile_role_self_change() fires only when NOT current_user_is_admin()
-- — so it guards customers and exempts every admin, which is backwards for
-- this purpose — and it watches `role`, never `admin_role`.
--
-- A trigger rather than a policy, because this is about which COLUMNS changed
-- and RLS cannot see that. It runs for the service role too, so it takes care
-- to let the server through: set-admin-role.js has already checked RBAC and
-- the limits by the time it writes, and it is the route this is pushing people
-- towards.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.guard_admin_privilege_columns()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.admin_role IS NOT DISTINCT FROM OLD.admin_role
     AND NEW.admin_permissions IS NOT DISTINCT FROM OLD.admin_permissions
     AND NEW.role IS NOT DISTINCT FROM OLD.role THEN
    RETURN NEW;                       -- nothing privilege-bearing changed
  END IF;

  -- Server-side writes. auth.uid() is NULL for the service role, which is how
  -- set-admin-role.js writes — and it has already checked RBAC and the limits.
  -- Without this the endpoint we want people using would be the one thing that
  -- stopped working.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT public.current_user_is_super_admin() THEN
    RAISE EXCEPTION 'Only a super admin can change roles or permissions (use the Users page)';
  END IF;

  -- Even a super admin, on their own row. Not because they lack the authority
  -- — they can grant it to somebody who grants it back — but because every
  -- self-promotion in the log should read as somebody else's decision. It also
  -- means one compromised session cannot quietly widen itself.
  IF auth.uid() = NEW.id THEN
    RAISE EXCEPTION 'You cannot change your own role or permissions';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS protect_admin_privilege_columns ON public.profiles;
CREATE TRIGGER protect_admin_privilege_columns
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_admin_privilege_columns();

-- current_user_is_super_admin() arrives in 0008. Defined again here so this
-- file can be run on its own — the two migrations are independent fixes and
-- neither should depend on the other having been applied first.
CREATE OR REPLACE FUNCTION public.current_user_is_super_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
      AND coalesce(admin_role, 'super_admin') = 'super_admin'
  );
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

-- ── How to check it worked ──────────────────────────────────────────────────
-- Signed in as a NON-super-admin, in the browser console on the admin page:
--
--   await sb.from('profiles').update({ admin_role: 'super_admin' })
--     .eq('id', (await sb.auth.getUser()).data.user.id)
--
-- Before: { error: null }, and you are now a super admin. After: an exception
-- saying only a super admin can change roles.
--
-- Then confirm the panel still works: as a super admin, Users → Manage access
-- on SOMEBODY ELSE must still save. That path goes through set-admin-role.js
-- with the service role and is deliberately still allowed.
--
-- Changing your OWN role now fails for everyone, by design. To change a super
-- admin's own role, have another super admin do it.
