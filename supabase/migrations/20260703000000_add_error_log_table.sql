-- error_log: runtime client errors captured by error-reporter.js via /api/log-error.
-- Inserts happen ONLY through that Function using the service-role key (which
-- bypasses RLS). RLS is enabled with no policies, so anon/authenticated clients
-- cannot read or write it directly. Read it from the Supabase dashboard / SQL.

create table if not exists public.error_log (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  message     text,
  source      text,          -- 'error' | 'unhandledrejection'
  url         text,
  line        integer,
  col         integer,
  stack       text,
  user_agent  text,
  release     text,          -- deployment marker (meta[name=zuwera-deployment])
  extra       jsonb
);

create index if not exists error_log_created_at_idx on public.error_log (created_at desc);

alter table public.error_log enable row level security;
revoke all on public.error_log from anon, authenticated;

-- Optional housekeeping: keep 30 days. Run manually or schedule with pg_cron.
--   delete from public.error_log where created_at < now() - interval '30 days';
