-- ============================================================================
-- 0024 — wholesale, as a customer group rather than a second store
--
-- Most apparel brands of any size sell DTC and wholesale from the same
-- catalogue. The usual implementation is a parallel storefront with its own
-- prices, its own accounts and its own checkout, and it is the wrong shape:
-- two systems that must agree about stock, about what a product is, and about
-- what it costs, forever.
--
-- ── WHY THIS IS SMALL ───────────────────────────────────────────────────────
--
-- 0022 already built the parts. `price_lists` carries `customer_group`, and
-- _price-resolution.js already refuses a list whose group the shopper is not
-- in. So a wholesale price list is a row in a table that exists, resolved by
-- code that exists, and the only thing missing was a way to be IN the group.
--
-- That is this migration. It adds the account, not the pricing.
--
--   • a buyer is APPROVED, by a human, and until then they are a retail
--     customer who happens to have applied
--   • an approved buyer is in the 'wholesale' group, so every list scoped to
--     that group becomes available to them and nothing else changes
--   • a minimum order and payment terms live with the account, because they
--     are per-buyer facts and not store policy
--
-- ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
--
-- No separate wholesale product table, no second checkout, no duplicate stock.
-- A wholesale order is an order. It is priced by the same resolver, it
-- decrements the same stock, and it appears in the same list — which is the
-- only way the two channels can ever agree about how many mediums are left.
--
-- ── THE SECURITY PART, WHICH IS THE WHOLE POINT ─────────────────────────────
--
-- `wholesale` is a PRICE. A customer who can write their own wholesale record
-- can set their own discount, and the existing "Users update own profile"
-- policy lets a signed-in person PATCH their own row from the browser. That is
-- exactly the hole migration 0010 closed for admin_role, and it is reopened by
-- any new column that decides money.
--
-- So the same guard, extended: a trigger refuses any change to this column
-- unless the writer is an admin. Not RLS alone — RLS decides which ROWS you
-- may touch, and the row in question is your own.
-- ============================================================================

alter table if exists public.profiles
  add column if not exists wholesale jsonb;

comment on column public.profiles.wholesale is
  'Wholesale account, or NULL for an ordinary customer. Shape: '
  '{ status: applied|approved|suspended, company, tax_id, approved_at, '
  'approved_by, min_order_cents, terms: prepaid|net15|net30|net60, notes }. '
  'Only status=approved puts the buyer in the ''wholesale'' customer group — '
  'see functions/api/_price-resolution.js. Writable by admins only, enforced '
  'by guard_wholesale_account() below, because this column decides price.';

-- ── Only an admin may grant, change or revoke a wholesale account ───────────
-- Mirrors guard_admin_privilege_columns() from 0010. A customer may still
-- update their own profile — name, colour, everything else — and simply
-- cannot move this one field.
create or replace function public.guard_wholesale_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.wholesale is distinct from old.wholesale then
    -- A server-side connection: the SQL editor, a migration, or a Worker using
    -- the service key. auth.uid() is null for all three, so every check below
    -- would refuse them — and until the admin screen exists those are the ONLY
    -- ways to grant an account. A guard that blocks the sole provisioning path
    -- is not a guard, it is an outage nobody can route around.
    -- Safe because none of these roles is ever reachable from a browser: the
    -- anon and authenticated roles are what a shopper's request arrives as, and
    -- neither is listed.
    if auth.uid() is null
       and current_user in ('postgres', 'service_role', 'supabase_admin')
    then
      return new;
    end if;

    if not public.current_user_is_super_admin()
       and not exists (
         select 1 from public.profiles p
          where p.id = auth.uid()
            and coalesce(p.admin_role, '') in ('super_admin', 'manager', 'finance')
       )
    then
      raise exception
        'wholesale accounts are granted by an administrator'
        using errcode = '42501';
    end if;
  end if;

  -- An INSERT carrying a wholesale account is the same grant by another route.
  if tg_op = 'INSERT' and new.wholesale is not null then
    if not public.current_user_is_super_admin()
       and not (auth.uid() is null and current_user in ('postgres', 'service_role', 'supabase_admin'))
    then
      new.wholesale := null;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists protect_wholesale_account on public.profiles;
create trigger protect_wholesale_account
  before insert or update on public.profiles
  for each row execute function public.guard_wholesale_account();

-- Approved buyers are looked up by status on nearly every price resolution.
create index if not exists profiles_wholesale_status_idx
  on public.profiles ((wholesale->>'status'))
  where wholesale is not null;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   -- Nobody is wholesale immediately after this runs:
--   select count(*) filter (where wholesale is not null) as accounts,
--          count(*)                                     as profiles
--     from profiles;
--
--   -- The guard is live (run as a non-admin; it must RAISE):
--   update profiles set wholesale = '{"status":"approved"}'::jsonb
--    where id = auth.uid();
--
--   -- Lists that will become available to an approved buyer:
--   select id, name, priority, active from price_lists
--    where customer_group = 'wholesale';
