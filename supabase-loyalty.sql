-- ============================================================================
-- Loyalty points — loyalty_ledger
-- Append-only ledger; a shopper's balance is sum(points). Positive rows are
-- earned (credited by stripe-webhook awardLoyaltyPoints on a signed-in order),
-- negative rows are redemptions (functions/api/loyalty.js).
--
-- Redeeming mints a SINGLE-USE coupon into commerce_config.promotions
-- (maxUsage: 1) so the discount rides the existing, server-recomputed promo
-- path — loyalty never touches pricing. NB: that single-use cap only actually
-- holds because sanitizeCommerceConfig now preserves maxUsage/usageCount.
--
-- Rules live in site_settings.loyalty_settings:
--   { enabled, pointsPerDollar, redeemPoints, redeemValue }
--
-- NOTE: applied live via the Supabase connector; this file is the record.
-- ============================================================================

create extension if not exists pgcrypto;

create table if not exists public.loyalty_ledger (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  points     int not null,                 -- positive = earned, negative = redeemed
  reason     text not null default 'purchase',
  order_id   text,
  promo_code text,                         -- set on redemption rows
  created_at timestamptz not null default now()
);

create index if not exists loyalty_ledger_user_idx
  on public.loyalty_ledger (user_id, created_at desc);

alter table public.loyalty_ledger enable row level security;

-- Shoppers read their own history (admins read all). Nobody writes through the
-- anon/authenticated keys: points are only granted by the webhook and spent via
-- the endpoint, both with the service role — so a shopper can't credit himself.
drop policy if exists "Loyalty read own" on public.loyalty_ledger;
create policy "Loyalty read own"
  on public.loyalty_ledger for select to authenticated
  using (auth.uid() = user_id or current_user_is_admin());

revoke insert, update, delete on public.loyalty_ledger from anon, authenticated;
