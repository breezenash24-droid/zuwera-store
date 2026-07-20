-- ============================================================================
-- Newsletter subscribers — newsletter_subscribers
-- Captures footer "Stay in the loop" signups. Written only by the service-role
-- endpoints (functions/api/subscribe.js, unsubscribe.js, send-journal.js,
-- newsletter-admin.js). Admins can read/manage directly via RLS.
--
-- NOTE: already created live via the Supabase connector; this file is the
-- source-of-truth record so the schema is in git and re-runnable.
-- ============================================================================

create extension if not exists pgcrypto;

create table if not exists public.newsletter_subscribers (
  id              uuid primary key default gen_random_uuid(),
  email           text not null,
  status          text not null default 'subscribed' check (status in ('subscribed','unsubscribed')),
  source          text,
  unsub_token     text not null default encode(gen_random_bytes(16), 'hex'),
  created_at      timestamptz not null default now(),
  unsubscribed_at timestamptz
);

-- Case-insensitive uniqueness on email (dedupe signups).
create unique index if not exists newsletter_subscribers_email_key
  on public.newsletter_subscribers (lower(email));

alter table public.newsletter_subscribers enable row level security;

-- Admins (authenticated) can read/manage; everyone else goes through the
-- service-role endpoints. anon has no direct access.
drop policy if exists "Newsletter admin full access" on public.newsletter_subscribers;
create policy "Newsletter admin full access"
  on public.newsletter_subscribers for all
  to authenticated
  using (current_user_is_admin()) with check (current_user_is_admin());

revoke all on public.newsletter_subscribers from anon;
