-- 0011 — three things the tax engine could not express.
--
-- 1. WHAT A PRODUCT IS. The engine has always mapped a neutral category
--    (clothing / footwear / digital / exempt) to each provider's own code, but
--    nothing could say which category a PRODUCT was — there was only a
--    store-wide default. So "everything is clothing" was the only answer
--    available, and the day a water bottle or a gift card is added it is
--    silently wrong: clothing is exempt in PA, NJ and MN, and a bottle is not.
--
-- 2. CUSTOMERS WHO DO NOT PAY TAX. A reseller or wholesale buyer holding a
--    valid exemption certificate must not be charged. There was no way to
--    record one, so the first B2B order would be overcharged with no way to
--    avoid it — and an over-collection is money taken from a customer who did
--    not owe it, which is worse than the under-collection everyone worries
--    about.
--
-- 3. WHAT A DIFFERENT ENGINE WOULD HAVE SAID. Choosing between the built-in
--    table and a paid provider is currently a guess. Shadow mode prices each
--    order a second time with another engine, charges from neither but the
--    live one, and records the difference — turning the choice into a
--    measurement taken on real orders.
--
-- Safe to run before the deploy that uses them: every column is nullable and
-- every table is additive, so existing code neither sees nor needs them.

-- ── 1. Per-product tax category ─────────────────────────────────────────────
alter table if exists public.products
  add column if not exists tax_category text;

comment on column public.products.tax_category is
  'Neutral tax category: general | clothing | footwear | digital | exempt. '
  'NULL means fall back to the store-wide default in site_settings.tax_engine. '
  'Each engine maps this to its own code (Stripe txcd_, TaxJar, TaxCloud TIC, '
  'Avalara), so switching provider never means re-tagging the catalogue.';

-- ── 2. Exemption certificates ───────────────────────────────────────────────
create table if not exists public.tax_exemptions (
  id            uuid primary key default gen_random_uuid(),
  -- Matched on whichever is present. Email covers guest checkout, which is how
  -- most wholesale buyers will first appear.
  email         text,
  user_id       uuid,
  -- Blank/empty means every state. Most certificates are state-specific.
  states        text[] default '{}',
  certificate   text,                       -- the certificate number on file
  business_name text,
  note          text,
  expires_at    timestamptz,                -- NULL = no expiry recorded
  revoked_at    timestamptz,
  created_at    timestamptz default now(),
  created_by    uuid
);

create index if not exists tax_exemptions_email_idx
  on public.tax_exemptions (lower(email)) where email is not null;
create index if not exists tax_exemptions_user_idx
  on public.tax_exemptions (user_id) where user_id is not null;

alter table public.tax_exemptions enable row level security;

-- Server-side only. An exemption zeroes tax on an order, so a customer able to
-- write one could stop paying tax; anon and authenticated get nothing at all
-- and every read happens through the service key on the pricing path.
drop policy if exists "tax exemptions are service-only" on public.tax_exemptions;
create policy "tax exemptions are service-only"
  on public.tax_exemptions for all
  using (false) with check (false);

-- ── 3. Shadow-mode comparisons ──────────────────────────────────────────────
create table if not exists public.tax_shadow_log (
  id             bigserial primary key,
  created_at     timestamptz default now(),
  order_number   text,
  state          text,
  zip            text,
  taxable_cents  integer,
  live_engine    text,
  live_cents     integer,
  shadow_engine  text,
  shadow_cents   integer,
  -- shadow minus live. Positive means the shadow engine would have charged
  -- MORE, i.e. the live one may be under-collecting.
  delta_cents    integer,
  shadow_error   text
);

create index if not exists tax_shadow_log_created_idx
  on public.tax_shadow_log (created_at desc);

alter table public.tax_shadow_log enable row level security;

drop policy if exists "shadow log is service-only" on public.tax_shadow_log;
create policy "shadow log is service-only"
  on public.tax_shadow_log for all
  using (false) with check (false);

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Products carry a category:
--   select column_name from information_schema.columns
--    where table_name = 'products' and column_name = 'tax_category';
-- Both tables exist and are locked down:
--   select tablename, rowsecurity from pg_tables
--    where tablename in ('tax_exemptions', 'tax_shadow_log');
