-- ============================================================================
-- 0009 — a product can only be deleted through the endpoint that checks limits
--
-- The "Deleting products" limit could not refuse anything, because the panel
-- deleted straight from the browser: four Supabase calls, no server in
-- between, nothing to ask. /api/admin-product-delete now does it and consults
-- the limits first — but an endpoint is only the polite route while the client
-- still holds the permission to do it itself. Anybody who can open a console
-- can skip past a check that lives in JavaScript.
--
-- So the permission goes. Authenticated sessions cannot DELETE from `products`
-- at all; the endpoint uses the service role, which bypasses RLS, and is now
-- the only way a product row can disappear.
--
-- WHY THIS TABLE AND NOT THE OTHERS. Nothing legitimate deletes a product from
-- the browser — it is one button with a confirm. Its CHILDREN are different:
-- removing an image or a colour while editing deletes from product_images and
-- color_variants, and blocking those would break the editor. They stay open,
-- and the endpoint cleans them up when it removes the parent.
--
-- The asymmetry is worth stating because it is the general shape: a limit can
-- be made to actually bind only where the browser has no legitimate reason to
-- hold the permission. Where it does — reading customer profiles, say — the
-- endpoint bounds the convenient path and no more, and it should say so rather
-- than imply a wall.
--
-- RESTRICTIVE, so it ANDs with whatever admin policy already exists rather
-- than replacing it. Reads, inserts and updates are untouched: this removes
-- exactly one verb.
-- ============================================================================

DROP POLICY IF EXISTS "Products delete via endpoint only" ON public.products;
CREATE POLICY "Products delete via endpoint only"
  ON public.products AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

-- ── How to check it worked ──────────────────────────────────────────────────
-- In the browser console on the admin page, signed in as any admin, against a
-- product id you do NOT mind losing if this has not applied:
--
--   await sb.from('products').delete().eq('id', '<some-id>')
--
-- Before: it deletes. After: a row-level security error, and the Delete button
-- in the panel still works because it goes through /api/admin-product-delete.
--
-- If the panel's Delete stops working after running this, the deploy carrying
-- the endpoint has not landed yet — the two go together.
