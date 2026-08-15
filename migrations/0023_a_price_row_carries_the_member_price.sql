-- ============================================================================
-- 0023 — a price row can say what a member pays
--
-- 0022 gave a row an `amount` and a `compare_at`. The product form has THREE
-- figures — price, member price, compare-at — so the pricing screen could
-- express two of the three, and the missing one was the one this store actually
-- uses on every product.
--
-- The workaround was real but unobvious: put member pricing on the Members
-- LIST, as a second row. That is the right shape for a store where members get
-- a different assortment or a different schedule. It is the wrong shape for
-- "this jacket is $40, or $35 if you are a member", which is one decision about
-- one product and should be one row.
--
-- ── HOW THIS AVOIDS BECOMING AMBIGUOUS ──────────────────────────────────────
--
-- Two stages, and they never compete:
--
--   1. WHICH ROW WINS is unchanged — list priority, then specificity, then the
--      later start, then id. Membership does not enter into it.
--   2. WITHIN the winning row, a member pays member_price when it is set and
--      lower than amount; everybody else pays amount.
--
-- So a Members-list row and a member_price on a Default-list row cannot fight:
-- stage 1 picks one row, and only that row's figures are read. It is the same
-- two-stage shape colourway pricing already uses (0021), which is the point —
-- one rule to learn rather than two that look alike.
--
-- member_price ABOVE amount is ignored rather than honoured, exactly as it is
-- on products and colourways. Charging somebody more for being a member is
-- never what was meant, and it is what a transposed pair of numbers produces.
--
-- The register gains the same pair, because "the price moved from $40 to $38"
-- is a different statement from "the member price moved from $35 to $30", and a
-- register that cannot tell them apart is answering the wrong question a year
-- later.
--
-- NULLABLE, so every row written under 0022 keeps behaving identically: no
-- member figure means members pay `amount`, which is what they were already
-- paying.
-- ============================================================================

alter table if exists public.prices
  add column if not exists member_price numeric(10,2)
    check (member_price is null or member_price >= 0);

comment on column public.prices.member_price is
  'What a signed-in member pays when THIS row wins. NULL means members pay '
  'amount. Only consulted after the winning row is chosen — see '
  '_price-resolution.js — so it can never compete with a Members price list. '
  'Ignored when it is higher than amount, as on products and colourways.';

alter table if exists public.price_audit
  add column if not exists from_member_amount numeric(10,2),
  add column if not exists to_member_amount   numeric(10,2);

comment on column public.price_audit.to_member_amount is
  'The member figure this change set, if any. Kept beside to_amount because '
  '"the price moved" and "the member price moved" are different statements and '
  'a register that conflates them cannot answer either.';

-- ── Verify ──────────────────────────────────────────────────────────────────
--   -- Nothing has a member figure immediately after this runs:
--   select count(*) filter (where member_price is not null) as with_member,
--          count(*) as rows from prices;
--
--   -- Rows where a member would pay MORE — should always be empty. The
--   -- resolver ignores these, but their existence means somebody typed the two
--   -- numbers the wrong way round and believes members are getting a discount.
--   select id, amount, member_price from prices
--    where member_price is not null and member_price >= amount;
