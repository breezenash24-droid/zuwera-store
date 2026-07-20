-- ============================================================================
-- Journal / Lookbook  —  journal_posts
-- Blog-style content shown at /journal (public reads only 'published' rows).
-- Admin CRUD goes through functions/api/journal-admin.js with the service-role
-- key after verifyAdmin, so no anon write policy is needed.
--
-- NOTE: this table was already created live on the project via the Supabase
-- connector. This file is the source-of-truth record so the schema is in git
-- and re-runnable on a fresh environment.
-- ============================================================================

create extension if not exists "pgcrypto";

create table if not exists public.journal_posts (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  slug         text not null unique,
  excerpt      text,
  body         text,
  cover_image  text,
  status       text not null default 'draft' check (status in ('draft','published')),
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Fast lookups for the public list (published, newest first) and by slug.
create index if not exists journal_posts_status_pub_idx
  on public.journal_posts (status, published_at desc nulls last);
create index if not exists journal_posts_slug_idx
  on public.journal_posts (slug);

-- Row Level Security: anyone may read PUBLISHED posts; nobody may write via the
-- anon/authenticated keys (writes happen server-side with the service role,
-- which bypasses RLS).
alter table public.journal_posts enable row level security;

drop policy if exists "Journal: public reads published" on public.journal_posts;
create policy "Journal: public reads published"
  on public.journal_posts
  for select
  to anon, authenticated
  using (status = 'published');

-- Defense in depth: strip the default write grants so the ONLY path to write is
-- the service role (admin endpoint). RLS already blocks anon writes, but this
-- means a future stray policy can't accidentally open them up.
revoke insert, update, delete on public.journal_posts from anon, authenticated;
