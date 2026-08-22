-- ============================================================================
-- 0033 — an order can explain itself
--
-- A real order, as the customer's account page renders it today:
--
--     Zuwera Aero Pro    S · Yellow            $22.00
--     Zuwera Vogue       M · Blueish Purple    $70.00
--     ─────────────────────────────────────────────────
--     Order #VXR84WZDM6                        $47.68
--
-- Ninety-two dollars of goods, forty-seven sixty-eight paid, and nothing
-- anywhere on the page accounting for the difference. It is not a rendering
-- bug. The row genuinely cannot answer the question.
--
-- ── WHAT THE ORDERS TABLE KNOWS, AND WHAT IT NEVER WROTE DOWN ───────────────
--
-- It has subtotal, shipping, tax and total. That is enough arithmetic for an
-- order where nothing was taken off, and every order where something WAS taken
-- off is unexplainable:
--
--   the promo code       lives in Stripe metadata as discount_code and
--                        discount_amount_cents, read once by the confirmation
--                        email, and never persisted
--   the gift card        same — stored_value_cents and stored_value_code ride
--                        on the PaymentIntent and stop there
--
-- Both are read by _fulfil.js while it builds the receipt email, and both are
-- dropped on the floor immediately afterwards. So the email could explain the
-- order and the account page could not, from the same fulfilment run, because
-- one of them had the numbers in scope and the other had only the row.
--
-- ── WHY THIS IS NOT A DISPLAY FIX ───────────────────────────────────────────
--
-- Stripe metadata is not a record. It is capped at 500 characters per value,
-- it is attached to a PaymentIntent that a PayPal order does not have, and it
-- is not queryable — you cannot ask "how much did promotions cost us in July"
-- of a field that only exists one API call at a time. A number the store makes
-- a decision with belongs in a column.
--
-- ── NOTHING IS BACKFILLED, ON PURPOSE ───────────────────────────────────────
--
-- The same call 0031 made about order numbers. Every order placed before this
-- migration has a discount and a gift card that were never recorded anywhere
-- durable, and there is nothing to recover them from — the metadata is on
-- Stripe objects the store does not re-read, and inferring a discount by
-- subtracting the totals would be inventing a figure and writing it down as
-- fact. An old order will show the parts it does have and stay silent about
-- the rest, which is true. A backfilled guess would not be.
--
-- ── AND WHY THE COLUMNS ARE NULLABLE ────────────────────────────────────────
--
-- NULL means "not recorded" and 0 means "there wasn't one", and those are
-- different sentences. An order from last month with NULL discount_cents is
-- not an order that had no discount — it is an order from before the store
-- kept track. The account page says nothing rather than printing a confident
-- "Discount $0.00" over an order that may well have had one.
-- ============================================================================

alter table public.orders
  add column if not exists discount_code text;

alter table public.orders
  add column if not exists discount_cents integer;

alter table public.orders
  add column if not exists stored_value_cents integer;

/* The last four characters, never the whole code — the same rule the audit log
   and the receipt email follow. A gift card code is spendable money, and a
   column holding live ones is a list of it in a table more people can read than
   can issue. This exists so an order can be matched to a card during a support
   conversation, which four characters is enough for. */
alter table public.orders
  add column if not exists stored_value_last4 text;

alter table public.orders
  add column if not exists stored_value_kind text;

comment on column public.orders.discount_cents is
  'What the promo code took off, in cents. NULL means not recorded (any order '
  'placed before migration 0033) — which is NOT the same as zero. See 0033.';

comment on column public.orders.stored_value_cents is
  'What a gift card or store credit paid toward this order, in cents. Tender, '
  'not a discount: the order total is unaffected by it and tax is charged on '
  'the full amount. NULL means not recorded. See 0033.';

alter table public.orders
  drop constraint if exists orders_discount_cents_sane;
alter table public.orders
  add constraint orders_discount_cents_sane
  check (discount_cents is null or discount_cents >= 0);

alter table public.orders
  drop constraint if exists orders_stored_value_cents_sane;
alter table public.orders
  add constraint orders_stored_value_cents_sane
  check (stored_value_cents is null or stored_value_cents >= 0);

/* "What did promotions cost us this quarter" is the question this column was
   added for, and it is a scan of every order without an index on the orders
   that actually had one. Partial, because most did not. */
create index if not exists orders_discount_code_idx
  on public.orders (discount_code)
  where discount_code is not null;
