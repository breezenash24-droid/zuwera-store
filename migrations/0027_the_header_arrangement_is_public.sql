-- ============================================================================
-- 0027 — header_layout joins the public-read allow-list
--
-- Which arrangement of the header the shop uses is stored in
-- site_settings.header_layout, and every storefront page reads it with the
-- anon key on load. It was not in the allow-list, so that read returned an
-- empty array on every page, forever: the builder's preview showed the chosen
-- arrangement (the draft travels by postMessage and never touches the database)
-- and the live site showed the one it shipped with. Choosing a header appeared
-- to work everywhere except where it mattered.
--
-- ── WHY THIS IS A NEW FILE AND NOT AN EDIT TO 0026 ───────────────────────────
--
-- 'header_layout' WAS added to 0026, after 0026 had already been applied.
-- Migrations are recorded by version and skipped once recorded, so that edit
-- could never run — the file said one thing and the database did another, and
-- nothing in the repository disagreed with itself loudly enough to notice.
-- migrate.js does detect this (it compares the recorded checksum with the
-- file's and reports `drifted`), which is worth saying plainly: the mechanism
-- built to catch exactly this mistake was in place, and the mistake was still
-- made, because nothing reads that report unless someone asks for status.
--
-- 0026 has been restored to the text that actually ran, so its checksum matches
-- again and `drifted` goes back to being empty and therefore meaningful.
--
-- ⚠ ALTER POLICY REPLACES the allow-list — it does not append, so this file
-- carries the COMPLETE set plus the one addition. The base is 0026, the latest
-- migration to rewrite this policy.
--
-- The draft key is deliberately absent, for the reason 0002 removed
-- landing_pages: a publicly readable draft key is a direct REST route to
-- unpublished work, and the key name ships in the JavaScript, so there is
-- nothing to guess.
-- ============================================================================

alter policy "Public read content keys" on public.site_settings
using (key = any (array[
  -- storefront chrome and theming
  'announcement_bar', 'brand', 'fonts', 'theme', 'header_behavior',
  'image_effects', 'nav_menu', 'bag_panel',
  -- the palette and the icon library: read on every page load by
  -- theme-engine.js and icon-sets.js
  'theme_modes', 'icons',
  -- page content
  'hero', 'about_page', 'faq', 'technologies', 'legal_policies', 'shipping_policy',
  'page_builder_published', 'landing_pages_published', 'collection_page',
  -- feature configuration the storefront reads directly
  'product_card_cta', 'feature_flags', 'fit_finder', 'integrations',
  'email_popup', 'tax_rate_overrides',
  -- copy edited on the canvas that no section owns (0026)
  'text_overrides',
  -- where the logo, the categories and the actions sit (position only)
  'header_layout'
]));
