-- ============================================================================
-- Stop unpublished landing pages being publicly readable
-- ----------------------------------------------------------------------------
-- 'landing_pages' is the DRAFT half of the landing-page pair; the storefront
-- serves 'landing_pages_published'. The draft was in the anon read allow-list,
-- so anyone could fetch unpublished pages straight from the REST API — no
-- guessing required, the key name is in the shipped JavaScript.
--
-- The storefront no longer reads it either way (landing.js always asks for the
-- published key now; the builder's own preview pane gets its config pushed over
-- postMessage, and the admin preview link goes through /api/preview-config,
-- which verifies a signed token and reads with the service key). So removing it
-- here breaks nothing — it closes the direct-API route that the code change
-- alone cannot.
--
-- ⚠ THIS ONE MATTERS. Unlike the other SQL in this repo, the application cannot
-- work around this: as long as the policy lists 'landing_pages', a request to
-- /rest/v1/site_settings?key=eq.landing_pages returns unpublished content to
-- anyone who asks. Run it.
--
-- ⚠ ALTER POLICY REPLACES the whole allow-list — it does not append. This file
-- carries the COMPLETE canonical list minus 'landing_pages'.
--
-- KEEP IN SYNC: supabase-bag-panel.sql, supabase-image-effects.sql,
-- supabase-feature-flags-public-read.sql, supabase-email-popup.sql.
-- ============================================================================

ALTER POLICY "Public read content keys" ON public.site_settings
USING (key = ANY (ARRAY[
  'announcement_bar','brand','fonts','hero','legal_policies','shipping_policy',
  'theme','technologies','tax_rate_overrides','about_page','faq','header_behavior',
  'product_card_cta','nav_menu','landing_pages_published',
  'image_effects','bag_panel','feature_flags','collection_page',
  'integrations','fit_finder','email_popup'
]));

-- Verify afterwards — this should return no rows when run as anon:
--   select key from public.site_settings where key = 'landing_pages';
