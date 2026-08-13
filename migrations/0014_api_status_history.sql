-- ============================================================================
-- 0014 — the API panel gets a memory
--
-- Every check the status page runs is thrown away the moment you navigate off.
-- Nothing calls /api/status but the admin page itself, so a key that dies at
-- 4am is invisible until somebody happens to open the tab, and "is this
-- healthy?" can only ever be answered about this exact second.
--
-- That is the difference between a status page and an operations tool, and it
-- is one table. With samples on disk the panel can say "Resend has been failing
-- since 04:12" instead of "Resend is failing", which is the first version
-- anybody can act on.
--
-- ALSO DEFINES webhook_events, which no .sql file in this repository creates.
--
-- It DOES exist in production and has been collecting rows — checked directly,
-- 65 of them. It was created outside the repo at some point, which is exactly
-- the drift migration 0001 was written to stop: a table the code depends on,
-- present on one database and defined nowhere, so a second deployment gets a
-- store whose webhook log silently 404s into logWebhookEvent's catch. That
-- helper swallows its own failures on purpose — a logging problem must never
-- fail a paid order — so nothing would ever say the log was missing.
--
-- `create table if not exists` therefore does nothing here and everything on a
-- fresh project. The columns match what logWebhookEvent() actually sends.
-- ============================================================================

-- ── What each check saw, when ───────────────────────────────────────────────
create table if not exists public.api_status_log (
  id          bigserial primary key,
  service     text        not null,
  ok          boolean     not null,
  configured  boolean,
  -- The vendor's own words on a failure. Truncated on write: this is for
  -- recognising a repeat, not for storing a stack trace.
  detail      text,
  checked_at  timestamptz not null default now()
);

comment on table public.api_status_log is
  'One row per service per status check. Read back to show how long a service '
  'has been in its current state. Pruned to 30 days by record_api_status().';

-- Reading is always "this service, most recent first".
create index if not exists api_status_log_service_time_idx
  on public.api_status_log (service, checked_at desc);
-- Pruning is always "everything older than X", and wants its own index or the
-- delete degrades into a sequential scan as the table grows.
create index if not exists api_status_log_time_idx
  on public.api_status_log (checked_at);

-- ── The table stripe-webhook.js has been writing to all along ───────────────
-- Columns match what logWebhookEvent() actually sends, so existing writes start
-- landing the moment this runs. Everything is nullable: this is a diagnostic
-- log, and a partial row is worth more than a rejected one.
-- Shape taken from the live database rather than invented: `id uuid` and
-- `received_at` (NOT created_at, which is the name every other log table here
-- uses and the one this was first written against). A fresh project must get
-- the same columns production has, or code that reads one works on exactly one
-- of the two databases.
create table if not exists public.webhook_events (
  id             uuid primary key default gen_random_uuid(),
  received_at    timestamptz not null default now(),
  event_type     text,
  payment_intent text,
  customer_email text,
  amount_cents   integer,
  sig_verified   boolean,
  error_message  text,
  raw_status     text           -- received | handler_error | payment_failed
);

comment on table public.webhook_events is
  'One row per Stripe webhook delivery. Answers "is Stripe reaching us and is '
  'the signature passing" without opening the Stripe dashboard. Written by '
  'logWebhookEvent() in stripe-webhook.js, which swallows its failures — so on '
  'a database where this table is absent the writes vanish with no error.';

create index if not exists webhook_events_received_idx on public.webhook_events (received_at desc);
create index if not exists webhook_events_pi_idx      on public.webhook_events (payment_intent);

-- ── Recording a run ─────────────────────────────────────────────────────────
-- One call per status check rather than one per service: thirteen round trips
-- from a Worker to record thirteen booleans is most of the cost of the checks
-- themselves.
create or replace function public.record_api_status(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return 0;
  end if;

  insert into api_status_log (service, ok, configured, detail)
  select
    left(r->>'service', 64),
    coalesce((r->>'ok')::boolean, false),
    (r->>'configured')::boolean,
    left(r->>'detail', 500)          -- recognising a repeat, not storing a trace
  from jsonb_array_elements(p_rows) as r
  where coalesce(r->>'service', '') <> '';

  get diagnostics v_count = row_count;

  /* Kept to 30 days, here rather than in a scheduled job, because a job nobody
     runs is how this table becomes the biggest thing in the database. Only
     fires occasionally — a delete on every write is pure overhead once the old
     rows are already gone. */
  if random() < 0.02 then
    delete from api_status_log where checked_at < now() - interval '30 days';
  end if;

  return v_count;
end;
$function$;

comment on function public.record_api_status(jsonb) is
  'Record one status-check run. SECURITY DEFINER so the status endpoint can '
  'write with the service key without granting broad insert rights; it takes '
  'no user input beyond the checks it just ran itself.';

revoke all on function public.record_api_status(jsonb) from public, anon;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   select record_api_status('[{"service":"resend","ok":true}]'::jsonb);
--   select service, ok, checked_at from api_status_log order by checked_at desc limit 5;
--   -- and, once an order comes through, the log that was never landing:
--   select event_type, raw_status, received_at from webhook_events order by received_at desc limit 5;
