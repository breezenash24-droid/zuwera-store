-- 0012 — record what the shipping label actually cost.
--
-- Every order already knows what the customer PAID for shipping (orders.shipping)
-- and, separately, what the label really cost — but the second number lived only
-- in Stripe PaymentIntent metadata and was never written to the order. So the
-- difference between the two, which is margin, could not be queried at all.
--
-- It matters most on free-shipping orders, where the customer paid nothing and
-- the label still cost something. A free-shipping threshold set too low loses
-- money on every order that crosses it, quietly, for as long as nobody subtracts
-- one column from the other.
--
-- Nullable, and NOT backfilled: orders taken before this genuinely have no
-- recorded cost, and writing a zero would read as "this one shipped for free"
-- and drag every average down with a number nobody measured.

alter table if exists public.orders
  add column if not exists actual_shipping_cost numeric(10,2);

comment on column public.orders.actual_shipping_cost is
  'What the shipping label cost us, in dollars. Compare against orders.shipping '
  '(what the customer was charged) for shipping margin. NULL on orders placed '
  'before this column existed, and on hand-delivery orders that never bought a '
  'label — both genuinely unmeasured rather than zero.';

-- ── Verify ──────────────────────────────────────────────────────────────────
--   select column_name, is_nullable from information_schema.columns
--    where table_name = 'orders' and column_name = 'actual_shipping_cost';
-- Once orders have flowed through, the leak (if any) reads out as:
--   select count(*), sum(shipping - actual_shipping_cost) as margin
--     from orders where actual_shipping_cost is not null;
