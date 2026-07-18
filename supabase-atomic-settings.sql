-- ─────────────────────────────────────────────────────────────────────────────
-- Atomic settings writes + atomic loyalty redemption
-- ─────────────────────────────────────────────────────────────────────────────
-- Fixes two concurrency bugs found in the commerce audit:
--
--   A) Lost updates on single-row site_settings JSON blobs. Many endpoints do a
--      read-modify-write on one big value (commerce_customer_profiles,
--      commerce_returns, commerce_order_ops, commerce_config.promotions). Two
--      concurrent writers both read the same value and the second overwrites the
--      first — silently dropping a saved profile, a submitted return request, or a
--      freshly-minted promo code. The `rev` column below powers an optimistic
--      compare-and-swap (see mutateSetting() in functions/api/_commerce.js): a
--      write only lands while `rev` is unchanged, otherwise the app re-reads and
--      re-applies. Nothing else has to change — mutateSetting falls back to a plain
--      upsert until this column exists, so the app keeps working before and after.
--
--   B) Loyalty redeem double-spend. The endpoint summed the ledger for the balance,
--      checked it, then inserted the spend in a separate step. Concurrent redeem
--      calls all passed the check and each minted a reward code (balance went
--      negative). redeem_loyalty() below does the balance-check and the spend insert
--      atomically under a per-user advisory lock, so a shopper can only ever spend
--      what they actually have.
--
-- Safe to run multiple times.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── A) optimistic-concurrency version column on site_settings ────────────────
alter table public.site_settings
  add column if not exists rev bigint not null default 0;

-- ── B) atomic loyalty redemption ─────────────────────────────────────────────
-- Returns the new spend row's id + the resulting balance. Raises:
--   'invalid_points'        when p_points is not a positive integer
--   'insufficient_balance'  when the shopper doesn't have enough points
create or replace function public.redeem_loyalty(p_user_id uuid, p_points int)
returns table (spend_id uuid, new_balance int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance int;
  v_id uuid;
begin
  if p_points is null or p_points <= 0 then
    raise exception 'invalid_points';
  end if;

  -- Serialize concurrent redemptions for this shopper so the balance check and
  -- the spend insert are one atomic step. The lock is released at commit.
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select coalesce(sum(points), 0) into v_balance
  from public.loyalty_ledger
  where user_id = p_user_id;

  if v_balance < p_points then
    raise exception 'insufficient_balance';
  end if;

  insert into public.loyalty_ledger (user_id, points, reason)
  values (p_user_id, -p_points, 'redeem')
  returning id into v_id;

  return query select v_id, (v_balance - p_points);
end;
$$;

-- Only the redemption endpoint (service role) may call this — never a shopper's
-- own anon/authenticated token, which would let them pass an arbitrary user id.
revoke all on function public.redeem_loyalty(uuid, int) from public, anon, authenticated;
grant execute on function public.redeem_loyalty(uuid, int) to service_role;
