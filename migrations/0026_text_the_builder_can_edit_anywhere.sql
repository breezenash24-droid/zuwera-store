-- ============================================================================
-- 0026 — text_overrides joins the public-read allow-list
--
-- The page builder can edit text that belongs to a section, because a section
-- has settings to write it into. Everything else on the page — the nav labels,
-- the announcement bar, and any line of copy baked into a page template — had
-- nowhere to be stored, so it could not be edited at all.
--
-- Two of those three already have owners: nav labels live in nav_menu, the bar
-- message lives in announcement_bar. Inline editing writes to THOSE keys rather
-- than shadowing them, because a second store for a value that already has one
-- is how this codebase ended up with an announcement bar you could set in two
-- places that disagreed. Neither key is new; neither needs a policy change.
--
-- The third has no owner, and this is it. text_overrides maps a page path plus
-- a stable element path to { was, now }:
--
--   { "/": { "#hero h2|1": { "was": "All the devils are here",
--                            "now": "Everything begins here" } } }
--
-- `was` is not decoration. An override applies ONLY while the element's own
-- text still equals it. Template copy changes on deploy, and an override keyed
-- to a position in the markup would otherwise start rewriting whatever moved
-- into that slot — silently, and on the live site. Requiring the original to
-- still be there means a stale override does nothing instead of doing damage.
--
-- ── WHY THE DRAFT KEY IS NOT HERE ───────────────────────────────────────────
--
-- text_overrides_draft is deliberately absent, for the reason 0002 removed
-- landing_pages: a publicly readable draft key is a direct REST route to
-- unpublished copy, and the key name ships in the JavaScript, so there is
-- nothing to guess. The builder's preview never reads drafts from the database
-- — it holds them in memory and posts them into the preview iframe, the same
-- way section edits have always previewed. Same for nav_menu_draft and
-- announcement_bar_draft.
--
-- ⚠ ALTER POLICY REPLACES the allow-list — it does not append, so this file
-- carries the COMPLETE set plus the one addition.
--
-- The base is 0005, NOT 0002. Both rewrite this policy and 0005 is the later
-- one; it added theme_modes and icons, which theme-engine.js and icon-sets.js
-- read on every page load. Building this file on 0002 — the migration whose own
-- header explains that it exists to end exactly this kind of drift — would have
-- silently revoked public read for the palette and the icon library sitewide.
-- That is not hypothetical: it is what the first draft of this file did, and
-- theme-tokens.test.js is what caught it.
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
  -- copy edited on the canvas that no section owns (see above)
  'text_overrides',
  -- which arrangement of the header the shop uses (position only)
  'header_layout'
]));
