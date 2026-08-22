-- ============================================================================
-- 0034 — a claimed card is a locked card
--
-- The question this answers, asked plainly: "when I email someone a gift card,
-- anyone who finds that email can spend it. What is the protocol?"
--
-- There are four layers to the honest answer and three of them already exist:
-- codes are ~2⁷⁷ of entropy from a CSPRNG and lookups are rate limited; the
-- code is kept out of the audit log, the receipts and the notification emails;
-- void is instant and deliberately not behind REFUND_SECRET, and the "your gift
-- card was used" email tells the buyer the same day if a code is stolen.
--
-- This is the fourth. It is the one that actually removes the exposure, and it
-- is what Amazon, Starbucks and Apple all do: move the value OFF the code. Once
-- a customer has claimed a card into their account, the balance lives behind a
-- login and the email becomes worthless to whoever finds it.
--
-- ── WHY A NEW FLAG AND NOT owner_user_id ────────────────────────────────────
--
-- This is the whole design decision, and getting it wrong breaks real
-- customers. `owner_user_id` is ALREADY set on cards nobody deliberately
-- claimed:
--
--   · store credit issued after a return binds to the account it was issued to,
--     so the balance shows up on that customer's account page
--   · an admin issuing to an address that has an account binds it the same way
--
-- Those are conveniences, not locks. If ownership alone meant "only this
-- account may spend it", every one of those customers would be refused their
-- own credit the moment they checked out as a guest — which is most of them,
-- because a return does not require signing in.
--
-- So the lock is a separate, explicit fact: false everywhere by default, true
-- ONLY when a signed-in customer asks for it through /api/claim-stored-value.
-- Ownership says where a balance is listed. Locking says who may spend it.
--
-- ── AND IT IS ENFORCED IN TWO PLACES, ON PURPOSE ────────────────────────────
--
-- The quote refuses first, so a shopper gets a sentence rather than a silent
-- failure at the moment of payment. The HOLD refuses too, in this function,
-- because the hold is where money actually stops being spendable and it is the
-- only check no future code path can forget to call. A browser that could name
-- its own deduction could name a bigger one; a browser that could skip the
-- ownership check could spend anybody's card.
--
-- ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
--
-- It does not lock anything retroactively. Every existing card stays exactly as
-- spendable as it was this morning, because a store that silently made
-- outstanding gift cards un-spendable by strangers would be breaking the gifts
-- people had already given.
-- ============================================================================

alter table public.stored_value
  add column if not exists locked_to_owner boolean not null default false;

comment on column public.stored_value.locked_to_owner is
  'TRUE only when a signed-in customer deliberately claimed this card to their '
  'account. A locked card can be spent only while signed in as owner_user_id. '
  'Deliberately separate from owner_user_id, which is also set by returns and '
  'by admin issuance and means only "list it on this account". See 0034.';

/* A lock with nobody to unlock it is a dead card. Cheap to refuse here. */
alter table public.stored_value
  drop constraint if exists stored_value_lock_needs_an_owner;
alter table public.stored_value
  add constraint stored_value_lock_needs_an_owner
  check (locked_to_owner = false or owner_user_id is not null);

-- ─────────────────────────────────────────────────────────────────────────────
-- The hold learns who is asking.
--
-- DROPPED AND RECREATED rather than CREATE OR REPLACE'd: adding a parameter
-- changes the signature, so a replace would leave the four-argument version in
-- place beside the new one and PostgREST would have two candidates to choose
-- between. One function, one signature.
--
-- The window where it does not exist is sub-second and fails in the safe
-- direction anyway — _stored-value.js turns an unreachable hold into
-- { ok: false, reason: 'unavailable' }, and create-payment-intent answers 503
-- rather than letting goods leave at the discounted amount.
-- ─────────────────────────────────────────────────────────────────────────────
drop function if exists public.zw_stored_value_hold(text, integer, text, integer);

create function public.zw_stored_value_hold(
  p_code    text,
  p_cents   integer,
  p_ref     text,
  p_seconds integer default 1800,
  p_user    uuid default null
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

  /* The lock. Checked before anything is reserved, and checked HERE because
     this is the only place that cannot be skipped by a caller. */
  if v.locked_to_owner and (p_user is null or p_user <> v.owner_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'held_cents', 0);
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

/* Lookup reports the lock, so the checkout box and the account page can say
   "this card is locked to another account" instead of "that code is not
   valid" — which would send somebody hunting for a typo in a code that is
   perfectly real. */
/* 0030's body verbatim, with one field added. Rewritten in full rather than
   patched because CREATE OR REPLACE takes the whole definition — and copying it
   exactly is how `currency` survives, which a from-memory rewrite of this
   function dropped on the first attempt. */
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
    'locked_to_owner', v.locked_to_owner,
    'initial_cents', v.initial_cents,
    'balance_cents', zw_stored_value_balance_cents(v.id)
  );
end;
$$;
