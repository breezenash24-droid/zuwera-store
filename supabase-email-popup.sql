-- ============================================================================
-- Email popup — make site_settings.email_popup storefront-readable (anon)
-- ----------------------------------------------------------------------------
-- email-popup.js runs for EVERY visitor, signed in or not, so it reads its
-- config with the anon key. site_settings public-read is whitelisted per key,
-- so without this the admin could configure a popup perfectly and no shopper
-- would ever see one: the anon read returns [] and the module quietly settles
-- on its defaults, which are `enabled: false`.
--
-- What's exposed is the popup's own presentation — copy, orientation, logo,
-- trigger timings, and the OFFER TERMS (type, value, minimum, expiry). Those
-- terms are public by nature: they are printed on the popup itself. Nothing
-- secret rides along, and knowing them grants nothing — /api/popup-claim reads
-- this same row server-side to decide what to issue, so a shopper editing the
-- request can't change their discount. The code is then validated at checkout
-- like any other promo.
--
-- ⚠ ALTER POLICY REPLACES the whole allow-list — it does not append. Every file
-- that touches this policy must carry the COMPLETE canonical list below, or
-- running them in the wrong order silently revokes what the others added, with
-- no error anywhere.
--
-- KEEP IN SYNC: supabase-bag-panel.sql, supabase-image-effects.sql,
-- supabase-feature-flags-public-read.sql. Adding a new public key means adding
-- it to all four.
-- ============================================================================

ALTER POLICY "Public read content keys" ON public.site_settings
USING (key = ANY (ARRAY[
  'announcement_bar','brand','fonts','hero','legal_policies','shipping_policy',
  'theme','technologies','tax_rate_overrides','about_page','faq','header_behavior',
  'product_card_cta','nav_menu','landing_pages','landing_pages_published',
  'image_effects','bag_panel','feature_flags','collection_page',
  'integrations','fit_finder','email_popup'
]));

-- ── Notes on the data this feature touches ──────────────────────────────────
--
-- Signups land in public.newsletter_subscribers (see supabase-newsletter.sql)
-- with source 'popup:<page>', written by /api/popup-claim with the service-role
-- key. anon has no direct access to that table, and the popup never writes to
-- it from the browser.
--
-- Discount codes are written into site_settings.commerce_config.promotions
-- through mutateSetting()'s compare-and-swap (supabase-atomic-settings.sql), so
-- a burst of signups can't lose codes to the read-modify-write race that key is
-- prone to. No new table is needed: a popup code IS a normal promo, and runs
-- through the same server-side validation as every other one.
