-- ─────────────────────────────────────────────────────────────────────────────
-- Product sports: the sport(s) a product is for
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds a `sports` text[] column to products. The admin product editor writes it
-- (comma-separated → array), the product page shows it as a "Sport" section, and
-- the collection page derives a Sport filter facet from the sports actually
-- assigned across products (Phase 2 of the collection filter system).
--
-- products is public-readable (storefront reads via anon key with select=*), so no
-- RLS change is needed — the SELECT policy already covers every column.
--
-- Applied to production 2026-07-29 via the add_product_sports migration. Idempotent.
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS sports text[];
COMMENT ON COLUMN public.products.sports IS
  'Sports this product is for (e.g. {Running,Training}); shown on the product page and drives the Sport filter on the collection page.';
