-- Zuwera admin RBAC (role-based access control)
-- Run this in the Supabase SQL Editor. Safe to re-run (idempotent, additive only).
--
-- Design: profiles.role stays coarse ('customer' | 'admin') so every existing
-- RLS policy that checks role='admin' keeps working untouched. We layer a
-- granular staff role on top via profiles.admin_role:
--   NULL         -> not staff (a normal customer)
--   super_admin  -> full access, incl. managing other admins' roles + API keys
--   manager      -> everything except role management + API keys
--   finance      -> dashboard, analytics, finance, receipts, tax, refunds
--   fulfillment  -> dashboard, receipts, shipping, returns, product read
--   content      -> products, appearance, settings, page builder, reviews, size charts
--   viewer       -> read-only across the panel
--
-- Least-privilege is enforced in the admin UI and in the sensitive serverless
-- endpoints (refunds, returns, user deletion, page-builder save, role changes).
-- RLS itself still trusts any role='admin' for reads/writes, because all staff
-- are trusted operators; the app layer is what segments what each role can DO.

alter table public.profiles
  add column if not exists admin_role text;

do $$ begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'profiles_admin_role_chk'
  ) then
    alter table public.profiles add constraint profiles_admin_role_chk
      check (admin_role is null or admin_role in
        ('super_admin','manager','finance','fulfillment','content','viewer'));
  end if;
end $$;

-- Existing panel admins become super_admins so nobody loses access on rollout.
update public.profiles
  set admin_role = 'super_admin'
  where role = 'admin' and admin_role is null;

comment on column public.profiles.admin_role is
  'Granular staff role for admin panel RBAC. NULL = not staff. One of: super_admin, manager, finance, fulfillment, content, viewer. profiles.role still gates panel access + RLS.';

-- Helper: is the current auth user a super_admin? (usable by future RLS if desired)
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.admin_role = 'super_admin'
  );
$$;
