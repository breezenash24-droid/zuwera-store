-- ============================================================================
-- 0005 — let the storefront read the theme and icon settings
--
-- theme-engine.js and icon-sets.js fetch site_settings with the ANON key, and
-- the "Public read content keys" policy is an explicit allow-list. Neither
-- theme_modes nor icons was on it, so both reads returned an empty result and
-- both modules fell back to their built-in defaults.
--
-- The effect: every theme and every icon set an admin configured applied in the
-- admin — which reads with an authenticated session — and reached the live site
-- never. The preview showed the truth, the storefront showed the defaults, and
-- nothing logged an error, because an empty result and "nothing configured" are
-- the same shape from the client.
--
-- This is precisely the drift 0002 was written to fix, one migration later:
-- fit_finder and integrations had been configured for months and were doing
-- nothing for exactly this reason. The lesson evidently needs the test that now
-- accompanies it — a storefront module that fetches a key with the anon key and
-- is not on this list is a feature that silently does not exist.
--
-- Neither key holds anything secret. theme_modes is colours and names; icons is
-- set names and SVG markup. Both are visible in the rendered page anyway.
--
-- ⚠ ALTER POLICY REPLACES the allow-list — it does not append. This file
-- therefore carries the COMPLETE canonical set, exactly as 0002 did, and is now
-- the single source of truth.
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
  'email_popup', 'tax_rate_overrides'
]));
