-- ============================================================================
-- 0030 — gift cards and store credit are the same thing, so they are one table
--
-- Two items on the audit asked for the same machinery:
--
--   B1  no gift cards — no product type, no code issuance, no balance, no
--       redemption. "Can we buy 40 of these for the team?" had no answer.
--   A5  "store credit" was a returns dropdown option with nothing behind it.
--       It was REMOVED on 2026-08-20 rather than left as a promise, and the
--       real thing was put on the work queue.
--
-- A gift card is a balance somebody bought. Store credit is a balance somebody
-- was given. Everything after that sentence is identical: a code, a balance, a
-- way to spend it at the till, and a history of what happened to it. Building
-- them as two systems would mean two redemption paths in the one place where a
-- bug means money — so this is one instrument with a `kind` column.
--
-- ── WHY A LEDGER AND NOT A BALANCE COLUMN ───────────────────────────────────
--
-- A `balance_cents` column has to be read, decided about, and written back, and
-- two checkouts on the same card do that at the same time: both read 5000, both
-- write 0, and $100 of goods leave for $50. The same read-modify-write race
-- that produced the lost promo counts this codebase already fixed with
-- mutateSetting() and redeem_loyalty.
--
-- So the balance is not stored. It is the SUM of immutable entries, and every
-- change is an insert. There is no value to overwrite and therefore no race to
-- lose, and "where did the money go" is answerable, which a column can never be.
--
-- ── HOLDS, AND THE TWO WAYS TO GET THIS WRONG ───────────────────────────────
--
-- Spend at checkout START and an abandoned cart eats the customer's balance.
-- Spend at payment SUCCESS and two tabs can each be told the balance is
-- available, both charge the card for the remainder, and the card is short.
--
-- So a checkout takes a HOLD — an entry that counts against the balance
-- immediately and expires on its own. Payment succeeds: the hold becomes a
-- capture. Payment fails or the customer wanders off: it expires and the money
-- comes back without anybody having to remember to release it. An expiring hold
-- is the only version of this that survives a Worker dying mid-checkout.
--
-- ── EVERY OPERATION IS ONE STATEMENT ────────────────────────────────────────
--
-- The hold function checks the balance and writes the hold in a single INSERT
-- ... SELECT with the balance computed inline, so there is no window between
-- deciding and recording. Same shape as decrement_stock and redeem_loyalty.
--
-- ── SERVICE ROLE ONLY ───────────────────────────────────────────────────────
--
-- RLS is on and no policy is created, so PostgREST refuses everything and only
-- the service role — meaning only a Worker that has already priced the cart —
-- can touch any of it. A client that could call the redeem function could spend
-- somebody else's card; a client that could read the table could enumerate
-- codes. Balance lookups go through /api/stored-value, which is rate limited
-- and requires the full code.
-- ============================================================================

create table if not exists public.stored_value (
  id             uuid primary key default gen_random_uuid(),
  /* Uppercase, no vowels and no 0/1/O/I — a code gets read down a phone line
     and typed by somebody who is annoyed. Generated in _stored-value.js. */
  code           text not null unique,
  kind           text not null check (kind in ('gift_card', 'store_credit')),
  currency       text not null default 'usd',
  initial_cents  integer not null check (initial_cents > 0),
  status         text not null default 'active' check (status in ('active', 'void')),
  /* Store credit is usually bound to the person it was given to; a gift card is
     bearer paper and both are null. Enforcement of that lives in the Worker,
     not here — a constraint would make "issue a card to a customer" impossible
     to record. */
  owner_user_id  uuid references auth.users(id) on delete set null,
  owner_email    text,
  issued_by      uuid references auth.users(id) on delete set null,
  issued_reason  text,
  /* The order that bought the gift card, or the return that caused the credit.
     Text rather than a foreign key because orders are identified by number in
     half this codebase and by id in the other half. */
  source_ref     text,
  expires_at     timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists stored_value_owner_idx on public.stored_value (owner_user_id);
create index if not exists stored_value_email_idx on public.stored_value (lower(owner_email));

create table if not exists public.stored_value_entries (
  id              uuid primary key default gen_random_uuid(),
  stored_value_id uuid not null references public.stored_value(id) on delete cascade,
  /* issue   + the money going on
     hold    − a checkout reserving it, with an expiry
     capture − a hold that became a payment
     release + a hold given back before it expired
     refund  + money coming back after a return
     void    − the whole remaining balance being cancelled */
  kind            text not null check (kind in ('issue', 'hold', 'capture', 'release', 'refund', 'void')),
  /* SIGNED. An issue is positive, a hold and a capture are negative. The
     balance is the sum, so there is no branch anywhere that has to remember
     which way each kind points. */
  cents           integer not null,
  order_ref       text,
  /* The checkout that placed a hold. capture and release find their holds by
     this, which is also what makes a repeated capture harmless. */
  hold_ref        text,
  expires_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists sv_entries_value_idx on public.stored_value_entries (stored_value_id);
create index if not exists sv_entries_hold_idx  on public.stored_value_entries (hold_ref) where hold_ref is not null;

alter table public.stored_value enable row level security;
alter table public.stored_value_entries enable row level security;
revoke all on public.stored_value from anon, authenticated;
revoke all on public.stored_value_entries from anon, authenticated;

-- ── the balance, in one place ───────────────────────────────────────────────
--
-- An expired hold does not count. That is the whole reason a hold can be left
-- lying around when a Worker dies: it stops reducing the balance by itself,
-- with nothing scheduled and nobody remembering.
create or replace function public.zw_stored_value_balance_cents(p_id uuid)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(sum(cents), 0)::integer
  from stored_value_entries
  where stored_value_id = p_id
    and (kind <> 'hold' or expires_at is null or expires_at > now());
$$;

-- ── look one up ─────────────────────────────────────────────────────────────
create or replace function public.zw_stored_value_lookup(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare v stored_value%rowtype;
begin
  select * into v from stored_value where code = upper(trim(p_code));
  if not found then
    return jsonb_build_object('found', false);
  end if;
  return jsonb_build_object(
    'found', true,
    'id', v.id,
    'kind', v.kind,
    'currency', v.currency,
    'status', v.status,
    'expired', (v.expires_at is not null and v.expires_at <= now()),
    'expires_at', v.expires_at,
    'owner_user_id', v.owner_user_id,
    'owner_email', v.owner_email,
    'initial_cents', v.initial_cents,
    'balance_cents', zw_stored_value_balance_cents(v.id)
  );
end;
$$;

-- ── take a hold, atomically, for at most what is there ──────────────────────
--
-- Returns what it actually held, which may be less than asked for. A checkout
-- that asked for $80 against a $50 card is not an error — it is a $50 payment
-- and $30 on a card, and the caller needs the number rather than an exception.
--
-- The balance is computed inside the INSERT, so there is no moment between
-- reading it and writing the hold for a second checkout to fit into.
create or replace function public.zw_stored_value_hold(
  p_code    text,
  p_cents   integer,
  p_ref     text,
  p_seconds integer default 1800
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v        stored_value%rowtype;
  v_want   integer := greatest(0, coalesce(p_cents, 0));
  v_held   integer;
  v_exists integer;
begin
  select * into v from stored_value where code = upper(trim(p_code)) for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found', 'held_cents', 0); end if;
  if v.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'void', 'held_cents', 0); end if;
  if v.expires_at is not null and v.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired', 'held_cents', 0);
  end if;

  /* IDEMPOTENT BY REFERENCE. A checkout that retries — a dropped response, a
     customer pressing pay twice — must not take a second hold against the same
     card. The reference is the order number, so the second call finds the first
     call's hold and reports it rather than doubling it. */
  select coalesce(sum(-cents), 0) into v_exists
  from stored_value_entries
  where stored_value_id = v.id and kind = 'hold' and hold_ref = p_ref
    and (expires_at is null or expires_at > now());
  if v_exists > 0 then
    return jsonb_build_object('ok', true, 'held_cents', v_exists, 'reused', true,
                              'balance_cents', zw_stored_value_balance_cents(v.id));
  end if;

  v_held := least(v_want, zw_stored_value_balance_cents(v.id));
  if v_held <= 0 then
    return jsonb_build_object('ok', true, 'held_cents', 0, 'balance_cents', 0);
  end if;

  insert into stored_value_entries (stored_value_id, kind, cents, hold_ref, expires_at)
  values (v.id, 'hold', -v_held, p_ref, now() + make_interval(secs => greatest(60, coalesce(p_seconds, 1800))));

  return jsonb_build_object('ok', true, 'held_cents', v_held, 'reused', false,
                            'balance_cents', zw_stored_value_balance_cents(v.id));
end;
$$;

-- ── a hold becomes a payment ────────────────────────────────────────────────
--
-- Idempotent: fulfilment runs from a webhook, and a webhook is delivered more
-- than once. A capture that has already happened returns what it captured the
-- first time rather than spending the balance again.
create or replace function public.zw_stored_value_capture(p_ref text, p_order_ref text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_done integer;
  v_take integer;
  v_id   uuid;
begin
  select coalesce(sum(-cents), 0) into v_done
  from stored_value_entries where kind = 'capture' and hold_ref = p_ref;
  if v_done > 0 then
    return jsonb_build_object('ok', true, 'captured_cents', v_done, 'already', true);
  end if;

  select stored_value_id, coalesce(sum(-cents), 0) into v_id, v_take
  from stored_value_entries
  where kind = 'hold' and hold_ref = p_ref and (expires_at is null or expires_at > now())
  group by stored_value_id;

  if v_id is null or coalesce(v_take, 0) <= 0 then
    /* The hold expired before the payment landed. Deliberately NOT an error and
       deliberately not a silent re-spend: the order is already paid for by the
       card, and taking the money off the card now would charge twice for the
       same goods. It is reported so the discrepancy is visible. */
    return jsonb_build_object('ok', false, 'reason', 'hold_expired', 'captured_cents', 0);
  end if;

  /* The hold is released and a capture written, rather than the hold being
     mutated: entries are immutable, so history keeps saying what happened. */
  insert into stored_value_entries (stored_value_id, kind, cents, hold_ref, order_ref)
  values (v_id, 'release', v_take, p_ref, p_order_ref),
         (v_id, 'capture', -v_take, p_ref, p_order_ref);

  return jsonb_build_object('ok', true, 'captured_cents', v_take, 'already', false,
                            'balance_cents', zw_stored_value_balance_cents(v_id));
end;
$$;

-- ── give a hold back early ──────────────────────────────────────────────────
create or replace function public.zw_stored_value_release(p_ref text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_id uuid; v_take integer;
begin
  select stored_value_id, coalesce(sum(-cents), 0) into v_id, v_take
  from stored_value_entries
  where kind = 'hold' and hold_ref = p_ref and (expires_at is null or expires_at > now())
  group by stored_value_id;
  if v_id is null or coalesce(v_take, 0) <= 0 then
    return jsonb_build_object('ok', true, 'released_cents', 0);
  end if;
  insert into stored_value_entries (stored_value_id, kind, cents, hold_ref)
  values (v_id, 'release', v_take, p_ref);
  return jsonb_build_object('ok', true, 'released_cents', v_take);
end;
$$;

-- ── issue ───────────────────────────────────────────────────────────────────
create or replace function public.zw_stored_value_issue(
  p_code    text,
  p_kind    text,
  p_cents   integer,
  p_owner   uuid default null,
  p_email   text default null,
  p_by      uuid default null,
  p_reason  text default null,
  p_source  text default null,
  p_expires timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_id uuid;
begin
  if coalesce(p_cents, 0) <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive');
  end if;
  insert into stored_value (code, kind, initial_cents, owner_user_id, owner_email,
                            issued_by, issued_reason, source_ref, expires_at)
  values (upper(trim(p_code)), p_kind, p_cents, p_owner, lower(nullif(trim(p_email), '')),
          p_by, p_reason, p_source, p_expires)
  returning id into v_id;

  insert into stored_value_entries (stored_value_id, kind, cents, order_ref)
  values (v_id, 'issue', p_cents, p_source);

  return jsonb_build_object('ok', true, 'id', v_id, 'balance_cents', p_cents);
end;
$$;

-- ── void what is left ───────────────────────────────────────────────────────
create or replace function public.zw_stored_value_void(p_code text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v stored_value%rowtype; v_left integer;
begin
  select * into v from stored_value where code = upper(trim(p_code)) for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  v_left := zw_stored_value_balance_cents(v.id);
  update stored_value set status = 'void' where id = v.id;
  if v_left > 0 then
    insert into stored_value_entries (stored_value_id, kind, cents, order_ref)
    values (v.id, 'void', -v_left, p_reason);
  end if;
  return jsonb_build_object('ok', true, 'voided_cents', v_left);
end;
$$;

-- Only a Worker holding the service key may do any of this.
do $$
declare f text;
begin
  foreach f in array array[
    'zw_stored_value_balance_cents(uuid)',
    'zw_stored_value_lookup(text)',
    'zw_stored_value_hold(text, integer, text, integer)',
    'zw_stored_value_capture(text, text)',
    'zw_stored_value_release(text)',
    'zw_stored_value_issue(text, text, integer, uuid, text, uuid, text, text, timestamptz)',
    'zw_stored_value_void(text, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

comment on table public.stored_value is
  'Gift cards and store credit — one instrument, distinguished by `kind`. Balance is never stored: it is the sum of stored_value_entries. Service role only.';
