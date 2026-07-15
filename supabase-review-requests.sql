-- ============================================================================
-- Review-request emails — adds orders.review_requested_at
-- Marks when the "how did we do?" review-request email was sent for an order,
-- so the scheduled job (functions/api/send-review-requests.js) never emails the
-- same order twice.
--
-- NOTE: applied live via the Supabase connector; this file is the record.
-- ============================================================================

alter table public.orders
  add column if not exists review_requested_at timestamptz;
