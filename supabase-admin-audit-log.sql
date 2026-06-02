-- Zuwera admin audit log
-- Run this in Supabase SQL Editor. It creates an append-only log for admin changes.

create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  admin_user_id uuid references auth.users(id) on delete set null,
  admin_email text,
  action text not null,
  resource_type text not null,
  resource_id text,
  metadata jsonb not null default '{}'::jsonb,
  user_agent text
);

create index if not exists admin_audit_log_created_at_idx
  on public.admin_audit_log (created_at desc);

create index if not exists admin_audit_log_resource_idx
  on public.admin_audit_log (resource_type, resource_id);

alter table public.admin_audit_log enable row level security;

drop policy if exists "Admins can read audit log" on public.admin_audit_log;
create policy "Admins can read audit log"
on public.admin_audit_log
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);

drop policy if exists "Admins can insert audit log" on public.admin_audit_log;
create policy "Admins can insert audit log"
on public.admin_audit_log
for insert
to authenticated
with check (
  admin_user_id = auth.uid()
  and exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);

drop policy if exists "Audit log is append only" on public.admin_audit_log;
-- No update/delete policies are created on purpose.
-- Admins can add and read audit rows, but cannot edit or delete history from the browser.
