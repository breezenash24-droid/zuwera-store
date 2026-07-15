-- ============================================================================
-- Refer a friend — referral_codes
-- One code per shopper. The friend types it in the normal promo box; when their
-- order lands, stripe-webhook (creditReferrer) pays the referrer in loyalty
-- points. See supabase-loyalty.sql for the ledger.
--
-- Nothing here touches pricing: the friend's discount is an ordinary promo in
-- commerce_config.promotions, minted lazily by functions/api/referral.js the
-- first time a shopper opens Refer a Friend (so the promo list only grows for
-- people who actually share). Each referral promo carries a maxUsage cap so a
-- code can't be farmed forever — that cap is only real because
-- sanitizeCommerceConfig now preserves maxUsage/usageCount (see #145).
--
-- Rules live in site_settings.referral_settings:
--   { enabled, friendType('percent'|'fixed'), friendValue, friendMinSubtotal,
--     maxUsesPerCode, referrerPoints }
--
-- NOTE: applied live via the Supabase connector; this file is the record.
-- ============================================================================

create extension if not exists pgcrypto;

create table if not exists public.referral_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null unique references auth.users(id) on delete cascade,
  code       text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists referral_codes_code_idx on public.referral_codes (upper(code));

alter table public.referral_codes enable row level security;

-- A shopper sees their own code (admins see all). Codes are only ever created by
-- the endpoint with the service role, so nobody can mint or claim one directly.
drop policy if exists "Referral read own" on public.referral_codes;
create policy "Referral read own"
  on public.referral_codes for select to authenticated
  using (auth.uid() = user_id or current_user_is_admin());

revoke insert, update, delete on public.referral_codes from anon, authenticated;
