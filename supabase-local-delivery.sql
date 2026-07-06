-- ─────────────────────────────────────────────────────────────────────────────
-- Campus hand-delivery: record how an order is fulfilled
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds a `delivery_method` column to `orders`:
--   'ship'          — normal mail delivery (default / null)
--   'hand_delivery' — delivered in person (no shipping label, no tracking email)
--
-- Set best-effort by functions/api/stripe-webhook.js from the payment metadata,
-- so this migration is optional and non-breaking: until you run it, orders are
-- unaffected and the webhook just skips writing the column.
--
-- Safe to run more than once.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_method text;
