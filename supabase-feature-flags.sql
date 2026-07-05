-- ─────────────────────────────────────────────────────────────────────────────
-- Feature flags: revenue-by-variant support
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds a jsonb column to `orders` that stores the buyer's ACTIVE feature-flag
-- variants at purchase time, e.g. {"checkout_v2": true, "new_pdp": false}.
--
-- It's written best-effort by functions/api/stripe-webhook.js AFTER the order is
-- saved, so this migration is optional and non-breaking: until you run it, the
-- webhook simply no-ops and orders are unaffected. Run it (Supabase → SQL editor)
-- to start collecting variant data for the "Orders since stamping" readout on the
-- admin Feature Flags page.
--
-- Safe to run more than once.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS feature_flags jsonb;
