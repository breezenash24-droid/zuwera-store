-- ─────────────────────────────────────────────────────────────────────────────
-- Fix: purchases weren't decrementing stock for coloured products
-- ─────────────────────────────────────────────────────────────────────────────
-- The stripe webhook calls decrement_stock(product_id, size, qty, color_name) on a
-- successful purchase. The OLD version did an exact `color_name = p_color_name`
-- match when a colour was passed. But the admin saves stock color-agnostically
-- (product_sizes.color_name is NULL for every row), while checkout passes the
-- selected colourway (e.g. "White"). So the match found ZERO rows and silently
-- decremented nothing — stock never went down on a purchase.
--
-- New behaviour: try an exact colour match first; if none exists (the normal case,
-- since rows are colour-agnostic), fall back to the product+size row regardless of
-- colour. Exactly one row is decremented, floored at 0. Works whether stock is
-- tracked per-colour or color-agnostic.
--
-- Idempotent (CREATE OR REPLACE). Run once in the Supabase SQL editor.
CREATE OR REPLACE FUNCTION public.decrement_stock(
  p_product_id uuid,
  p_size text,
  p_qty integer,
  p_color_name text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  -- 1) Prefer an exact colour match when a colour is supplied.
  IF p_color_name IS NOT NULL AND p_color_name <> '' THEN
    SELECT id INTO v_id
    FROM product_sizes
    WHERE product_id = p_product_id
      AND size = p_size
      AND color_name = p_color_name
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  -- 2) Fall back to the product+size row regardless of colour. This covers stock
  --    stored with color_name NULL (how the admin currently saves it), which is why
  --    the old exact-match branch never matched.
  IF v_id IS NULL THEN
    SELECT id INTO v_id
    FROM product_sizes
    WHERE product_id = p_product_id
      AND size = p_size
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  IF v_id IS NOT NULL THEN
    UPDATE product_sizes
    SET stock_quantity = GREATEST(0, stock_quantity - p_qty)
    WHERE id = v_id;
  END IF;
END;
$function$;
