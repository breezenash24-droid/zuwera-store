-- ============================================================================
-- 0020 — an order records which ad, email or post produced it
--
-- Nothing recorded this. `utm_*` and `gclid` appeared nowhere in the codebase;
-- `fbclid` appeared once, in meta-pixel.js, where it was read to build the
-- pixel's `_fbc` cookie and then discarded. So every order in this table is
-- anonymous as to what brought the customer, and — unlike almost every other
-- gap in this system — that cannot be repaired afterwards. A click id exists
-- for the duration of one page load. There is no export, no report and no
-- support ticket that recovers it later.
--
-- The same shape of loss as `delivered_at` in 0015, which was added after 61
-- orders had already shipped without it. Those 61 have no delivery date and
-- never will. This column is being added before launch for that reason.
--
-- WHY jsonb RATHER THAN A COLUMN PER PARAMETER.
--
-- Nine fields today (five utm_*, four click ids) and the platforms add more —
-- `msclkid` and `ttclid` did not exist when `utm_source` was standardised. A
-- column each would mean a migration every time an ad network is tried, on a
-- table that also carries orders. The queries that matter are indexed below, so
-- the usual argument for separate columns (a jsonb scan on every report) does
-- not apply here.
--
-- WHAT IS IN IT.
--
--   { "first": { "utm_source": "google", "utm_medium": "cpc",
--                "utm_campaign": "…", "gclid": "…", "referrer": "google.com",
--                "landing": "/product.html", "ts": 1755100000000 },
--     "last":  { … same shape … } }
--
-- Both touches, because they answer different questions: first says what FOUND
-- the customer, last says what CLOSED them and is what the ad platforms will
-- report. `last` is always present — when a customer arrived once and bought,
-- it is a copy of `first` rather than a hole, so a report never has to special
-- -case single-visit orders.
--
-- NOT IN IT: `fbp`/`fbc`. Those identify the browser to Meta, are useless to
-- anyone else, and go straight into the Conversions API `user_data`. Keeping
-- them here would be storing a third-party tracking identifier against a named
-- customer with a shipping address, for no reporting benefit.
--
-- NULLABLE, NO DEFAULT. Existing orders predate any of this and an empty object
-- would read as "we looked and there was nothing", which is a different and
-- false statement. NULL means "not recorded". It is also what every order from
-- a visitor who declined the cookie banner will hold, permanently and by
-- design — attribution is gated on consent in attribution.js.
-- ============================================================================

alter table if exists public.orders
  add column if not exists attribution jsonb;

comment on column public.orders.attribution is
  'Where this order came from: {"first":{utm_source,utm_medium,utm_campaign,'
  'utm_term,utm_content,gclid,fbclid,msclkid,ttclid,referrer,landing,ts},'
  '"last":{…}}. Captured by attribution.js on the landing page, carried through '
  'payment metadata, written by saveOrderToSupabase. NULL means not recorded: '
  'an order placed before this column existed, or by a visitor who declined the '
  'cookie banner (attribution is consent-gated, deliberately). Meta match keys '
  'fbp/fbc are NOT stored here — they go to the Conversions API only.';

-- ── Indexes ─────────────────────────────────────────────────────────────────
-- Expression indexes on the three fields reports actually group by. This is the
-- reason jsonb costs nothing here: these are as fast as real columns, and a new
-- ad network needs a new index rather than a new migration on the orders table.
--
-- Partial, because the overwhelming majority of rows will be NULL for a long
-- time — every order placed before today, plus every order from a visitor who
-- declined. An index over those is pages of nothing.

create index if not exists orders_attr_source_idx
  on public.orders ((attribution -> 'last' ->> 'utm_source'))
  where attribution is not null;

create index if not exists orders_attr_campaign_idx
  on public.orders ((attribution -> 'last' ->> 'utm_campaign'))
  where attribution is not null;

-- First touch gets its own on source only. Cohort work groups by what FOUND a
-- customer, and that is a different question from what closed the sale — which
-- is the whole reason both touches are stored.
create index if not exists orders_attr_first_source_idx
  on public.orders ((attribution -> 'first' ->> 'utm_source'))
  where attribution is not null;

-- Google offline conversion import is keyed on gclid, so it is looked up by
-- exact value rather than grouped. Only rows that have one.
create index if not exists orders_attr_gclid_idx
  on public.orders ((attribution -> 'last' ->> 'gclid'))
  where attribution -> 'last' ->> 'gclid' is not null;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   -- Should be 0 immediately after this runs, and climb with new orders.
--   select count(*) filter (where attribution is not null) as attributed,
--          count(*)                                        as total
--     from orders;
--
--   -- Revenue by last-touch source, once orders exist:
--   select coalesce(attribution->'last'->>'utm_source', '(none)') as source,
--          count(*) as orders, sum(total::numeric) as revenue
--     from orders group by source order by revenue desc nulls last;
--
--   -- Where first and last disagree — the orders a single-touch model would
--   -- have credited to the wrong channel:
--   select attribution->'first'->>'utm_source' as found_by,
--          attribution->'last' ->>'utm_source' as closed_by,
--          count(*)
--     from orders
--    where attribution is not null
--      and attribution->'first'->>'utm_source'
--          is distinct from attribution->'last'->>'utm_source'
--    group by 1, 2 order by 3 desc;
--
--   -- If `attributed` stays at 0 while orders arrive, the cause is one of:
--   -- consent being declined (expected, check the rate), attribution.js not
--   -- loaded on the landing page, or commerce-checkout.js not injecting it.
