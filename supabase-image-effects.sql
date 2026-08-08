-- ─────────────────────────────────────────────────────────────────────────────
-- Image effects: make the setting storefront-readable
-- ─────────────────────────────────────────────────────────────────────────────
-- The admin "Image Effects" control (Appearance page) stores its config in
-- site_settings under key 'image_effects', e.g.:
--   { "hoverZoom": { "enabled": true, "scale": 1.04,
--                    "types": { "product": true, "category": true, "media": true } } }
--   (enabled = master switch; types is optional and missing types default to on.)
--
-- site_settings public-read is whitelisted per key, so the storefront loader
-- (image-effects.js, anon key) can only read it once 'image_effects' is added to
-- the "Public read content keys" policy. This ALTER appends it alongside the
-- other display settings already exposed (header_behavior, product_card_cta, …).
-- The value is non-sensitive (just a zoom scale), safe to expose publicly.
--
-- Already applied to production; kept here for reproducibility.
--
-- ⚠ ALTER POLICY REPLACES the whole allow-list — it does not append. Every file
-- that touches this policy must therefore carry the COMPLETE canonical list
-- below, or running them in the wrong order silently revokes whatever the others
-- added. This file used to list only the 17 keys that existed when it was
-- written, and its comment claimed re-running "simply re-sets the same
-- allow-list" — running it after supabase-bag-panel.sql or
-- supabase-feature-flags-public-read.sql would have dropped 'bag_panel',
-- 'feature_flags' and 'collection_page', silently reverting feature flags, the
-- bag panel and the collection page to their defaults with no error anywhere.
--
-- KEEP IN SYNC: supabase-bag-panel.sql, supabase-feature-flags-public-read.sql.
-- Adding a new public key means adding it to all three.
ALTER POLICY "Public read content keys" ON public.site_settings
USING (key = ANY (ARRAY[
  'announcement_bar','brand','fonts','hero','legal_policies','shipping_policy',
  'theme','technologies','tax_rate_overrides','about_page','faq','header_behavior',
  'product_card_cta','nav_menu','landing_pages','landing_pages_published',
  'image_effects','bag_panel','feature_flags','collection_page',
  'integrations','fit_finder','email_popup'
]));
