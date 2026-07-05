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
-- Already applied to production; kept here for reproducibility. Idempotent-ish:
-- re-running simply re-sets the same allow-list.
ALTER POLICY "Public read content keys" ON public.site_settings
USING (key = ANY (ARRAY[
  'announcement_bar','brand','fonts','hero','legal_policies','shipping_policy',
  'theme','technologies','tax_rate_overrides','about_page','faq','header_behavior',
  'product_card_cta','nav_menu','landing_pages','landing_pages_published',
  'image_effects'
]));
