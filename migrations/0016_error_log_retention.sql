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

-- ── The index FIRST ─────────────────────────────────────────────────────────
-- The first version of this migration deleted the backlog before creating the
-- index and used `id not in (select … from error_log …)`, which is a sequential
-- scan per row across 28,000 rows. It hit the statement timeout (57014) and
-- applied nothing. Order matters: index, then delete, and delete in a shape
-- that can use it.
create index if not exists error_log_source_time_idx
  on public.error_log (source, created_at desc);

-- ── Keep it bounded ─────────────────────────────────────────────────────────
-- BATCHED, and that is the whole reason this survives. An unbounded delete of
-- 28,000 rows is one long statement that either finishes or is cancelled with
-- nothing to show for it. A bounded one always finishes, and the backlog drains
-- over successive calls — which is fine, because it is called from the write
-- path and there is no deadline.
create or replace function public.prune_error_log(p_batch integer default 2000)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_total integer := 0;
  v_n     integer := 0;
  v_batch integer := greatest(1, least(coalesce(p_batch, 2000), 20000));
begin
  /* A CSP report matters while the violation is live. One that stopped two
     weeks ago is either fixed or nobody cares — and if it is still happening, a
     fresh row is being written right now. */
  delete from error_log
  where ctid in (
    select ctid from error_log
    where source = 'csp' and created_at < now() - interval '14 days'
    limit v_batch
  );
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  /* Real errors get a quarter. Long enough to see a pattern, short enough that
     this table cannot become the biggest thing in a 500 MB database. */
  delete from error_log
  where ctid in (
    select ctid from error_log
    where source <> 'csp' and created_at < now() - interval '90 days'
    limit v_batch
  );
  get diagnostics v_n = row_count;
  return v_total + v_n;
end;
$function$;

-- ── Clear the backlog, in bounded passes ────────────────────────────────────
-- GROUPED ON THE MESSAGE WITHOUT ITS QUERY STRING, which is the whole point.
-- Grouping on the raw message only removes 10,575 of 27,993 rows, because the
-- duplication is INSIDE the message: GA4 posts to
-- /g/collect?v=2&tid=…&gtm=45je6852v9245643753za200… and that gtm token changes
-- on every pageview, so nearly every row is technically distinct. Strip the
-- query and 27,993 rows become 76 actual problems.
--
-- That is the same normalising csp-report.js now applies to new rows, so the
-- history ends up in the same shape as everything written from here.
do $backlog$
declare
  v_n integer;
  v_guard integer := 0;
begin
  loop
    delete from public.error_log
    where ctid in (
      select e.ctid
      from public.error_log e
      join (
        select split_part(message, '?', 1) as k, max(created_at) as keep_at
        from public.error_log
        where source = 'csp'
        group by split_part(message, '?', 1)
      ) g on g.k = split_part(e.message, '?', 1) and e.created_at < g.keep_at
      where e.source = 'csp'
      limit 3000
    );
    get diagnostics v_n = row_count;
    exit when v_n = 0;
    v_guard := v_guard + 1;
    /* Whatever is left drains through prune_error_log() from the write path.
       Better to apply cleanly and finish over the next hour than to be
       cancelled again and apply nothing at all — which is what happened the
       first time this ran. */
    exit when v_guard > 15;
  end loop;

  /* The survivors keep their query strings, which would make them look unlike
     everything written from now on and re-split on the next pass. Normalise
     them once — there are only tens of rows left by this point. */
  update public.error_log
  set message = split_part(message, '?', 1)
  where source = 'csp' and message like '%?%';
end
$backlog$;

comment on function public.prune_error_log(integer) is
  'Retention for error_log: CSP reports 14 days, real errors 90. Called from '
  'log-error.js on a small fraction of writes so it needs no scheduler — a '
  'cleanup job nobody runs is how this table reached 28,000 rows.';

revoke all on function public.prune_error_log(integer) from public, anon;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   select source, count(*) from error_log group by source;
--   -- csp should now be tens of rows, not tens of thousands.
--   select message, count(*) from error_log where source='csp'
--    group by message order by count(*) desc limit 10;
--   -- and anything still climbing here is a live violation worth fixing.
