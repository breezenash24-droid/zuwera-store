-- ============================================================================
-- 0006 — the storage the live payment path needs
--
-- Test mode gives clean, documented behaviour on demand. Real cards do not, and
-- four gaps only exist once real money arrives:
--
--   * Stripe Radar scores every live charge and does essentially nothing in
--     test mode, so there is no signal on whether real customers are being
--     wrongly flagged — and the score is NOT recoverable later. A charge scored
--     last week cannot be re-scored, so the day this column does not exist is a
--     day of evidence gone.
--   * The webhook dedupes on "does an order for this PaymentIntent exist",
--     which covers the ordinary retry and not two events arriving at once —
--     both can pass that check before either writes. It also cannot dedupe an
--     event that creates no order.
--   * A dispute currently arrives and is dropped. A chargeback nobody hears
--     about is a chargeback lost by default, and the response window runs
--     whether or not anyone noticed.
--
-- Nothing here changes behaviour on its own. It is the storage those handlers
-- need, applied first so the code that follows has somewhere to write.
-- ============================================================================

-- ── Radar's verdict, kept with the order ────────────────────────────────────
-- Nullable and unbackfilled on purpose: orders taken before this ran genuinely
-- have no score, and inventing 'normal' for them would poison the first
-- distribution anyone looks at. Absent must read as "not measured", never as
-- "measured and fine".
alter table public.orders add column if not exists risk_level text;
alter table public.orders add column if not exists risk_score integer;

-- ── Events already handled ──────────────────────────────────────────────────
-- Keyed on Stripe's event id, which is what makes this work where the existing
-- guard does not: the id is stable across retries, unique per delivery, and
-- exists for events that create no order.
--
-- The primary key IS the lock. Two concurrent deliveries both insert; exactly
-- one succeeds and the other gets a duplicate-key error, which the handler
-- reads as "someone else has this" and returns. A select-then-insert would let
-- both pass, which is the race the current check has.
create table if not exists public.processed_events (
  event_id   text primary key,
  event_type text,
  seen_at    timestamptz not null default now()
);

-- Kept for a window rather than forever. Stripe retries for about three days,
-- so rows older than that answer no question anyone asks.
create index if not exists processed_events_seen_at_idx
  on public.processed_events (seen_at);

-- ── Disputes ────────────────────────────────────────────────────────────────
-- Its own table rather than a flag on the order: a dispute has its own life —
-- opened, evidence due, won or lost — and squeezing that into an order status
-- loses the deadline, which is the only part with a clock on it.
create table if not exists public.disputes (
  id            text primary key,          -- Stripe dispute id
  charge_id     text,
  payment_intent text,
  order_id      text,
  amount        integer,                   -- cents, matching order items
  currency      text,
  reason        text,
  status        text,
  evidence_due  timestamptz,
  opened_at     timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  raw           jsonb
);

create index if not exists disputes_order_idx  on public.disputes (order_id);
create index if not exists disputes_status_idx on public.disputes (status);

-- ── Access ──────────────────────────────────────────────────────────────────
-- Both tables are written by the webhook with the service-role key, which
-- bypasses RLS. RLS is still enabled with no policy, so the ANON key — the one
-- every storefront visitor holds — can read neither. A dispute record names a
-- customer and an amount, and processed_events would let anyone enumerate order
-- volume by counting rows.
alter table public.processed_events enable row level security;
alter table public.disputes         enable row level security;
