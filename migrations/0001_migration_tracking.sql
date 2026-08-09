-- ============================================================================
-- 0001 — migration tracking
--
-- THE ONLY FILE A HUMAN EVER RUNS BY HAND. Paste it into the Supabase SQL
-- editor once, per project. Everything after this is applied from
-- Admin → APIs → Database migrations, which is the whole point: the failure
-- this system exists to prevent is not "the SQL was wrong", it is "nobody
-- remembered to run the SQL".
--
-- That is not hypothetical here. The live RLS policy had drifted from every
-- .sql file in the repository — 'fit_finder' and 'integrations' were read by
-- the storefront but absent from the policy, so Find Your Size silently used
-- built-in defaults and the integrations module loaded nothing. Both were
-- configured correctly in the admin and inert on the site, for weeks, with no
-- error anywhere. A migration file that never runs is worse than no file: it
-- makes the repository claim something about production that is not true.
--
-- Safe to run more than once.
-- ============================================================================

create table if not exists public.schema_migrations (
  version     text primary key,
  name        text not null,
  checksum    text not null,          -- detects a migration edited after it ran
  applied_at  timestamptz not null default now(),
  applied_by  text
);

comment on table public.schema_migrations is
  'Applied database migrations. Written by apply_migration(); see /api/migrate and migrations/.';

alter table public.schema_migrations enable row level security;

-- No policies: nobody reaches this through PostgREST as anon or as a logged-in
-- user. The migration endpoint uses the service-role key, which bypasses RLS,
-- and it is the only thing that should ever touch this table.
revoke all on public.schema_migrations from anon, authenticated;

-- ── the applier ─────────────────────────────────────────────────────────────
-- Runs one migration's SQL and records it, in a single transaction: if the SQL
-- raises, the row is not written and the migration stays pending, so a failed
-- run can be fixed and retried rather than leaving the tracking table lying.
--
-- SECURITY. This executes arbitrary SQL, so it is exactly as dangerous as the
-- credential that can call it. EXECUTE is revoked from anon and authenticated
-- and granted to nobody — only the service-role key can invoke it, and that key
-- can already do anything. It never leaves the server: it lives in Cloudflare's
-- environment and is used only by Pages Functions.
create or replace function public.apply_migration(
  p_version  text,
  p_name     text,
  p_sql      text,
  p_checksum text,
  p_actor    text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.schema_migrations where version = p_version) then
    return;                                    -- already applied; do nothing
  end if;

  execute p_sql;

  insert into public.schema_migrations (version, name, checksum, applied_by)
  values (p_version, p_name, p_checksum, p_actor);
end;
$$;

revoke all on function public.apply_migration(text, text, text, text, text) from public, anon, authenticated;

-- ── record this file itself ─────────────────────────────────────────────────
-- So the runner does not try to apply 0001 again through the very function
-- 0001 creates.
insert into public.schema_migrations (version, name, checksum, applied_by)
values ('0001', 'migration_tracking', 'bootstrap', 'sql-editor')
on conflict (version) do nothing;

-- ── baseline ────────────────────────────────────────────────────────────────
-- Every .sql file in the repository root predates this system and was applied
-- by hand in some order nobody recorded. They are marked applied so the runner
-- does not replay them against a live database — several are destructive.
--
-- This is an honest baseline, not a reconstruction: it says "the schema is
-- whatever it is today, and everything from here is tracked". Reconstructing
-- the real history from files that had already drifted from production would
-- be inventing a past that did not happen.
insert into public.schema_migrations (version, name, checksum, applied_by)
values ('0000', 'baseline_pre_migration_system', 'baseline', 'sql-editor')
on conflict (version) do nothing;
