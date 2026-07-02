-- Zuwera profiles RLS hardening — RUN AFTER supabase-rbac.sql
-- Closes a privilege-escalation hole: the existing "Users update own profile"
-- policy (auth.uid() = id) let ANY signed-in user PATCH their own row from the
-- browser, including role / admin_role — i.e. self-promote to admin/super_admin.
--
-- Fix: users may still edit their own profile (name, preferences, etc.) but can
-- NOT change their own role or admin_role. Admins keep full control via the
-- "Admins manage profiles" policy, and /api/set-admin-role uses the service key
-- (bypasses RLS) so role assignment still works.

drop policy if exists "Users update own profile" on public.profiles;

create policy "Users update own profile"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (
  auth.uid() = id
  -- role / admin_role / admin_permissions must match the CURRENT committed values
  -- (MVCC snapshot), so a self-update that tries to change any of them is rejected.
  -- admin_permissions holds page grants; users must not self-escalate. Color
  -- changes go through /api/set-my-color (service key), not direct writes.
  and role = (select p.role from public.profiles p where p.id = auth.uid())
  and admin_role is not distinct from (select p.admin_role from public.profiles p where p.id = auth.uid())
  and admin_permissions is not distinct from (select p.admin_permissions from public.profiles p where p.id = auth.uid())
);

-- CRITICAL: the old broad policies let ANY role='admin' account (including a
-- viewer) UPDATE ANY profile — so a restricted staffer could self-promote by
-- editing their own role/admin_role/admin_permissions, bypassing the guard above
-- (RLS policies are OR'd). Scope profile management to super_admins only.
-- Admins keep READ access via "Admins read profiles". Name edits for other users
-- go through /api/set-user-name (service key). Role changes go through
-- /api/set-admin-role (service key). Both bypass RLS and keep working.
drop policy if exists "Admins manage profiles" on public.profiles;
drop policy if exists "Admin update profiles" on public.profiles;

create policy "Super admins manage profiles"
on public.profiles
for all
to authenticated
using (public.is_super_admin())
with check (public.is_super_admin());
