-- ============================================================================
-- 0022 — pricing becomes its own system, separate from merchandising
--
-- Until now a price was a column on the thing it priced: products.current_price,
-- and after 0021 color_variants.current_price. Whoever could edit a product
-- could change what it cost, immediately, with no record of the old figure and
-- nobody's approval. The admin audit log did record `product.update` — but its
-- metadata carries sku, title, status and image counts, and NO price fields at
-- all. So a price change today leaves a row saying somebody edited a product,
-- which cannot tell you the price moved, let alone from what to what.
--
-- That gap is unrecoverable in the same way delivered_at and the click ids
-- were: the old price is gone the moment it is overwritten.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────
--
--   price_lists   WHO a price is for — channel, region, customer group.
--   prices        WHAT something costs on a list, BETWEEN two dates, in a
--                 workflow state (proposed → approved → live).
--   price_audit   WHO changed it, WHEN, FROM what TO what, and who approved.
--
-- ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
--
-- It does not remove products.current_price or color_variants.current_price.
-- Those stay as the FALLBACK, and the resolver returns them whenever no price
-- row applies. Three reasons, and the third is the real one:
--
--   1. Nothing has to be migrated on the day this is applied. Every product
--      keeps its price and the store behaves identically.
--   2. An empty pricing system prices the catalogue correctly rather than
--      pricing it at zero, which is the failure that would take the store down.
--   3. A store that never opens this screen never pays for it.
--
-- ── SELF-APPROVAL IS ALLOWED, AND RECORDED AS SUCH ──────────────────────────
--
-- An approval workflow needs a second person. This store has one owner and a
-- manager, so requiring a different approver would make the system unusable on
-- the day it ships — and an unusable control gets switched off, which is worse
-- than a recorded one.
--
-- So approving your own change is permitted and stamped: price_audit.self_approved
-- is true when approver = proposer. `require_second_approver` on the list turns
-- it into a hard rule the day there is somebody to be the second pair of eyes.
-- The register is honest either way, which is the part that answers "who
-- approved this" a year later.
-- ============================================================================

-- ── WHO a price is for ──────────────────────────────────────────────────────
create table if not exists public.price_lists (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,          -- 'default', 'members', 'wholesale'
  name        text not null,
  -- NULL means "any". A list with all three null applies to everybody, which is
  -- what the default list is.
  channel         text,                      -- 'web', 'pos', …
  region          text,                      -- 'US', 'EU', …
  customer_group  text,                      -- 'member', 'wholesale', …
  -- Highest priority wins when more than one list matches a shopper. Ties are
  -- broken by specificity then by recency in the resolver, deterministically —
  -- two lists that could both apply must never resolve differently run to run.
  priority    integer not null default 0,
  active      boolean not null default true,
  require_second_approver boolean not null default false,
  created_at  timestamptz not null default now(),
  created_by  uuid
);

comment on table public.price_lists is
  'Who a price applies to: channel, region, customer group. NULL on any of those '
  'means "any". Priority breaks ties, highest first. See _price-resolution.js.';

-- The list everything falls back to. Seeded here so an empty system still has a
-- shape, and so the admin screen has somewhere to put a plain price.
insert into public.price_lists (code, name, priority, active)
values ('default', 'Default', 0, true)
on conflict (code) do nothing;

-- The members list mirrors what member_price already expresses, so the two ways
-- of saying it cannot disagree: this list is seeded INACTIVE and is only
-- consulted once somebody switches it on and puts prices in it.
insert into public.price_lists (code, name, customer_group, priority, active)
values ('members', 'Members', 'member', 10, false)
on conflict (code) do nothing;

-- ── WHAT something costs, when, and in what state ───────────────────────────
create table if not exists public.prices (
  id               uuid primary key default gen_random_uuid(),
  price_list_id    uuid not null references public.price_lists(id) on delete cascade,
  product_id       uuid not null references public.products(id) on delete cascade,
  -- NULL = every colourway of this product. A row naming a colour beats a row
  -- that does not, which is how "this product is $220, but crimson is $176.97"
  -- is expressed without listing every other colour.
  color_variant_id uuid references public.color_variants(id) on delete cascade,

  amount       numeric(10,2) not null check (amount >= 0),
  compare_at   numeric(10,2) check (compare_at is null or compare_at >= 0),

  -- NULL start = "already in effect". NULL end = "until further notice".
  starts_at    timestamptz,
  ends_at      timestamptz,

  -- proposed → approved (live) | rejected. superseded is set when a later
  -- approved row covers the same ground, so history stays readable.
  status       text not null default 'proposed'
                 check (status in ('proposed', 'approved', 'rejected', 'superseded')),

  note         text,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  approved_by  uuid,
  approved_at  timestamptz,
  rejected_by  uuid,
  rejected_at  timestamptz,

  -- An end before a start is not a window, it is a typo that silently prices
  -- nothing. Refused at the door rather than debugged later.
  constraint prices_window_ordered check (ends_at is null or starts_at is null or ends_at > starts_at)
);

comment on table public.prices is
  'What something costs on a price list, between two dates, in a workflow state. '
  'Only status=approved rows inside their window are ever charged. NULL '
  'color_variant_id means every colourway. When nothing here applies, the '
  'resolver falls back to color_variants.current_price then products.current_price '
  '— so an empty pricing system prices the catalogue exactly as it did before.';

-- The resolver's own query: live rows for a product, newest first.
create index if not exists prices_live_idx
  on public.prices (product_id, price_list_id, starts_at desc)
  where status = 'approved';

create index if not exists prices_pending_idx
  on public.prices (created_at desc) where status = 'proposed';

create index if not exists prices_variant_idx
  on public.prices (color_variant_id) where color_variant_id is not null;

-- ── WHO changed it, and what it was before ──────────────────────────────────
-- Append-only. The `from_*` columns are the point: without them this records
-- that something happened rather than what changed, which is the gap the
-- existing admin_audit_log has for prices today.
create table if not exists public.price_audit (
  id            bigserial primary key,
  at            timestamptz not null default now(),
  actor_id      uuid,
  actor_email   text,
  action        text not null
                  check (action in ('proposed', 'approved', 'rejected', 'edited', 'superseded', 'direct_change')),
  price_id      uuid,
  price_list_code  text,
  product_id    uuid,
  product_title text,                        -- denormalised: a product may later be deleted
  color_name    text,
  from_amount   numeric(10,2),
  to_amount     numeric(10,2),
  from_compare_at numeric(10,2),
  to_compare_at   numeric(10,2),
  starts_at     timestamptz,
  ends_at       timestamptz,
  -- True when the approver is the proposer. Permitted by design at this size,
  -- and recorded so the register never implies a second pair of eyes that was
  -- not there.
  self_approved boolean not null default false,
  note          text
);

comment on table public.price_audit is
  'Append-only record of every price movement: who, when, from what to what, and '
  'who approved. self_approved marks a change approved by the person who '
  'proposed it — allowed at this size and never disguised. Also records '
  'direct_change, which is a price edited straight on the product form rather '
  'than through the pricing system.';

create index if not exists price_audit_at_idx      on public.price_audit (at desc);
create index if not exists price_audit_product_idx on public.price_audit (product_id, at desc);

-- ── Row-level security ──────────────────────────────────────────────────────
alter table public.price_lists enable row level security;
alter table public.prices      enable row level security;
alter table public.price_audit enable row level security;

-- Storefront reads NOTHING here directly. Prices reach a browser only through
-- /api/prices, which resolves them server-side — the same shape the tax rate
-- took when the client rate table was removed, and for the same reason: a
-- number the browser computes is a number that can disagree with the charge.
drop policy if exists "price lists are server-side" on public.price_lists;
create policy "price lists are server-side" on public.price_lists
  for all using (false) with check (false);

drop policy if exists "prices are server-side" on public.prices;
create policy "prices are server-side" on public.prices
  for all using (false) with check (false);

-- The register is READABLE by an admin holding the pricing page, because a
-- record nobody can read is not a record. It is never writable from a browser:
-- every row is written by /api/admin-prices with the service key, so an admin
-- cannot edit their own history.
drop policy if exists "price audit readable by pricing admins" on public.price_audit;
create policy "price audit readable by pricing admins" on public.price_audit
  for select to authenticated
  using (public.current_user_can_page('pricing'));

drop policy if exists "price audit is append-only from the server" on public.price_audit;
create policy "price audit is append-only from the server" on public.price_audit
  for insert to authenticated with check (false);

revoke update, delete on public.price_audit from anon, authenticated;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   -- Two lists, no prices, nothing charged differently:
--   select code, name, priority, active from price_lists order by priority desc;
--   select count(*) from prices;              -- 0 immediately after this runs
--
--   -- What is live right now, per product:
--   select p.title, cv.color_name, pl.code, pr.amount, pr.starts_at, pr.ends_at
--     from prices pr
--     join price_lists pl on pl.id = pr.price_list_id
--     join products p on p.id = pr.product_id
--     left join color_variants cv on cv.id = pr.color_variant_id
--    where pr.status = 'approved'
--      and (pr.starts_at is null or pr.starts_at <= now())
--      and (pr.ends_at is null or pr.ends_at > now())
--    order by p.title, pl.priority desc;
--
--   -- Waiting on somebody:
--   select count(*) from prices where status = 'proposed';
--
--   -- THE ONE TO WATCH: changes nobody else saw.
--   select at, actor_email, product_title, color_name, from_amount, to_amount
--     from price_audit where self_approved order by at desc limit 50;
