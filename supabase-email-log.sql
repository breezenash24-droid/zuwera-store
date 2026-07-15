-- ============================================================================
-- Email activity log — email_log
-- Records every automated email the store sends (review requests, abandoned-cart
-- nudges, journal emails) so the admin can see what went out. Written by the
-- service-role senders; readable by admins (RLS). anon has no access.
--
-- Send timing (review-request delay in days, abandoned-cart delay in minutes) is
-- stored separately in site_settings.email_settings and edited in Admin → Emails.
--
-- NOTE: applied live via the Supabase connector; this file is the record.
-- ============================================================================

create table if not exists public.email_log (
  id         uuid primary key default gen_random_uuid(),
  type       text not null,                 -- review_request | abandoned_cart | journal | …
  recipient  text,
  subject    text,
  status     text not null default 'sent' check (status in ('sent','failed')),
  provider   text,                          -- resend | brevo | loops
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists email_log_created_idx on public.email_log (created_at desc);
create index if not exists email_log_type_idx    on public.email_log (type);

alter table public.email_log enable row level security;

drop policy if exists "Email log admin read" on public.email_log;
create policy "Email log admin read" on public.email_log
  for select to authenticated using (current_user_is_admin());

revoke all on public.email_log from anon;
