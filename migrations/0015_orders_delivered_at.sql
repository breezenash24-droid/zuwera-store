-- ============================================================================
-- 0015 — when the parcel actually arrived
--
-- Every order confirmation, the returns page and the policy all say "30-day
-- free returns". Nothing enforces it: returnEligibility() checks the order
-- status and what has already been sent back, and has no date check at all. An
-- order from three years ago is returnable today.
--
-- Enforcing it needs a date to count from, and the honest answer is that the
-- store does not have one. `orders` has created_at (when it was PAID) and
-- nothing else. Counting thirty days from payment is not the promise that was
-- made: an order placed on the 1st, shipped on the 7th and delivered on the
-- 10th would give that customer twenty days, not thirty, and they would be
-- refused while still inside the window they were told about.
--
-- So: record the delivery. shippo-webhook.js already receives a DELIVERED event
-- and already marks the order — it simply never kept the timestamp.
--
-- THIS CANNOT BE BACKFILLED. The 61 existing orders have no delivery date and
-- never will; Shippo's tracking history is not retained indefinitely and the
-- webhook has already fired for them. That is the reason to add the column
-- before the rule rather than alongside it — every day without it is another
-- day of orders that can only ever be judged from their payment date.
--
-- The eligibility rule therefore has to work with the column empty, and does:
-- no delivery date means fall back to created_at plus a transit allowance, and
-- an order it cannot place at all is ALLOWED rather than refused. A wrongly
-- refused return is a support email and a customer who does not come back; a
-- wrongly allowed one costs a single item.
-- ============================================================================

alter table if exists public.orders
  add column if not exists delivered_at timestamptz;

comment on column public.orders.delivered_at is
  'When the carrier reported delivery. Written by shippo-webhook.js on a '
  'DELIVERED event. NULL on orders placed before this column existed, on '
  'hand-delivered orders, and on anything still in transit — the return window '
  'falls back to created_at plus a transit allowance when it is absent, and '
  'allows the return outright when no date can be established.';

-- The return check reads it per order, and the admin lists recent deliveries.
create index if not exists orders_delivered_at_idx
  on public.orders (delivered_at desc nulls last);

-- ── Verify ──────────────────────────────────────────────────────────────────
--   select count(*) filter (where delivered_at is not null) as recorded,
--          count(*)                                        as total
--     from orders;
--   -- expect recorded = 0 immediately after this runs, then climbing as
--   -- deliveries come in. If it stays at 0 while orders are being delivered,
--   -- the Shippo webhook is not reaching /api/shippo-webhook.
