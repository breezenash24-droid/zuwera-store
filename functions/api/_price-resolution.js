/**
 * _price-resolution.js — which price applies, to whom, right now.
 *
 * The pricing system from migration 0022 sits ON TOP of the prices already on
 * products and color_variants; it does not replace them. When nothing here
 * matches, the answer is whatever _variant-price.js already said. That ordering
 * is the whole safety of this feature: an empty pricing system prices the
 * catalogue exactly as it did before, rather than pricing it at zero.
 *
 * ── THE ORDER, AND WHY IT IS FIXED ──────────────────────────────────────────
 *
 * Several price rows can be live for one shopper at one instant. Picking
 * between them has to be deterministic, or the same cart prices differently on
 * two page loads and nobody can reproduce the complaint. In order:
 *
 *   1. LIST PRIORITY, highest first. A members list at 10 beats the default
 *      at 0. This is the axis a merchant thinks in.
 *   2. SPECIFICITY. A row naming a colour beats one that does not, so "the
 *      product is $220 but crimson is $176.97" needs two rows, not twelve.
 *   3. LATEST START. Of two rows that are otherwise equal, the one that came
 *      into effect most recently wins — a scheduled change supersedes the
 *      standing price the moment its window opens.
 *   4. NEWEST ROW. A total tie is broken by id/created_at so the answer is
 *      stable rather than dependent on row order from the database.
 *
 * A row is only a candidate if it is APPROVED and `now` is inside its window.
 * Proposed rows price nothing — that is what makes the workflow real rather
 * than decorative.
 *
 * ── THE THING THIS MUST NEVER DO ────────────────────────────────────────────
 *
 * Return a price the shopper was not shown. The browser never resolves any of
 * this: /api/prices asks the server, exactly as checkout-tax.js asks
 * /api/tax-quote rather than keeping a rate table. A second implementation in
 * the browser is how the tax on screen and the tax on the card came to differ,
 * and prices are the same shape of problem with a bigger blast radius.
 */

import { resolveVariantPrice } from './_variant-price.js';

/** Dollars → integer cents. 0 for anything unusable, never NaN. */
function cents(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

function ms(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * Is this list one of the shopper's?
 *
 * NULL on channel/region/customer_group means "any". A list that names a group
 * the shopper is not in is not theirs, which is the entire access rule — there
 * is no separate permission model for who may be charged what.
 */
export function listApplies(list, shopper) {
  if (!list || list.active === false) return false;
  const s = shopper || {};
  const groups = Array.isArray(s.groups) ? s.groups.map((g) => String(g).toLowerCase()) : [];

  if (list.channel && String(list.channel).toLowerCase() !== String(s.channel || 'web').toLowerCase()) return false;
  if (list.region && String(list.region).toUpperCase() !== String(s.region || 'US').toUpperCase()) return false;
  if (list.customer_group && !groups.includes(String(list.customer_group).toLowerCase())) return false;
  return true;
}

/** Approved, and `now` is inside its window. */
export function priceIsLive(row, now) {
  if (!row || row.status !== 'approved') return false;
  const from = ms(row.starts_at);
  const to   = ms(row.ends_at);
  if (from !== null && now < from) return false;
  /* Exclusive end: a window ending at midnight does not price anything at
     midnight. Inclusive would leave two rows live for one instant at every
     handover, which is precisely the ambiguity the ordering above exists to
     remove. */
  if (to !== null && now >= to) return false;
  return true;
}

/**
 * The winning row for one (product, colour, shopper, instant), or null.
 *
 * `lists` and `rows` are passed in rather than fetched so this stays pure and
 * can be run over a table of cases — the fetch layer is below.
 */
export function pickPrice({ rows, lists, productId, colorVariantId, shopper, now }) {
  const at = Number.isFinite(now) ? now : Date.now();
  const byId = new Map((lists || []).map((l) => [String(l.id), l]));

  const candidates = (rows || []).filter((r) => {
    if (String(r.product_id) !== String(productId)) return false;
    /* A row for a DIFFERENT colour is not a fallback for this one. Only an
       exact match or a product-wide row (null colour) can apply. */
    if (r.color_variant_id && String(r.color_variant_id) !== String(colorVariantId || '')) return false;
    const list = byId.get(String(r.price_list_id));
    if (!listApplies(list, shopper)) return false;
    return priceIsLive(r, at);
  });

  if (!candidates.length) return null;

  const priorityOf = (r) => Number((byId.get(String(r.price_list_id)) || {}).priority) || 0;
  candidates.sort((a, b) => {
    const p = priorityOf(b) - priorityOf(a);
    if (p) return p;
    const spec = (b.color_variant_id ? 1 : 0) - (a.color_variant_id ? 1 : 0);
    if (spec) return spec;
    const start = (ms(b.starts_at) || 0) - (ms(a.starts_at) || 0);
    if (start) return start;
    /* Last resort so the answer is stable rather than however the rows arrived. */
    return String(b.id || '').localeCompare(String(a.id || ''));
  });

  return candidates[0];
}

/**
 * The price a shopper pays, with the reason attached.
 *
 * `source` is not decoration: every price complaint starts with "why is it
 * showing that", and an answer that cannot say where the figure came from turns
 * into an afternoon of reading tables.
 */
export function resolvePrice({ product, variant, rows, lists, shopper, now }) {
  const s = shopper || {};
  const isMember = Array.isArray(s.groups) && s.groups.map(String).includes('member');

  /* The catalogue answer, which is also the fallback. Computed first so a
     pricing system with nothing in it is exactly the system that preceded it. */
  const base = resolveVariantPrice(product, variant, isMember);

  const row = pickPrice({
    rows, lists,
    productId: product && product.id,
    colorVariantId: variant && variant.id,
    shopper: s, now,
  });

  if (!row) {
    return {
      priceCents: base.priceCents,
      regularCents: base.regularCents,
      memberCents: base.memberCents,
      usingMember: base.usingMember,
      compareAtCents: base.msrpCents,
      source: base.source,          // 'variant' | 'product'
      priceListCode: '',
      priceId: '',
      startsAt: '', endsAt: '',
    };
  }

  const amountCents = cents(row.amount);
  /* A price row of zero is not a free product, it is a row that should never
     have been approved. Falling back is the safe reading: the catalogue price
     is a real number somebody chose. */
  if (amountCents <= 0) {
    return {
      priceCents: base.priceCents,
      regularCents: base.regularCents,
      memberCents: base.memberCents,
      usingMember: base.usingMember,
      compareAtCents: base.msrpCents,
      source: base.source,
      priceListCode: '',
      priceId: '',
      startsAt: '', endsAt: '',
      ignoredZeroRow: String(row.id || ''),
    };
  }

  /* STAGE TWO: what a member pays, WITHIN the row that already won (0023).
     Membership plays no part in choosing the row — that is stage one above —
     so a member_price here can never compete with a Members price list. Only
     the winning row's figures are ever read.

     Ignored when it is not actually cheaper, exactly as on products and
     colourways: charging somebody more for being a member is never what was
     meant, and it is what a transposed pair of numbers produces. */
  const rowMemberCents = cents(row.member_price);
  const useRowMember = isMember && rowMemberCents > 0 && rowMemberCents < amountCents;

  const list = (lists || []).find((l) => String(l.id) === String(row.price_list_id)) || {};
  return {
    priceCents: useRowMember ? rowMemberCents : amountCents,
    regularCents: amountCents,
    memberCents: rowMemberCents,
    usingMember: useRowMember,
    compareAtCents: cents(row.compare_at) || base.msrpCents,
    source: 'price_list',
    priceListCode: String(list.code || ''),
    priceId: String(row.id || ''),
    startsAt: row.starts_at || '',
    endsAt: row.ends_at || '',
  };
}

/* ── Fetching ───────────────────────────────────────────────────────────────
   One read per request rather than one per cart line. A five-line cart used to
   mean five round trips before this; the pricing tables are small and the whole
   live set for a handful of products fits in a single query. */

function headers(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
  if (!env.SUPABASE_URL || !key) return null;
  return { apikey: key, Authorization: 'Bearer ' + key };
}

/**
 * Live price rows and the lists they belong to, for a set of products.
 *
 * Returns `{ rows: [], lists: [] }` on ANY failure — a missing table before
 * 0022 is applied, a rejected select, an unreachable database. Empty means
 * "nothing overrides the catalogue", which is the only safe direction: the
 * alternative is a store that cannot quote a price because a reporting table is
 * unavailable.
 */
export async function fetchPricingContext(env, productIds) {
  const empty = { rows: [], lists: [] };
  const H = headers(env);
  const ids = [...new Set((productIds || []).map(String).filter(Boolean))];
  if (!H || !ids.length) return empty;

  const base = env.SUPABASE_URL + '/rest/v1/';
  const get = async (path) => {
    const r = await fetch(base + path, { headers: H, cache: 'no-store' }).catch(() => null);
    if (!r || !r.ok) {
      if (r) console.warn(`fetchPricingContext: ${path.split('?')[0]} → ${r.status}; pricing from the catalogue`);
      return null;
    }
    const j = await r.json().catch(() => null);
    return Array.isArray(j) ? j : null;
  };

  const [rows, lists] = await Promise.all([
    get('prices?select=id,price_list_id,product_id,color_variant_id,amount,compare_at,starts_at,ends_at,status'
        + `&status=eq.approved&product_id=in.(${ids.join(',')})`),
    get('price_lists?select=id,code,name,channel,region,customer_group,priority,active&active=eq.true'),
  ]);

  if (!rows || !lists) return empty;
  return { rows, lists };
}

/**
 * Which lists a shopper belongs to, expressed as groups.
 *
 * Membership is the only group this store has, and it is already decided by
 * verifyAccessToken on the pricing path — so this takes the answer rather than
 * working it out again. Region and channel are stubs with honest defaults; the
 * day a second channel exists they become real without the resolver changing.
 */
export function shopperFor({ isMember, region, channel }) {
  return {
    groups: isMember ? ['member'] : [],
    region: region || 'US',
    channel: channel || 'web',
  };
}
