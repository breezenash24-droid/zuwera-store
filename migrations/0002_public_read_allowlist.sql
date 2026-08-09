-- ============================================================================
-- 0002 — canonical site_settings public-read allow-list
--
-- Fixes drift that was costing two features, and closes one exposure.
--
-- Checked against production before writing this. anon could read 19 keys. Two
-- keys the storefront actually reads were missing:
--
--   fit_finder    fit-finder.js reads it on every product page. Absent, so
--                 "Find your size" ignored the weight bands set in the admin
--                 and answered from its built-in defaults instead.
--   integrations  integrations.js reads it. Absent, so nothing configured on
--                 the integrations screen ever loaded.
--
-- Both had been configured in the admin and were doing nothing on the site.
-- Neither logged an error: an empty result and "no overrides set" look the same
-- from the client.
--
-- And one key was present that should not have been:
--
--   landing_pages  the DRAFT half of the landing-page pair. Publicly readable
--                  meant anyone could fetch unpublished pages straight from the
--                  REST API — no guessing needed, the key name ships in the
--                  JavaScript. The storefront no longer reads it (landing.js
--                  always asks for landing_pages_published; the builder's own
--                  preview gets its config over postMessage; the admin preview
--                  link goes through /api/preview-config with a signed token),
--                  so removing it breaks nothing and closes the direct-API
--                  route the code change alone could not.
--
-- ⚠ ALTER POLICY REPLACES the allow-list — it does not append. This file
-- therefore carries the COMPLETE canonical set, and from here it is the single
-- source of truth: the older root-level .sql files each carried their own copy,
-- which is how the lists diverged in the first place.
-- ============================================================================

alter policy "Public read content keys" on public.site_settings
using (key = any (array[
  -- storefront chrome and theming
  'announcement_bar', 'brand', 'fonts', 'theme', 'header_behavior',
  'image_effects', 'nav_menu', 'bag_panel',
  -- page content
  'hero', 'about_page', 'faq', 'technologies', 'legal_policies', 'shipping_policy',
  'page_builder_published', 'landing_pages_published', 'collection_page',
  -- feature configuration the storefront reads directly
  'product_card_cta', 'feature_flags', 'fit_finder', 'integrations',
  'email_popup', 'tax_rate_overrides'
]));
