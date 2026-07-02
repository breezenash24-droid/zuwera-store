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
  -- role / admin_role must match the CURRENT committed values (MVCC snapshot),
  -- so a self-update that tries to change either is rejected.
  and role = (select p.role from public.profiles p where p.id = auth.uid())
  and admin_role is not distinct from (select p.admin_role from public.profiles p where p.id = auth.uid())
);
