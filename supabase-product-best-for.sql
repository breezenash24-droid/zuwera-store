-- ─────────────────────────────────────────────────────────────────────────────
-- Product "best for" (weather) — drives the collection "Best for" filter
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds a `best_for` text[] column to products. The admin product editor writes it
-- (weather checkboxes), and the collection page derives a "Best for" filter facet
-- from it. (The sibling "Material" filter needs NO column — it is derived from the
-- existing material_composition free text.)
--
-- products is public-readable (storefront reads via anon key with select=*), so no
-- RLS change is needed — the SELECT policy already covers every column.
--
-- Applied to production 2026-07-30 via the add_product_best_for migration. Idempotent.
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS best_for text[];
COMMENT ON COLUMN public.products.best_for IS
  'Weather conditions this product is best for (e.g. {"Warm Weather","Wet Weather"}); drives the "Best for" filter on the collection page.';
