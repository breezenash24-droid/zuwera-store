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
-- ALSO CREATES webhook_events, WHICH NOTHING EVER CREATED. stripe-webhook.js
-- has been writing a row per delivery since it was written — event type,
-- payment intent, signature verified, handler errors — through a helper that
-- swallows its own failures because a logging problem must never fail a paid
-- order. No .sql file in this repository has ever created that table. So every
-- one of those writes has been 404ing into the catch, and the log built
-- specifically to answer "is Stripe reaching us and is the signature passing"
-- has been empty the entire time. That question came up repeatedly while
-- chasing the missing confirmation emails, and this is why it could not be
-- answered from the data.
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
create table if not exists public.webhook_events (
  id             bigserial primary key,
  event_type     text,
  payment_intent text,
  customer_email text,
  amount_cents   integer,
  sig_verified   boolean,
  raw_status     text,          -- received | handler_error | payment_failed
  error_message  text,
  created_at     timestamptz not null default now()
);

comment on table public.webhook_events is
  'One row per Stripe webhook delivery. Answers "is Stripe reaching us and is '
  'the signature passing" without opening the Stripe dashboard. Written by '
  'logWebhookEvent() in stripe-webhook.js, which swallows failures — so if this '
  'table is missing, the writes disappear silently. It was, and they did.';

create index if not exists webhook_events_created_idx on public.webhook_events (created_at desc);
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
--   select event_type, raw_status, created_at from webhook_events order by created_at desc limit 5;
