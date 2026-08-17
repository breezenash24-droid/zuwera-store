-- ============================================================================
-- 0025 — a price list can carry a rule, not just a pile of rows
--
-- Wholesale shipped able to express "this product is $35 for trade" and unable
-- to express "trade is half of retail" — which is the one every trade account
-- in the world actually runs on.
--
-- The cost of that gap is not typing. It is DRIFT. A percentage stated as 50
-- rows is 50 chances to fat-finger a figure, and — the part that actually bites
-- — every product added afterwards silently has no trade price at all. Nothing
-- errors: pickPrice() finds no row, resolvePrice() falls back to the catalogue,
-- and an approved wholesale buyer is quietly charged full retail on the newest
-- half of the range. The fallback that stops an empty pricing system selling at
-- zero is the same fallback that hides this.
--
-- A rule cannot drift, because there is nothing to keep in step. It prices the
-- product that was added this morning on exactly the terms as the rest.
--
-- ── WHAT A RULE DOES NOT DO ─────────────────────────────────────────────────
--
-- It never beats an explicit row. A row naming a product is a decision somebody
-- made and had approved; a rule is what applies when nobody made one. Same
-- precedence as a row naming a colour beating a row that does not — the more
-- specific statement wins — and it keeps the escape hatch that matters: one
-- product priced by hand does not mean abandoning the rule for the other
-- forty-nine.
--
-- It is also NOT an approval bypass. Rows go through propose → approve because
-- each is a separate decision about a separate product. A rule is one decision,
-- taken here, recorded in the audit log by the endpoint that writes it. Putting
-- a rule through the row workflow would mean approving a change to a price that
-- does not exist yet, on products that do not exist yet.
--
-- ── WHY PERCENT AND NOT A MULTIPLIER ────────────────────────────────────────
--
-- "40% off" and "0.6x" are the same arithmetic and not the same mistake. A
-- misread multiplier of 6 charges six times retail; a misread percentage of 6
-- charges 94% of it. The bounded field is the one that fails small, and the
-- CHECK below makes the dangerous half unrepresentable rather than merely
-- discouraged.
-- ============================================================================

alter table if exists public.price_lists
  add column if not exists rule_percent_off numeric(5,2);

comment on column public.price_lists.rule_percent_off is
  'Percent off the catalogue price for products this list has no explicit row '
  'for. NULL means the list is rows-only and prices nothing by itself. '
  'Applied in resolvePrice() AFTER pickPrice() finds no row, so an explicit '
  'row always wins. See functions/api/_price-resolution.js.';

-- 100 would price at zero and 0 is a rule that does nothing but looks like one,
-- so both ends are refused. A list wanting no rule leaves it NULL.
alter table public.price_lists
  drop constraint if exists price_lists_rule_percent_sane;
alter table public.price_lists
  add constraint price_lists_rule_percent_sane
  check (rule_percent_off is null or (rule_percent_off > 0 and rule_percent_off < 100));

-- ── Verify ──────────────────────────────────────────────────────────────────
-- The column and its guard:
--   select column_name, data_type from information_schema.columns
--    where table_name = 'price_lists' and column_name = 'rule_percent_off';
-- The constraint refuses the two ends:
--   update public.price_lists set rule_percent_off = 100;  -- must fail
--   update public.price_lists set rule_percent_off = 0;    -- must fail
