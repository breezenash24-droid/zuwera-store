-- ============================================================================
-- 0017 — the database enforces the permissions the admin page already shows
--
-- RBAC is real in the UI: a staff member set to "orders: none" sees no Orders
-- page. It is not real in the database. The row-level policy on `orders` is
--
--     USING (current_user_is_admin())
--
-- and that function asks one question — profiles.role = 'admin' — ignoring
-- admin_role and admin_permissions entirely. So anyone who is an admin AT ALL
-- can open the browser console and run
--
--     sb.from('orders').select('*')
--
-- and read every customer's name, email, shipping address and order total,
-- whatever their permissions say. The page hides it; the database hands it over.
-- The admin panel talks to Supabase directly, so there is no server in that
-- path to check anything — RLS is the only enforcement point there is.
--
-- WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT.
--
-- Somebody with an EXPLICIT permission map is now held to it by the database.
-- Somebody without one is unchanged — still an admin, still allowed. That is a
-- partial fix on purpose, and the reason is worth writing down: resolving a
-- role PRESET (manager, staff, …) into page permissions would mean a second
-- copy of the permission model in SQL, which is exactly the duplication that
-- has produced silent divergence everywhere else in this codebase. A copy that
-- drifts would either lock a real admin out or quietly re-open this hole, and
-- both are worse than the narrower fix.
--
-- The complete fix is to store the RESOLVED page list on the profile when it is
-- saved, so SQL reads a flat array and JS stays the only place that resolves
-- anything. That is a change to the write path and belongs on its own.
--
-- CHECKED BEFORE WRITING THIS. Two admins exist: one super_admin (passes on the
-- first branch) and one manager whose explicit map contains "orders": "view"
-- (passes on the third). Nobody loses access.
-- ============================================================================

create or replace function public.current_user_can_page(p_page text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
      and (
        -- Super admins hold every page, as they do in resolvePerms().
        admin_role = 'super_admin'
        -- No explicit map: unchanged from before this migration. See the note
        -- above — inferring one from a role preset would duplicate the model.
        or admin_permissions -> 'pages' is null
        -- Explicit map: 'view' and 'edit' both grant read, 'none' and a missing
        -- key do not. Same two levels resolvePerms() treats as access.
        or coalesce(admin_permissions -> 'pages' ->> p_page, '') in ('view', 'edit')
      )
  );
$function$;

comment on function public.current_user_can_page(text) is
  'Does the signed-in admin hold this page? Mirrors resolvePerms() in _rbac.js '
  'for explicit permission maps. An admin with no map is allowed, deliberately: '
  'resolving role PRESETS here would mean a second copy of the permission '
  'model in SQL. See migrations/0017 for why that trade was made.';

-- ── Orders: the one that carries customer PII ───────────────────────────────
-- Same policy, one question tighter. Customers keep their own-order access
-- untouched — that policy is separate and is not modified here.
drop policy if exists "Admin full access" on public.orders;
create policy "Admin full access" on public.orders
  for all
  to authenticated
  using (public.current_user_can_page('orders'))
  with check (public.current_user_can_page('orders'));

-- ── Verify ──────────────────────────────────────────────────────────────────
--   -- Who would still be able to read orders, and why:
--   select id, admin_role,
--          admin_role = 'super_admin'                                as by_super,
--          admin_permissions->'pages' is null                        as by_no_map,
--          admin_permissions->'pages'->>'orders' in ('view','edit')  as by_grant
--     from profiles where role = 'admin';
--   -- Every admin should be true in at least one column. If one is false in
--   -- all three, they have just lost the Orders page — intended if their
--   -- permissions say so, and worth confirming before you walk away.
