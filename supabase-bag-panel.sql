-- ─────────────────────────────────────────────────────────────────────────────
-- Bag panel: make the setting storefront-readable
-- ─────────────────────────────────────────────────────────────────────────────
-- The admin "Bag panel" control (Appearance page) stores its config in
-- site_settings under key 'bag_panel', e.g.:
--   {
--     "supportEmail": "orders@zuwera.store",
--     "rows": {
--       "orders":  { "enabled": true, "label": "Orders" },
--       "saves":   { "enabled": true, "label": "Your saves" },
--       "account": { "enabled": true, "label": "Account" },
--       "support": { "enabled": true, "label": "Support" }
--     }
--   }
-- Every field is optional; the storefront loader falls back to today's hardcoded
-- values when a field (or the whole key) is missing, so nothing breaks before this
-- runs. The content is non-sensitive (labels + a public support address), safe to
-- expose publicly.
--
-- site_settings public-read is whitelisted per key, so the storefront bag panel
-- (storefront-features.js, anon key) can only read it once 'bag_panel' is added to
-- the "Public read content keys" policy. This ALTER appends it alongside the other
-- display settings already exposed (header_behavior, product_card_cta, image_effects, …).
--
-- Run once against production. Idempotent: re-running simply re-sets the allow-list.
ALTER POLICY "Public read content keys" ON public.site_settings
USING (key = ANY (ARRAY[
  'announcement_bar','brand','fonts','hero','legal_policies','shipping_policy',
  'theme','technologies','tax_rate_overrides','about_page','faq','header_behavior',
  'product_card_cta','nav_menu','landing_pages','landing_pages_published',
  'image_effects','bag_panel'
]));
