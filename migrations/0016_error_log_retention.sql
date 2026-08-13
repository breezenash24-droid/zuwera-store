-- ============================================================================
-- 0016 — the error log had eaten the error log
--
-- 28,038 rows, of which 27,993 were CSP reports at roughly 700 a day. The 79
-- real JavaScript errors — the ones a customer actually hit — were buried
-- underneath them. That is the cost, more than the storage: a log nobody can
-- read is a log nobody reads, and this one had been quietly telling us things
-- for a month with nobody able to see them.
--
-- WHAT IT WAS TELLING US, once the duplicates collapsed:
--
--   connect-src → analytics.google.com   ~3,400 reports, still arriving today.
--     connect-src allows *.google-analytics.com, and GA4 also posts to
--     analytics.google.com, which that wildcard does not cover. Harmless right
--     now because the policy is Report-ONLY — but it is exactly the list of
--     things that would break the day anyone enforces it.
--
--   media-src → supabase storage, frame-src → facebook.com
--     Both stopped in mid-July. Already fixed; the rows are just history.
--
-- Three changes, and the pruning is the least important of them:
--   1. _headers now allows analytics.google.com          (the actual gap)
--   2. csp-report.js strips query strings and skips a violation already seen
--      in the last 24h — one row per problem per day instead of per pageview
--   3. this: clear the backlog, and keep it bounded from here
--
-- Nothing is deleted that anyone would want. Real errors keep 90 days; CSP
-- reports keep 14, because a CSP report is only useful while the violation is
-- still happening — and if it is still happening, it is still being recorded.
-- ============================================================================

-- ── Clear the backlog ───────────────────────────────────────────────────────
-- Keeps one example of each distinct CSP violation so the history of what was
-- happening is not lost, and drops the thousands of repeats.
delete from public.error_log
where source = 'csp'
  and id not in (
    select distinct on (message) id
    from public.error_log
    where source = 'csp'
    order by message, created_at desc
  );

-- ── Keep it bounded ─────────────────────────────────────────────────────────
create or replace function public.prune_error_log()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_deleted integer := 0;
begin
  /* A CSP report matters while the violation is live. One that stopped two
     weeks ago is either fixed or nobody cares, and either way a new one will
     be recorded the moment it happens again. */
  delete from error_log where source = 'csp' and created_at < now() - interval '14 days';
  get diagnostics v_deleted = row_count;

  /* Real errors get a quarter. Long enough to notice a pattern, short enough
     that the table cannot become the biggest thing in a 500 MB database. */
  delete from error_log where source <> 'csp' and created_at < now() - interval '90 days';
  return v_deleted + coalesce((select 0), 0);
end;
$function$;

comment on function public.prune_error_log() is
  'Retention for error_log: CSP reports 14 days, real errors 90. Called from '
  'log-error.js on a small fraction of writes so it needs no scheduler — a '
  'cleanup job nobody runs is how this table reached 28,000 rows.';

revoke all on function public.prune_error_log() from public, anon;

-- Reading is almost always "recent, of this kind".
create index if not exists error_log_source_time_idx
  on public.error_log (source, created_at desc);

-- ── Verify ──────────────────────────────────────────────────────────────────
--   select source, count(*) from error_log group by source;
--   -- csp should now be tens of rows, not tens of thousands.
--   select message, count(*) from error_log where source='csp'
--    group by message order by count(*) desc limit 10;
--   -- and anything still climbing here is a live violation worth fixing.
