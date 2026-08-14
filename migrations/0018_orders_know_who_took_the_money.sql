-- ============================================================================
-- 0018 — which processor took the money
--
-- Every order row records `stripe_payment_intent_id`, and until now that name
-- was also the answer: there was one processor, so the column identified both
-- the payment AND who handled it. PayPal breaks that. Its capture id goes into
-- the same column — deliberately, because saveOrderToSupabase dedupes on it and
-- reusing the column keeps idempotency working with no second code path — but
-- the column is now doing two jobs and only says the truth about one of them.
--
-- What that costs, concretely:
--
--   • A refund has to be issued through the processor that took it. Reading
--     `stripe_payment_intent_id` and calling Stripe on a PayPal order fails at
--     the worst possible moment: a customer is owed money and the button does
--     not work.
--   • Finance cannot split revenue by processor, so reconciling against two
--     payout schedules means matching by hand.
--   • The prefix is a convention, not a guarantee. `paypal_` happens to be
--     there today because paypal-capture.js writes it; nothing enforces it and
--     nothing would notice if it changed.
--
-- Defaulting existing rows to 'stripe' is honest rather than convenient: every
-- order in this table was taken by Stripe, because nothing else could take one
-- until now.
--
-- The column is deliberately loose (text, not an enum). A new processor should
-- be a settings change and a route, not a migration — an enum would make adding
-- one require altering a type on a live table, and that is a lot of ceremony to
-- protect a field this system writes and nobody types.
-- ============================================================================

alter table if exists public.orders
  add column if not exists processor text not null default 'stripe';

comment on column public.orders.processor is
  'Which payment processor took this order: stripe, paypal, … Written by '
  'saveOrderToSupabase from the order metadata. Existing rows default to '
  'stripe, which is accurate — nothing else could take an order before this '
  'column existed. Refunds must be issued through the processor named here; '
  'stripe_payment_intent_id holds the reference but no longer implies who.';

-- Finance and the admin both filter by it, and a partial index is enough
-- because the overwhelming majority of rows will be one value.
create index if not exists orders_processor_idx
  on public.orders (processor)
  where processor <> 'stripe';

-- ── Verify ──────────────────────────────────────────────────────────────────
--   select processor, count(*) from orders group by processor;
--   -- expect every existing row as 'stripe' immediately after this runs.
--   -- A 'paypal' row appearing means the PayPal path wrote it correctly; a
--   -- PayPal order still showing 'stripe' means _fulfil.js is not reading
--   -- meta.payment_provider.
