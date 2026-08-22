-- ============================================================================
-- 0035 — a gift card can be sold in several amounts
--
-- 0032 said this, in its own header: "Denominations are separate product rows —
-- $25, $50, $100 — which is what the catalogue, the grid, the bag and the admin
-- already know how to draw. Nothing new renders, nothing new gets priced."
--
-- That was true and it was cheap, and it is being changed on purpose, so the
-- reason belongs here rather than in a commit message.
--
-- Four product rows means four SKUs to keep in step, four sets of photographs,
-- four review threads for one thing people have opinions about, four rows in
-- every catalogue page and grid, and a shopper who has to go BACK to the
-- collection to change their mind about $50. It also makes the buyer-priced
-- amount added since then look like a fifth product rather than the same
-- choice. Every modern store puts the amounts on one page, because a gift card
-- has one identity and several values, which is the definition of a variant.
--
-- ── WHY THIS IS NOT A PRICE LIST ────────────────────────────────────────────
--
-- Migration 0022 already has price lists, effective dates and approvals, and
-- none of that is what this is. A price list answers "what does this cost for
-- whom, and from when". This answers "which amounts is this card sold in",
-- which the SHOPPER picks from and which are all simultaneously true. Modelling
-- it as prices would mean four live prices on one product with no rule for
-- choosing between them.
--
-- ── AND WHY IT IS NOT A CONSTRAINT ON THE FACE VALUE ────────────────────────
--
-- gift_card_cents stays exactly what it was: the amount the card is worth when
-- nobody chooses. It is still what makes this row a gift card at all — the
-- single nullable integer with no second state to disagree with, from 0032 —
-- and the denominations are a display list layered over it, not a replacement.
-- A card with an empty list behaves precisely as it did before this ran.
--
-- The check below is deliberately shallow: positive numbers, at most eight of
-- them. It does NOT check them against gift_card_cents, or against the free
-- entry bounds, or against each other. What a card may be sold for is decided
-- at the till by _cart-pricing.js, which is the only place that knows what was
-- actually charged — the same reasoning that keeps the mint guard out of the
-- database in 0032. A database that also had an opinion here would be a second
-- authority on the one number that must have exactly one.
--
-- The amount a buyer picks becomes BOTH the price and the face value, from one
-- input, on the server. That is the whole reason a chosen figure is safe, and
-- an exact match against this list is what makes a chip safe when free entry
-- is switched off.
-- ============================================================================

alter table public.products
  add column if not exists gift_card_denominations integer[];

comment on column public.products.gift_card_denominations is
  'The amounts, in CENTS, this gift card is offered in on its product page. '
  'NULL or empty means the card sells at its listed price only. Picking one '
  'sets both the price and the face value from a single number — see '
  'functions/api/_cart-pricing.js. Not a price list (migration 0022): these are '
  'all true at once and the shopper chooses. Ignored entirely on a product that '
  'is not a gift card.';

/* Positive, and few enough to read as a row of buttons. Eight is where a
   storefront needs a dropdown instead, and the twenty-first would be off the
   bottom of a phone. Nothing here compares them to the price: what a card may
   be sold for is settled at the till, which is the only place that knows what
   was charged.

   ── WHY THIS IS `0 < all (...)` AND NOT A COUNT ───────────────────────────
   The obvious way to say "every element is positive" is to unnest the array
   and count the ones that are not. Postgres refuses it outright:

       cannot use subquery in check constraint

   A CHECK may only look at the row in front of it, and `(select ... from
   unnest(...))` is a subquery even though it reads nothing but this column.
   The quantified form is not — `0 < all (array)` is a scalar compared against
   an array, evaluated in place, and it says the same thing.

   It is also correct on the two edges that matter. Over an empty array `{}`
   the comparison is vacuously TRUE, and array_length answers NULL there rather
   than 0, which is why the length test is wrapped in coalesce: without it an
   empty array made the whole expression NULL, and a NULL check passes by
   accident rather than on purpose. */
alter table public.products
  drop constraint if exists products_gift_card_denominations_sane;
alter table public.products
  add constraint products_gift_card_denominations_sane
  check (
    gift_card_denominations is null
    or (
      coalesce(array_length(gift_card_denominations, 1), 0) <= 8
      and 0 < all (gift_card_denominations)
    )
  );
