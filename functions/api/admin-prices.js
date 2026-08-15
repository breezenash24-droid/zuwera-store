/**
 * /api/admin-prices — propose, approve, reject and read price changes.
 *
 * Everything here runs on the SERVER with the service key, and that is the
 * point rather than an implementation detail. The existing admin audit log is
 * written by the browser (`sb.from('admin_audit_log').insert(...)` in
 * admin-main.js), which makes it a record an admin could decline to write. A
 * price register that the priced party can skip is evidence, not governance.
 *
 * So: the browser may only ASK for a change. This file reads the current price,
 * writes the new row, and writes the audit line in the same request — the
 * before-figure comes from the database rather than from the request body,
 * because a body that carries "it used to be $220" is a body that can say
 * anything.
 *
 * ── SELF-APPROVAL ───────────────────────────────────────────────────────────
 *
 * Permitted, and stamped. A workflow that demands a second person is unusable
 * in a store with one owner, and an unusable control gets switched off — which
 * ends with no register at all. Approving your own change sets
 * price_audit.self_approved, so the record never implies a second pair of eyes
 * that was not there. A list can be set to require_second_approver the day
 * somebody else exists, and then it is refused outright.
 *
 * ── WHY 'pricing' IS ITS OWN PERMISSION ─────────────────────────────────────
 *
 * Editing product copy and deciding what the company charges are different
 * jobs. They were the same permission because price was a column on the product
 * form. A content editor should be able to fix a typo in a description without
 * being able to take 40% off it.
 */

import { cors, json, verifyAdmin } from './_commerce.js';
import { permsHave } from './_rbac.js';
import { resolveVariantPrice } from './_variant-price.js';
import { fetchPricingContext, resolvePrice, shopperFor } from './_price-resolution.js';

function H(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!env.SUPABASE_URL || !key) return null;
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}

/* verifyAdmin's signature is (env, accessToken) and it returns the admin object
   or NULL — it does not return {ok}. Getting that wrong is not a small mistake:
   passing (request, env) makes the Request object the `env`, so the first thing
   that reads env.SUPABASE_URL throws "Supabase is not configured for commerce
   features." and the page reports a configuration problem that does not exist.
   Copied from admin-returns.js, which is the working shape. */
async function requireAdmin(request, env, capability) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const admin = await verifyAdmin(env, token);
  if (!admin) throw new Error('Not authorised.');
  if (capability && !permsHave(admin.permissions, capability)) {
    throw new Error('Your role does not have permission for this action.');
  }
  return admin;
}

const money = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};

const when = (v) => {
  if (!v) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? `${v}T00:00:00.000Z` : String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/* The figure a shopper would be charged for this product/colour right now,
   read from the database rather than taken from the request. This is the
   "from" in the register, and it is the only reason the register is worth
   keeping — a log of new prices with no old ones records that something
   happened, which is what admin_audit_log already does for products. */
async function currentPriceCents(env, productId, colorVariantId) {
  const h = H(env);
  if (!h) return { cents: 0, memberCents: 0, title: '', colorName: '' };
  const base = env.SUPABASE_URL + '/rest/v1/';
  const [products, variants] = await Promise.all([
    fetch(`${base}products?select=id,title,current_price,member_price,msrp&id=eq.${productId}&limit=1`,
          { headers: h, cache: 'no-store' }).then((r) => r.ok ? r.json() : []).catch(() => []),
    colorVariantId
      ? fetch(`${base}color_variants?select=id,color_name,current_price,member_price,msrp&id=eq.${colorVariantId}&limit=1`,
              { headers: h, cache: 'no-store' }).then((r) => r.ok ? r.json() : []).catch(() => [])
      : Promise.resolve([]),
  ]);
  const product = (products || [])[0] || null;
  const variant = (variants || [])[0] || null;
  if (!product) return { cents: 0, memberCents: 0, title: '', colorName: '' };

  const ctx = await fetchPricingContext(env, [productId]);
  const r = resolvePrice({
    product, variant, rows: ctx.rows, lists: ctx.lists,
    /* Priced as an ordinary shopper: the register records the public price, not
       whatever the admin happens to qualify for. */
    shopper: shopperFor({ isMember: false }), now: Date.now(),
  });
  /* memberCents is what a MEMBER pays today, resolved separately rather than
     read off the same call: the line above deliberately prices as a guest, and
     the register needs both before-figures because "the price moved" and "the
     member price moved" are different statements. */
  const m = resolvePrice({
    product, variant, rows: ctx.rows, lists: ctx.lists,
    shopper: shopperFor({ isMember: true }), now: Date.now(),
  });
  return {
    cents: r.priceCents,
    memberCents: m.priceCents === r.priceCents ? 0 : m.priceCents,
    title: product.title || '',
    colorName: variant ? (variant.color_name || '') : '',
  };
}

async function writeAudit(env, row) {
  const h = H(env);
  if (!h) return;
  await fetch(env.SUPABASE_URL + '/rest/v1/price_audit', {
    method: 'POST', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(row),
  }).catch((e) => console.warn('price_audit write failed:', e && e.message));
}

/* ── GET: the board ─────────────────────────────────────────────────────── */
export async function onRequestGet({ request, env }) {
  try {
    const admin = await requireAdmin(request, env, 'pricing_write');
    const h = H(env);
    if (!h) return json({ ok: false, error: 'Not configured.' }, 503, cors(env));
    const base = env.SUPABASE_URL + '/rest/v1/';
    const url = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500);

    const [lists, prices, audit] = await Promise.all([
      fetch(`${base}price_lists?select=*&order=priority.desc`, { headers: h, cache: 'no-store' })
        .then((r) => r.ok ? r.json() : []).catch(() => []),
      fetch(`${base}prices?select=*&order=created_at.desc&limit=${limit}`, { headers: h, cache: 'no-store' })
        .then((r) => r.ok ? r.json() : []).catch(() => []),
      fetch(`${base}price_audit?select=*&order=at.desc&limit=${limit}`, { headers: h, cache: 'no-store' })
        .then((r) => r.ok ? r.json() : []).catch(() => []),
    ]);

    return json({
      ok: true,
      lists: lists || [],
      prices: prices || [],
      audit: audit || [],
      /* So the panel can show "you proposed this" without a second round trip,
         and so self-approval can be labelled before it is committed. */
      you: admin.profile?.email || admin.email || '',
    }, 200, cors(env));
  } catch (e) {
    return json({ ok: false, error: e?.message || 'Could not load pricing.' }, 400, cors(env));
  }
}

/* ── POST: propose / approve / reject ───────────────────────────────────── */
export async function onRequestPost({ request, env }) {
  try {
    const admin = await requireAdmin(request, env, 'pricing_write');
    const actor = admin.profile?.email || admin.email || '';
    /* verifyAdmin spreads the auth user, so `admin.id` is the user id. `userId`
       was never a field on it — it would have made every audit row anonymous. */
    const actorId = admin.profile?.id || admin.id || null;
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    const h = H(env);
    if (!h) return json({ ok: false, error: 'Not configured.' }, 503, cors(env));
    const base = env.SUPABASE_URL + '/rest/v1/';

    if (action === 'propose') {
      const productId = String(body.productId || '').trim();
      const colorVariantId = String(body.colorVariantId || '').trim() || null;
      const listId = String(body.priceListId || '').trim();
      const amount = money(body.amount);
      if (!productId || !listId) return json({ ok: false, error: 'A product and a price list are required.' }, 400, cors(env));
      if (amount === null || amount <= 0) {
        /* Zero is refused rather than stored. The resolver ignores a zero row
           and falls back, so storing one would create a change that appears in
           the register, appears approved, and prices nothing. */
        return json({ ok: false, error: 'A price above zero is required.' }, 400, cors(env));
      }

      const startsAt = when(body.startsAt);
      const endsAt = when(body.endsAt);
      if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
        return json({ ok: false, error: 'The end date must be after the start date.' }, 400, cors(env));
      }

      /* Refused rather than stored-and-ignored. The resolver already declines
         to honour a member price at or above the regular one, but storing it
         would leave an approved row that reads as a member discount and is not
         one — the register would show a movement nobody ever received. */
      const memberPrice = money(body.memberPrice);
      if (memberPrice !== null && memberPrice >= amount) {
        return json({ ok: false, error: 'The member price must be below the price.' }, 400, cors(env));
      }

      const before = await currentPriceCents(env, productId, colorVariantId);

      const insert = await fetch(base + 'prices', {
        method: 'POST', headers: { ...h, Prefer: 'return=representation' },
        body: JSON.stringify({
          price_list_id: listId, product_id: productId, color_variant_id: colorVariantId,
          amount, member_price: memberPrice, compare_at: money(body.compareAt),
          starts_at: startsAt, ends_at: endsAt,
          status: 'proposed', note: String(body.note || '').slice(0, 500),
          created_by: actorId,
        }),
      });
      if (!insert.ok) {
        const detail = await insert.text().catch(() => '');
        return json({ ok: false, error: 'Could not save that change. ' + detail.slice(0, 200) }, 502, cors(env));
      }
      const saved = (await insert.json().catch(() => []))[0] || {};

      await writeAudit(env, {
        actor_id: actorId, actor_email: actor, action: 'proposed',
        price_id: saved.id || null, product_id: productId,
        product_title: before.title, color_name: before.colorName,
        from_amount: before.cents / 100, to_amount: amount,
        from_member_amount: before.memberCents ? before.memberCents / 100 : null,
        to_member_amount: memberPrice,
        to_compare_at: money(body.compareAt),
        starts_at: startsAt, ends_at: endsAt,
        note: String(body.note || '').slice(0, 500),
      });

      return json({ ok: true, price: saved }, 200, cors(env));
    }

    if (action === 'approve' || action === 'reject') {
      const priceId = String(body.priceId || '').trim();
      if (!priceId) return json({ ok: false, error: 'Missing price id.' }, 400, cors(env));

      const rows = await fetch(`${base}prices?select=*&id=eq.${priceId}&limit=1`, { headers: h, cache: 'no-store' })
        .then((r) => r.ok ? r.json() : []).catch(() => []);
      const price = (rows || [])[0];
      if (!price) return json({ ok: false, error: 'That change no longer exists.' }, 404, cors(env));
      if (price.status !== 'proposed') {
        return json({ ok: false, error: `That change is already ${price.status}.` }, 409, cors(env));
      }

      const selfApproved = Boolean(price.created_by && actorId && String(price.created_by) === String(actorId));

      if (action === 'approve' && selfApproved) {
        /* Allowed by default, refused when the list demands a second pair of
           eyes. The check is here rather than in the UI because a rule enforced
           only in a form is a rule enforced only for people using the form. */
        const listRows = await fetch(`${base}price_lists?select=require_second_approver,name&id=eq.${price.price_list_id}&limit=1`,
                                     { headers: h, cache: 'no-store' })
          .then((r) => r.ok ? r.json() : []).catch(() => []);
        if ((listRows || [])[0]?.require_second_approver) {
          return json({
            ok: false,
            error: `${(listRows[0].name || 'This list')} requires a second person to approve a change. Ask another admin with pricing access to review it.`,
          }, 403, cors(env));
        }
      }

      const patch = action === 'approve'
        ? { status: 'approved', approved_by: actorId, approved_at: new Date().toISOString() }
        : { status: 'rejected', rejected_by: actorId, rejected_at: new Date().toISOString() };

      const upd = await fetch(`${base}prices?id=eq.${priceId}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      if (!upd.ok) return json({ ok: false, error: 'Could not update that change.' }, 502, cors(env));

      const before = await currentPriceCents(env, price.product_id, price.color_variant_id);
      await writeAudit(env, {
        actor_id: actorId, actor_email: actor, action: action === 'approve' ? 'approved' : 'rejected',
        price_id: priceId, product_id: price.product_id,
        product_title: before.title, color_name: before.colorName,
        from_amount: before.cents / 100,
        to_amount: action === 'approve' ? price.amount : null,
        starts_at: price.starts_at, ends_at: price.ends_at,
        self_approved: action === 'approve' ? selfApproved : false,
        note: String(body.note || '').slice(0, 500),
      });

      return json({ ok: true, status: patch.status, selfApproved }, 200, cors(env));
    }

    return json({ ok: false, error: 'Unsupported action.' }, 400, cors(env));
  } catch (e) {
    return json({ ok: false, error: e?.message || 'Could not change pricing.' }, 400, cors(env));
  }
}
