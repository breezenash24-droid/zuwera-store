-- ─────────────────────────────────────────────────────────────────────────────
-- Abandoned-cart recovery: remember checkout carts to nudge shoppers who don't buy
-- ─────────────────────────────────────────────────────────────────────────────
-- /api/abandoned-cart upserts a row when a shopper enters their email at checkout.
-- stripe-webhook marks recovered_at on purchase. /api/send-abandoned-cart-emails
-- (hourly cron) emails rows older than the delay that weren't recovered/emailed.
-- Service-role only (no RLS policies) — holds customer emails + carts.
CREATE TABLE IF NOT EXISTS public.abandoned_carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  cart jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal_cents integer DEFAULT 0,
  item_count integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  recovered_at timestamptz,
  emailed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_abandoned_carts_email ON public.abandoned_carts (lower(email));
ALTER TABLE public.abandoned_carts ENABLE ROW LEVEL SECURITY;
-- Intentionally NO policies: anon/authenticated get nothing; only the service-role
-- endpoints touch this table. Already applied to the live DB via the connector.
