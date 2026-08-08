-- ─────────────────────────────────────────────────────────────────────────────
-- Feature flags: make site_settings.feature_flags storefront-readable (anon)
-- ─────────────────────────────────────────────────────────────────────────────
-- flags.js evaluates feature flags on the PUBLIC storefront using the anon key
-- (by design — flags must work for every visitor, no login/consent needed). But
-- site_settings public-read is whitelisted per key, and 'feature_flags' was never
-- added to the "Public read content keys" policy. Result: the admin (authenticated)
-- could see + save flags, but anon reads returned [] on the live site, so every
-- zwFlag() evaluated to false and no gated feature (e.g. product search) appeared,
-- even with the toggle switched ON in the admin.
--
-- The USING clause REPLACES the whole allow-list (it is not additive), so this must
-- always list the COMPLETE current set of anon-readable content keys. This array is
-- kept in sync with the live "Public read content keys" policy — notably it now
-- includes 'bag_panel' (added after this file's first version) so re-running it
-- never silently drops that key. Flag configs are non-sensitive
-- (name/enabled/rollout/description) and the client already evaluates them, so
-- exposing them publicly matches the system's design.
--
-- Applied to production 2026-07-28 via the add_feature_flags_to_public_read_whitelist
-- migration. Idempotent: re-running simply re-sets the same allow-list.
-- 2026-07-29: added 'collection_page' (builder Collection tab config, read by
-- drop001.html with the anon key) via the add_collection_page_public_read migration.
--
-- KEEP IN SYNC: supabase-image-effects.sql, supabase-bag-panel.sql. Those two file
-- also ALTER this policy and so must carry this exact list; they were stuck at the
-- 17- and 18-key versions predating 'feature_flags'/'collection_page', so running
-- either of them after this one silently revoked those keys — flags and the
-- collection page reverting to defaults with no error. Adding a new public key
-- means adding it to all three.
ALTER POLICY "Public read content keys" ON public.site_settings
USING (key = ANY (ARRAY[
  'announcement_bar','brand','fonts','hero','legal_policies','shipping_policy',
  'theme','technologies','tax_rate_overrides','about_page','faq','header_behavior',
  'product_card_cta','nav_menu','landing_pages','landing_pages_published',
  'image_effects','bag_panel','feature_flags','collection_page'
]));
