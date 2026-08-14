-- ============================================================================
-- 0019 — the tax filing reference belongs to the order, not to Stripe
--
-- When a sale is reported to the tax provider it hands back a transaction id.
-- That id is what a refund later reverses: without it the customer gets their
-- money back and the filing still says the sale happened, so the store pays tax
-- on a sale that no longer exists — quietly, and only discoverable by
-- reconciling by hand.
--
-- It was being stored by writing metadata onto the STRIPE PAYMENT INTENT:
--
--     POST /v1/payment_intents/{id}  metadata[tax_txn]=…
--
-- which works for exactly as long as Stripe is the only processor. A PayPal
-- order has no PaymentIntent — its id is `paypal_<capture>` — so that call
-- fails, the reference is never kept, and reverseTaxSale() is later handed an
-- empty string. The refund goes through and the filing is never corrected.
--
-- Nothing would report it. The Stripe write is wrapped in a try/catch that logs
-- and continues, correctly: a bookkeeping call must not fail an order that has
-- already taken money. So the first sign would be a tax bill.
--
-- The order row is the processor-agnostic place, and it is where the refund
-- route is already looking when it needs anything else about the order.
--
-- Existing Stripe orders keep working: admin-refund falls back to reading the
-- PaymentIntent when this column is empty, so nothing needs backfilling and
-- nothing that already filed correctly changes behaviour.
-- ============================================================================

alter table if exists public.orders
  add column if not exists tax_txn text;

comment on column public.orders.tax_txn is
  'Transaction id returned by the tax provider when this sale was reported. '
  'Reversed on refund so the store stops owing tax on a sale that came back. '
  'Written by reportSaleToTaxProvider() in _fulfil.js. NULL on orders placed '
  'before this column existed (the refund route falls back to Stripe '
  'PaymentIntent metadata for those), on orders where the engine files nothing '
  '(the built-in table, Zip-Tax), and where reporting is switched off.';

-- ── Verify ──────────────────────────────────────────────────────────────────
--   select processor,
--          count(*)                                  as orders,
--          count(*) filter (where tax_txn is not null) as with_reference
--     from orders group by processor;
--   -- Immediately after this runs: with_reference = 0 everywhere, and it
--   -- climbs as new orders are placed. A PayPal row that stays at 0 while
--   -- Stripe rows climb means _fulfil.js is still writing to the intent only.
