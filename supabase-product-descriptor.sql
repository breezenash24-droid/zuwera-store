-- ─────────────────────────────────────────────────────────────────────────────
-- Product descriptor: optional PDP subtitle line ("says what it is")
-- ─────────────────────────────────────────────────────────────────────────────
-- The product page previously showed only the gender (e.g. "UNISEX") under the
-- title. It now shows a descriptive line like Nike ("Men's Tank Tops"), built
-- automatically from gender + category (the `subtitle` column). This optional
-- `descriptor` column lets the admin override that auto line with any custom text
-- when the auto category doesn't fit — blank/NULL means "auto-build it".
--
-- products is public-readable (storefront reads via anon key with select=*), so no
-- RLS change is needed — the SELECT policy already covers every column.
--
-- Applied to production 2026-07-29 via the add_product_descriptor migration.
-- Idempotent.
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS descriptor text;
COMMENT ON COLUMN public.products.descriptor IS
  'Optional custom PDP subtitle line; when blank the storefront auto-builds "<Gender>''s <Category>" (e.g. Men''s Tank Tops).';
