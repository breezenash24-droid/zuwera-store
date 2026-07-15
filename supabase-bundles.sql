-- ============================================================================
-- Bundles ("complete the set") — bundles
-- Admin-defined groups of products. On a product page belonging to a set, the
-- storefront shows the set's other pieces (storefront-features.js, gated by the
-- feature_bundles flag). An optional promo_code is displayed as the set's offer;
-- the discount itself runs through the existing promo path, which is recomputed
-- server-side at payment time — bundles never touch pricing directly.
--
-- NOTE: applied live via the Supabase connector; this file is the record.
-- ============================================================================

create extension if not exists pgcrypto;

create table if not exists public.bundles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  blurb       text,
  product_ids jsonb not null default '[]'::jsonb,   -- array of products.id
  promo_code  text,                                  -- optional; must exist in Coupons
  active      boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.bundles enable row level security;

-- Shoppers read only active sets; admins manage everything. The two policies OR
-- together, so an admin still sees inactive sets.
drop policy if exists "Bundles public read active" on public.bundles;
create policy "Bundles public read active"
  on public.bundles for select to anon, authenticated using (active = true);

drop policy if exists "Bundles admin manage" on public.bundles;
create policy "Bundles admin manage"
  on public.bundles for all to authenticated
  using (current_user_is_admin()) with check (current_user_is_admin());

revoke insert, update, delete on public.bundles from anon;
