-- ─────────────────────────────────────────────────────────────────────────────
-- Feature flags: make site_settings.feature_flags storefront-readable (anon)
-- ─────────────────────────────────────────────────────────────────────────────
-- flags.js evaluates feature flags on the PUBLIC storefront using the anon key
-- (by design — flags must work for every visitor, no login/consent needed). But
-- site_settings public-read is whitelisted per key, and 'feature_flags' was never
-- added to the "Public read content keys" policy. Result: the admin (authenticated)
-- could see + save flags, but anon reads returned [] on the live site, so every
-- zwFlag() evaluated to false and no gated feature ever appeared.
--
-- This ALTER re-sets the whole allow-list (USING replaces, it is not additive) to
-- the full set of non-sensitive display/config keys currently exposed, PLUS
-- 'feature_flags'. Flag configs are non-sensitive (name/enabled/rollout/description)
-- and the client already evaluates them, so exposing them publicly matches the
-- system's design.
--
-- Idempotent: re-running simply re-sets the same allow-list.
ALTER POLICY "Public read content keys" ON public.site_settings
USING (key = ANY (ARRAY[
  'announcement_bar','brand','fonts','hero','legal_policies','shipping_policy',
  'theme','technologies','tax_rate_overrides','about_page','faq','header_behavior',
  'product_card_cta','nav_menu','landing_pages','landing_pages_published',
  'image_effects','page_builder_published','feature_flags'
]));
