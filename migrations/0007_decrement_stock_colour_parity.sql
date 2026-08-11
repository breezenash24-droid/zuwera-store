-- ============================================================================
-- 0007 — the decrement has to find the same row the availability check counted
--
-- Symptom: a size showing "Only 1 left" stayed at 1 after it sold.
--
-- Cause, and it is two bugs stacked:
--
--   1. The colour was matched with `color_name = p_color_name` — exact, so
--      case- and whitespace-sensitive. A cart carrying "Yellow" against a row
--      saying "yellow" never matched. Not an edge case: it failed EVERY time
--      for any product whose stored colour casing differs from the swatch, so
--      the exact branch was effectively dead code.
--
--   2. Which meant the fallback ran on every purchase. And the fallback took
--      the OLDEST row for that product+size REGARDLESS OF COLOUR. So buying
--      Yellow decremented Black. The colour that sold never went down — it can
--      be oversold forever — and a colour nobody bought silently drained to
--      zero and disappeared from the storefront.
--
-- Both are the same mistake the JavaScript availability check had, fixed there
-- in fetchSizeStockQty (functions/api/_cart-pricing.js) and stock-rules.js.
-- This is the third copy, in the language the other two cannot check. It is
-- also the one that actually moves inventory, so it is the one where being
-- wrong costs stock rather than a page.
--
-- THE RULE, matching the JavaScript exactly:
--   * colour compared normalised (trimmed, lower-cased)
--   * size folded, so a cart's "XXL" finds a row stored as "2XL"
--   * fall back ONLY to colour-agnostic rows (color_name IS NULL), which
--     legitimately describe every colourway. NEVER to another colour's row —
--     that describes a different garment.
--   * if nothing matches, decrement NOTHING and say so, rather than taking a
--     guess at which garment just sold.
--
-- Returns the number of rows changed (0 or 1) so the webhook can tell a
-- successful decrement from a silent miss. That is the reason for the DROP:
-- Postgres will not change a function's return type in place.
-- ============================================================================

DROP FUNCTION IF EXISTS public.decrement_stock(uuid, text, integer, text);

-- Fold size labels the way the storefront and the payment path do: 2XL → XXL,
-- 3XS → XXXS. Without it a cart's display label misses a row stored in the
-- other form, and the miss lands in the same place every other miss does.
CREATE OR REPLACE FUNCTION public.zw_canon_size(p_size text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN s ~ '^([2-5])x(s|l)$' THEN repeat('x', (substring(s from 1 for 1))::int) || substring(s from 3)
    ELSE s
  END
  FROM (SELECT lower(regexp_replace(coalesce(p_size, ''), '\s', '', 'g')) AS s) t;
$function$;

CREATE OR REPLACE FUNCTION public.decrement_stock(
  p_product_id uuid,
  p_size text,
  p_qty integer,
  p_color_name text DEFAULT NULL::text
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_id      uuid;
  v_changed integer := 0;
BEGIN
  IF p_product_id IS NULL OR p_qty IS NULL OR p_qty <= 0 THEN
    RETURN 0;
  END IF;

  -- 1) The colour that was actually bought, matched the way the storefront
  --    matched it when it said the item was available.
  IF p_color_name IS NOT NULL AND btrim(p_color_name) <> '' THEN
    SELECT id INTO v_id
    FROM product_sizes
    WHERE product_id = p_product_id
      AND zw_canon_size(size) = zw_canon_size(p_size)
      AND lower(btrim(coalesce(color_name, ''))) = lower(btrim(p_color_name))
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  -- 2) Colour-agnostic rows only. Legacy products save one row per size with
  --    color_name NULL, and that row genuinely covers every colourway — so it
  --    is the right fallback. Another COLOUR's row is not, and taking from it
  --    is what made a sold colour never go down while an unsold one drained.
  IF v_id IS NULL THEN
    SELECT id INTO v_id
    FROM product_sizes
    WHERE product_id = p_product_id
      AND zw_canon_size(size) = zw_canon_size(p_size)
      AND color_name IS NULL
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  -- 3) No row describes what was sold. Decrementing a guess is how this broke;
  --    changing nothing and reporting 0 lets the webhook raise it instead.
  IF v_id IS NULL THEN
    RAISE WARNING 'decrement_stock: no row for product % size % colour %',
      p_product_id, p_size, coalesce(p_color_name, '(none)');
    RETURN 0;
  END IF;

  UPDATE product_sizes
  SET stock_quantity = GREATEST(0, coalesce(stock_quantity, 0) - p_qty)
  WHERE id = v_id;

  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed;
END;
$function$;
