-- ============================================================================
-- 0029 — two controls stop being advisory
--
-- The audit finding was not "these features are missing". All three of the
-- things below EXISTED and reported a state they could not produce, which is
-- worse than not having them, because a switch that says it is on gets trusted
-- in exactly the moment it fails.
--
-- ── 1 · THE AUDIT LOG WAS WRITTEN BY THE BROWSER ────────────────────────────
--
-- supabase-admin-audit-log.sql grants INSERT to `authenticated` with
--
--     with check (admin_user_id = auth.uid() and <is an admin>)
--
-- which stops one admin signing a row as another and stops nothing else. Every
-- other column — the action, the resource, the metadata — was whatever the page
-- chose to send, all 48 call sites were in admin-main.js, and anything done
-- with the same token outside that page left no row at all. The log recorded
-- what the interface decided to record.
--
-- The rows are now written by /api/admin-audit and by decide(), both with the
-- service role, both taking the identity from a token the server verified. So
-- the client's INSERT permission is not merely unnecessary now, it is the hole:
-- while it exists, anybody holding an admin token can still write a row saying
-- whatever they like, or write none.
--
-- DEPLOY ORDER MATTERS HERE. Ship the code first, run this second. The other
-- way round leaves a window where the panel still inserts directly and is
-- refused — loudly now, since the silent latch is gone, but still a window of
-- lost history.
--
-- SELECT is untouched. Reading the log is a different question from writing it,
-- and the two were tangled once already: a failed READ used to switch WRITING
-- off for the rest of the session.
--
-- ── 2 · NINE PUBLIC ENDPOINTS HAD NO LIMIT OF ANY KIND ──────────────────────
--
-- validate-promo, subscribe, popup-claim, guest-return, referral,
-- notify-restock, translate, log-error, upload-review-photo and
-- create-payment-intent could each be called as fast as a socket allows. That
-- is promo-code enumeration, list bombing, storage and translation spend, and
-- an unmetered door for card testing.
--
-- _ratelimit.js checks an isolate-local counter first, which is free and
-- catches a loop from one address. This is the other half: a counter every colo
-- shares, so a spread-out or slow-drip abuser is held too.
--
-- WHY A FUNCTION AND NOT A TABLE WRITE. Read-then-write from the edge is a race
-- with itself under exactly the load a rate limiter exists for — two requests
-- read 9, both write 10, and a limit of 10 admits eleven. The counter has to be
-- incremented and read in one statement, which is what this is. Same reasoning
-- as redeem_loyalty and decrement_stock.
--
-- FAIL OPEN, LOUDLY. If this migration has not been run, _ratelimit.js allows
-- the request and marks itself degraded, and /api/health reports it. A limiter
-- that takes checkout down when a migration is late is worse than the abuse it
-- prevents — but a limiter that quietly stops limiting is the thing this whole
-- migration is about, so the degraded state is published rather than swallowed.
-- ============================================================================

-- ── 1 · the audit log is written by the server, or not at all ───────────────

drop policy if exists "Admins can insert audit log" on public.admin_audit_log;

revoke insert, update, delete on public.admin_audit_log from authenticated;
revoke insert, update, delete on public.admin_audit_log from anon;

-- No UPDATE or DELETE policy has ever existed here and none is added: history
-- that can be edited is not history. The service role bypasses RLS, which is
-- how the two server writers get in.

comment on table public.admin_audit_log is
  'Append-only admin history. Written ONLY by the service role via /api/admin-audit and decide() in _commerce.js. Clients may read (subject to RLS) and may not write.';

-- ── 2 · one atomic counter, shared by every edge location ───────────────────

create table if not exists public.rate_limit_counters (
  bucket text primary key,
  count integer not null default 0,
  window_start timestamptz not null default now()
);

create index if not exists rate_limit_counters_window_idx
  on public.rate_limit_counters (window_start);

alter table public.rate_limit_counters enable row level security;

-- Deliberately no policies. Nothing but the service role has any business
-- reading or writing this, and an absent policy denies rather than permits.
revoke all on public.rate_limit_counters from authenticated;
revoke all on public.rate_limit_counters from anon;

create or replace function public.zw_rate_limit(
  p_bucket text,
  p_max integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_now      timestamptz := now();
  v_window   interval    := make_interval(secs => greatest(1, p_window_seconds));
  v_count    integer;
  v_start    timestamptz;
begin
  insert into rate_limit_counters as r (bucket, count, window_start)
  values (p_bucket, 1, v_now)
  on conflict (bucket) do update
    set count = case when r.window_start < v_now - v_window then 1 else r.count + 1 end,
        window_start = case when r.window_start < v_now - v_window then v_now else r.window_start end
  returning r.count, r.window_start into v_count, v_start;

  -- Housekeeping, rarely and cheaply. A rate-limit row is worthless an hour
  -- after its window closed, and a table that only grows is a slow leak in a
  -- place nobody looks. Doing it on ~1 call in 1000 keeps it off the hot path
  -- and needs no scheduler, which this deployment does not have.
  if random() < 0.001 then
    delete from rate_limit_counters where window_start < v_now - interval '1 day';
  end if;

  return jsonb_build_object(
    'allowed', v_count <= greatest(1, p_max),
    'count', v_count,
    'retry_after', greatest(1, ceil(extract(epoch from ((v_start + v_window) - v_now)))::integer)
  );
end;
$$;

revoke all on function public.zw_rate_limit(text, integer, integer) from public;
revoke all on function public.zw_rate_limit(text, integer, integer) from anon;
revoke all on function public.zw_rate_limit(text, integer, integer) from authenticated;
grant execute on function public.zw_rate_limit(text, integer, integer) to service_role;

comment on function public.zw_rate_limit(text, integer, integer) is
  'Atomic fixed-window counter for _ratelimit.js. Returns {allowed, count, retry_after}. Service role only — a client that could call this could also reset its own bucket.';
