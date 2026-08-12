-- ============================================================================
-- 0013 — putting stock back has to find the same row that took it out
--
-- Symptom: "Size/color row not found for ZW-UTP-002" when restocking a returned
-- M / Cyan, on an order that sold and decremented perfectly well.
--
-- Cause: the restock modal in admin-returns-ui.js looked the row up itself, with
--        ... .eq('size', op.size).eq('color_name', op.color)
-- which is exactly the matching that migration 0007 removed from
-- decrement_stock, for exactly this reason. Case-sensitive, whitespace-
-- sensitive, no size folding, and no fallback for the colour-agnostic rows that
-- legacy products use. So a garment stored as "cyan" is unreachable from a
-- return that says "Cyan", and a product with one row per size and
-- color_name NULL is unreachable from any return at all.
--
-- 0007 fixed this for the SELL side and wrote down the rule. The restock side
-- was a fourth copy nobody updated — the same shape of fault this codebase keeps
-- finding, where one question has several answerers and only some get the fix.
--
-- The consequence is quieter than the sell-side bug and lasts longer. A refund
-- is issued, the customer is made whole, the garment is physically back on the
-- shelf — and the storefront still believes it is sold out. It never comes back
-- for sale until somebody edits stock by hand, and nothing anywhere says so.
--
-- THE FIX: extract the row-finding into one function and have both sides call
-- it. Not "make restock match decrement" — they would drift again. One
-- definition of which row describes a given garment, used by the thing that
-- takes stock away and the thing that puts it back.
-- ============================================================================

-- ── The rule, once ──────────────────────────────────────────────────────────
-- Lifted verbatim from decrement_stock as written by 0007. Same normalising,
-- same fallback, same refusal to guess.
CREATE OR REPLACE FUNCTION public.zw_find_size_row(
  p_product_id uuid,
  p_size text,
  p_color_name text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF p_product_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- 1) The colour actually named, matched the way the storefront matches it.
  IF p_color_name IS NOT NULL AND btrim(p_color_name) <> '' THEN
    SELECT id INTO v_id
    FROM product_sizes
    WHERE product_id = p_product_id
      AND zw_canon_size(size) = zw_canon_size(p_size)
      AND lower(btrim(coalesce(color_name, ''))) = lower(btrim(p_color_name))
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  -- 2) Colour-agnostic rows ONLY. A row with color_name NULL genuinely covers
  --    every colourway. Another COLOUR's row describes a different garment, and
  --    reaching for it is what made a sold colour never go down while an unsold
  --    one drained to zero.
  IF v_id IS NULL THEN
    SELECT id INTO v_id
    FROM product_sizes
    WHERE product_id = p_product_id
      AND zw_canon_size(size) = zw_canon_size(p_size)
      AND color_name IS NULL
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  RETURN v_id;   -- NULL means nothing describes this garment. Say so; do not guess.
END;
$function$;

COMMENT ON FUNCTION public.zw_find_size_row(uuid, text, text) IS
  'Which product_sizes row describes this garment. The ONE definition — used by '
  'decrement_stock (a sale) and restock_stock (a return). Colour compared '
  'normalised, size folded, falling back only to colour-agnostic (NULL) rows, '
  'never to another colour. NULL when nothing matches.';

-- ── Selling: unchanged behaviour, now delegating ────────────────────────────
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

  v_id := zw_find_size_row(p_product_id, p_size, p_color_name);

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

-- ── Returning: the same row, going the other way ────────────────────────────
-- Deliberately NOT SECURITY DEFINER. The admin already updates product_sizes
-- directly from this screen, so RLS grants exactly the rights this needs; a
-- definer function would hand the same power to anyone who could reach the RPC
-- and would be a wider door than the one it replaces.
CREATE OR REPLACE FUNCTION public.restock_stock(
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

  v_id := zw_find_size_row(p_product_id, p_size, p_color_name);

  IF v_id IS NULL THEN
    RAISE WARNING 'restock_stock: no row for product % size % colour %',
      p_product_id, p_size, coalesce(p_color_name, '(none)');
    RETURN 0;
  END IF;

  -- No upper clamp: stock coming back from a return is a real count, and a
  -- ceiling here would silently swallow it.
  UPDATE product_sizes
  SET stock_quantity = coalesce(stock_quantity, 0) + p_qty
  WHERE id = v_id;

  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed;
END;
$function$;

COMMENT ON FUNCTION public.restock_stock(uuid, text, integer, text) IS
  'Put returned stock back on the row a sale would have taken it from. Returns '
  'rows changed (0 or 1) — 0 means nothing matched and the caller must say so '
  'rather than report a restock that did not happen.';

GRANT EXECUTE ON FUNCTION public.zw_find_size_row(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restock_stock(uuid, text, integer, text) TO authenticated;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   The case that failed: a return saying "Cyan" against a row saying "cyan".
--     select zw_find_size_row('<product-uuid>', 'M', 'Cyan');
--   should return the same id as
--     select zw_find_size_row('<product-uuid>', 'm', ' cyan ');
--   and a size stored as "2XL" should be found by "XXL".
