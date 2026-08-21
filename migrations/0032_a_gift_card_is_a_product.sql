-- ============================================================================
-- 0032 — a gift card is a product you can put in a bag
--
-- 0030 built the instrument: a code, a balance, a hold, a capture. 0031's work
-- made an order findable. What has never existed is the ordinary way anybody
-- gets a gift card — buying one. Until now the only way a code came into being
-- was an admin issuing it by hand from the Coupons page, which answers "make it
-- right for this customer" and does not answer "can we buy 40 of these for the
-- team", which is the question that put gift cards on the audit.
--
-- ── FACE VALUE IS A COLUMN, NOT THE PRICE ───────────────────────────────────
--
-- The obvious shortcut is to make the card worth whatever was charged for the
-- line. It is wrong in one direction and dangerous in the other.
--
--   WRONG:      a member paying $45 for a $50 card should get $50. Under
--               "worth what you paid" the discount silently eats the gift.
--   DANGEROUS:  a 20% promo on a $100 card would mean paying $80 for $100 of
--               spendable balance. Run that in a loop and the store pays the
--               customer. It is not a hypothetical — it is the first thing
--               anybody tries.
--
-- So the value is stated here, and gift card lines are excluded from promotions
-- and member pricing in _cart-pricing.js. Those two facts have to travel
-- together: this column without that exclusion IS the arbitrage.
--
-- ── ONE COLUMN, BECAUSE TWO COULD DISAGREE ──────────────────────────────────
--
-- A boolean `is_gift_card` plus a separate `value_cents` can be half-set — a
-- card marked as a card with no value, or a value on something that ships. A
-- single nullable integer cannot: NULL means this is a normal product, and any
-- positive number means it is a gift card worth exactly that much. There is no
-- third state to handle and no pair to keep in step.
--
-- Denominations are separate product rows — $25, $50, $100 — which is what the
-- catalogue, the grid, the bag and the admin already know how to draw. Nothing
-- new renders, nothing new gets priced.
--
-- ── WHAT A GIFT CARD IS NOT ─────────────────────────────────────────────────
--
-- It does not ship, so it takes no shipping charge and needs no label. It has
-- no stock, so nothing is decremented and it can never sell out. And it is NOT
-- TAXABLE at purchase — tax is charged when the card is SPENT, on whatever it
-- buys, and charging it at both ends charges it twice. That last one needs no
-- new machinery: products.tax_category already accepts 'exempt', which _tax.js
-- has always understood as "Not taxable".
--
-- The check below refuses a card that would be taxed, because a gift card sold
-- with tax on it is a refund and an apology, and the constraint is cheaper than
-- remembering.
-- ============================================================================

alter table public.products
  add column if not exists gift_card_cents integer;

comment on column public.products.gift_card_cents is
  'NULL for a normal product. A positive number means this product IS a gift '
  'card worth that many cents: it does not ship, holds no stock, is exempt from '
  'tax at purchase, and is excluded from promotions and member pricing. See '
  'migration 0032 for why the value lives here rather than in the price.';

alter table public.products
  drop constraint if exists products_gift_card_cents_positive;
alter table public.products
  add constraint products_gift_card_cents_positive
  check (gift_card_cents is null or gift_card_cents > 0);

/* A gift card taxed at purchase is taxed again when it is spent. The store
   cannot un-charge the first one without a refund, so this is refused at the
   database rather than left to whoever fills the form. */
alter table public.products
  drop constraint if exists products_gift_card_is_tax_exempt;
alter table public.products
  add constraint products_gift_card_is_tax_exempt
  check (gift_card_cents is null or tax_category = 'exempt');

create index if not exists products_gift_card_idx
  on public.products (gift_card_cents)
  where gift_card_cents is not null;
