-- ============================================================================
-- Review photos — adds a `photos` column to the existing reviews table.
-- Stores an array of public image URLs (uploaded via
-- functions/api/upload-review-photo.js to the product-images bucket).
--
-- The review row is owned by the shopper (RLS: auth insert/update where
-- auth.uid() = user_id), so the photo URLs are written client-side as part of
-- the normal insert/update. Admins can moderate via their existing full-access
-- policy on reviews.
--
-- NOTE: applied live via the Supabase connector; this file is the record.
-- ============================================================================

alter table public.reviews
  add column if not exists photos jsonb not null default '[]'::jsonb;
