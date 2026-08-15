-- ============================================================================
-- 0021 — a colourway can cost something different
--
-- Price lives on `products`; colour lives in `color_variants`. So every
-- colourway of a product has had to cost exactly the same, and none of them
-- could be discounted on its own. That is not how the thing being modelled
-- works — a limited colour, a collaboration, or last season's colour left in
-- the run are routinely different money.
--
-- The workaround available today is to split one product into several, and it
-- is worse than the problem: the swatch row breaks apart, reviews scatter across
-- the copies, and per-colour stock in product_sizes stops lining up with the
-- product it belongs to.
--
-- ── WHERE PRICE BELONGS ─────────────────────────────────────────────────────
--
-- On the thing that can be BOUGHT, not on the thing that is browsed. A shopper
-- browses a product and buys a colour in a size. Every commerce platform that
-- got this right put price on the variant for that reason — Shopify has no
-- product-level price at all, only a derived "from" figure.
--
-- This migration does not go the whole way there. Size is not priced here, only
-- colour, because sizes of one colourway costing different amounts is not a
-- thing this store does and columns added "while we are here" are how tables
-- acquire fields nothing writes. product_sizes is where that would go later.
--
-- ── ALL-OR-NOTHING, ON PURPOSE ──────────────────────────────────────────────
--
-- current_price is the switch. Set it, and this row's member_price and msrp
-- apply too — including when they are NULL. Leave it NULL and every figure
-- comes from the product.
--
-- The alternative, falling back field by field, produces the worst bug
-- available here: a premium colourway at $250 inheriting the product's $35
-- member price, so members buy the expensive colour for less than the cheap one.
-- Field-by-field reads as the more helpful design and is exactly why that would
-- happen quietly. See functions/api/_variant-price.js.
--
-- NULLABLE, NO DEFAULTS, so every existing colourway keeps inheriting and
-- nothing changes price on the day this is applied.
-- ============================================================================

alter table if exists public.color_variants
  add column if not exists current_price numeric(10,2),
  add column if not exists member_price  numeric(10,2),
  add column if not exists msrp          numeric(10,2);

comment on column public.color_variants.current_price is
  'What this colourway costs, overriding products.current_price. NULL means '
  'inherit every price from the product. Setting this makes the row''s '
  'member_price and msrp apply as well, INCLUDING when they are NULL — see '
  'functions/api/_variant-price.js for why inheritance is all-or-nothing.';

comment on column public.color_variants.member_price is
  'Member price for this colourway. Only consulted when current_price is set on '
  'the same row. A colour with its own price and no member price simply has no '
  'member discount — deliberate, and the safe direction.';

comment on column public.color_variants.msrp is
  'Compare-at price for this colourway, for the struck-through figure. Only '
  'consulted when current_price is set on the same row.';

-- Grids ask "cheapest colour of this product" to render "from $X".
create index if not exists color_variants_priced_idx
  on public.color_variants (product_id, current_price)
  where current_price is not null;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   -- Nothing should be priced immediately after this runs:
--   select count(*) filter (where current_price is not null) as priced,
--          count(*)                                          as colourways
--     from color_variants;
--
--   -- Colourways priced differently from their product, once some are set:
--   select p.title, c.color_name, p.current_price as product_price,
--          c.current_price as colour_price, c.member_price
--     from color_variants c join products p on p.id = c.product_id
--    where c.current_price is not null
--    order by p.title, c.sort_order;
--
--   -- THE ONE TO WATCH: a colour with its own price and no member price has no
--   -- member discount. Expected, but worth seeing the list before a launch.
--   select p.title, c.color_name, c.current_price
--     from color_variants c join products p on p.id = c.product_id
--    where c.current_price is not null and c.member_price is null;
